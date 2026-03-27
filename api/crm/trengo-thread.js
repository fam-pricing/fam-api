// fäm Living — GET /api/crm/trengo-thread?lead_id=message_lead_XXXXX
// Returns Trengo ticket messages + AI summary for a CRM lead.
// Auth: same JWT as dashboard (role >= viewer)

import { requireAuth } from '../_auth.js';

const GH_API        = 'https://api.github.com';
const TRENGO_API    = 'https://app.trengo.com/api/v2';
const REPO          = 'fam-pricing/fam-api';
const CRM_FILE      = 'data/crm_state.json';

// ── CRM state ─────────────────────────────────────────────────────────────────

async function readCRMState() {
  const ghToken = process.env.GH_TOKEN;
  if (!ghToken) return {};
  const r = await fetch(`${GH_API}/repos/${REPO}/contents/${CRM_FILE}`, {
    headers: { Authorization: `Bearer ${ghToken}`, Accept: 'application/vnd.github.v3+json' },
  });
  if (!r.ok) return {};
  const d = await r.json();
  try {
    const content = Buffer.from(d.content.replace(/\n/g, ''), 'base64').toString('utf8');
    return JSON.parse(content);
  } catch {
    return {};
  }
}

// ── Trengo helpers ─────────────────────────────────────────────────────────────

async function getTrengoTicket(ticketId) {
  const token = process.env.TRENGO_TOKEN;
  const r = await fetch(`${TRENGO_API}/tickets/${ticketId}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  if (!r.ok) return null;
  return r.json();
}

async function getTrengoMessages(ticketId) {
  const token = process.env.TRENGO_TOKEN;
  const r = await fetch(`${TRENGO_API}/tickets/${ticketId}/messages`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  if (!r.ok) return [];
  const d = await r.json();
  return d.data || d.messages || d || [];
}

// ── Summary generator ─────────────────────────────────────────────────────────

// Fallback rule-based summary (used when AI API is unavailable)
function ruleSummary(messages, leadMeta, leadName) {
  leadName = leadName || 'Lead';
  if (!messages.length) return 'No messages yet — template was just sent.';
  const texts = messages
    .filter(m => m.message || m.body || m.text)
    .map(m => ({
      from: m.type?.toUpperCase() === 'INBOUND' ? leadName : (m.agent?.name || 'Agent'),
      text: (m.message || m.body || m.text || '').trim(),
    }))
    .filter(m => m.text);
  if (!texts.length) return 'Conversation started — no text messages yet.';
  const leadMsgs  = texts.filter(m => m.from === 'Lead');
  const allText   = texts.map(m => m.text).join(' ').toLowerCase();
  const negative  = /not interested|no thanks|wrong|stop|unsubscribe|busy/.test(allText);
  const interested = /visit|viewing|when|available|interested|yes|sure|ok|price|how much|confirm|schedule/.test(allText);
  let status = leadMsgs.length === 0 ? 'Awaiting lead reply'
    : negative ? '⚠️ Lead not interested'
    : interested ? '✅ Lead is engaging'
    : '💬 Lead replied';
  return `${status} · ${texts.length} messages (${leadMsgs.length} from lead)`;
}

// AI summary via Anthropic Messages API (native fetch, no npm)
async function generateSummary(messages, leadMeta, leadName) {
  leadName = leadName || 'Lead';
  const apiKey = process.env.ANTHROPIC_API_KEY;

  // Build conversation transcript
  const texts = messages
    .filter(m => m.message || m.body || m.text)
    .map(m => ({
      from: m.type?.toUpperCase() === 'INBOUND' ? 'Lead' : 'Agent',
      text: (m.message || m.body || m.text || '').trim(),
    }))
    .filter(m => m.text);

  if (!texts.length) return 'No messages yet — template was just sent.';

  if (!apiKey) return ruleSummary(messages, leadMeta, leadName);

  const transcript = texts.map(m => `${m.from}: ${m.text}`).join('\n');
  const property   = leadMeta?.listing_title || 'unknown property';

  const prompt = `You are a CRM assistant for fäm Living, a Dubai holiday home rental company.

A lead enquired about: ${property}

Here is the WhatsApp conversation so far:
${transcript}

Write a SHORT 2–3 sentence summary for the agent covering:
1. Current status — has the lead replied? Are they interested?
2. What the lead said or asked (if anything)
3. Recommended next action

Be direct and practical. No bullet points. No markdown. Plain text only.`;

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key':         apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type':      'application/json',
      },
      body: JSON.stringify({
        model:      'claude-haiku-4-5-20251001',
        max_tokens: 200,
        messages:   [{ role: 'user', content: prompt }],
      }),
    });
    if (!r.ok) {
      const errBody = await r.text().catch(() => String(r.status));
      console.error('[trengo-thread] Anthropic error', r.status, errBody);
      return `[AI_ERROR ${r.status}] ${errBody.slice(0, 200)}`;
    }
    const d = await r.json();
    return d?.content?.[0]?.text?.trim() || ruleSummary(messages, leadMeta, leadName);
  } catch (e) {
    console.error('[trengo-thread] Anthropic fetch failed', e?.message);
    return `[AI_FETCH_ERROR] ${e?.message}`;
  }
}

// ── Handler ───────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const user = requireAuth(req, res, 'agent');
  if (!user) return;

  const { lead_id, lead_name } = req.query;
  const leadName = lead_name || 'Lead';
  if (!lead_id) return res.status(400).json({ error: 'lead_id required' });

  try {
    // 1. Get CRM state to find Trengo ticket ID
    const crmState = await readCRMState();
    const leadMeta = crmState[lead_id];

    if (!leadMeta) {
      return res.status(404).json({ error: 'Lead not found in CRM' });
    }

    const ticketId = leadMeta.trengo_ticket_id;

    if (!ticketId) {
      return res.status(200).json({
        ok:       true,
        ticket:   null,
        messages: [],
        summary:  leadMeta.auto_responded
          ? 'Trengo ticket not yet created — lead may have no phone number.'
          : 'Lead not yet auto-responded.',
        meta:     leadMeta,
      });
    }

    // 2. Fetch ticket + messages from Trengo in parallel
    const [ticket, messages] = await Promise.all([
      getTrengoTicket(ticketId),
      getTrengoMessages(ticketId),
    ]);

    // 3. Normalise messages for frontend
    const normalised = messages.map(m => ({
      id:        m.id,
      from:      m.type?.toUpperCase() === 'INBOUND' ? 'lead' : 'agent',
      text:      m.message || m.body || m.text || '',
      time:      m.created_at || m.timestamp || '',
      author:    m.type?.toUpperCase() === 'INBOUND' ? leadName : (m.agent?.name || 'Agent'),
    })).filter(m => m.text);

    // 4. Generate summary
    const summary = await generateSummary(messages, leadMeta, leadName);

    return res.status(200).json({
      ok:       true,
      ticket:   ticket ? {
        id:       ticket.id,
        status:   ticket.status,
        assignee: ticket.assignee?.name || null,
        created:  ticket.created_at || null,
      } : null,
      messages: normalised,
      summary,
      meta:     {
        phone:          leadMeta.pf_phone,
        listing_title:  leadMeta.listing_title,
        auto_responded: leadMeta.auto_responded,
        responded_at:   leadMeta.auto_responded_at,
      },
    });

  } catch (err) {
    console.error('[trengo-thread]', err);
    return res.status(500).json({ error: err.message });
  }
}
