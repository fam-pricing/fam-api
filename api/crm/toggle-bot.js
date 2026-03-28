// fäm Living — POST /api/crm/toggle-bot
// Called by the Trengo sidebar app to pause or resume the bot for a specific ticket.

const GH_API   = 'https://api.github.com';
const REPO     = 'fam-pricing/fam-api';
const CRM_FILE = 'data/crm_state.json';

async function readCRMState() {
  const ghToken = process.env.GH_TOKEN;
  if (!ghToken) return { state: {}, sha: null };
  const r = await fetch(`${GH_API}/repos/${REPO}/contents/${CRM_FILE}`, {
    headers: { Authorization: `Bearer ${ghToken}`, Accept: 'application/vnd.github.v3+json' },
  });
  if (!r.ok) return { state: {}, sha: null };
  const d = await r.json();
  try {
    return {
      state: JSON.parse(Buffer.from(d.content.replace(/\n/g, ''), 'base64').toString('utf8')),
      sha: d.sha,
    };
  } catch { return { state: {}, sha: d.sha }; }
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
    body: JSON.stringify({ message: 'CRM: bot toggle via Trengo sidebar [bot]', content, sha }),
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let body = req.body;
  if (!body || typeof body === 'string') {
    try { body = JSON.parse(body); } catch { return res.status(400).json({ error: 'Invalid JSON' }); }
  }

  const { ticket_id, action, reason, auth_token } = body || {};

  // Validate auth token if configured
  const expectedToken = process.env.SIDEBAR_AUTH_TOKEN;
  if (expectedToken && auth_token !== expectedToken) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Validate inputs
  const ticketId = parseInt(ticket_id) || null;
  if (!ticketId) return res.status(400).json({ error: 'Missing ticket_id' });
  if (!['pause', 'resume'].includes(action)) return res.status(400).json({ error: 'action must be pause or resume' });

  const { state, sha } = await readCRMState();
  if (!state || !sha) return res.status(500).json({ error: 'CRM unavailable' });

  const leadId = Object.keys(state).find(k => String(state[k].trengo_ticket_id) === String(ticketId));
  if (!leadId) return res.status(404).json({ error: 'Lead not found in CRM' });

  const leadName = state[leadId].lead_name || 'Lead';

  if (action === 'pause') {
    state[leadId].bot_paused        = true;
    state[leadId].bot_paused_reason = reason || 'Manually paused via Trengo sidebar';
    state[leadId].bot_paused_at     = new Date().toISOString();
    console.log(`[toggle-bot] Paused bot for ${leadName} (ticket ${ticketId}): ${reason}`);
  } else {
    state[leadId].bot_paused        = false;
    state[leadId].bot_paused_reason = null;
    state[leadId].bot_paused_at     = null;
    console.log(`[toggle-bot] Resumed bot for ${leadName} (ticket ${ticketId})`);
  }

  await writeCRMState(state, sha);

  return res.status(200).json({ ok: true, action, lead: leadName, ticketId });
}
