// fäm Living — Cron: auto-respond to PF leads + fire Trengo pf3 template
// Runs every minute via Vercel Cron (Pro plan).
// 1. Hits PF responseLink → marks lead as replied on PF, extracts lead phone
// 2. Sends pf3 WhatsApp template via Trengo Portal Leads channel → opens ticket assigned to Afifa

const PF_API        = 'https://atlas.propertyfinder.com';
const GH_API        = 'https://api.github.com';
const TRENGO_API    = 'https://app.trengo.com/api/v2';
const REPO          = 'fam-pricing/fam-api';
const CRM_FILE      = 'data/crm_state.json';
const REF_MAP_FILE  = 'data/ref_mapping.json';
const REF_URL_FILE  = 'data/ref_url_map.json';
const TRENGO_CHANNEL = 1304636;  // Portal Leads (WA_BUSINESS)
const TRENGO_TEMPLATE = 229953;  // pf3
const AFIFA_ID       = 340123;   // Afifa A.

// ── PF helpers ────────────────────────────────────────────────────────────────

async function getPFToken() {
  const r = await fetch(`${PF_API}/v1/auth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiKey: process.env.PF_API_KEY, apiSecret: process.env.PF_API_SECRET }),
  });
  if (!r.ok) throw new Error(`PF auth failed: ${r.status}`);
  const d = await r.json();
  if (!d.accessToken) throw new Error('No PF accessToken');
  return d.accessToken;
}

async function fetchRecentLeads(token) {
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

// Read a JSON file from GitHub repo
async function fetchGHJson(filePath) {
  const ghToken = process.env.GH_TOKEN;
  if (!ghToken) return {};
  try {
    const r = await fetch(`${GH_API}/repos/${REPO}/contents/${filePath}`, {
      headers: { Authorization: `Bearer ${ghToken}`, Accept: 'application/vnd.github.v3+json' },
    });
    if (!r.ok) return {};
    const d = await r.json();
    const content = Buffer.from(d.content.replace(/\n/g, ''), 'base64').toString('utf8');
    return JSON.parse(content);
  } catch {
    return {};
  }
}

// Build the {{1}} template value for a given PF ref:
// 1. Use the actual PF listing URL (ref_url_map) — lead can tap to see the property
// 2. Fall back to "BED in BUILDING" from ref_mapping
// 3. Last resort: the raw ref string
function listingValueFromRef(ref, refMapping, refUrlMap) {
  if (!ref) return null;
  const url = refUrlMap[ref];
  if (url) return url;
  const mapping = refMapping[ref];
  if (mapping) return `${mapping.bed_type} in ${mapping.building}`;
  return ref;
}

// ── PF auto-respond ────────────────────────────────────────────────────────────

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

// ── Trengo helpers ─────────────────────────────────────────────────────────────

async function createTrengoTicket(phone) {
  const token = process.env.TRENGO_TOKEN;
  if (!token || !phone) return null;

  const cleanPhone = phone.replace(/^\+/, '');

  try {
    const r = await fetch(`${TRENGO_API}/tickets`, {
      method:  'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        channel_id:         TRENGO_CHANNEL,
        contact_identifier: cleanPhone,
      }),
    });
    const d = await r.json();
    if (!r.ok) { console.error('[Trengo] ticket creation failed:', r.status, JSON.stringify(d)); return null; }
    return d.id || null;
  } catch (err) {
    console.error('[Trengo] createTicket error:', err.message);
    return null;
  }
}

async function sendTrengoTemplate(ticketId, listingTitle) {
  const token = process.env.TRENGO_TOKEN;
  if (!token || !ticketId) return false;

  // Exact format the Trengo UI uses — ticket_id + params array with key/value/type
  try {
    const r = await fetch(`${TRENGO_API}/wa_sessions`, {
      method:  'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        hsm_id:    TRENGO_TEMPLATE,
        params:    [{ key: '{{1}}', value: listingTitle || 'your enquiry on Property Finder', type: 'body' }],
        source:    'trengo-app',
        ticket_id: ticketId,
      }),
    });
    const d = await r.json();
    if (!r.ok) { console.error('[Trengo] template send failed:', r.status, JSON.stringify(d)); return false; }
    console.log('[Trengo] template sent, message id:', d.message?.id);
    return true;
  } catch (err) {
    console.error('[Trengo] sendTemplate error:', err.message);
    return false;
  }
}

async function assignTrengoTicket(ticketId, userId) {
  const token = process.env.TRENGO_TOKEN;
  if (!token || !ticketId) return;
  try {
    const r = await fetch(`${TRENGO_API}/tickets/${ticketId}/assign`, {
      method:  'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ ticket_id: ticketId, user_id: userId, note: null, type: 'user' }),
    });
    if (!r.ok) console.error('[Trengo] assign failed:', r.status);
  } catch (err) {
    console.error('[Trengo] assign error:', err.message);
  }
}

// ── GitHub CRM state ──────────────────────────────────────────────────────────

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
    body: JSON.stringify({ message: 'CRM: auto-respond + Trengo [cron]', content, sha }),
  });
}

// ── Main handler ──────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = req.headers.authorization || '';
    if (auth !== `Bearer ${cronSecret}`) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  try {
    const pfToken  = await getPFToken();
    const rawLeads = await fetchRecentLeads(pfToken);
    const [{ state: crmState, sha }, refMapping, refUrlMap] = await Promise.all([
      readCRMState(),
      fetchGHJson(REF_MAP_FILE),
      fetchGHJson(REF_URL_FILE),
    ]);

    // Only leads not yet auto-responded and with a responseLink
    const newLeads = rawLeads.filter(l => l.responseLink && !crmState[l.id]?.auto_responded);

    if (newLeads.length === 0) {
      return res.status(200).json({ ok: true, responded: 0, message: 'No new leads' });
    }

    // Build set of phones that already received a template in the last 24h (from CRM history)
    // This prevents Meta 131049 error when the same person enquires on multiple listings
    const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;
    const recentlyMessaged = new Set();
    for (const lead of Object.values(crmState)) {
      if (lead.pf_phone && lead.auto_responded_at) {
        if (Date.now() - new Date(lead.auto_responded_at).getTime() < TWENTY_FOUR_HOURS_MS) {
          recentlyMessaged.add(lead.pf_phone);
        }
      }
    }

    // Process leads SEQUENTIALLY (not parallel) so phone dedup works within the same batch
    const results = [];
    const phonesThisBatch = new Set();

    for (const lead of newLeads) {
      // 1. Hit PF responseLink → marks lead replied on PF, extracts lead phone
      const phone = await autoRespond(lead.responseLink);

      // 2. Build listing value: URL from ref_url_map, or title from ref_mapping
      const ref          = lead.listing?.reference || null;
      const listingTitle = listingValueFromRef(ref, refMapping, refUrlMap);

      let trengoTicketId = null;
      if (phone) {
        // 3. Create Trengo ticket (always — one ticket per listing enquiry)
        trengoTicketId = await createTrengoTicket(phone);

        if (trengoTicketId) {
          // 4. Send pf3 template ONLY if this phone hasn't been messaged in the last 24h
          //    Prevents Meta 131049 error for leads who enquire on multiple listings at once
          const alreadyMessaged = recentlyMessaged.has(phone) || phonesThisBatch.has(phone);
          let templateSent = false;
          if (!alreadyMessaged) {
            templateSent = await sendTrengoTemplate(trengoTicketId, listingTitle);
            if (templateSent) phonesThisBatch.add(phone);
          } else {
            console.log(`[cron] Skipping template for ${phone} — already sent in last 24h (dedup)`);
          }
          // 5. Assign to Afifa regardless
          await assignTrengoTicket(trengoTicketId, AFIFA_ID);
        }
      }

      const leadName = lead.sender?.name || null;
      results.push({ id: lead.id, phone, listingTitle, trengoTicketId, leadName });
    }

    // Write results back to CRM state
    for (const { id, phone, listingTitle, trengoTicketId, leadName } of results) {
      crmState[id] = crmState[id] || { stage: 'new', notes: [] };
      crmState[id].auto_responded    = true;
      crmState[id].auto_responded_at = new Date().toISOString();
      if (phone)          crmState[id].pf_phone         = phone;
      if (listingTitle)   crmState[id].listing_title    = listingTitle;
      if (trengoTicketId) crmState[id].trengo_ticket_id = trengoTicketId;
      if (leadName)       crmState[id].lead_name        = leadName;
    }

    await writeCRMState(crmState, sha);

    const trengoCount = results.filter(r => r.trengoTicketId).length;
    console.log(`[cron] Responded: ${newLeads.length} PF leads, ${trengoCount} Trengo tickets created`);

    return res.status(200).json({
      ok: true,
      responded:     newLeads.length,
      trengo_tickets: trengoCount,
      details:        results.map(r => ({ id: r.id, phone: r.phone, trengo: r.trengoTicketId })),
    });

  } catch (err) {
    console.error('[cron/auto-respond]', err);
    return res.status(500).json({ error: err.message });
  }
}
