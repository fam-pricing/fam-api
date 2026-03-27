// fam Living — Login endpoint
// POST /api/login
// Body: { username, password }
// Returns: { token, role, username }
//
// Users stored in USERS env var as JSON array:
// [{"username":"faysal","password":"<sha256hex>","role":"admin"}, ...]
// Roles: "owner" (faysal only — full access + unpublish) | "admin" (publish only) | "viewer" (read-only)
// Note: faysal is always elevated to "owner" regardless of USERS env var role.

import { signJWT, hashPassword } from './_auth.js';

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

  // Load users
  let users = [];
  try { users = JSON.parse(process.env.USERS || '[]'); } catch {
    return res.status(500).json({ error: 'USERS env var is invalid JSON' });
  }

  const user = users.find(u => u.username === username.toLowerCase().trim());

  // Use constant-time comparison to avoid timing attacks
  const provided = hashPassword(password);
  const expected = user?.password || '0'.repeat(64);
  const match = provided === expected && !!user;

  if (!match) {
    // Small delay to slow brute force
    await new Promise(r => setTimeout(r, 500));
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  // faysal always gets owner role regardless of USERS env var
  const effectiveRole = user.username === 'faysal' ? 'owner' : user.role;

  const token = signJWT(
    {
      username: user.username,
      role:     effectiveRole,
      exp:      Math.floor(Date.now() / 1000) + 8 * 3600, // 8 hours
    },
    secret,
  );

  console.log(`[login] ${user.username} (${effectiveRole}) signed in`);

  return res.status(200).json({
    token,
    role:     effectiveRole,
    username: user.username,
  });
}
