// Shared JWT helpers — HS256, no external deps
import crypto from 'crypto';

function b64url(input) {
  const str = typeof input === 'string' ? input : JSON.stringify(input);
  return Buffer.from(str).toString('base64')
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function b64urlDecode(str) {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(padded, 'base64').toString('utf8');
}

export function signJWT(payload, secret) {
  const header = b64url({ alg: 'HS256', typ: 'JWT' });
  const body   = b64url(payload);
  const sig    = crypto.createHmac('sha256', secret)
    .update(`${header}.${body}`).digest('base64')
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${header}.${body}.${sig}`;
}

export function verifyJWT(token, secret) {
  if (!token) throw new Error('No token');
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Malformed token');
  const [header, body, sig] = parts;
  const expected = crypto.createHmac('sha256', secret)
    .update(`${header}.${body}`).digest('base64')
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  if (sig !== expected) throw new Error('Invalid signature');
  const payload = JSON.parse(b64urlDecode(body));
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) throw new Error('Token expired');
  return payload;
}

// Role hierarchy: owner > admin > viewer > agent
const ROLE_LEVEL = { agent: 1, viewer: 2, admin: 3, owner: 4 };

// Extract and verify JWT from Authorization: Bearer <token> header
// requiredRole = minimum role required (owner satisfies admin check, admin satisfies viewer check)
export function requireAuth(req, res, requiredRole) {
  const secret = process.env.JWT_SECRET;
  if (!secret) { res.status(500).json({ error: 'JWT_SECRET not configured' }); return null; }
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) { res.status(401).json({ error: 'Not authenticated' }); return null; }
  try {
    const payload = verifyJWT(token, secret);
    if (requiredRole) {
      const userLevel = ROLE_LEVEL[payload.role] || 0;
      const needLevel = ROLE_LEVEL[requiredRole] || 0;
      if (userLevel < needLevel) {
        res.status(403).json({ error: 'Insufficient permissions' }); return null;
      }
    }
    return payload;
  } catch (e) {
    res.status(401).json({ error: e.message }); return null;
  }
}

export function hashPassword(pw) {
  return crypto.createHash('sha256').update(pw).digest('hex');
}
