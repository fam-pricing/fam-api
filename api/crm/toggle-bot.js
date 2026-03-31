// fäm Living — POST /api/crm/toggle-bot
// Called by the Trengo sidebar app to pause or resume the bot for a specific ticket.
//
// SAFE — only modifies bot_paused flag in CRM state. NO messages sent to guests or leads.
// Uses lib/crm.js for Redis-first reads/writes (falls back to GitHub if Redis unavailable).

import { readCRMState, writeCRMState } from '../../lib/crm.js';

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

  // Redis-first CRM read
  const { state, sha } = await readCRMState();
  if (!state) return res.status(500).json({ error: 'CRM unavailable' });

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

  // Redis-first CRM write — sha is null when Redis is active (not needed), used for GitHub fallback
  await writeCRMState(state, sha);

  return res.status(200).json({ ok: true, action, lead: leadName, ticketId });
}
