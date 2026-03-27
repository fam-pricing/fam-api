// fam Living — User Management API (owner only)
// GET    /api/admin/users              → list all users
// POST   /api/admin/users              → create user
// PATCH  /api/admin/users              → update user (role, email, password reset)
// DELETE /api/admin/users?username=    → delete user

import { requireAuth, hashPassword } from '../_auth.js';

const GH_API     = 'https://api.github.com';
const REPO       = 'fam-pricing/fam-api';
const USERS_FILE = 'data/users.json';

function randomPassword(len = 12) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let pwd = '';
  const buf = new Uint8Array(len * 2);
  crypto.getRandomValues(buf);
  for (let i = 0; i < len; i++) pwd += chars[buf[i] % chars.length];
  return pwd;
}

async function readUsers() {
  const ghToken = process.env.GH_TOKEN;
  if (!ghToken) return { users: [], sha: null };
  try {
    const r = await fetch(`${GH_API}/repos/${REPO}/contents/${USERS_FILE}`, {
      headers: { Authorization: `Bearer ${ghToken}`, Accept: 'application/vnd.github.v3+json' },
    });
    if (!r.ok) return { users: [], sha: null };
    const d = await r.json();
    const content = Buffer.from(d.content.replace(/\n/g, ''), 'base64').toString('utf8');
    return { users: JSON.parse(content), sha: d.sha };
  } catch { return { users: [], sha: null }; }
}

async function writeUsers(users, sha, message) {
  const ghToken = process.env.GH_TOKEN;
  if (!ghToken) throw new Error('GH_TOKEN not configured');
  const content = Buffer.from(JSON.stringify(users, null, 2)).toString('base64');
  const r = await fetch(`${GH_API}/repos/${REPO}/contents/${USERS_FILE}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${ghToken}`, Accept: 'application/vnd.github.v3+json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: message || 'admin: update users', content, sha }),
  });
  if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.message || `GitHub write failed: ${r.status}`); }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const user = requireAuth(req, res, 'owner');
  if (!user) return;

  const { users, sha } = await readUsers();

  // GET — list users
  if (req.method === 'GET') {
    let envUsers = [];
    try { envUsers = JSON.parse(process.env.USERS || '[]'); } catch {}
    const merged = [...users];
    for (const eu of envUsers) {
      if (!merged.find(u => u.username === eu.username))
        merged.push({ username: eu.username, role: eu.role, email: null, last_login: null, created_at: null });
    }
    return res.status(200).json({ users: merged.map(({ password, ...u }) => u) });
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: 'Invalid JSON' }); } }

  // POST — create user
  if (req.method === 'POST') {
    const { username, role, email } = body || {};
    if (!username || !role) return res.status(400).json({ error: 'username and role required' });
    const uname = username.toLowerCase().trim();
    if (users.find(u => u.username === uname)) return res.status(409).json({ error: 'Username already exists' });
    if (!['owner','admin','viewer','agent'].includes(role)) return res.status(400).json({ error: 'Invalid role' });

    const pwd = randomPassword();
    users.push({ username: uname, password: hashPassword(pwd), role, email: email || null, last_login: null, created_at: new Date().toISOString() });
    await writeUsers(users, sha, `admin: create user ${uname}`);
    return res.status(201).json({ ok: true, username: uname, role, password: pwd });
  }

  // PATCH — update role / email / reset password
  if (req.method === 'PATCH') {
    const { username, role, email, reset_password } = body || {};
    if (!username) return res.status(400).json({ error: 'username required' });
    const uname = username.toLowerCase().trim();

    let idx = users.findIndex(u => u.username === uname);
    if (idx === -1) {
      let envUsers = [];
      try { envUsers = JSON.parse(process.env.USERS || '[]'); } catch {}
      const eu = envUsers.find(u => u.username === uname);
      if (!eu) return res.status(404).json({ error: 'User not found' });
      users.push({ username: uname, role: eu.role, email: null, last_login: null, created_at: new Date().toISOString() });
      idx = users.length - 1;
    }

    let newPassword = null;
    if (role) users[idx].role = role;
    if (email !== undefined) users[idx].email = email || null;
    if (reset_password) { newPassword = randomPassword(); users[idx].password = hashPassword(newPassword); }

    await writeUsers(users, sha, `admin: update user ${uname}`);
    const { password, ...safe } = users[idx];
    return res.status(200).json({ ok: true, user: safe, ...(newPassword ? { new_password: newPassword } : {}) });
  }

  // DELETE — remove user
  if (req.method === 'DELETE') {
    const uname = (req.query.username || '').toLowerCase().trim();
    if (!uname) return res.status(400).json({ error: 'username query param required' });
    if (uname === 'faysal') return res.status(403).json({ error: 'Cannot delete owner account' });
    const newUsers = users.filter(u => u.username !== uname);
    if (newUsers.length === users.length) return res.status(404).json({ error: 'User not found' });
    await writeUsers(newUsers, sha, `admin: delete user ${uname}`);
    return res.status(200).json({ ok: true, deleted: uname });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
