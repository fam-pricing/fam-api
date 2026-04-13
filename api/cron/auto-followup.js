// fäm Living — Cron: AI-powered follow-ups for silent leads
// Runs every hour via Vercel Cron.
//
// TWO SYSTEMS — both now use Claude Sonnet for contextual, human-sounding messages:
//
// 1. INITIAL FOLLOW-UPS (leads who never replied after auto-response):
//   All delays measured from auto_responded_at (initial message sent time).
//   All 3 follow-ups must land within 24h to stay inside the WhatsApp session window.
//   - Follow-up #1:  6h — SOFT_HELPFUL (acknowledge interest, mention property specifics)
//   - Follow-up #2: 12h — VALUE_ADD (suggest viewing, mention availability, share useful detail)
//   - Follow-up #3: 23h — GENTLE_URGENCY (last message, light scarcity, door always open)
//   AI generates each message using CRM data (building, bed type, lead quality signals).
//   Fallback to static templates if AI fails. After 3 follow-ups → mark cold, stop.
//   If lead replies at any point → all follow-ups cancelled.
//
// 2. SMART CONTEXTUAL FOLLOW-UP (leads who engaged then went quiet):
//   For leads who DID reply at least once but then went quiet.
//   Triggers 4h after the last bot/agent reply if lead hasn't responded.
//   AI reads full conversation + buying stage + lead quality → decides IF follow-up
//   makes sense and writes a message that picks up where the conversation left off.
//   Different strategies for READY_TO_BOOK vs OBJECTING vs INTERESTED leads.
//   One-time only per lead. Never fires if bot is paused or stage is viewing/closed/lost.

import { readCRMState, writeCRMState, ghRead, TRENGO_API, CRM_FILE, REF_MAP_FILE } from '../../lib/crm.js';

// All measured from auto_responded_at (initial message time)
const FOLLOW_UP_1_DELAY_MS =  6 * 60 * 60 * 1000;  //  6 hours
const FOLLOW_UP_2_DELAY_MS = 12 * 60 * 60 * 1000;  // 12 hours
const FOLLOW_UP_3_DELAY_MS = 23 * 60 * 60 * 1000;  // 23 hours (last chance before window closes)

// readCRMState / writeCRMState — imported from lib/crm.js (Redis primary, GitHub fallback)

// ── GitHub JSON helper ────────────────────────────────────────────────────────

async function fetchGHJson(filePath) {
  const { data } = await ghRead(filePath);
  return data || {};
}

// ── Trengo helpers ────────────────────────────────────────────────────────────

// Returns timestamp of the last INBOUND message, or null if none
async function getLastInboundTime(ticketId) {
  const token = process.env.TRENGO_TOKEN;
  if (!token || !ticketId) return null;
  try {
    const r = await fetch(`${TRENGO_API}/tickets/${ticketId}/messages`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    if (!r.ok) return null;
    const d = await r.json();
    const messages = d.data || d.messages || [];
    const inbound = messages.filter(m => m.type?.toUpperCase() === 'INBOUND');
    if (!inbound.length) return null;
    // Sort descending — get most recent inbound
    inbound.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
    return inbound[0].created_at || null;
  } catch {
    return null;
  }
}

// Send a plain text WhatsApp message (session already open from pf3 template)
async function sendFollowUpMessage(ticketId, message) {
  const token = process.env.TRENGO_TOKEN;
  if (!token || !ticketId) return false;
  try {
    const r = await fetch(`${TRENGO_API}/tickets/${ticketId}/messages`, {
      method:  'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ message, type: 'OUTBOUND' }),
    });
    const d = await r.json();
    if (!r.ok) {
      console.error('[followup] message send failed:', r.status, JSON.stringify(d));
      return false;
    }
    console.log('[followup] message sent to ticket', ticketId);
    return true;
  } catch (err) {
    console.error('[followup] send error:', err.message);
    return false;
  }
}

// ── AI-powered contextual follow-up generator ────────────────────────────────
// Replaces hardcoded generic messages with Claude-generated, context-aware follow-ups.
// Uses CRM data (property, building, bed type, quality signals) to craft messages
// that feel personal and reference what the lead actually enquired about.

// Fallback templates — used if AI generation fails (network, quota, etc.)
function buildFallbackMessage(followUpNumber, leadName, listingTitle) {
  const name = leadName ? ` ${leadName.split(' ')[0]}` : '';
  const prop = listingTitle || 'the property';
  if (followUpNumber === 1) {
    return `Hi${name}, just checking in on your enquiry about ${prop}. Still available if you have any questions.`;
  }
  if (followUpNumber === 2) {
    return `Hi${name}, wanted to follow up one more time. We can arrange a viewing at your convenience. Let us know.`;
  }
  return `Hi${name}, last message from our side. If you're still interested in ${prop}, we're here. Happy to help whenever you're ready.`;
}

// Strategy per follow-up number:
//   #1 (6h)  — Soft, helpful: acknowledge their interest, mention specific property details, offer help
//   #2 (12h) — Value-add: mention viewings, share something useful about the property/area
//   #3 (23h) — Gentle urgency: last chance within the 24h window, light scarcity
const FOLLOWUP_STRATEGIES = {
  1: 'SOFT_HELPFUL',   // "Saw your interest in X, happy to answer questions about it"
  2: 'VALUE_ADD',      // "We can arrange a viewing, the unit has X, area is great for Y"
  3: 'GENTLE_URGENCY', // "Last follow-up — the unit is getting interest, let us know if you'd like to see it"
};

async function generateContextualFollowUp(followUpNumber, lead, refMapping) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return buildFallbackMessage(followUpNumber, lead.lead_name, lead.listing_title);

  const firstName = lead.lead_name ? lead.lead_name.split(' ')[0] : null;
  const strategy  = FOLLOWUP_STRATEGIES[followUpNumber] || 'SOFT_HELPFUL';

  // Enrich from ref_mapping if listing_title is a PF ref or URL
  let building = null;
  let bedType  = null;
  const listingRef = lead.listing_ref || null;
  if (listingRef && refMapping[listingRef]) {
    building = refMapping[listingRef].building;
    bedType  = refMapping[listingRef].bed_type;
  }
  // If listing_title contains "in" pattern like "2BR in Grande", parse it
  if (!building && lead.listing_title) {
    const inMatch = lead.listing_title.match(/(.+?)\s+in\s+(.+)/i);
    if (inMatch) {
      bedType  = bedType  || inMatch[1].trim();
      building = building || inMatch[2].trim();
    }
  }

  const leadContext = [
    firstName ? `Lead name: ${firstName}` : 'Lead name: unknown',
    building  ? `Building: ${building}` : null,
    bedType   ? `Unit type: ${bedType}` : null,
    lead.listing_title ? `Listing: ${lead.listing_title}` : null,
    lead.lead_quality_label ? `Lead quality: ${lead.lead_quality_label}` : null,
    lead.lead_quality_signals?.length ? `Signals: ${lead.lead_quality_signals.join(', ')}` : null,
  ].filter(Boolean).join('\n');

  const strategyInstructions = {
    SOFT_HELPFUL: `This is the FIRST follow-up (6h after enquiry). Be soft and helpful.
- Acknowledge their specific interest (mention the building/unit type if known)
- Let them know you're available for questions
- Keep it casual and warm, like a helpful friend not a salesperson
- If you know the building, you can mention one appealing fact (e.g., "great views", "fully furnished", "walking distance to metro")`,
    VALUE_ADD: `This is the SECOND follow-up (12h after enquiry). Add value.
- Offer something concrete: suggest a viewing, mention availability
- If you know the unit type, reference it specifically
- Be slightly more direct — they've had time to think
- Example angles: "We have availability for viewings this week", "The unit is fully furnished and move-in ready"`,
    GENTLE_URGENCY: `This is the THIRD and FINAL follow-up (23h, last message before WhatsApp window closes). Create gentle urgency.
- Make it clear this is your last message (don't be pushy, be respectful)
- Light scarcity: "getting interest from others" or "won't be available long"
- Leave the door open: "whenever you're ready, we're here"
- Keep it dignified — not desperate, not guilt-tripping`,
  };

  const prompt = `You are writing a WhatsApp follow-up message for fäm Living, a premium Dubai holiday home rental company.

LEAD CONTEXT:
${leadContext}

STRATEGY: ${strategy}
${strategyInstructions[strategy]}

RULES:
- Write ONE short WhatsApp message (1-3 sentences max)
- Sound human, warm, professional — like a real estate agent who cares, not a bot
- Use the lead's first name if known
- Reference the specific property/building/unit type if known — NEVER say "the property" if you have specifics
- NO emojis, NO exclamation marks overload, NO all-caps
- NO em dashes (—), use commas or periods instead
- Do NOT mention price or discounts
- Do NOT say "I hope this message finds you well" or any cliché opener
- If you don't know the building name, keep it general but still warm
- Output ONLY the message text, nothing else — no quotes, no prefix, no explanation`;

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 200,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!r.ok) {
      console.error('[followup] AI generation failed:', r.status);
      return buildFallbackMessage(followUpNumber, lead.lead_name, lead.listing_title);
    }
    const d = await r.json();
    let message = (d?.content?.[0]?.text || '').trim();
    // Strip em dashes that AI might sneak in
    message = message.replace(/\s*\u2014\s*/g, ', ');
    // Strip quotes if AI wrapped them
    message = message.replace(/^["']|["']$/g, '').trim();

    if (!message || message.length < 10) {
      return buildFallbackMessage(followUpNumber, lead.lead_name, lead.listing_title);
    }

    console.log(`[followup] AI generated follow-up #${followUpNumber} for ${lead.lead_name}: "${message}"`);
    return message;
  } catch (err) {
    console.error('[followup] AI generation error:', err.message);
    return buildFallbackMessage(followUpNumber, lead.lead_name, lead.listing_title);
  }
}

// ── Smart contextual follow-up ────────────────────────────────────────────────
// Reads full Trengo thread, uses AI to decide if a follow-up makes sense and what to say.
// Returns { send: true, message: '...' } or { send: false }

const SMART_FOLLOWUP_DELAY_MS = 4 * 60 * 60 * 1000; // 4 hours of silence = follow-up candidate

async function getTrengoThread(ticketId) {
  const token = process.env.TRENGO_TOKEN;
  if (!token || !ticketId) return [];
  try {
    const r = await fetch(`${TRENGO_API}/tickets/${ticketId}/messages`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    if (!r.ok) return [];
    const d = await r.json();
    return d.data || d.messages || [];
  } catch { return []; }
}

// Detect buying stage from conversation (same logic as auto-reply.js)
function detectBuyingStageFromMessages(messages) {
  const inboundMsgs = messages.filter(m =>
    (m.type || '').toUpperCase() === 'INBOUND' && !m.internal_note
  );
  const allText = inboundMsgs
    .map(m => (m.message || m.body || '').toLowerCase())
    .join(' ');
  const msgCount = inboundMsgs.length;

  if (/pay(ment)?|transfer|card|cash|contract|sign|move.?in|check.?in|when can i|start date|keys/.test(allText))
    return 'READY_TO_BOOK';
  if (/budget|too (much|expensive|high)|can('t| not) afford|over.?budget|cheaper|lower price/.test(allText))
    return 'OBJECTING';
  if (/view(ing)?|visit|see (the|it)|deposit|document|process|what('s| is) next|book(ing)?|reserve|lock.?in/.test(allText))
    return 'ENGAGED';
  if (/price|how much|availab|bed|bedroom|\bbr\b|studio|area|building|option|what.*have|do you have/.test(allText))
    return 'INTERESTED';
  if (msgCount <= 2) return 'BROWSING';
  return 'INTERESTED';
}

const SMART_STAGE_HINTS = {
  BROWSING:      'Lead is early-stage, just browsing. Keep it very light and low-pressure.',
  INTERESTED:    'Lead showed interest (asked about price/availability). Reference what they asked about.',
  ENGAGED:       'Lead was actively engaged (viewings, documents, next steps). Nudge them back to the action they were considering.',
  READY_TO_BOOK: 'Lead was nearly ready to book. This is high priority, gently remind them of the next step they need to take.',
  OBJECTING:     'Lead had budget concerns. Do NOT push price. Instead, offer flexibility (different units, longer stays for better rates).',
};

async function generateSmartFollowUp(messages, lead, refMapping) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { send: false };

  const leadName    = lead.lead_name || 'there';
  const listingTitle = lead.listing_title || 'a property';

  // Build readable conversation history
  const history = messages
    .filter(m => !m.internal_note && (m.message || m.body))
    .sort((a, b) => new Date(a.created_at || 0) - new Date(b.created_at || 0))
    .map(m => {
      const isInbound = (m.type || '').toUpperCase() === 'INBOUND';
      const text = (m.message || m.body || '').trim();
      return `${isInbound ? leadName : 'Agent'}: ${text}`;
    })
    .join('\n');

  if (!history) return { send: false };

  // Enrich with CRM intelligence
  const buyingStage = detectBuyingStageFromMessages(messages);
  const stageHint   = SMART_STAGE_HINTS[buyingStage] || '';
  const qualityLabel = lead.lead_quality_label || null;

  // Enrich from ref_mapping
  let building = null, bedType = null;
  const listingRef = lead.listing_ref || null;
  if (listingRef && refMapping && refMapping[listingRef]) {
    building = refMapping[listingRef].building;
    bedType  = refMapping[listingRef].bed_type;
  }

  const contextLines = [
    `Lead: ${leadName}`,
    `Property: ${listingTitle}`,
    building ? `Building: ${building}` : null,
    bedType  ? `Unit type: ${bedType}` : null,
    `Buying stage: ${buyingStage}`,
    qualityLabel ? `Lead quality: ${qualityLabel}` : null,
    lead.lead_quality_signals?.length ? `Signals: ${lead.lead_quality_signals.join(', ')}` : null,
  ].filter(Boolean).join('\n');

  const prompt = `You are a WhatsApp sales agent for fäm Living, a premium Dubai holiday home rental company.

Below is a conversation with a lead. They engaged but went quiet — the last message was from the Agent, and the lead hasn't replied in 4+ hours.

LEAD CONTEXT:
${contextLines}

STAGE HINT: ${stageHint}

CONVERSATION:
${history}

TASK: Decide if a contextual follow-up message should be sent, and if so, write it.

DECISION RULES:
- Send ONLY if the conversation ended with an open question or the ball is clearly in the lead's court
- Do NOT send if: lead said not interested, lead asked for time and it's too soon, viewing is confirmed, or conversation reached a natural close
- ${buyingStage === 'READY_TO_BOOK' ? 'PRIORITY: This lead was close to booking. A well-crafted follow-up here is high value.' : ''}
- ${buyingStage === 'OBJECTING' ? 'CAUTION: Lead had budget concerns. Do NOT push on price. Offer alternatives or flexibility.' : ''}

MESSAGE RULES (if sending):
- Write ONE short warm WhatsApp message (1-3 sentences max)
- Reference the ACTUAL conversation, not generic "still interested?"
- Show you read what they said — pick up from where the conversation left off
- Sound human, warm, professional
- NO emojis, NO em dashes, NO exclamation mark overload
- Never mention price or discount unless the lead brought it up last
- Use the lead's first name

Respond in exactly one of these two formats:
NO
(if no follow-up needed)

YES: [your follow-up message here]
(if follow-up is appropriate)`;

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 200,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!r.ok) return { send: false };
    const d = await r.json();
    const text = (d?.content?.[0]?.text || '').trim();

    if (text.startsWith('YES:')) {
      let message = text.replace(/^YES:\s*/i, '').replace(/\s*\u2014\s*/g, ', ').trim();
      message = message.replace(/^["']|["']$/g, '').trim();
      return { send: true, message };
    }
    return { send: false };
  } catch {
    return { send: false };
  }
}

// ── Main handler ──────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = req.headers.authorization || '';
    if (auth !== `Bearer ${cronSecret}`) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  try {
    const [{ state: crmState, sha: initialSha }, refMapping] = await Promise.all([
      readCRMState(),
      fetchGHJson(REF_MAP_FILE),
    ]);
    let sha = initialSha;
    const now = Date.now();
    const results = { sent_followup_1: [], sent_followup_2: [], skipped_replied: [], skipped_cold: [], errors: [] };
    let changed = false;

    for (const [leadId, lead] of Object.entries(crmState)) {
      // Only process leads that have been auto-responded with a Trengo ticket
      if (!lead.auto_responded || !lead.trengo_ticket_id) continue;
      // Skip leads already marked cold
      if (lead.follow_up_cold) { results.skipped_cold.push(leadId); continue; }
      // Skip leads where bot is paused (Faysal/team manually handling)
      if (lead.bot_paused) { results.skipped_cold.push(leadId); continue; }

      const ticketId     = lead.trengo_ticket_id;
      const respondedAt  = new Date(lead.auto_responded_at).getTime();
      const followUpCount = lead.follow_up_count || 0;

      // Check if lead has replied via Trengo since we last messaged
      const lastInboundTime = await getLastInboundTime(ticketId);
      const leadReplied = !!lastInboundTime;

      if (leadReplied) {
        // Lead replied — no follow-up needed. Store flag so we stop checking.
        if (!lead.lead_replied) {
          crmState[leadId].lead_replied = true;
          crmState[leadId].lead_replied_at = lastInboundTime;
          changed = true;
        }
        results.skipped_replied.push(leadId);
        continue;
      }

      // All delays measured from respondedAt to stay inside the 24h WhatsApp window

      // ── Follow-up #1 — 6h (soft, helpful) ──────────────────────────────────
      if (followUpCount === 0 && now - respondedAt >= FOLLOW_UP_1_DELAY_MS) {
        const msg = await generateContextualFollowUp(1, lead, refMapping);
        const ok  = await sendFollowUpMessage(ticketId, msg);
        if (ok) {
          crmState[leadId].follow_up_count   = 1;
          crmState[leadId].follow_up_1_at    = new Date().toISOString();
          crmState[leadId].follow_up_1_msg   = msg;
          changed = true;
          results.sent_followup_1.push(leadId);
        } else {
          results.errors.push({ leadId, step: 'followup_1' });
        }
        continue;
      }

      // ── Follow-up #2 — 12h (value-add, suggest viewing) ───────────────────
      if (followUpCount === 1 && now - respondedAt >= FOLLOW_UP_2_DELAY_MS) {
        const msg = await generateContextualFollowUp(2, lead, refMapping);
        const ok  = await sendFollowUpMessage(ticketId, msg);
        if (ok) {
          crmState[leadId].follow_up_count   = 2;
          crmState[leadId].follow_up_2_at    = new Date().toISOString();
          crmState[leadId].follow_up_2_msg   = msg;
          changed = true;
          results.sent_followup_2.push(leadId);
        } else {
          results.errors.push({ leadId, step: 'followup_2' });
        }
        continue;
      }

      // ── Follow-up #3 — 23h (gentle urgency, final before window closes) ───
      if (followUpCount === 2 && now - respondedAt >= FOLLOW_UP_3_DELAY_MS) {
        const msg = await generateContextualFollowUp(3, lead, refMapping);
        const ok  = await sendFollowUpMessage(ticketId, msg);
        if (ok) {
          crmState[leadId].follow_up_count   = 3;
          crmState[leadId].follow_up_3_at    = new Date().toISOString();
          crmState[leadId].follow_up_3_msg   = msg;
          crmState[leadId].follow_up_cold    = true;  // Stop after 3 follow-ups
          changed = true;
          results.sent_followup_3 = results.sent_followup_3 || [];
          results.sent_followup_3.push(leadId);
        } else {
          results.errors.push({ leadId, step: 'followup_3' });
        }
      }
    }

    // Only write CRM state if something changed (initial follow-ups)
    if (changed) {
      await writeCRMState(crmState, sha);
      // Re-read SHA after write so smart follow-up block has fresh SHA
      const refreshed = await readCRMState();
      Object.assign(crmState, refreshed.state);
      sha = refreshed.sha;
      changed = false;
    }

    // ── SAFETY NET: Unanswered inbound detection ───────────────────────────────
    // Catches tickets where the lead sent a message and the bot silently failed to reply.
    // If last message is INBOUND and it's been > 1h, post an internal note alerting Faysal.
    // This prevents leads like 941773913 from dying in silence.
    const UNANSWERED_THRESHOLD_MS = 1 * 60 * 60 * 1000; // 1 hour
    results.unanswered_escalated = [];

    for (const [leadId, lead] of Object.entries(crmState)) {
      if (!lead.trengo_ticket_id || !lead.auto_responded || !lead.lead_replied) continue;
      if (lead.bot_paused || lead.follow_up_cold) continue;
      if (lead.unanswered_alert_sent) continue; // Already alerted for this silence

      const ticketId = lead.trengo_ticket_id;
      const messages = await getTrengoThread(ticketId);
      if (!messages.length) continue;

      const real = messages.filter(m => !m.internal_note && (m.message || m.body));
      if (!real.length) continue;
      real.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
      const latest = real[0];
      const latestIsInbound = (latest.type || '').toUpperCase() === 'INBOUND';
      if (!latestIsInbound) continue; // Bot/agent spoke last — not an unanswered inbound

      const latestTime = latest.created_at ? new Date(latest.created_at).getTime() : 0;
      if (!latestTime || Date.now() - latestTime < UNANSWERED_THRESHOLD_MS) continue;

      // Count how many consecutive unanswered inbound messages
      let unansweredCount = 0;
      for (const m of real) {
        if ((m.type || '').toUpperCase() === 'INBOUND') unansweredCount++;
        else break;
      }

      const hoursAgo = Math.round((Date.now() - latestTime) / (60 * 60 * 1000));
      const lastLeadMsg = (latest.message || latest.body || '').substring(0, 200);

      // Escalate to team Reservations (assign ticket + internal note + pause bot)
      const token = process.env.TRENGO_TOKEN;
      if (token) {
        try {
          // Post internal note with context
          await fetch(`${TRENGO_API}/tickets/${ticketId}/messages`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({
              message: `🚨 UNANSWERED LEAD — ${lead.lead_name || 'Unknown'} has ${unansweredCount} unanswered message(s) from ${hoursAgo}h ago.\n\nLast message: "${lastLeadMsg}"\n\nBot failed to reply. Escalating to team.\n— fäm Bot`,
              internal: true,
            }),
          });
          // Assign to team Reservations (id: 78822)
          await fetch(`${TRENGO_API}/tickets/${ticketId}/assign`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({ ticket_id: ticketId, type: 'team', team_id: 78822 }),
          });
          console.log(`[followup] Unanswered ticket ${ticketId} assigned to team Reservations`);
        } catch (e) { console.error('[followup] unanswered escalation error:', e?.message); }
      }

      crmState[leadId].unanswered_alert_sent = true;
      crmState[leadId].unanswered_alert_at   = new Date().toISOString();
      crmState[leadId].bot_paused            = true; // Pause bot so it doesn't interfere with team
      changed = true;
      results.unanswered_escalated.push({ leadId, name: lead.lead_name, unansweredCount, hoursAgo });
      console.log(`[followup] Unanswered inbound alert for ${lead.lead_name} (ticket ${ticketId}) — ${unansweredCount} msgs, ${hoursAgo}h ago`);
    }

    if (changed) {
      await writeCRMState(crmState, sha);
      const refreshed = await readCRMState();
      Object.assign(crmState, refreshed.state);
      sha = refreshed.sha;
      changed = false;
    }

    // ── Smart contextual follow-up ────────────────────────────────────────────
    // Targets leads who engaged (replied) but went quiet after a conversation started.
    // Separate from the initial 6h/12h/23h nudges — those are for leads who never replied.
    results.smart_followup_sent = [];
    results.smart_followup_skipped = [];

    for (const [leadId, lead] of Object.entries(crmState)) {
      // Must have engaged (replied at least once) and bot replied back
      if (!lead.lead_replied || !lead.bot_reply_count || lead.bot_reply_count === 0) continue;
      // Re-triggerable: allow if smart_followup_last_at is > 1h ago AND there's been
      // new bot activity since the last follow-up (conversation continued and went silent again)
      if (lead.smart_followup_sent) {
        const lastFollowAt = lead.smart_followup_last_at ? new Date(lead.smart_followup_last_at).getTime() : 0;
        const lastBotReply = lead.last_bot_reply_at ? new Date(lead.last_bot_reply_at).getTime() : 0;
        const oneHourAgo = Date.now() - (1 * 60 * 60 * 1000);
        // Only re-trigger if: 1h+ since last follow-up AND bot has replied since the follow-up
        const canRetrigger = lastFollowAt < oneHourAgo && lastBotReply > lastFollowAt;
        if (!canRetrigger) continue;
      }
      // Not paused, not closed/lost/viewing
      if (lead.bot_paused) continue;
      if (['viewing', 'closed', 'lost'].includes(lead.stage)) continue;
      // Must have a ticket
      if (!lead.trengo_ticket_id) continue;

      // Check 4h silence: measure from most recent of last_bot_reply_at / last_agent_reply_at
      const lastBotAt   = lead.last_bot_reply_at   ? new Date(lead.last_bot_reply_at).getTime()   : 0;
      const lastAgentAt = lead.last_agent_reply_at  ? new Date(lead.last_agent_reply_at).getTime() : 0;
      const lastOutboundAt = Math.max(lastBotAt, lastAgentAt);
      if (!lastOutboundAt) continue;
      if (Date.now() - lastOutboundAt < SMART_FOLLOWUP_DELAY_MS) continue;

      // Read full Trengo thread
      const messages = await getTrengoThread(lead.trengo_ticket_id);
      if (!messages.length) continue;

      // Last real message must be OUTBOUND (ball in lead's court)
      const real = messages.filter(m => !m.internal_note && (m.message || m.body));
      if (!real.length) continue;
      real.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
      const lastIsOutbound = (real[0].type || '').toUpperCase() === 'OUTBOUND';
      if (!lastIsOutbound) continue; // Lead spoke last — no follow-up needed

      // Ask AI: should we follow up, and how?
      const { send, message } = await generateSmartFollowUp(messages, lead, refMapping);

      crmState[leadId].smart_followup_sent    = true;
      crmState[leadId].smart_followup_last_at = new Date().toISOString();
      // Keep legacy field for backward compat
      crmState[leadId].smart_followup_at      = new Date().toISOString();
      changed = true;

      if (send && message) {
        const ok = await sendFollowUpMessage(lead.trengo_ticket_id, message);
        if (ok) {
          crmState[leadId].smart_followup_message = message;
          results.smart_followup_sent.push({ leadId, name: lead.lead_name, message });
          console.log(`[followup] Smart follow-up sent to ${lead.lead_name} (ticket ${lead.trengo_ticket_id}): "${message}"`);
        } else {
          results.errors.push({ leadId, step: 'smart_followup' });
        }
      } else {
        results.smart_followup_skipped.push({ leadId, name: lead.lead_name, reason: 'AI decided no follow-up needed' });
        console.log(`[followup] Smart follow-up skipped for ${lead.lead_name} — AI said not appropriate`);
      }
    }

    if (changed) {
      await writeCRMState(crmState, sha);
    }

    return res.status(200).json({ ok: true, changed, ...results });

  } catch (err) {
    console.error('[auto-followup]', err);
    return res.status(500).json({ error: err.message });
  }
}
