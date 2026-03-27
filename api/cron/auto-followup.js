// fäm Living — Cron: follow up on silent leads
// Runs every hour via Vercel Cron.
// Logic:
//   - Follow-up #1: 24h after auto_responded_at with no inbound reply
//   - Follow-up #2: 48h after follow_up_1_at with still no inbound reply
//   - After 2 follow-ups → mark as cold, stop messaging
//
// Checks Trengo for last inbound message timestamp before sending.

const GH_API     = 'https://api.github.com';
const TRENGO_API = 'https://app.trengo.com/api/v2';
const REPO       = 'fam-pricing/fam-api';
const CRM_FILE   = 'data/crm_state.json';

const FOLLOW_UP_1_DELAY_MS = 24 * 60 * 60 * 1000;  // 24 hours
const FOLLOW_UP_2_DELAY_MS = 48 * 60 * 60 * 1000;  // 48 hours after follow-up 1

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
  const name = leadName ? `, ${leadName.split(' ')[0]}` : '';
  if (followUpNumber === 1) {
    return `Hi${name}! 👋 Just following up on your enquiry about ${listingTitle || 'the property'}. We'd love to help — are you still looking? Feel free to ask any questions!`;
  }
  return `Hi${name}, I wanted to make sure my last message reached you. We still have availability and would be happy to arrange a viewing or answer any questions. Let us know if you're still interested! 😊`;
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
      const followUp1At  = lead.follow_up_1_at ? new Date(lead.follow_up_1_at).getTime() : null;
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

      // ── Follow-up #1 ──────────────────────────────────────────────────────
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

      // ── Follow-up #2 ──────────────────────────────────────────────────────
      if (followUpCount === 1 && followUp1At && now - followUp1At >= FOLLOW_UP_2_DELAY_MS) {
        const msg = buildFollowUpMessage(2, lead.lead_name, lead.listing_title);
        const ok  = await sendFollowUpMessage(ticketId, msg);
        if (ok) {
          crmState[leadId].follow_up_count = 2;
          crmState[leadId].follow_up_2_at  = new Date().toISOString();
          crmState[leadId].follow_up_cold  = true;  // Stop after 2 follow-ups
          changed = true;
          results.sent_followup_2.push(leadId);
        } else {
          results.errors.push({ leadId, step: 'followup_2' });
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
