// fam Living — CRM leads endpoint
// GET /api/crm/leads?days=30
//
// Returns PF leads (last N days) merged with CRM stage/notes from GitHub.
// Role filtering:
//   owner  → all leads
//   agent  → only leads for listings assigned to them on PF
//   admin/viewer → nothing (no PF agent mapping)

import { requireAuth } from '../_auth.js';

const PF_API  = 'https://atlas.propertyfinder.com';
const GH_API  = 'https://api.github.com';
const REPO    = 'fam-pricing/fam-api';
const CRM_FILE = 'data/crm_state.json';

// Known PF publicProfile ID → { name, username }
// username matches the login username in USERS env var
const AGENT_MAP = {
  239575: { name: 'Afifa Al Shami', username: 'afifa' },
  280624: { name: 'Ahmed A.',       username: 'ahmed' },
  237124: { name: 'Joel V.',        username: 'joel'  },
  // Sobhi and Mona: IDs will be discovered from live leads and added here
};

// username → PF publicProfile ID (reverse map for filtering)
const USERNAME_TO_PFID = {
  afifa:   239575,
  ahmed:   280624,
  joel:    237124,
  // sobhi and mona: add IDs when discovered
};

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

async function fetchListings(token) {
  const all = [];
  let page = 1;
  while (true) {
    const r = await fetch(`${PF_API}/v1/listings?perPage=100&page=${page}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) break;
    const d = await r.json();
    all.push(...(d.results || []));
    if (!d.pagination?.nextPage) break;
    page++;
  }
  return all;
}

async function fetchLeads(token, days) {
  const all = [];
  const now  = new Date();
  const from = new Date(now.getTime() - days * 86400_000);
  const fromStr = from.toISOString();
  const toStr   = now.toISOString();
  let page = 1;
  while (page <= 25) { // max 1250 leads
    const r = await fetch(
      `${PF_API}/v1/leads?perPage=50&page=${page}&createdAtFrom=${fromStr}&createdAtTo=${toStr}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!r.ok) break;
    const d = await r.json();
    const batch = d.data || d.results || [];
    all.push(...batch);
    if (!d.pagination?.nextPage) break;
    page++;
  }
  return all;
}

async function readCRMState() {
  const ghToken = process.env.GH_TOKEN;
  if (!ghToken) return { state: {}, sha: null };
  const r = await fetch(`${GH_API}/repos/${REPO}/contents/${CRM_FILE}`, {
    headers: {
      Authorization: `Bearer ${ghToken}`,
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
    body: JSON.stringify({
      message: 'CRM: auto-respond new leads',
      content,
      sha,
    }),
  });
}

// Hit responseLink so PF marks the lead as RESPONDED (preserves response rate).
// Returns the lead phone extracted from the wa.me redirect URL (if available).
async function autoRespond(responseLink) {
  if (!responseLink) return null;
  try {
    const r = await fetch(responseLink, { redirect: 'manual' });
    const location = r.headers.get('location') || '';
    // location = https://api.whatsapp.com/send?phone=971XXXXXXX&text=...
    const match = location.match(/[?&]phone=(\d+)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const user = requireAuth(req, res);
  if (!user) return;

  const days = Math.min(parseInt(req.query?.days || '30', 10) || 30, 90);
  const isOwner = (user.role === 'owner');
  const userPfId = USERNAME_TO_PFID[user.username] ?? null;

  // Non-owner, non-agent: no CRM access (e.g. viewer)
  if (!isOwner && !userPfId && user.role !== 'admin') {
    return res.status(200).json({ leads: [], total: 0 });
  }

  try {
    const pfToken = await getPFToken();

    const [rawListings, rawLeads, { state: crmState }] = await Promise.all([
      fetchListings(pfToken),
      fetchLeads(pfToken, days),
      readCRMState(),
    ]);

    // Build profileId → agent info (extend AGENT_MAP with live listing data)
    const profileMap = { ...AGENT_MAP };
    for (const lst of rawListings) {
      const a = lst.assignedTo;
      if (a?.id && !profileMap[a.id]) {
        profileMap[a.id] = { name: a.name, username: null };
      }
    }

    // Load ref_mapping for building names
    const refMapping = require('../../data/ref_mapping.json');

    // --- AUTO-RESPOND: hit responseLink for any lead not yet responded to ---
    // Fire all requests in parallel, update crmState, write back once.
    const newLeads = rawLeads.filter(l => l.responseLink && !crmState[l.id]?.auto_responded);
    let stateChanged = false;
    if (newLeads.length > 0) {
      const results = await Promise.all(
        newLeads.map(async l => ({
          id: l.id,
          phone: await autoRespond(l.responseLink),
        }))
      );
      for (const { id, phone } of results) {
        crmState[id] = crmState[id] || { stage: 'new', notes: [] };
        crmState[id].auto_responded = true;
        crmState[id].auto_responded_at = new Date().toISOString();
        if (phone) crmState[id].pf_phone = phone;
        stateChanged = true;
      }
      if (stateChanged) {
        // Re-read SHA fresh before writing to avoid conflicts
        const { sha: freshSha } = await readCRMState();
        await writeCRMState(crmState, freshSha);
      }
    }
    // --- END AUTO-RESPOND ---

    const leads = [];
    for (const l of rawLeads) {
      const profileId = l.publicProfile?.id ?? null;

      // Filter by agent
      if (!isOwner) {
        if (userPfId && profileId !== userPfId) continue;
        if (!userPfId) continue; // admin/viewer with no PF ID — skip
      }

      const agentInfo = profileId ? (profileMap[profileId] || { name: `Agent #${profileId}`, username: null }) : { name: '—', username: null };
      const ref       = l.listing?.reference || '';
      const mapping   = refMapping[ref] || null;
      const building  = mapping ? mapping.building : (ref.startsWith('PF-HH-AR-') ? ref : '—');
      const bed_type  = mapping?.bed_type || '';
      const phone     = (l.sender?.contacts || []).find(c => c.type === 'phone')?.value || '';
      const crm       = crmState[l.id] || { stage: 'new', notes: [], closed_price: null, lost_reason: null };

      leads.push({
        id:               l.id,
        channel:          l.channel || 'whatsapp',
        createdAt:        l.createdAt,
        sender_name:      l.sender?.name || '—',
        sender_phone:     phone,
        building,
        bed_type,
        listing_ref:      ref,
        pf_status:        (l.status || 'delivered').toUpperCase(),
        agent_name:       agentInfo.name,
        agent_username:   agentInfo.username,
        agent_pf_id:      profileId,
        crm_stage:        crm.stage || 'new',
        crm_notes:        crm.notes || [],
        crm_closed_price: crm.closed_price ?? null,
        crm_lost_reason:  crm.lost_reason  ?? null,
        crm_updated_at:   crm.updated_at   ?? null,
        crm_updated_by:   crm.updated_by   ?? null,
        auto_responded:     crm.auto_responded || false,
        crm_auto_responded:   crm.auto_responded || false,
        crm_trengo_ticket:    crm.trengo_ticket_id || null,
        crm_viewing_requested: crm.viewing_requested || null,
        crm_bot_paused:       crm.bot_paused || false,
        crm_last_bot_reply_at: crm.last_bot_reply_at || null,
        crm_last_agent_reply_at: crm.last_agent_reply_at || null,
      });
    }

    // Newest first
    leads.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    return res.status(200).json({ leads, total: leads.length, days, auto_responded: newLeads.length });

  } catch (err) {
    console.error('[crm/leads]', err);
    return res.status(500).json({ error: err.message });
  }
}
