// fam Living — CRM update endpoint
// POST /api/crm/update
// Body: { lead_id, stage?, note?, closed_price?, lost_reason? }
//
// Updates CRM state for a single lead, persisted as JSON in GitHub.
// Any authenticated user can update (agents can only update their own leads — enforced by leads.js filtering).

import { requireAuth } from '../_auth.js';

const GH_API   = 'https://api.github.com';
const REPO     = 'fam-pricing/fam-api';
const CRM_FILE = 'data/crm_state.json';

async function readCRMState() {
  const token = process.env.GH_TOKEN;
  if (!token) return { state: {}, sha: null };
  const r = await fetch(`${GH_API}/repos/${REPO}/contents/${CRM_FILE}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github.v3+json',
    },
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

async function writeCRMState(state, sha, commitMessage) {
  const token = process.env.GH_TOKEN;
  if (!token) throw new Error('GH_TOKEN not configured');
  const content = Buffer.from(JSON.stringify(state, null, 2)).toString('base64');
  const body = { message: commitMessage, content };
  if (sha) body.sha = sha;
  const r = await fetch(`${GH_API}/repos/${REPO}/contents/${CRM_FILE}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`GitHub write failed ${r.status}: ${text.slice(0, 200)}`);
  }
  return r.json();
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const user = requireAuth(req, res);
  if (!user) return;

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { return res.status(400).json({ error: 'Invalid JSON' }); }
  }

  const { lead_id, stage, note, closed_price, lost_reason } = body || {};
  if (!lead_id) return res.status(400).json({ error: 'lead_id is required' });

  const VALID_STAGES = ['new', 'contacted', 'viewing', 'closed', 'lost'];
  if (stage && !VALID_STAGES.includes(stage)) {
    return res.status(400).json({ error: `Invalid stage. Must be one of: ${VALID_STAGES.join(', ')}` });
  }

  try {
    const { state, sha } = await readCRMState();

    const existing = state[lead_id] || {
      stage: 'new',
      notes: [],
      closed_price: null,
      lost_reason:  null,
      created_at:   new Date().toISOString(),
    };

    if (stage)                  existing.stage        = stage;
    if (note?.trim())           existing.notes        = [...(existing.notes || []), {
                                                          text: note.trim(),
                                                          ts:   new Date().toISOString(),
                                                          by:   user.username,
                                                        }];
    if (closed_price !== undefined) existing.closed_price = closed_price;
    if (lost_reason  !== undefined) existing.lost_reason  = lost_reason;

    existing.updated_at = new Date().toISOString();
    existing.updated_by = user.username;

    state[lead_id] = existing;

    const action = stage ? `→ ${stage}` : (note ? 'note' : 'update');
    await writeCRMState(state, sha, `CRM: ${lead_id} ${action} by ${user.username}`);

    console.log(`[crm/update] ${lead_id} ${action} by ${user.username}`);

    return res.status(200).json({ success: true, lead_id, state: existing });

  } catch (err) {
    console.error('[crm/update]', err);
    return res.status(500).json({ error: err.message });
  }
}
