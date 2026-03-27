// api/playbook.js — GET read / POST save the AI playbook via GitHub API
// Vercel filesystem is read-only — all reads/writes go through GitHub Contents API.
// GET: owner only  |  POST: owner only

const { requireAuth } = require('./_auth');

const GH_API       = 'https://api.github.com';
const REPO         = 'fam-pricing/fam-api';
const PLAYBOOK_FILE = 'data/playbook.md';

async function ghReadPlaybook() {
  const token = process.env.GH_TOKEN;
  if (!token) return { content: '', sha: null };
  const r = await fetch(`${GH_API}/repos/${REPO}/contents/${PLAYBOOK_FILE}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github.v3+json' },
  });
  if (!r.ok) return { content: '', sha: null };
  const d = await r.json();
  try {
    return {
      content: Buffer.from(d.content.replace(/\n/g, ''), 'base64').toString('utf8'),
      sha: d.sha,
    };
  } catch { return { content: '', sha: d.sha }; }
}

async function ghWritePlaybook(content, sha) {
  const token = process.env.GH_TOKEN;
  if (!token) throw new Error('GH_TOKEN not set');
  const encoded = Buffer.from(content).toString('base64');
  const r = await fetch(`${GH_API}/repos/${REPO}/contents/${PLAYBOOK_FILE}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ message: 'Playbook updated via dashboard', content: encoded, sha }),
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    throw new Error(err.message || `GitHub write failed: ${r.status}`);
  }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── GET ──────────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    const user = requireAuth(req, res, 'owner');
    if (!user) return;
    try {
      const { content } = await ghReadPlaybook();
      return res.status(200).json({ content });
    } catch (e) {
      return res.status(500).json({ error: 'Failed to read playbook: ' + e.message });
    }
  }

  // ── POST ─────────────────────────────────────────────────────────────
  if (req.method === 'POST') {
    const user = requireAuth(req, res, 'owner');
    if (!user) return;

    let newContent = '';
    if (req.body && typeof req.body === 'object') {
      newContent = req.body.content || '';
    } else if (typeof req.body === 'string') {
      try { newContent = JSON.parse(req.body).content || ''; } catch { newContent = req.body; }
    }

    try {
      const { sha } = await ghReadPlaybook();   // get current SHA for the PUT
      await ghWritePlaybook(newContent, sha);
      return res.status(200).json({ ok: true });
    } catch (e) {
      return res.status(500).json({ error: 'Failed to save playbook: ' + e.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
