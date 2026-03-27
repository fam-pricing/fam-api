// api/playbook.js — GET read / POST save the AI playbook
// GET: any authenticated user can read
// POST: requires admin (level 3)

const fs   = require('fs');
const path = require('path');
const { requireAuth } = require('./_auth');

const PLAYBOOK_PATH = path.join(__dirname, '../data/playbook.md');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── GET ──────────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    const user = requireAuth(req, res, 'agent');
    if (!user) return;
    try {
      const content = fs.existsSync(PLAYBOOK_PATH)
        ? fs.readFileSync(PLAYBOOK_PATH, 'utf8')
        : '';
      return res.status(200).json({ content });
    } catch (e) {
      return res.status(500).json({ error: 'Failed to read playbook' });
    }
  }

  // ── POST ─────────────────────────────────────────────────────────────
  if (req.method === 'POST') {
    const user = requireAuth(req, res, 'admin');
    if (!user) return;

    let body = '';
    if (typeof req.body === 'string') {
      body = req.body;
    } else if (req.body && typeof req.body === 'object') {
      body = req.body.content || '';
    } else {
      // parse raw body for Vercel
      await new Promise((resolve) => {
        let raw = '';
        req.on('data', chunk => { raw += chunk; });
        req.on('end', () => {
          try { body = JSON.parse(raw).content || ''; } catch { body = raw; }
          resolve();
        });
      });
    }

    try {
      fs.writeFileSync(PLAYBOOK_PATH, body, 'utf8');
      return res.status(200).json({ ok: true });
    } catch (e) {
      return res.status(500).json({ error: 'Failed to save playbook' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
