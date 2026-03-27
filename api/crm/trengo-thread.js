// fäm Living — GET /api/crm/trengo-thread?lead_id=message_lead_XXXXX
// Returns Trengo ticket messages + AI summary for a CRM lead.
// Auth: same JWT as dashboard (role >= viewer)

import jwt from 'jsonwebtoken';

const GH_API        = 'https://api.github.com';
const TRENGO_API    = 'https://app.trengo.com/api/v2';
const REPO          = 'fam-pricing/fam-api';
const CRM_FILE      = 'data/crm_state.json';

// ── Auth ──────────────────────────────────────────────────────────────────────

function verifyJWT(req) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return null;
  try {
    return jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return null;
  }
}

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

function generateSummary(messages, leadMeta) {
  if (!messages.length) return 'No messages yet — template was just sent.';

  const texts = messages
    .filter(m => m.body || m.message || m.text)
    .map(m => ({
      from:    m.type === 'inbound' ? 'Lead' : 'Agent',
      text:    (m.body || m.message || m.text || '').trim(),
      time:    m.created_at || m.timestamp || '',
    }))
    .filter(m => m.text);

  if (!texts.length) return 'Conversation started, no text messages yet.';

  const total      = texts.length;
  const leadMsgs   = texts.filter(m => m.from === 'Lead');
  const agentMsgs  = texts.filter(m => m.from === 'Agent');
  const lastMsg    = texts[texts.length - 1];
  const hasReply   = leadMsgs.length > 0;

  // Detect interest signals
  const allText    = texts.map(m => m.text).join(' ').toLowerCase();
  const interested = /visit|viewing|when|available|interested|yes|sure|ok|price|how much|confirm|schedule/.test(allText);
  const negative   = /not interested|no thanks|wrong|stop|unsubscribe|busy/.test(allText);

  let status = 'Awaiting lead reply';
  if (negative)   status = '⚠️ Lead not interested';
  else if (interested && hasReply) status = '✅ Lead is engaging';
  else if (hasReply) status = '💬 Lead replied';

  const lines = [
    `${status}`,
    `${total} message${total !== 1 ? 's' : ''} — ${leadMsgs.length} from lead, ${agentMsgs.length} from agent.`,
  ];

  if (lastMsg) {
    const preview = lastMsg.text.length > 80
      ? lastMsg.text.slice(0, 80) + '…'
      : lastMsg.text;
    lines.push(`Last message (${lastMsg.from}): "${preview}"`);
  }

  if (leadMeta?.listing_title) {
    lines.push(`Property: ${leadMeta.listing_title}`);
  }

  return lines.join('\n');
}

// ── Handler ───────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const user = verifyJWT(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const { lead_id } = req.query;
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
      from:      m.type === 'inbound' ? 'lead' : 'agent',
      text:      m.body || m.message || m.text || '',
      time:      m.created_at || m.timestamp || '',
      author:    m.author?.name || m.agent?.name || (m.type === 'inbound' ? 'Lead' : 'Agent'),
    })).filter(m => m.text);

    // 4. Generate summary
    const summary = generateSummary(messages, leadMeta);

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
