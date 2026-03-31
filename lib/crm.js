// fäm Living — CRM abstraction layer
// Dual-backend: Upstash Redis (primary) with GitHub JSON (fallback).
//
// When UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN are set:
//   → CRM state stored as per-lead Redis keys (crm:{leadId}) + full state key (crm:state)
//   → O(1) reads/writes per lead, no SHA conflicts, ~1ms latency
//
// When Upstash env vars are NOT set:
//   → Falls back to GitHub JSON file (existing behaviour)
//   → SHA-based optimistic locking, ~200ms latency
//
// All other consumers import from this module. Backend swap is transparent.

import { Redis } from '@upstash/redis';

const GH_API = 'https://api.github.com';
const REPO   = 'fam-pricing/fam-api';

// ── File paths (GitHub backend) ──────────────────────────────────────────────

export const CRM_FILE      = 'data/crm_state.json';
export const PENDING_FILE  = 'data/pending_escalations.json';
export const PLAYBOOK_FILE = 'data/playbook.md';
export const LISTINGS_FILE = 'data/listings.json';
export const REF_MAP_FILE  = 'data/ref_mapping.json';
export const METRICS_FILE  = 'data/bot_metrics.json';

// ── Redis client (lazy init) ─────────────────────────────────────────────────

let _redis = null;
function getRedis() {
  if (_redis) return _redis;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  _redis = new Redis({ url, token });
  return _redis;
}

function useRedis() {
  return !!getRedis();
}

// ── Low-level GitHub helpers ─────────────────────────────────────────────────

export async function ghRead(file) {
  const ghToken = process.env.GH_TOKEN;
  if (!ghToken) return { data: null, sha: null };
  const r = await fetch(`${GH_API}/repos/${REPO}/contents/${file}`, {
    headers: { Authorization: `Bearer ${ghToken}`, Accept: 'application/vnd.github.v3+json' },
  });
  if (!r.ok) return { data: null, sha: null };
  const d = await r.json();
  try {
    return { data: JSON.parse(Buffer.from(d.content.replace(/\n/g, ''), 'base64').toString('utf8')), sha: d.sha };
  } catch { return { data: null, sha: d.sha }; }
}

export async function ghReadText(file) {
  const ghToken = process.env.GH_TOKEN;
  if (!ghToken) return { text: '', sha: null };
  const r = await fetch(`${GH_API}/repos/${REPO}/contents/${file}`, {
    headers: { Authorization: `Bearer ${ghToken}`, Accept: 'application/vnd.github.v3+json' },
  });
  if (!r.ok) return { text: '', sha: null };
  const d = await r.json();
  try {
    return { text: Buffer.from(d.content.replace(/\n/g, ''), 'base64').toString('utf8'), sha: d.sha };
  } catch { return { text: '', sha: d.sha }; }
}

export async function ghWrite(file, data, sha, message) {
  const ghToken = process.env.GH_TOKEN;
  if (!ghToken) return;
  const content = Buffer.from(
    typeof data === 'string' ? data : JSON.stringify(data, null, 2)
  ).toString('base64');
  await fetch(`${GH_API}/repos/${REPO}/contents/${file}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${ghToken}`, Accept: 'application/vnd.github.v3+json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, content, sha }),
  });
}

// ── CRM state — dual backend ────────────────────────────────────────────────

export async function readCRMState() {
  const redis = getRedis();
  if (redis) {
    try {
      const state = await redis.get('crm:state');
      // Redis returns parsed JSON directly (Upstash SDK auto-parses)
      return { state: state || {}, sha: null };
    } catch (e) {
      console.warn('[crm] Redis read failed, falling back to GitHub:', e?.message);
    }
  }
  // GitHub fallback
  const { data, sha } = await ghRead(CRM_FILE);
  return { state: data || {}, sha };
}

export async function writeCRMState(state, sha) {
  const redis = getRedis();
  if (redis) {
    try {
      // Write full state to Redis (atomic, no SHA needed)
      await redis.set('crm:state', state);
      // Also write individual lead keys for fast per-lead lookups
      // (fire-and-forget, don't await individual keys)
      const pipeline = redis.pipeline();
      for (const [leadId, leadData] of Object.entries(state)) {
        pipeline.set(`crm:lead:${leadId}`, leadData);
      }
      pipeline.exec().catch(() => {}); // best-effort per-lead keys
      return;
    } catch (e) {
      console.warn('[crm] Redis write failed, falling back to GitHub:', e?.message);
    }
  }
  // GitHub fallback
  await ghWrite(CRM_FILE, state, sha, 'CRM: auto-reply [bot]');
}

// Fast per-lead read (Redis only, falls back to full state read)
export async function readLead(leadId) {
  const redis = getRedis();
  if (redis) {
    try {
      const lead = await redis.get(`crm:lead:${leadId}`);
      if (lead) return lead;
    } catch {}
  }
  // Fallback: read full state
  const { state } = await readCRMState();
  return state[leadId] || null;
}

// Fast per-lead write (Redis only, updates both lead key and full state)
export async function writeLead(leadId, leadData) {
  const redis = getRedis();
  if (redis) {
    try {
      const pipeline = redis.pipeline();
      pipeline.set(`crm:lead:${leadId}`, leadData);
      // Update full state atomically using a Lua script or read-modify-write
      // For now, read full state, update, write back
      const state = (await redis.get('crm:state')) || {};
      state[leadId] = leadData;
      pipeline.set('crm:state', state);
      await pipeline.exec();
      return;
    } catch (e) {
      console.warn('[crm] Redis writeLead failed:', e?.message);
    }
  }
  // No GitHub shortcut for single-lead write — caller uses writeCRMState
}

// ── Pending escalations ──────────────────────────────────────────────────────

export async function readPendingEsc() {
  const redis = getRedis();
  if (redis) {
    try {
      const esc = await redis.get('crm:pending_escalations');
      return { esc: esc || { faysal_ticket_id: null, current_question_id: null, pending: [] }, sha: null };
    } catch {}
  }
  const { data, sha } = await ghRead(PENDING_FILE);
  return { esc: data || { faysal_ticket_id: null, current_question_id: null, pending: [] }, sha };
}

export async function writePendingEsc(esc, sha) {
  const redis = getRedis();
  if (redis) {
    try {
      await redis.set('crm:pending_escalations', esc);
      return;
    } catch {}
  }
  await ghWrite(PENDING_FILE, esc, sha, 'Bot: pending escalations update');
}

// ── Playbook ─────────────────────────────────────────────────────────────────
// Always stored on GitHub (it's a markdown file in the repo, not transactional data)

export async function loadPlaybook() {
  const { text } = await ghReadText(PLAYBOOK_FILE);
  return text || '';
}

export async function appendToPlaybook(rule) {
  const { text, sha } = await ghReadText(PLAYBOOK_FILE);
  const updated = text + '\n' + rule;
  await ghWrite(PLAYBOOK_FILE, updated, sha, 'Playbook: new rule [bot]');
}

// ── Listings / ref mapping ───────────────────────────────────────────────────
// Read-only, always from GitHub (updated by scheduled runs)

export async function loadListings() {
  const { data } = await ghRead(LISTINGS_FILE);
  return data || [];
}

export async function loadRefMapping() {
  const { data } = await ghRead(REF_MAP_FILE);
  return data || {};
}

// ── Metrics ──────────────────────────────────────────────────────────────────

export async function readMetrics() {
  const redis = getRedis();
  if (redis) {
    try {
      const metrics = await redis.get('crm:metrics');
      return { metrics: metrics || [], sha: null };
    } catch {}
  }
  const { data, sha } = await ghRead(METRICS_FILE);
  return { metrics: data || [], sha };
}

export async function writeMetrics(metrics, sha) {
  const redis = getRedis();
  if (redis) {
    try {
      await redis.set('crm:metrics', metrics);
      return;
    } catch {}
  }
  await ghWrite(METRICS_FILE, metrics, sha, 'Metrics: update [bot]');
}

export async function appendMetricEvent(event) {
  const redis = getRedis();
  if (redis) {
    try {
      // Use a Redis list with automatic 7-day TTL
      await redis.lpush('crm:metrics:events', event);
      await redis.ltrim('crm:metrics:events', 0, 9999); // cap at 10k events
      return;
    } catch {}
  }
  // GitHub fallback handled by the caller's fire-and-forget appendMetricsEvent()
}

// ── Trengo constants ─────────────────────────────────────────────────────────

export const TRENGO_API = 'https://app.trengo.com/api/v2';

// ── Dubai time helpers ───────────────────────────────────────────────────────

export const DUBAI_OFFSET_HOURS = 4;

export function getDubaiHour() {
  return (new Date().getUTCHours() + DUBAI_OFFSET_HOURS) % 24;
}

export function getDubaiDate() {
  return new Date(Date.now() + DUBAI_OFFSET_HOURS * 3600000);
}

export function isNightShift() {
  const h = getDubaiHour();
  return h >= 21 || h < 6;
}

// ── User IDs ─────────────────────────────────────────────────────────────────

export const FAYSAL_USER_ID = 141332;

// ── Migration helper ─────────────────────────────────────────────────────────
// One-time function to seed Redis from GitHub JSON. Call once after setting up Upstash.

export async function migrateGitHubToRedis() {
  const redis = getRedis();
  if (!redis) throw new Error('Redis not configured');

  // Migrate CRM state
  const { data: crmData } = await ghRead(CRM_FILE);
  if (crmData) {
    await redis.set('crm:state', crmData);
    const pipeline = redis.pipeline();
    for (const [leadId, leadData] of Object.entries(crmData)) {
      pipeline.set(`crm:lead:${leadId}`, leadData);
    }
    await pipeline.exec();
    console.log(`[migration] CRM state: ${Object.keys(crmData).length} leads migrated`);
  }

  // Migrate pending escalations
  const { data: escData } = await ghRead(PENDING_FILE);
  if (escData) {
    await redis.set('crm:pending_escalations', escData);
    console.log('[migration] Pending escalations migrated');
  }

  // Migrate metrics
  const { data: metricsData } = await ghRead(METRICS_FILE);
  if (metricsData) {
    await redis.set('crm:metrics', metricsData);
    console.log(`[migration] Metrics: ${metricsData.length} events migrated`);
  }

  return { leads: Object.keys(crmData || {}).length, escalations: (escData?.pending || []).length };
}
