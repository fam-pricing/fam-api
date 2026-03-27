// fäm Living — POST /api/crm/auto-reply
// Trengo webhook handler for both INBOUND (lead) and OUTBOUND (agent) messages.
//
// Night shift mode (9 PM – 6 AM Dubai time):
//   INBOUND → AI reads message, generates reply, posts back via Trengo
//   Bot escalates to Faysal when unsure:
//     → sends WhatsApp to Faysal via Trengo (FAYSAL_TICKET_ID)
//     → stores Q in pending_escalations.json
//     → Faysal replies on WhatsApp → bot learns, updates playbook, follows up with lead
//
// Day shift (6 AM – 9 PM Dubai):
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

const DUBAI_OFFSET_HOURS = 4;
const NIGHT_START = 21;
const NIGHT_END   = 6;

const REPLY_DELAY_MS    = 3000;
const AGENT_COOLDOWN_MS = 15 * 60 * 1000;

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

async function postTrengoNote(ticketId, note) {
  const token = process.env.TRENGO_TOKEN;
  try {
    await fetch(`${TRENGO_API}/tickets/${ticketId}/notes`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ message: note }),
    });
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
  const note = `🤖 Night bot couldn't answer (${dubaiTime}):\n\n"${question}"\n\nFaysal notified via WhatsApp. Reply to this lead if Faysal doesn't respond before your shift.`;
  await postTrengoNote(trengoTicketId, note);

  console.log(`[auto-reply] Escalated "${question}" to Faysal (escId: ${escId})`);
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
    // No pending questions — treat this as a direct playbook teaching
    if (cleanAnswer) {
      const newRule = `- ${cleanAnswer}\n  (Taught directly by Faysal)`;
      await appendToPlaybook(newRule);
      // Increment direct teachings counter so dashboard shows it
      esc.direct_teachings_count = (esc.direct_teachings_count || 0) + 1;
      await writePendingEsc(esc, escSha);
      await postTrengoMessage(faysalTicketId,
        `✅ *Playbook updated!*\n\n📝 "${cleanAnswer}"\n\nI'll apply this going forward. Send another rule anytime — or I'll ping you here when I get stuck with a lead 📚`);
    } else {
      await postTrengoMessage(faysalTicketId, `Hey! No pending questions right now. Send me a rule to add to my playbook anytime 📚`);
    }
    return;
  }

  // There ARE pending questions — Faysal's message answers the current one
  const current = pending.sort((a, b) => new Date(b.escalated_at) - new Date(a.escalated_at))[0];

  console.log(`[auto-reply] Faysal answered Q: "${current.question}" → "${answer}"`);

  // Update playbook with the Q&A rule
  const newRule = `- If a lead asks: "${current.question}" → Reply: "${cleanAnswer || answer}"\n  (Taught by Faysal for ${current.lead_name} re ${current.property})`;
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

// ── Claude AI reply ───────────────────────────────────────────────────────────

async function generateReply(conversation, leadMeta, newMessage, leadName) {
  const apiKey  = process.env.ANTHROPIC_API_KEY;
  const playbook = await loadPlaybook();

  if (!apiKey) return { reply: null, escalate: true, reason: 'No API key' };

  const history = conversation
    .slice(-10)
    .filter(m => m.message || m.body || m.text)
    .map(m => {
      const isInbound = m.type?.toUpperCase() === 'INBOUND';
      return `${isInbound ? leadName : 'Agent'}: ${(m.message || m.body || m.text || '').trim()}`;
    })
    .join('\n');

  const property = leadMeta?.listing_title || 'the property';

  const prompt = `${playbook}

---

You are handling a WhatsApp conversation for fäm Living. Lead name: ${leadName}. Property enquiry: ${property}.

Conversation so far:
${history}

The lead just sent:
"${newMessage}"

Instructions:
- Reply naturally as a warm human team member on WhatsApp. Short, friendly, direct.
- Follow ALL rules in the playbook above — pricing, discounts, tone, cross-sell, etc.
- If confident: output ONLY the message to send. Nothing else. No labels.
- If NOT confident (don't know price, availability, a specific detail): output [ESCALATE: reason] on line 1, then the holding message on line 2 (e.g. "Let me check that for you and come back shortly! 😊").

Sound human. Never sound like AI.`;

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 300, messages: [{ role: 'user', content: prompt }] }),
    });

    if (!r.ok) {
      const err = await r.text().catch(() => String(r.status));
      console.error('[auto-reply] Anthropic error:', r.status, err);
      return { reply: null, escalate: true, reason: `Anthropic ${r.status}` };
    }

    const d    = await r.json();
    const text = d?.content?.[0]?.text?.trim() || '';
    if (!text) return { reply: null, escalate: true, reason: 'Empty response' };

    if (text.startsWith('[ESCALATE:')) {
      const lines      = text.split('\n');
      const reason     = lines[0].replace('[ESCALATE:', '').replace(']', '').trim();
      const holdingMsg = lines.slice(1).join('\n').trim() || "Let me check that for you and come back shortly! 😊";
      return { reply: holdingMsg, escalate: true, reason };
    }

    return { reply: text, escalate: false, reason: null };

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

  // Trengo sends FLAT payloads: { ticket_id, message, contact_id, user_id, ... }
  // NOT nested { ticket: { id }, message: { body, type } }
  // We must handle both formats (flat = real Trengo, nested = curl tests / API calls)
  const isFlat = typeof body?.message === 'string' || body?.ticket_id != null;

  const ticketId = body?.ticket?.id              // nested test format
                || body?.ticket_id               // flat Trengo format  ← KEY FIX
                || body?.message?.ticket_id
                || null;

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
  const leadId   = Object.keys(crmState).find(k => crmState[k].trengo_ticket_id === ticketId);
  if (!leadId) return res.status(200).json({ ok: true, skipped: 'Ticket not in CRM' });

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

  const nightShift = isNightShift();
  const dubaiHour  = getDubaiHour();
  console.log(`[auto-reply] Inbound on ticket ${ticketId} | Dubai hour: ${dubaiHour} | Night shift: ${nightShift}`);

  // DAY SHIFT — Afifa is on
  if (!nightShift) {
    crmState[leadId].lead_replied    = true;
    crmState[leadId].lead_replied_at = new Date().toISOString();
    await writeCRMState(crmState, sha);
    return res.status(200).json({ ok: true, skipped: 'Day shift — Afifa handles', dubaiHour });
  }

  // NIGHT SHIFT — bot is on

  if (leadMeta.bot_paused) {
    return res.status(200).json({ ok: true, skipped: 'Bot paused for this lead' });
  }

  const lastAgentAt = leadMeta.last_agent_reply_at ? new Date(leadMeta.last_agent_reply_at).getTime() : 0;
  if (Date.now() - lastAgentAt < AGENT_COOLDOWN_MS) {
    return res.status(200).json({ ok: true, skipped: 'Agent cooldown active' });
  }

  const conversation = await getTrengoMessages(ticketId);
  await new Promise(r => setTimeout(r, REPLY_DELAY_MS));
  const { reply, escalate, reason } = await generateReply(conversation, leadMeta, messageText, leadName);

  if (escalate) {
    if (reply) await postTrengoMessage(ticketId, reply);
    await escalateToFaysal(leadName, leadMeta.listing_title, messageText, ticketId, crmState, leadId, sha);
    await writeCRMState(crmState, sha);
    return res.status(200).json({ ok: true, action: 'escalated', reason });
  }

  const sent = await postTrengoMessage(ticketId, reply);

  crmState[leadId].lead_replied       = true;
  crmState[leadId].lead_replied_at    = new Date().toISOString();
  crmState[leadId].last_bot_reply_at  = new Date().toISOString();
  crmState[leadId].bot_reply_count    = (leadMeta.bot_reply_count || 0) + 1;
  await writeCRMState(crmState, sha);

  return res.status(200).json({ ok: true, action: 'replied', sent, dubaiHour });
}
