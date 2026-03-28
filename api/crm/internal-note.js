// POST /api/crm/internal-note
// Body: { ticket_id, message, secret }
// Posts an internal (team-only) note to a Trengo ticket using server-side TRENGO_TOKEN.
// Protected by webhook secret — no JWT required so it can be called from backend scripts.

const TRENGO_API = 'https://app.trengo.com/api/v2';
const BOT_SECRET = process.env.BOT_SECRET || 'fambot_wh_b4zu496kec';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { return res.status(400).json({ error: 'Invalid JSON' }); }
  }

  const { ticket_id, message, secret } = body || {};

  if (!secret || secret !== BOT_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!ticket_id || !message) {
    return res.status(400).json({ error: 'ticket_id and message are required' });
  }

  const trengoToken = process.env.TRENGO_TOKEN;
  if (!trengoToken) {
    return res.status(500).json({ error: 'TRENGO_TOKEN not configured' });
  }

  try {
    const r = await fetch(`${TRENGO_API}/tickets/${ticket_id}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${trengoToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ message, type: 'note' }),
    });

    const data = await r.json().catch(() => ({}));

    if (!r.ok) {
      console.error('[internal-note] Trengo error', r.status, data);
      return res.status(r.status).json({ error: 'Trengo API error', detail: data });
    }

    console.log(`[internal-note] Note posted to ticket ${ticket_id}`);
    return res.status(200).json({ ok: true, ticket_id, trengo_response: data });

  } catch (err) {
    console.error('[internal-note]', err);
    return res.status(500).json({ error: err.message });
  }
}
