// fäm Living — Cron: follow up on silent leads
// Runs every hour via Vercel Cron.
// Logic:
//   All delays measured from auto_responded_at (initial message sent time).
//   All 3 follow-ups must land within 24h to stay inside the WhatsApp session window.
//   - Follow-up #1:  6h after auto_responded_at (no inbound reply)
//   - Follow-up #2: 12h after auto_responded_at (still no reply)
//   - Follow-up #3: 23h after auto_responded_at (final nudge, just before window closes)
//   After 3 follow-ups → mark cold, stop messaging.
//   If lead replies at any point → all follow-ups cancelled.
//
// SMART CONTEXTUAL FOLLOW-UP (separate from above):
//   For leads who DID engage (replied at least once) but then went quiet.
//   Triggers 4h after the last bot/agent reply if lead hasn't responded.
//   AI reads full conversation, decides IF follow-up makes sense, writes contextual message.
//   One-time only per lead. Never fires if bot is paused or stage is viewing/closed/lost.

const GH_API     = 'https://api.github.com';
const TRENGO_API = 'https://app.trengo.com/api/v2';
const REPO       = 'fam-pricing/fam-api';
const CRM_FILE   = 'data/crm_state.json';

// All measured from auto_responded_at (initial message time)
const FOLLOW_UP_1_DELAY_MS =  6 * 60 * 60 * 1000;  //  6 hours
const FOLLOW_UP_2_DELAY_MS = 12 * 60 * 60 * 1000;  // 12 hours
const FOLLOW_UP_3_DELAY_MS = 23 * 60 * 60 * 1000;  // 23 hours (last chance before window closes)

// ── GitHub CRM state ──────────────────────────────────────────────────────────

async function readCRMState() {
  const ghToken = process.env.GH_TOKEN;
  if (!ghToken) return { state: {}, sha: null };
  const r = await fetch(`${GH_API}/repos/${REPO}/contents/${CRM_FILE}`, {
    headers: { Authorization: `Bearer ${ghToken}`, Accept: 'application/vnd.github.v3+json' },
  });
  if (!r.ok) return { state: {}, sha: null };
  const d = await r.json();
  try {
    const content = Buffer.from(d.content.replace(/\n/g, ''), 'base64').toString('utf8');
    return { state: JSON.parse(content), sha: d.sha };
  } catch {
    return { state: {}, sha: d.sha };
  }
}

async function writeCRMState(state, sha) {
  const ghToken = process.env.GH_TOKEN;
  if (!ghToken) return;
  const content = Buffer.from(JSON.stringify(state, null, 2)).toString('base64');
  await fetch(`${GH_API}/repos/${REPO}/contents/${CRM_FILE}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${ghToken}`,
      Accept: 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ message: 'CRM: auto-followup [cron]', content, sha }),
  });
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

// Build a personalised follow-up message
function buildFollowUpMessage(followUpNumber, leadName, listingTitle) {
  const name = leadName ? ` ${leadName.split(' ')[0]}` : '';
  const prop = listingTitle || 'the property';
  if (followUpNumber === 1) {
    return `Hi${name}, just checking in on your enquiry about ${prop}. Still available if you have any questions.`;
  }
  if (followUpNumber === 2) {
    return `Hi${name}, wanted to follow up one more time. We still have availability and can arrange a viewing at your convenience. Let us know.`;
  }
  // Follow-up 3 — final nudge before window closes
  return `Hi${name}, last message from our side. If you're still interested in ${prop}, we're here. Happy to help whenever you're ready.`;
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

async function generateSmartFollowUp(messages, leadName, listingTitle) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { send: false };

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

  const prompt = `You are a WhatsApp sales agent for fäm Living, a Dubai holiday home rental company.

Below is a conversation with a lead named ${leadName} about "${listingTitle || 'a property'}".
The lead engaged but then went quiet — the last message was from the Agent and the lead has not replied in 4+ hours.

CONVERSATION:
${history}

TASK: Decide if a contextual follow-up message should be sent.

Rules:
- Send ONLY if the conversation ended with an open question or the ball is clearly in the lead's court.
- Do NOT send if: the lead said they're not interested, the lead asked for time and it's clearly too soon, a viewing is already confirmed, or the conversation reached a natural close.
- If you send, write ONE short warm WhatsApp message that references the actual conversation — not a generic "still interested?" — something that shows you read what they said.
- Never mention price or discount unless the lead brought it up last.
- Keep it under 2 sentences. Human, not salesy.

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
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 150,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!r.ok) return { send: false };
    const d = await r.json();
    const text = (d?.content?.[0]?.text || '').trim();

    if (text.startsWith('YES:')) {
      const message = text.replace(/^YES:\s*/i, '').replace(/\s*\u2014\s*/g, ', ').trim();
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
    const { state: crmState, sha: initialSha } = await readCRMState();
    let sha = initialSha;
    const now = Date.now();
    const results = { sent_followup_1: [], sent_followup_2: [], skipped_replied: [], skipped_cold: [], errors: [] };
    let changed = false;

    for (const [leadId, lead] of Object.entries(crmState)) {
      // Only process leads that have been auto-responded with a Trengo ticket
      if (!lead.auto_responded || !lead.trengo_ticket_id) continue;
      // Skip leads already marked cold
      if (lead.follow_up_cold) { results.skipped_cold.push(leadId); continue; }

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

      // ── Follow-up #1 — 6h ─────────────────────────────────────────────────
      if (followUpCount === 0 && now - respondedAt >= FOLLOW_UP_1_DELAY_MS) {
        const msg = buildFollowUpMessage(1, lead.lead_name, lead.listing_title);
        const ok  = await sendFollowUpMessage(ticketId, msg);
        if (ok) {
          crmState[leadId].follow_up_count = 1;
          crmState[leadId].follow_up_1_at  = new Date().toISOString();
          changed = true;
          results.sent_followup_1.push(leadId);
        } else {
          results.errors.push({ leadId, step: 'followup_1' });
        }
        continue;
      }

      // ── Follow-up #2 — 12h ────────────────────────────────────────────────
      if (followUpCount === 1 && now - respondedAt >= FOLLOW_UP_2_DELAY_MS) {
        const msg = buildFollowUpMessage(2, lead.lead_name, lead.listing_title);
        const ok  = await sendFollowUpMessage(ticketId, msg);
        if (ok) {
          crmState[leadId].follow_up_count = 2;
          crmState[leadId].follow_up_2_at  = new Date().toISOString();
          changed = true;
          results.sent_followup_2.push(leadId);
        } else {
          results.errors.push({ leadId, step: 'followup_2' });
        }
        continue;
      }

      // ── Follow-up #3 — 23h (final, before window closes) ──────────────────
      if (followUpCount === 2 && now - respondedAt >= FOLLOW_UP_3_DELAY_MS) {
        const msg = buildFollowUpMessage(3, lead.lead_name, lead.listing_title);
        const ok  = await sendFollowUpMessage(ticketId, msg);
        if (ok) {
          crmState[leadId].follow_up_count = 3;
          crmState[leadId].follow_up_3_at  = new Date().toISOString();
          crmState[leadId].follow_up_cold  = true;  // Stop after 3 follow-ups
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

    // ── Smart contextual follow-up ────────────────────────────────────────────
    // Targets leads who engaged (replied) but went quiet after a conversation started.
    // Separate from the initial 6h/12h/23h nudges — those are for leads who never replied.
    results.smart_followup_sent = [];
    results.smart_followup_skipped = [];

    for (const [leadId, lead] of Object.entries(crmState)) {
      // Must have engaged (replied at least once) and bot replied back
      if (!lead.lead_replied || !lead.bot_reply_count || lead.bot_reply_count === 0) continue;
      // Not already done
      if (lead.smart_followup_sent) continue;
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
      const { send, message } = await generateSmartFollowUp(messages, lead.lead_name || 'there', lead.listing_title);

      crmState[leadId].smart_followup_sent = true;
      crmState[leadId].smart_followup_at   = new Date().toISOString();
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
