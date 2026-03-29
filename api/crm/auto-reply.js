// fäm Living — POST /api/crm/auto-reply
// Trengo webhook handler for both INBOUND (lead) and OUTBOUND (agent) messages.
//
// Bot active hours (currently 9 PM – 6 AM Dubai time, expanding to 24/7 soon):
//   INBOUND → AI reads message, generates reply, posts back via Trengo
//   Bot escalates to Faysal when unsure:
//     → sends WhatsApp to Faysal via Trengo (FAYSAL_TICKET_ID)
//     → stores Q in pending_escalations.json
//     → Faysal replies on WhatsApp → bot learns, updates playbook, follows up with lead
//
// Outside active hours (currently 6 AM – 9 PM Dubai):
//   INBOUND → bot stays silent, Afifa handles
//   OUTBOUND from Afifa → bot reads and logs as learning opportunity
//     → if Afifa replied after a bot escalation, extract Q&A, log for playbook update
//
// Kill switches:
//   AUTOBOT_ENABLED env var must = 'true' (global off switch)
//   bot_paused flag in crm_state disables per-lead (Afifa can flip this)

const GH_API     = 'https://api.github.com';
const TRENGO_API = 'https://app.trengo.com/api/v2';
const REPO       = 'fam-pricing/fam-api';
const CRM_FILE        = 'data/crm_state.json';
const PENDING_FILE    = 'data/pending_escalations.json';
const PLAYBOOK_FILE   = 'data/playbook.md';
const LISTINGS_FILE   = 'data/listings.json';
const REF_MAP_FILE    = 'data/ref_mapping.json';

const DUBAI_OFFSET_HOURS = 4;
const NIGHT_START = 21;
const NIGHT_END   = 6;

const READ_DELAY_BASE   = 2000; // base delay to simulate reading
const READ_DELAY_JITTER = 3000; // random jitter (0-3s) to desynchronize concurrent webhooks
const AGENT_COOLDOWN_MS = 3 * 60 * 1000; // 3 min — bot's own outbound replies were triggering 15min lockout

// ── Time helpers ──────────────────────────────────────────────────────────────

function getDubaiHour() {
  return (new Date().getUTCHours() + DUBAI_OFFSET_HOURS) % 24;
}

function isNightShift() {
  const h = getDubaiHour();
  return h >= NIGHT_START || h < NIGHT_END;
}

// ── GitHub helpers ────────────────────────────────────────────────────────────

async function ghRead(file) {
  const ghToken = process.env.GH_TOKEN;
  if (!ghToken) return { data: null, sha: null };
  const r = await fetch(`${GH_API}/repos/${REPO}/contents/${file}`, {
    headers: { Authorization: `Bearer ${ghToken}`, Accept: 'application/vnd.github.v3+json' },
  });
  if (!r.ok) return { data: null, sha: null };
  const d = await r.json();
  try {
    return { data: JSON.parse(Buffer.from(d.content.replace(/\n/g, ''), 'base64').toString('utf8')), sha: d.sha };
  } catch { return { data: null, sha: d.sha }; }
}

async function ghWrite(file, data, sha, message) {
  const ghToken = process.env.GH_TOKEN;
  if (!ghToken) return;
  const content = Buffer.from(JSON.stringify(data, null, 2)).toString('base64');
  await fetch(`${GH_API}/repos/${REPO}/contents/${file}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${ghToken}`, Accept: 'application/vnd.github.v3+json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, content, sha }),
  });
}

async function readCRMState() {
  const { data, sha } = await ghRead(CRM_FILE);
  return { state: data || {}, sha };
}

async function writeCRMState(state, sha) {
  await ghWrite(CRM_FILE, state, sha, 'CRM: auto-reply [bot]');
}

async function readPendingEsc() {
  const { data, sha } = await ghRead(PENDING_FILE);
  return { esc: data || { faysal_ticket_id: null, current_question_id: null, pending: [] }, sha };
}

async function writePendingEsc(esc, sha) {
  await ghWrite(PENDING_FILE, esc, sha, 'Bot: pending escalations update');
}

// ── Playbook (GitHub-backed) ───────────────────────────────────────────────────

async function ghReadText(file) {
  const ghToken = process.env.GH_TOKEN;
  if (!ghToken) return { content: '', sha: null };
  const r = await fetch(`${GH_API}/repos/${REPO}/contents/${file}`, {
    headers: { Authorization: `Bearer ${ghToken}`, Accept: 'application/vnd.github.v3+json' },
  });
  if (!r.ok) return { content: '', sha: null };
  const d = await r.json();
  try {
    return { content: Buffer.from(d.content.replace(/\n/g, ''), 'base64').toString('utf8'), sha: d.sha };
  } catch { return { content: '', sha: d.sha }; }
}

async function ghWriteText(file, content, sha, message) {
  const ghToken = process.env.GH_TOKEN;
  if (!ghToken) return;
  const encoded = Buffer.from(content).toString('base64');
  await fetch(`${GH_API}/repos/${REPO}/contents/${file}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${ghToken}`, Accept: 'application/vnd.github.v3+json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, content: encoded, sha }),
  });
}

async function loadPlaybook() {
  try {
    const { content } = await ghReadText(PLAYBOOK_FILE);
    return content.trim();
  } catch (e) {
    console.warn('[auto-reply] playbook load failed:', e?.message);
    return '';
  }
}

async function appendToPlaybook(newRule) {
  try {
    const { content, sha } = await ghReadText(PLAYBOOK_FILE);
    const today = new Date().toISOString().split('T')[0];
    const entry = `\n## Learned (${today})\n${newRule}\n`;
    await ghWriteText(PLAYBOOK_FILE, content + entry, sha, 'Bot: playbook updated');
    console.log('[auto-reply] Playbook updated on GitHub');
  } catch (e) {
    console.error('[auto-reply] Failed to update playbook:', e?.message);
  }
}

// ── Trengo helpers ────────────────────────────────────────────────────────────

async function getTrengoMessages(ticketId) {
  const token = process.env.TRENGO_TOKEN;
  try {
    const r = await fetch(`${TRENGO_API}/tickets/${ticketId}/messages`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    if (!r.ok) return [];
    const d = await r.json();
    return d.data || d.messages || [];
  } catch { return []; }
}

// Check if the most recent real message in the thread is from an agent (not the lead).
// If the lead spoke last, the bot should reply regardless of when the agent last replied.
// This prevents piling on (agent speaks → bot also speaks) but allows the bot to
// handle follow-up questions the lead sends after an agent reply.
async function hasRecentAgentReplyInTrengo(ticketId) {
  const messages = await getTrengoMessages(ticketId);
  if (!messages.length) return false;

  // Sort by created_at descending, ignoring internal notes
  const realMessages = messages.filter(m => !m.internal_note);
  if (!realMessages.length) return false;

  realMessages.sort((a, b) => {
    const tsA = a.created_at ? (typeof a.created_at === 'number' ? a.created_at * 1000 : new Date(a.created_at).getTime()) : 0;
    const tsB = b.created_at ? (typeof b.created_at === 'number' ? b.created_at * 1000 : new Date(b.created_at).getTime()) : 0;
    return tsB - tsA;
  });

  // Only block if the LAST message is from an agent (outbound) — i.e. agent just spoke
  // If the lead spoke last (inbound), bot should reply
  const lastMsg = realMessages[0];
  const lastIsOutbound = (lastMsg.type || '').toUpperCase() === 'OUTBOUND';
  return lastIsOutbound;
}

async function postTrengoMessage(ticketId, message) {
  const token = process.env.TRENGO_TOKEN;
  try {
    const r = await fetch(`${TRENGO_API}/tickets/${ticketId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ message, type: 'OUTBOUND' }),
    });
    const d = await r.json();
    if (!r.ok) { console.error('[auto-reply] post failed:', r.status, JSON.stringify(d)); return false; }
    return true;
  } catch (err) { console.error('[auto-reply] postMessage error:', err.message); return false; }
}

async function attachTrengoLabel(ticketId, labelId) {
  const token = process.env.TRENGO_TOKEN;
  try {
    const r = await fetch(`${TRENGO_API}/tickets/${ticketId}/labels`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ label_id: labelId }),
    });
    if (!r.ok) console.error('[auto-reply] label attach failed:', r.status);
    else console.log(`[auto-reply] Label ${labelId} attached to ticket ${ticketId}`);
  } catch (e) { console.error('[auto-reply] label attach error:', e?.message); }
}

const LABEL_LEAD    = 1816534; // "Lead" — attached on first bot reply
const LABEL_VIEWING = 1816630; // "viewing" — attached when viewing is requested

async function postTrengoNote(ticketId, note) {
  const token = process.env.TRENGO_TOKEN;
  try {
    const r = await fetch(`${TRENGO_API}/tickets/${ticketId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ message: note, internal_note: true }),
    });
    if (!r.ok) console.error('[auto-reply] note post failed:', r.status);
  } catch (e) { console.error('[auto-reply] note post failed:', e?.message); }
}

// ── Send message to Faysal via WhatsApp ───────────────────────────────────────
// Uses FAYSAL_TICKET_ID env var (Faysal's WhatsApp ticket in Trengo).
// Falls back to internal note if ticket ID not set yet.

async function sendToFaysal(message, escData, escSha) {
  let ticketId = process.env.FAYSAL_TICKET_ID
    ? parseInt(process.env.FAYSAL_TICKET_ID, 10)
    : escData?.faysal_ticket_id || null;

  if (!ticketId) {
    // Try to create a new outbound conversation with Faysal
    const channelId = process.env.FAM_WA_CHANNEL_ID ? parseInt(process.env.FAM_WA_CHANNEL_ID, 10) : null;
    if (channelId) {
      const token = process.env.TRENGO_TOKEN;
      try {
        const r = await fetch(`${TRENGO_API}/tickets`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({
            channel_id: channelId,
            contact: { phone: '+971502725428' },
            message,
          }),
        });
        if (r.ok) {
          const d = await r.json();
          ticketId = d?.id || d?.ticket?.id || null;
          if (ticketId && escData) {
            escData.faysal_ticket_id = ticketId;
            await writePendingEsc(escData, escSha);
          }
          console.log(`[auto-reply] Created Faysal WA ticket: ${ticketId}`);
          return true;
        }
      } catch (e) { console.error('[auto-reply] Create Faysal ticket failed:', e?.message); }
    }
    console.log('[auto-reply] No FAYSAL_TICKET_ID set — escalation only in Trengo notes');
    return false;
  }

  const sent = await postTrengoMessage(ticketId, message);
  console.log(`[auto-reply] Faysal WA (ticket ${ticketId}): ${sent ? 'sent' : 'failed'}`);
  return sent;
}

// ── Escalate to Faysal ────────────────────────────────────────────────────────

async function escalateToFaysal(leadName, property, question, trengoTicketId, crmState, leadId, crmSha) {
  const dubaiTime = new Date(Date.now() + DUBAI_OFFSET_HOURS * 3600000)
    .toISOString().replace('T', ' ').substring(0, 16) + ' Dubai';

  // Store on CRM so Afifa's daytime reply can also teach us
  if (crmState && leadId) {
    crmState[leadId].last_escalated_at       = new Date().toISOString();
    crmState[leadId].last_escalated_question = question;
  }

  // Add to pending escalations store
  const { esc, sha: escSha } = await readPendingEsc();
  const escId = `esc_${Date.now()}`;
  esc.pending = esc.pending || [];
  esc.pending.push({
    id:             escId,
    lead_ticket_id: trengoTicketId,
    lead_id:        leadId,
    lead_name:      leadName,
    property:       property || 'unknown',
    question,
    escalated_at:   new Date().toISOString(),
    reminded_at:    null,
    answered_at:    null,
  });
  esc.current_question_id = escId;

  const waMessage =
    `❓ *fäm Bot — lead needs your help!*\n\n` +
    `*Lead:* ${leadName}\n` +
    `*Property:* ${property || 'unknown'}\n\n` +
    `*They asked:*\n"${question}"\n\n` +
    `Reply here with the answer and I'll update my playbook + follow up with the lead 📚`;

  await sendToFaysal(waMessage, esc, escSha);
  await writePendingEsc(esc, escSha);

  // Always leave an internal Trengo note too (so Afifa sees it on day shift)
  const note = `🤖 Bot couldn't answer (${dubaiTime}):\n\n"${question}"\n\nFaysal notified via WhatsApp. Reply to this lead if Faysal doesn't respond in time.`;
  await postTrengoNote(trengoTicketId, note);

  console.log(`[auto-reply] Escalated "${question}" to Faysal (escId: ${escId})`);
}

// ── Classify whether Faysal's message is a playbook rule ─────────────────────
// Returns true = real rule to save, false = casual chat (greeting, test, ack)

async function classifyAsRule(message) {
  // Fast path: obvious non-rules (very short greetings / single words)
  const lower = message.toLowerCase().trim();
  const obvious = /^(hi|hello|hey|ok|okay|yes|no|test|testing|good|great|thanks|thank you|sure|yep|nope|lol|haha|nice|cool|got it|noted|👍|😊|😄|check|ping|just testing|hi ;|hello ;)/.test(lower);
  if (obvious || message.length < 6) return false;

  // AI classification for anything ambiguous
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    // Without AI, require message to have at least one instruction-like word
    return /never|always|don't|do not|make sure|remember|if|when|reply|say|tell|avoid|use|don't|must|should/.test(lower);
  }

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 10,
        messages: [{
          role: 'user',
          content: `Is this message a business rule or instruction that should be saved to a sales playbook? Answer only YES or NO.\n\nMessage: "${message}"`,
        }],
      }),
    });
    if (!r.ok) return true; // default to saving on API error
    const d = await r.json();
    const answer = (d?.content?.[0]?.text || '').trim().toUpperCase();
    return answer.startsWith('YES');
  } catch {
    return true; // default to saving if classification fails
  }
}

// ── Rephrase a raw rule into clean playbook language ─────────────────────────
// Takes Faysal's informal/rough instruction and rewrites it as a crisp rule.

async function rephraseRule(rawMessage) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return rawMessage; // fallback to original if no key

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 120,
        messages: [{
          role: 'user',
          content: `You are editing a sales playbook for a Dubai holiday home rental company.

Faysal (the owner) just sent this raw instruction:
"${rawMessage}"

Rewrite it as a single, clean playbook rule. Fix typos, tighten the language, make it clear and actionable. Keep the exact meaning and intent — do not change what is being said. Output ONLY the rewritten rule, nothing else. No quotes, no labels, no explanation.`,
        }],
      }),
    });
    if (!r.ok) return rawMessage;
    const d = await r.json();
    const rephrased = (d?.content?.[0]?.text || '').trim();
    return rephrased || rawMessage;
  } catch {
    return rawMessage; // fallback to original on error
  }
}

// ── Handle Faysal's teaching reply ───────────────────────────────────────────
// Called when Faysal replies on his dedicated WA teaching conversation.

async function handleFaysalTeachingReply(faysalTicketId, answer) {
  const { esc, sha: escSha } = await readPendingEsc();
  const pending = (esc.pending || []).filter(e => !e.answered_at);

  // Strip common trigger phrases ("update playbook", "remember", etc.)
  const cleanAnswer = answer
    .replace(/^(update playbook[,:]?\s*|remember[,:]?\s*|add to playbook[,:]?\s*)/i, '')
    .replace(/\s*(update playbook|add to playbook)\.?$/i, '')
    .trim();

  if (!pending.length) {
    // No pending questions — check if this is a real rule or just casual chat
    if (cleanAnswer) {
      const isRule = await classifyAsRule(cleanAnswer);
      if (!isRule) {
        // Casual message (greeting, test, acknowledgment, etc.) — just reply naturally
        await postTrengoMessage(faysalTicketId,
          `Hey! No pending questions right now — all quiet. Send me a rule to add anytime, or I'll ping you here when I get stuck with a lead.`);
        return;
      }
      // Rephrase into clean playbook language before saving
      const polishedRule = await rephraseRule(cleanAnswer);
      const newRule = `- ${polishedRule}\n  (Taught by Faysal)`;
      await appendToPlaybook(newRule);
      // Increment direct teachings counter so dashboard shows it
      esc.direct_teachings_count = (esc.direct_teachings_count || 0) + 1;
      await writePendingEsc(esc, escSha);
      await postTrengoMessage(faysalTicketId,
        `Got it — saved to playbook as:\n\n"${polishedRule}"\n\nSend another rule anytime, or I'll ping you here when I get stuck with a lead.`);
    } else {
      await postTrengoMessage(faysalTicketId, `Hey! No pending questions right now. Send me a rule to add to my playbook anytime.`);
    }
    return;
  }

  // There ARE pending questions — Faysal's message answers the current one
  const current = pending.sort((a, b) => new Date(b.escalated_at) - new Date(a.escalated_at))[0];

  console.log(`[auto-reply] Faysal answered Q: "${current.question}" → "${answer}"`);

  // Rephrase Faysal's answer into a clean playbook rule before saving
  const polishedAnswer = await rephraseRule(`If a lead asks "${current.question}", reply: "${cleanAnswer || answer}"`);
  const newRule = `- ${polishedAnswer}\n  (Taught by Faysal for ${current.lead_name})`;
  await appendToPlaybook(newRule);

  // Mark as answered
  const idx = esc.pending.findIndex(e => e.id === current.id);
  if (idx !== -1) {
    esc.pending[idx].answered_at = new Date().toISOString();
    esc.pending[idx].answer      = answer;
  }

  // If there are more pending escalations, set the next one as current
  const remaining = esc.pending.filter(e => !e.answered_at);
  esc.current_question_id = remaining.length ? remaining[0].id : null;
  await writePendingEsc(esc, escSha);

  // Follow up with the lead if their ticket is still active
  if (current.lead_ticket_id) {
    const replyToLead = answer; // Send Faysal's answer directly to the lead
    await postTrengoMessage(current.lead_ticket_id, replyToLead);
    console.log(`[auto-reply] Followed up with lead ticket ${current.lead_ticket_id}`);

    // If this lead had a viewing escalated, mark as team_responded so bot won't re-escalate
    if (current.lead_id) {
      try {
        const { state: crmNow, sha: crmSha } = await readCRMState();
        if (crmNow[current.lead_id] && crmNow[current.lead_id].viewing_status === 'escalated') {
          crmNow[current.lead_id].viewing_status = 'team_responded';
          await writeCRMState(crmNow, crmSha);
          console.log(`[auto-reply] Viewing status → team_responded for ${current.lead_name}`);
        }
      } catch (e) { console.warn('[auto-reply] viewing status update failed:', e?.message); }
    }
  }

  // Confirm to Faysal
  const nextPending = remaining.filter(e => e.id !== current.id);
  let confirmMsg = `✅ *Got it!* Playbook updated and lead notified.\n\n*Rule added:*\n"${current.question}" → use your answer ✓`;
  if (nextPending.length > 0) {
    const next = nextPending[0];
    confirmMsg += `\n\n❓ *Next question:*\n*Lead:* ${next.lead_name} | *Property:* ${next.property}\n"${next.question}"`;
  } else {
    confirmMsg += `\n\nNo more pending questions — you're all caught up! 🎉`;
  }
  await postTrengoMessage(faysalTicketId, confirmMsg);
}

// ── Learn from Afifa ──────────────────────────────────────────────────────────

async function learnFromAfifaReply(ticketId, agentMessage, leadMeta, crmState, leadId, sha) {
  const question = leadMeta.last_escalated_question;
  if (!question) return;

  const escalatedAt = leadMeta.last_escalated_at ? new Date(leadMeta.last_escalated_at).getTime() : 0;
  const ageHours    = (Date.now() - escalatedAt) / 3600000;
  if (ageHours > 24) return;

  const leadName = leadMeta.lead_name || 'Lead';
  const property = leadMeta.listing_title || 'unknown property';

  console.log(`[auto-reply] Learning from Afifa: Q="${question}" → A="${agentMessage}"`);

  const newRule = `- If a lead asks: "${question}" → Reply: "${agentMessage}"\n  (Learned from Afifa handling ${leadName} re ${property})`;
  await appendToPlaybook(newRule);

  crmState[leadId].last_escalated_question = null;
  crmState[leadId].last_learned_at         = new Date().toISOString();
  await writeCRMState(crmState, sha);

  await postTrengoNote(ticketId, `✅ Bot learned from your reply and updated the playbook.`);
}

// ── Portfolio lookup ──────────────────────────────────────────────────────────
// Reads data/listings.json (refreshed on every Sync) to answer portfolio questions.

async function getPortfolioListings(messageText) {
  try {
    const { data } = await ghRead(LISTINGS_FILE);
    if (!data || !Array.isArray(data)) return null;

    // Try to detect a specific area from the message
    const msg = messageText.toLowerCase();
    const areaKeywords = {
      'business bay': 'Business Bay',
      'downtown': 'Downtown',
      'city walk': 'City Walk',
      'jvc': 'JVC',
      'dubai marina': 'Dubai Marina',
      'dubai hills': 'Dubai Hills',
      'creek harbour': 'Dubai Creek Harbour',
      'dubai creek': 'Dubai Creek Harbour',
      'sports city': 'Dubai Sports City',
      'palm': 'Palm Jumeirah',
      'marina': 'Dubai Marina',
      'jbr': 'JBR',
    };

    let filter = null;
    for (const [kw, area] of Object.entries(areaKeywords)) {
      if (msg.includes(kw)) { filter = area; break; }
    }

    const listings = filter
      ? data.filter(l => l.area && l.area.toLowerCase().includes(filter.toLowerCase()))
      : data;

    if (!listings.length) return null;

    // Group by area
    const byArea = {};
    listings.forEach(l => {
      const a = l.area || 'Other';
      if (!byArea[a]) byArea[a] = [];
      byArea[a].push(`${l.beds} in ${l.building} — AED ${Number(l.price).toLocaleString()}/mo`);
    });

    return Object.entries(byArea)
      .map(([area, items]) => `${area}:
${items.map(i => `  • ${i}`).join('\n')}`)
      .join('\n\n');
  } catch (e) {
    console.warn('[auto-reply] portfolio lookup failed:', e?.message);
    return null;
  }
}

// Returns true if the message is asking about available listings/options
function isPortfolioQuestion(text) {
  const t = text.toLowerCase();
  // Broad match — any message asking about listings, options, availability, or portfolio
  return /option|propert|listing|available|avail|apartment|studio|\bunit\b|what else|show me|give me|what.*have|have.*what|portfolio|inventory|what do you|do you have/.test(t);
}

// ── Claude AI reply ───────────────────────────────────────────────────────────

async function generateReply(conversation, leadMeta, newMessage, leadName) {
  const apiKey  = process.env.ANTHROPIC_API_KEY;
  const playbook = await loadPlaybook();

  if (!apiKey) return { reply: null, escalate: true, reason: 'No API key' };

  // Always inject live portfolio so bot never escalates on availability questions
  let portfolioContext = '';
  const listings = await getPortfolioListings(newMessage);
  if (listings) {
    portfolioContext = `\n\n## Active fäm Living Portfolio (live prices — use this to answer any question about what we have available):\n${listings}\n`;
  }

  const history = conversation
    .slice(-10)
    .filter(m => m.message || m.body || m.text)
    .map(m => {
      const isInbound = m.type?.toUpperCase() === 'INBOUND';
      return `${isInbound ? leadName : 'Agent'}: ${(m.message || m.body || m.text || '').trim()}`;
    })
    .join('\n');

  // Resolve raw PF refs (e.g. "PF-HH-AR-109427") to "BED in BUILDING" using ref_mapping
  // If listing_title is still a raw ref, the bot has no idea what property to talk about → hallucination risk
  let rawListing = leadMeta?.listing_title || null;
  let property = rawListing || 'the property';
  if (rawListing && /^PF-HH-AR-/i.test(rawListing)) {
    try {
      const { data: refMap } = await ghRead(REF_MAP_FILE);
      const mapping = refMap?.[rawListing];
      if (mapping?.building && mapping?.bed_type) {
        property = `${mapping.bed_type} in ${mapping.building}`;
      } else {
        property = 'unknown property (ref not in mapping)';
      }
    } catch {
      property = 'unknown property';
    }
  }

  // Viewing state context — prevents re-escalation loop
  let viewingContext = '';
  if (leadMeta?.viewing_status === 'team_responded') {
    viewingContext = `\n\nVIEWING STATUS: The team has ALREADY confirmed viewing availability for this lead (requested: ${leadMeta.viewing_requested || 'a viewing'}). The lead is now confirming the time. Do NOT escalate again. Do NOT say "let me check with the team." Just acknowledge warmly, e.g. "You're all set for [time]! Our team will coordinate with you shortly." Then reply normally.`;
  } else if (leadMeta?.viewing_status === 'confirmed') {
    viewingContext = `\n\nVIEWING STATUS: A viewing is already confirmed for this lead. No need to discuss viewing scheduling further unless the lead brings it up again to change the time.`;
  }

  const systemPrompt = `${playbook}${portfolioContext}${viewingContext}

You are a warm, human WhatsApp sales agent for fäm Living. Lead: ${leadName}. Property: ${property}.

RULES — follow exactly, no exceptions:
- The Active fäm Living Portfolio above lists ALL live listings. Use it for any availability/options question. Never escalate for this.
- PORTFOLIO STRICT RULE: ONLY suggest or mention buildings that appear in the Active Portfolio list above with a price. If a building is not in that list, it is NOT currently available — do not mention it, do not suggest it, do not cross-sell it. Aykon City and any other building not in the list must never be suggested.
- PROPERTY CONTEXT RULE — CRITICAL: The "Property" field above tells you exactly which unit this lead enquired about. Always answer based on that specific property. If the Property field says "unknown property" or you cannot identify it, do NOT guess — instead say "Let me pull up the details for you" and [ESCALATE: cannot identify listing for lead ${leadName}].
- NO HALLUCINATION — CRITICAL: NEVER invent property details (bed type, building name, price, area) that are not explicitly in the Property field or the Active Portfolio. If you are not 100% certain of a detail, escalate. A wrong answer is worse than escalating.
- STAY ON TOPIC — CRITICAL: Only discuss topics the lead has actually brought up. NEVER introduce new subjects (pets, cleaning fees, policies, amenities, etc.) unless the lead explicitly asked about them. If the lead's message is unclear, ask a short clarifying question instead of guessing what they mean. Re-read their exact words before replying.
- NEVER BE CONDESCENDING: Do not say "I see the confusion here", "Let me clarify", "I think you mean", "Actually...", or anything that implies the lead is wrong or confused. If there is a misunderstanding, address it gently without pointing it out. Just answer what they asked.
- READ THE FULL CONVERSATION: Before replying, read the entire conversation history above carefully. Understand what the lead has said across ALL messages, not just the last one. If the lead corrected themselves (e.g. said "actually I want a studio not a 2BR"), act on the correction.
- OUTPUT FORMAT — CRITICAL: Output ONLY the reply message text. Absolutely zero reasoning, thinking, or internal monologue before or after.
- Your very first character must be part of the actual message to the customer.
- Never write "Let me", "I need to", "I should", "Looking at", or any self-reflection.
- TAGS MUST BE ON THEIR OWN LINE: [ESCALATE: ...] and [VIEWING: ...] tags must ALWAYS appear on their own line, separate from the customer message. Never embed a tag in the middle of a sentence. Put the tag on line 1 and the customer reply on line 2.
- If confident → reply directly.
- If NOT confident → [ESCALATE: reason] on line 1, short holding message on line 2.
- VIEWING: Viewings are available any day 9am-6pm. When a lead asks for a time within these hours, CONFIRM it. Output [VIEWING: property on day at time] on line 1, then a warm confirmation on line 2 (e.g. "12pm today works! Our team will coordinate with you shortly."). Do NOT say "let me check" or "let me confirm" — just confirm it. If the time is outside 9am-6pm, tell them viewings are 9am-6pm and ask for another time.
- CONTACT/AGENT REQUESTS: If a lead asks for a phone number or contact of the person they will meet, escalate immediately. [ESCALATE: lead requesting team member contact] on line 1, then "Our team member will reach out to you directly with their contact details." on line 2.
- Keep it short, warm, human.
- NEVER use em dashes (—) or en dashes in your replies. Use commas or periods instead. This is non-negotiable.
- PRICING MATH — CRITICAL: Prices are seasonal and only locked for 3 months at a time. NEVER calculate or quote a total for more than 3 months. If a lead asks about 4, 6, 12 months or a full year: quote the current monthly rate and say our rates are confirmed in 3-month blocks, you can lock in the current rate for the first 3 months, and for beyond that the rate depends on the season and you will need to confirm with the team. Then [ESCALATE: lead asking about long-term pricing beyond 3 months]. Do NOT multiply price by 12 or 6 or any number above 3.`;

  const userMessage = `Conversation so far:\n${history}\n\nLead just sent: "${newMessage}"`;

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 300, system: systemPrompt, messages: [{ role: 'user', content: userMessage }] }),
    });

    if (!r.ok) {
      const err = await r.text().catch(() => String(r.status));
      console.error('[auto-reply] Anthropic error:', r.status, err);
      return { reply: null, escalate: true, reason: `Anthropic ${r.status}` };
    }

    const d    = await r.json();
    const text = d?.content?.[0]?.text?.trim() || '';
    if (!text) return { reply: null, escalate: true, reason: 'Empty response' };

    // ── [ESCALATE:] detection — anywhere in the text, not just at the start ──
    // The AI sometimes puts the tag mid-sentence (e.g. "Let me check. [ESCALATE: reason]")
    // which previously leaked the raw tag to the customer.
    const escMatch = text.match(/\[ESCALATE:\s*([^\]]*)\]/i);
    if (escMatch) {
      const reason     = escMatch[1].trim();
      const holdingMsg = text.replace(/\[ESCALATE:\s*[^\]]*\]/i, '').trim()
                              .replace(/\s*\u2014\s*/g, ', ')
                              // Remove any line that was ONLY the tag
                              .split('\n').filter(l => l.trim()).join('\n').trim()
                           || "Let me check that for you and come back shortly!";
      return { reply: holdingMsg, escalate: true, reason, viewing: null };
    }

    // ── [VIEWING:] detection — anywhere in the text ──
    const viewMatch = text.match(/\[VIEWING:\s*([^\]]*)\]/i);
    if (viewMatch) {
      const when      = viewMatch[1].trim();
      const replyText = text.replace(/\[VIEWING:\s*[^\]]*\]/i, '').trim()
                             .replace(/\s*\u2014\s*/g, ', ')
                             .split('\n').filter(l => l.trim()).join('\n').trim()
                          || `${when} works! Our team will coordinate with you shortly.`;
      return { reply: replyText, escalate: false, reason: null, viewing: when };
    }

    // ── Safety net: strip any leftover brackets the AI might output ──
    // Catches partial tags like "[ESCAL..." or "[VIEW..." that could confuse the lead
    let cleanReply = text.replace(/\[(?:ESCALAT|VIEWING)[^\]]*\]?/gi, '').trim();

    // Strip em dashes — they're flagged in our style guide
    cleanReply = cleanReply.replace(/\s*\u2014\s*/g, ', ').replace(/\s*\u2013\s*/g, ', ').trim();
    return { reply: cleanReply, escalate: false, reason: null, viewing: null };

  } catch (err) {
    console.error('[auto-reply] Claude call failed:', err?.message);
    return { reply: null, escalate: true, reason: err?.message };
  }
}

// ── Main webhook handler ───────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (process.env.AUTOBOT_ENABLED !== 'true') {
    return res.status(200).json({ ok: true, skipped: 'Bot disabled (AUTOBOT_ENABLED != true)' });
  }

  const webhookSecret = process.env.TRENGO_WEBHOOK_SECRET;
  if (webhookSecret) {
    const providedSecret = req.query?.secret || '';
    if (providedSecret !== webhookSecret) {
      console.warn('[auto-reply] Invalid webhook secret');
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  let body = req.body;
  if (!body || typeof body === 'string') {
    try { body = JSON.parse(body); } catch { return res.status(400).json({ error: 'Invalid JSON' }); }
  }

  // RAW PAYLOAD LOG — saves incoming body to GitHub for debugging
  try {
    const ghTok = process.env.GH_TOKEN;
    const logData = { ts: new Date().toISOString(), query: req.query, body };
    const logB64 = Buffer.from(JSON.stringify(logData, null, 2)).toString('base64');
    let logSha = null;
    try {
      const lr = await fetch('https://api.github.com/repos/fam-pricing/fam-api/contents/data/webhook_capture.json', { headers: { Authorization: 'token ' + ghTok } });
      if (lr.ok) { const ld = await lr.json(); logSha = ld.sha; }
    } catch {}
    await fetch('https://api.github.com/repos/fam-pricing/fam-api/contents/data/webhook_capture.json', {
      method: 'PUT',
      headers: { Authorization: 'token ' + ghTok, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'log: incoming webhook', content: logB64, ...(logSha ? { sha: logSha } : {}) })
    });
  } catch (logErr) { console.warn('log failed', logErr.message); }

  // Trengo sends FLAT payloads: { ticket_id, message, contact_id, user_id, ... }
  // NOT nested { ticket: { id }, message: { body, type } }
  // We must handle both formats (flat = real Trengo, nested = curl tests / API calls)
  const isFlat = typeof body?.message === 'string' || body?.ticket_id != null;

  const ticketId = parseInt(body?.ticket?.id      // nested test format
                || body?.ticket_id               // flat Trengo format — Trengo sends as STRING
                || body?.message?.ticket_id
                || 0) || null;

  const messageText = (isFlat ? (body?.message || '') : '')  // flat: body.message IS the text
                    || body?.message?.message                  // nested variants
                    || body?.message?.body
                    || body?.message?.text
                    || '';

  // Flat inbound has no user_id; flat outbound has user_id (agent who sent it)
  const messageType = (body?.message?.type       // nested format
                    || body?.type
                    || (isFlat
                        ? (body?.user_id ? 'OUTBOUND' : 'INBOUND')
                        : '')
                    ).toUpperCase();

  console.log(`[auto-reply] ticket=${ticketId} type=${messageType} text="${String(messageText).substring(0,50)}" flat=${isFlat}`);

  if (!ticketId) return res.status(200).json({ ok: true, skipped: 'No ticket ID' });

  // ── Check if this is Faysal's teaching reply ──────────────────────────────
  // Do this BEFORE the CRM lookup so we don't skip it as "not in CRM"
  if (messageType === 'INBOUND' && messageText) {
    const faysalTicketId = process.env.FAYSAL_TICKET_ID
      ? parseInt(process.env.FAYSAL_TICKET_ID, 10)
      : null;

    // Also check persisted ticket ID if env not set
    if (!faysalTicketId) {
      const { esc } = await readPendingEsc();
      if (esc.faysal_ticket_id && ticketId == esc.faysal_ticket_id) {
        await handleFaysalTeachingReply(ticketId, messageText);
        return res.status(200).json({ ok: true, action: 'faysal_teaching_reply' });
      }
    } else if (ticketId == faysalTicketId) {
      await handleFaysalTeachingReply(ticketId, messageText);
      return res.status(200).json({ ok: true, action: 'faysal_teaching_reply' });
    }
  }

  // Load CRM state
  const { state: crmState, sha } = await readCRMState();
  const leadId   = Object.keys(crmState).find(k => String(crmState[k].trengo_ticket_id) === String(ticketId));
  if (!leadId) return res.status(200).json({ ok: true, skipped: 'Ticket not in CRM' });

  // ── Owner phone guard ──────────────────────────────────────────────────────
  // If this ticket belongs to Faysal's own phone number, treat as teaching — never as a lead.
  const OWNER_PHONE = process.env.OWNER_PHONE || '971502725428';
  const leadPhone = crmState[leadId]?.pf_phone || '';
  if (leadPhone === OWNER_PHONE) {
    if (messageType === 'INBOUND' && messageText) {
      const faysalTicketId = process.env.FAYSAL_TICKET_ID ? parseInt(process.env.FAYSAL_TICKET_ID, 10) : null;
      await handleFaysalTeachingReply(faysalTicketId || ticketId, messageText);
    }
    return res.status(200).json({ ok: true, action: 'owner_phone_guard' });
  }

  const leadMeta = crmState[leadId];
  const leadName = leadMeta.lead_name || 'there';

  // ── OUTBOUND (agent reply — Afifa is speaking) ─────────────────────────────
  if (messageType === 'OUTBOUND' && messageText) {
    crmState[leadId].last_agent_reply_at = new Date().toISOString();
    await learnFromAfifaReply(ticketId, messageText, leadMeta, crmState, leadId, sha);
    return res.status(200).json({ ok: true, action: 'agent_reply_tracked' });
  }

  // ── INBOUND (lead is speaking) ─────────────────────────────────────────────
  if (messageType !== 'INBOUND') {
    return res.status(200).json({ ok: true, skipped: `Message type ${messageType} ignored` });
  }

  if (!messageText) return res.status(200).json({ ok: true, skipped: 'Empty message' });

  // ── Auto-responder detection — skip WhatsApp Business auto-replies ──────────
  // Fires when we message a lead who has a WA Business auto-responder set up.
  // Their phone instantly replies with a canned message. We should ignore it silently.
  const AUTO_RESPONDER_PATTERNS = [
    /thank you for (your message|contacting|reaching out)/i,
    /we('re| are) (currently )?(unavailable|away|offline|out of office)/i,
    /we will (respond|get back|reply).{0,40}(soon|as soon as possible|shortly)/i,
    /how (may|can) (i|we) help you/i,
    /this is an? (auto(mated)?|automatic) (reply|response|message)/i,
    /i('m| am) (currently )?unavailable/i,
    /please (leave|send) (a message|your (details|enquiry))/i,
    /our (team|staff|office) (will|is)/i,
  ];
  const isAutoResponder = AUTO_RESPONDER_PATTERNS.some(p => p.test(messageText));
  if (isAutoResponder) {
    console.log(`[auto-reply] Auto-responder detected on ticket ${ticketId} — skipping silently`);
    return res.status(200).json({ ok: true, skipped: 'Auto-responder detected' });
  }

  const dubaiHour = getDubaiHour();
  console.log(`[auto-reply] Inbound on ticket ${ticketId} | Dubai hour: ${dubaiHour} | Bot: 24/7 active`);

  // BOT RUNS 24/7

  if (leadMeta.bot_paused) {
    return res.status(200).json({ ok: true, skipped: 'Bot paused for this lead' });
  }

  const lastAgentAt = leadMeta.last_agent_reply_at ? new Date(leadMeta.last_agent_reply_at).getTime() : 0;
  if (Date.now() - lastAgentAt < AGENT_COOLDOWN_MS) {
    return res.status(200).json({ ok: true, skipped: 'Agent cooldown active' });
  }

  // Per-ticket bot cooldown: 5s blocks truly duplicate simultaneous webhooks only.
  // message_id deduplication above already handles true duplicates; this just covers
  // the rare case Trengo fires the same event twice within seconds with no message_id.
  const lastBotAt = leadMeta.last_bot_reply_at ? new Date(leadMeta.last_bot_reply_at).getTime() : 0;
  const BOT_COOLDOWN_MS = 5 * 1000; // 5 seconds — deduplicates same-second duplicates without blocking real follow-ups
  if (Date.now() - lastBotAt < BOT_COOLDOWN_MS) {
    return res.status(200).json({ ok: true, skipped: 'Bot cooldown — replied too recently' });
  }

  // Message-ID deduplication: skip if this exact message was already processed
  // (prevents double-reply when Trengo fires the same webhook twice)
  const incomingMsgId = String(body?.message_id || body?.message?.id || '');
  if (incomingMsgId && leadMeta.last_processed_message_id === incomingMsgId) {
    return res.status(200).json({ ok: true, skipped: `Duplicate message_id ${incomingMsgId}` });
  }

  const conversation = await getTrengoMessages(ticketId);

  // Short read pause + random jitter to desynchronize concurrent webhooks
  const jitter = Math.floor(Math.random() * READ_DELAY_JITTER);
  await new Promise(r => setTimeout(r, READ_DELAY_BASE + jitter));
  console.log(`[auto-reply] Read delay: ${READ_DELAY_BASE + jitter}ms (jitter: ${jitter}ms)`);

  // ── Live agent guard — check Trengo thread for recent agent reply ──────────
  // Prevents bot from piling on after Afifa or Faysal already responded.
  const agentAlreadyReplied = await hasRecentAgentReplyInTrengo(ticketId);
  if (agentAlreadyReplied) {
    crmState[leadId].last_agent_reply_at = new Date().toISOString(); // sync CRM
    await writeCRMState(crmState, sha);
    console.log(`[auto-reply] Live agent guard triggered on ticket ${ticketId} — agent replied recently, bot standing down`);
    return res.status(200).json({ ok: true, skipped: 'Agent replied recently in Trengo — bot standing down', dubaiHour });
  }

  const { reply, escalate, reason, viewing } = await generateReply(conversation, leadMeta, messageText, leadName);

  if (escalate) {
    if (reply) {
      // Simulate typing the holding message before sending
      const holdingDelay = Math.min(6000, Math.max(2000, reply.length * 30));
      await new Promise(r => setTimeout(r, holdingDelay));
      await postTrengoMessage(ticketId, reply);
    }
    // Track viewing status in CRM so we don't re-escalate when lead confirms
    if (viewing) {
      crmState[leadId].viewing_status    = 'escalated';
      crmState[leadId].viewing_requested = viewing;
    }
    await escalateToFaysal(leadName, leadMeta.listing_title, messageText, ticketId, crmState, leadId, sha);
    await writeCRMState(crmState, sha);
    return res.status(200).json({ ok: true, action: 'escalated', reason });
  }

  // Simulate human typing speed (~3 chars/sec on mobile WhatsApp)
  // 2s read time already elapsed above; now add typing time for the reply
  const typingMs = Math.min(10000, Math.max(3000, reply.length * 40)); // Capped at 10s to stay within Vercel 30s function limit
  await new Promise(r => setTimeout(r, typingMs));

  // ── Optimistic lock: re-read CRM to detect if another instance already replied ──
  // Two webhooks can arrive simultaneously, both pass cooldown, both generate replies.
  // By re-checking here (after delays + AI call), the slower one will see the faster
  // one already updated last_bot_reply_at and bail out instead of double-replying.
  try {
    const { state: freshCRM } = await readCRMState();
    const freshMeta = freshCRM[leadId];
    if (freshMeta) {
      const freshBotAt = freshMeta.last_bot_reply_at ? new Date(freshMeta.last_bot_reply_at).getTime() : 0;
      if (freshBotAt > lastBotAt) {
        console.log(`[auto-reply] OPTIMISTIC LOCK: another instance replied while we were generating. Bailing out.`);
        return res.status(200).json({ ok: true, skipped: 'Optimistic lock — another instance replied first' });
      }
      if (freshMeta.bot_paused) {
        console.log(`[auto-reply] OPTIMISTIC LOCK: bot was paused while generating. Bailing out.`);
        return res.status(200).json({ ok: true, skipped: 'Bot paused during generation' });
      }
    }
  } catch (e) {
    console.warn('[auto-reply] Optimistic lock check failed, proceeding anyway:', e?.message);
  }

  const sent = await postTrengoMessage(ticketId, reply);

  // Viewing auto-confirmed — post internal note for Afifa to coordinate access
  if (viewing) {
    const property = leadMeta?.listing_title || 'the property';
    const note =
      `📅 VIEWING CONFIRMED BY BOT\n\n` +
      `Lead: ${leadName}\n` +
      `Property: ${property}\n` +
      `When: ${viewing}\n\n` +
      `Bot confirmed with lead. Please coordinate key access and meet the lead.\n\n` +
      `@afifa340123 @chahana470168 @junaid731578 @farhan731560 @abdul315306\n\n` +
      `— fäm Bot`;
    await postTrengoNote(ticketId, note);
    await attachTrengoLabel(ticketId, LABEL_VIEWING);
    crmState[leadId].viewing_status    = 'confirmed';
    crmState[leadId].viewing_requested = viewing;
    console.log('[auto-reply] Viewing CONFIRMED + label for', leadName, viewing);
  }

  // Attach "Lead" label on first bot reply to this ticket
  const isFirstBotReply = !leadMeta.bot_reply_count || leadMeta.bot_reply_count === 0;
  if (isFirstBotReply) {
    await attachTrengoLabel(ticketId, LABEL_LEAD);
  }

  crmState[leadId].lead_replied              = true;
  crmState[leadId].lead_replied_at           = new Date().toISOString();
  crmState[leadId].last_bot_reply_at         = new Date().toISOString();
  crmState[leadId].bot_reply_count           = (leadMeta.bot_reply_count || 0) + 1;
  if (incomingMsgId) crmState[leadId].last_processed_message_id = incomingMsgId;

  // If viewing was team_responded and bot just replied normally (not escalating), mark confirmed
  if (leadMeta.viewing_status === 'team_responded') {
    crmState[leadId].viewing_status = 'confirmed';
    console.log(`[auto-reply] Viewing status → confirmed for ${leadName}`);
  }

  await writeCRMState(crmState, sha);

  return res.status(200).json({ ok: true, action: 'replied', sent, dubaiHour, viewing: viewing || null });
}
