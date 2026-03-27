// fäm Living — Cron: auto-respond to PF leads + fire Trengo pf3 template
// Runs every minute via Vercel Cron (Pro plan).
// 1. Hits PF responseLink → marks lead as replied on PF, extracts lead phone
// 2. Sends pf3 WhatsApp template via Trengo Portal Leads channel → opens ticket assigned to Afifa

const PF_API        = 'https://atlas.propertyfinder.com';
const GH_API        = 'https://api.github.com';
const TRENGO_API    = 'https://app.trengo.com/api/v2';
const REPO          = 'fam-pricing/fam-api';
const CRM_FILE      = 'data/crm_state.json';
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

async function fetchListingTitle(pfToken, listingULID) {
  try {
    const r = await fetch(`${PF_API}/v1/listings/${listingULID}`, {
      headers: { Authorization: `Bearer ${pfToken}` },
    });
    if (!r.ok) return null;
    const d = await r.json();
    // Build a readable title: bedrooms + property type + area
    const beds = d.bedrooms != null ? `${d.bedrooms}BR ` : '';
    const type = d.propertyType?.name || d.category || '';
    const area = d.location?.community?.name || d.location?.area?.name || '';
    const ref  = d.referenceNumber || listingULID;
    return `${beds}${type}${area ? ' in ' + area : ''} (${ref})`.trim();
  } catch {
    return null;
  }
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

async function sendTrengoTemplate(phone, listingTitle) {
  const token = process.env.TRENGO_TOKEN;
  if (!token || !phone) return null;

  // Trengo expects phone without leading + but with country code
  const cleanPhone = phone.replace(/^\+/, '');

  const body = {
    channel_id:          TRENGO_CHANNEL,
    contact_identifier:  cleanPhone,
    wa_template_id:      TRENGO_TEMPLATE,
    wa_template_values:  [listingTitle || 'your enquiry'],
    assignee_id:         AFIFA_ID,
  };

  try {
    const r = await fetch(`${TRENGO_API}/tickets`, {
      method:  'POST',
      headers: {
        Authorization:  `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept:         'application/json',
      },
      body: JSON.stringify(body),
    });
    const d = await r.json();
    if (!r.ok) {
      console.error('[Trengo] ticket creation failed:', r.status, JSON.stringify(d));
      return null;
    }
    // Return ticket id
    return d.id || d.ticket?.id || null;
  } catch (err) {
    console.error('[Trengo] error:', err.message);
    return null;
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
    const { state: crmState, sha } = await readCRMState();

    // Only leads not yet auto-responded and with a responseLink
    const newLeads = rawLeads.filter(l => l.responseLink && !crmState[l.id]?.auto_responded);

    if (newLeads.length === 0) {
      return res.status(200).json({ ok: true, responded: 0, message: 'No new leads' });
    }

    // Process each new lead: PF auto-respond + Trengo template
    const results = await Promise.all(newLeads.map(async lead => {
      // 1. Hit PF responseLink → extracts lead phone from WhatsApp redirect
      const phone = await autoRespond(lead.responseLink);

      // 2. Fetch listing title for template {{1}} variable
      const listingULID = lead.listing?.id;
      const listingTitle = listingULID
        ? await fetchListingTitle(pfToken, listingULID)
        : (lead.listing?.reference || null);

      // 3. Send Trengo pf3 template (only if we have a phone number)
      const trengoTicketId = phone
        ? await sendTrengoTemplate(phone, listingTitle)
        : null;

      return { id: lead.id, phone, listingTitle, trengoTicketId };
    }));

    // Write results back to CRM state
    for (const { id, phone, listingTitle, trengoTicketId } of results) {
      crmState[id] = crmState[id] || { stage: 'new', notes: [] };
      crmState[id].auto_responded    = true;
      crmState[id].auto_responded_at = new Date().toISOString();
      if (phone)          crmState[id].pf_phone       = phone;
      if (listingTitle)   crmState[id].listing_title  = listingTitle;
      if (trengoTicketId) crmState[id].trengo_ticket_id = trengoTicketId;
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
