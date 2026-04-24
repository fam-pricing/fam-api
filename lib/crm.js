// fäm Living — CRM abstraction layer
// GitHub-only backend. Simple, reliable, no external dependencies.
// Removed Upstash Redis — hit 500k request limit, caused mass-send flood 2026-04-23.

const GH_API = 'https://api.github.com';
const REPO   = 'fam-pricing/fam-api';

// ── File paths ────────────────────────────────────────────────────────────────
export const CRM_FILE      = 'data/crm_state.json';
export const PENDING_FILE  = 'data/pending_escalations.json';
export const PLAYBOOK_FILE = 'data/playbook.md';
export const LISTINGS_FILE = 'data/listings.json';
export const REF_MAP_FILE  = 'data/ref_mapping.json';
export const METRICS_FILE  = 'data/bot_metrics.json';

// ── Low-level GitHub helpers ──────────────────────────────────────────────────
export async function ghRead(file) {
  const ghToken = process.env.GH_TOKEN;
  if (!ghToken) return { data: null, sha: null };
  const r = await fetch(`${GH_API}/repos/${REPO}/contents/${file}`, {
    headers: { Authorization: `Bearer ${ghToken}`, Accept: 'application/vnd.github.v3+json' },
  });
  if (!r.ok) return { data: null, sha: null };
  const d = await r.json();
  try {
    return {
      data: JSON.parse(Buffer.from(d.content.replace(/\n/g, ''), 'base64').toString('utf8')),
      sha: d.sha,
    };
  } catch {
    return { data: null, sha: d.sha };
  }
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
  } catch {
    return { text: '', sha: d.sha };
  }
}

export async function ghWrite(file, data, sha, message) {
  const ghToken = process.env.GH_TOKEN;
  if (!ghToken) return;
  const content = Buffer.from(
    typeof data === 'string' ? data : JSON.stringify(data, null, 2)
  ).toString('base64');

  // Retry loop: if SHA conflicts (409), re-read fresh SHA and retry.
  // This prevents the silent-fail loop where CRM never updates and leads
  // get reprocessed every minute (root cause of the mass-send incident).
  const MAX_RETRIES = 3;
  let currentSha = sha;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const r = await fetch(`${GH_API}/repos/${REPO}/contents/${file}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${ghToken}`,
        Accept: 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ message, content, sha: currentSha }),
    });

    if (r.ok) return; // Success

    if (r.status === 409 && attempt < MAX_RETRIES - 1) {
      // SHA conflict — another write happened between our read and write.
      // Re-read the file to get the fresh SHA and retry.
      console.warn(`[crm] ghWrite 409 conflict on ${file} (attempt ${attempt + 1}/${MAX_RETRIES}) — retrying with fresh SHA`);
      const freshRead = await fetch(`${GH_API}/repos/${REPO}/contents/${file}`, {
        headers: { Authorization: `Bearer ${ghToken}`, Accept: 'application/vnd.github.v3+json' },
      });
      if (freshRead.ok) {
        const freshData = await freshRead.json();
        currentSha = freshData.sha;
      } else {
        console.error(`[crm] ghWrite: failed to re-read SHA for ${file}: ${freshRead.status}`);
        return;
      }
    } else {
      // Non-409 error or final retry exhausted
      const body = await r.text().catch(() => '');
      console.error(`[crm] ghWrite FAILED on ${file}: ${r.status} ${body.slice(0, 200)}`);
      return;
    }
  }
}

// ── CRM state ─────────────────────────────────────────────────────────────────
export async function readCRMState() {
  const { data, sha } = await ghRead(CRM_FILE);
  const state = data || {};
  const size = Object.keys(state).length;
  if (size === 0) {
    console.error('[crm] CRITICAL: CRM state is EMPTY — possible data loss.');
  }
  return { state, sha };
}

export async function writeCRMState(state, sha) {
  await ghWrite(CRM_FILE, state, sha, 'CRM: auto-reply [bot]');
}

export async function readLead(leadId) {
  const { state } = await readCRMState();
  return state[leadId] || null;
}

export async function writeLead(leadId, leadData) {
  const { state, sha } = await readCRMState();
  state[leadId] = leadData;
  await writeCRMState(state, sha);
}

// ── Pending escalations ───────────────────────────────────────────────────────
export async function readPendingEsc() {
  const { data, sha } = await ghRead(PENDING_FILE);
  return {
    esc: data || { faysal_ticket_id: null, current_question_id: null, pending: [] },
    sha,
  };
}

export async function writePendingEsc(esc, sha) {
  await ghWrite(PENDING_FILE, esc, sha, 'Bot: pending escalations update');
}

// ── Playbook ──────────────────────────────────────────────────────────────────
export async function loadPlaybook() {
  const { text } = await ghReadText(PLAYBOOK_FILE);
  return text || '';
}

export async function appendToPlaybook(rule) {
  const { text, sha } = await ghReadText(PLAYBOOK_FILE);
  await ghWrite(PLAYBOOK_FILE, text + '\n' + rule, sha, 'Playbook: new rule [bot]');
}

// ── Listings / ref mapping ────────────────────────────────────────────────────
export async function loadListings() {
  const { data } = await ghRead(LISTINGS_FILE);
  return data || [];
}

export async function loadRefMapping() {
  const { data } = await ghRead(REF_MAP_FILE);
  return data || {};
}

// ── Metrics ───────────────────────────────────────────────────────────────────
export async function readMetrics() {
  const { data, sha } = await ghRead(METRICS_FILE);
  return { metrics: data || [], sha };
}

export async function writeMetrics(metrics, sha) {
  await ghWrite(METRICS_FILE, metrics, sha, 'Metrics: update [bot]');
}

export async function appendMetricEvent(event) {
  // Fire-and-forget — caller handles this
}

// ── Trengo constants ──────────────────────────────────────────────────────────
export const TRENGO_API = 'https://app.trengo.com/api/v2';

// ── Dubai time helpers ────────────────────────────────────────────────────────
export const DUBAI_OFFSET_HOURS = 4;
export function getDubaiHour()  { return (new Date().getUTCHours() + DUBAI_OFFSET_HOURS) % 24; }
export function getDubaiDate()  { return new Date(Date.now() + DUBAI_OFFSET_HOURS * 3600000); }
export function isNightShift()  { const h = getDubaiHour(); return h >= 21 || h < 6; }

// ── User IDs ──────────────────────────────────────────────────────────────────
export const FAYSAL_USER_ID = 141332;
