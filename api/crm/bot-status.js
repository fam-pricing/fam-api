// fäm Living — GET /api/crm/bot-status
// Returns bot activity stats + event feed for the dashboard Bot tab.
// Requires owner or admin role.

import { requireAuth } from '../_auth.js';

const GH_API  = 'https://api.github.com';
const REPO    = 'fam-pricing/fam-api';
const CRM_FILE     = 'data/crm_state.json';
const PENDING_FILE = 'data/pending_escalations.json';

const DUBAI_OFFSET = 4;
const NIGHT_START  = 21;
const NIGHT_END    = 6;

function getDubaiHour() {
  return (new Date().getUTCHours() + DUBAI_OFFSET) % 24;
}

function isNightShift(h) {
  return h >= NIGHT_START || h < NIGHT_END;
}

async function ghReadJSON(file) {
  const ghToken = process.env.GH_TOKEN;
  if (!ghToken) return null;
  const r = await fetch(`${GH_API}/repos/${REPO}/contents/${file}`, {
    headers: { Authorization: `Bearer ${ghToken}`, Accept: 'application/vnd.github.v3+json' },
  });
  if (!r.ok) return null;
  const d = await r.json();
  try {
    return JSON.parse(Buffer.from(d.content.replace(/\n/g, ''), 'base64').toString('utf8'));
  } catch { return null; }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const user = requireAuth(req, res);
  if (!user) return;
  if (user.role !== 'owner' && user.role !== 'admin') {
    return res.status(403).json({ error: 'Owner or admin only' });
  }

  try {
    const [crmState, pendingEsc] = await Promise.all([
      ghReadJSON(CRM_FILE),
      ghReadJSON(PENDING_FILE),
    ]);

    const leads  = crmState ? Object.entries(crmState) : [];
    const dubaiH = getDubaiHour();

    // Stats
    const botEnabled    = process.env.AUTOBOT_ENABLED === 'true';
    const nightShift    = isNightShift(dubaiH);
    const totalLeads    = leads.length;
    const botReplied    = leads.filter(([, v]) => (v.bot_reply_count || 0) > 0).length;
    const totalBotReplies = leads.reduce((s, [, v]) => s + (v.bot_reply_count || 0), 0);
    const pendingQ       = (pendingEsc?.pending || []).filter(e => !e.answered_at).length;
    const answeredQ      = (pendingEsc?.pending || []).filter(e => e.answered_at).length;
    const learnedFromAfifa = leads.filter(([, v]) => v.last_learned_at).length;

    // Build event feed — pull key timestamps from each lead and flatten into timeline
    const events = [];
    for (const [id, v] of leads) {
      const name = v.lead_name || id;
      const prop = v.listing_title || '';
      if (v.last_bot_reply_at) {
        events.push({ type: 'reply', ts: v.last_bot_reply_at, label: `Replied to ${name}`, detail: prop, count: v.bot_reply_count || 1 });
      }
      if (v.last_escalated_at && v.last_escalated_question) {
        events.push({ type: 'escalate', ts: v.last_escalated_at, label: `Escalated: ${name}`, detail: `"${v.last_escalated_question.substring(0, 80)}${v.last_escalated_question.length > 80 ? '…' : ''}"` });
      }
      if (v.last_learned_at) {
        events.push({ type: 'learn', ts: v.last_learned_at, label: `Learned from Afifa`, detail: `Re ${name} — ${prop}` });
      }
    }

    // Add teaching events from pending escalations
    for (const e of (pendingEsc?.pending || [])) {
      if (e.answered_at) {
        events.push({ type: 'taught', ts: e.answered_at, label: `Faysal taught bot`, detail: `"${(e.question || '').substring(0, 80)}${(e.question || '').length > 80 ? '…' : ''}"` });
      } else {
        events.push({ type: 'waiting', ts: e.escalated_at, label: `Waiting for Faysal`, detail: `"${(e.question || '').substring(0, 80)}${(e.question || '').length > 80 ? '…' : ''}"` });
      }
    }

    // Sort newest first, take 40
    events.sort((a, b) => new Date(b.ts) - new Date(a.ts));
    const recentEvents = events.slice(0, 40);

    // Format timestamps to Dubai time
    const fmtTs = (iso) => {
      if (!iso) return '—';
      const d = new Date(new Date(iso).getTime() + DUBAI_OFFSET * 3600000);
      return d.toISOString().replace('T', ' ').substring(0, 16) + ' GST';
    };

    return res.status(200).json({
      bot_enabled:       botEnabled,
      night_shift:       nightShift,
      dubai_hour:        dubaiH,
      shift_label:       nightShift ? '🌙 Night Shift — Bot Active' : '☀️ Day Shift — Afifa Handles',
      stats: {
        total_leads:        totalLeads,
        bot_replied_leads:  botReplied,
        total_bot_replies:  totalBotReplies,
        pending_escalations: pendingQ,
        taught_by_faysal:    answeredQ,
        learned_from_afifa:  learnedFromAfifa,
        faysal_ticket_id:    pendingEsc?.faysal_ticket_id || null,
      },
      events: recentEvents.map(e => ({ ...e, ts_label: fmtTs(e.ts) })),
    });

  } catch (err) {
    console.error('[bot-status]', err);
    return res.status(500).json({ error: err.message });
  }
}
