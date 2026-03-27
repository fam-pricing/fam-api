// fam Living — Cron: auto-respond to new PF leads
// Runs every minute via Vercel Cron.
// Hits the PF responseLink for any lead not yet auto-responded,
// preserving fäm Living's response rate on Property Finder.

const PF_API   = 'https://atlas.propertyfinder.com';
const GH_API   = 'https://api.github.com';
const REPO     = 'fam-pricing/fam-api';
const CRM_FILE = 'data/crm_state.json';

async function getPFToken() {
  const r = await fetch(`${PF_API}/v1/auth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiKey: process.env.PF_API_KEY, apiSecret: process.env.PF_API_SECRET }),
  });
  if (!r.ok) throw new Error(`PF auth failed: ${r.status}`);
  const d = await r.json();
  if (!d.accessToken) throw new Error('No accessToken');
  return d.accessToken;
}

async function fetchRecentLeads(token) {
  // Fetch last 2 days only — we only care about new leads
  const now  = new Date();
  const from = new Date(now.getTime() - 2 * 86400_000);
  const r = await fetch(
    `${PF_API}/v1/leads?perPage=50&page=1&createdAtFrom=${from.toISOString()}&createdAtTo=${now.toISOString()}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!r.ok) return [];
  const d = await r.json();
  return d.data || d.results || [];
}

async function readCRMState() {
  const ghToken = process.env.GH_TOKEN;
  if (!ghToken) return { state: {}, sha: null };
  const r = await fetch(`${GH_API}/repos/${REPO}/contents/${CRM_FILE}`, {
    headers: { Authorization: `Bearer ${ghToken}`, Accept: 'application/vnd.github.v3+json' },
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

async function writeCRMState(state, sha) {
  const ghToken = process.env.GH_TOKEN;
  if (!ghToken) return;
  const content = Buffer.from(JSON.stringify(state, null, 2)).toString('base64');
  await fetch(`${GH_API}/repos/${REPO}/contents/${CRM_FILE}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${ghToken}`,
      Accept: 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ message: 'CRM: auto-respond new leads [cron]', content, sha }),
  });
}

async function autoRespond(responseLink) {
  if (!responseLink) return null;
  try {
    const r = await fetch(responseLink, { redirect: 'manual' });
    const location = r.headers.get('location') || '';
    const match = location.match(/[?&]phone=(\d+)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  // Vercel cron passes Authorization: Bearer CRON_SECRET
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = req.headers.authorization || '';
    if (auth !== `Bearer ${cronSecret}`) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  try {
    const pfToken = await getPFToken();
    const rawLeads = await fetchRecentLeads(pfToken);

    const { state: crmState, sha } = await readCRMState();

    // Only process leads without auto_responded flag
    const newLeads = rawLeads.filter(l => l.responseLink && !crmState[l.id]?.auto_responded);

    if (newLeads.length === 0) {
      return res.status(200).json({ ok: true, responded: 0, message: 'No new leads' });
    }

    // Fire all response links in parallel
    const results = await Promise.all(
      newLeads.map(async l => ({
        id: l.id,
        phone: await autoRespond(l.responseLink),
      }))
    );

    for (const { id, phone } of results) {
      crmState[id] = crmState[id] || { stage: 'new', notes: [] };
      crmState[id].auto_responded     = true;
      crmState[id].auto_responded_at  = new Date().toISOString();
      if (phone) crmState[id].pf_phone = phone;
    }

    await writeCRMState(crmState, sha);

    console.log(`[cron/auto-respond] Responded to ${newLeads.length} new leads`);
    return res.status(200).json({ ok: true, responded: newLeads.length });

  } catch (err) {
    console.error('[cron/auto-respond]', err);
    return res.status(500).json({ error: err.message });
  }
}
