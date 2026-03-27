// fam Living — Login endpoint
// POST /api/login → { token, role, username }
//
// Auth priority:
//   1. users.json (GitHub) — primary store, supports full CRUD via admin panel
//   2. USERS env var — fallback for users not yet in users.json (e.g. faysal)
// Roles: owner | admin | viewer | agent
// faysal is always elevated to "owner" regardless of stored role.

import { signJWT, hashPassword } from './_auth.js';

const GH_API     = 'https://api.github.com';
const REPO       = 'fam-pricing/fam-api';
const USERS_FILE = 'data/users.json';

async function readUsersFile() {
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
  } catch {
    return { users: [], sha: null };
  }
}

async function writeUsersFile(users, sha) {
  const ghToken = process.env.GH_TOKEN;
  if (!ghToken) return;
  const content = Buffer.from(JSON.stringify(users, null, 2)).toString('base64');
  await fetch(`${GH_API}/repos/${REPO}/contents/${USERS_FILE}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${ghToken}`,
      Accept: 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ message: 'auth: update last_login', content, sha }),
  });
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const secret = process.env.JWT_SECRET;
  if (!secret) return res.status(500).json({ error: 'JWT_SECRET not configured' });

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { return res.status(400).json({ error: 'Invalid JSON' }); }
  }

  const { username, password } = body || {};
  if (!username || !password) return res.status(400).json({ error: 'username and password required' });

  const uname    = username.toLowerCase().trim();
  const provided = hashPassword(password);

  // 1. Try users.json (primary)
  const { users, sha } = await readUsersFile();
  let matchedUser = null;
  const fileUser  = users.find(u => u.username === uname);

  if (fileUser?.password && provided === fileUser.password) {
    matchedUser = fileUser;
  }

  // 2. Fallback to USERS env var (for faysal + legacy users without a users.json password)
  if (!matchedUser) {
    let envUsers = [];
    try { envUsers = JSON.parse(process.env.USERS || '[]'); } catch {}
    const envUser = envUsers.find(u => u.username === uname);
    const expected = envUser?.password || '0'.repeat(64);
    if (provided === expected && !!envUser) matchedUser = envUser;
  }

  if (!matchedUser) {
    await new Promise(r => setTimeout(r, 500));
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  // Role: users.json takes precedence (role changes via admin panel take effect immediately)
  const effectiveRole = uname === 'faysal' ? 'owner' : (fileUser?.role || matchedUser.role);

  // Update last_login in users.json (non-blocking)
  if (sha !== null) {
    const now      = new Date().toISOString();
    let   updated  = false;
    const newUsers = users.map(u => {
      if (u.username === uname) { updated = true; return { ...u, last_login: now }; }
      return u;
    });
    if (!updated) {
      // First login for a user who authenticated via env var — bootstrap their entry
      newUsers.push({ username: uname, role: effectiveRole, email: null, last_login: now, created_at: now });
    }
    writeUsersFile(newUsers, sha).catch(() => {});
  }

  const token = signJWT(
    { username: uname, role: effectiveRole, exp: Math.floor(Date.now() / 1000) + 8 * 3600 },
    secret,
  );

  console.log(`[login] ${uname} (${effectiveRole}) signed in`);
  return res.status(200).json({ token, role: effectiveRole, username: uname });
}
