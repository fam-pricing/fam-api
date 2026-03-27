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
    const { state: crmState, sha } = await readCRMState();
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

    // Only write CRM state if something changed
    if (changed) {
      await writeCRMState(crmState, sha);
    }

    return res.status(200).json({ ok: true, changed, ...results });

  } catch (err) {
    console.error('[auto-followup]', err);
    return res.status(500).json({ error: err.message });
  }
}
