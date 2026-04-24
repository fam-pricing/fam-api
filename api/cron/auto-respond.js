// fäm Living — Cron: auto-respond to PF leads + fire Trengo pf3 template
// Runs every minute via Vercel Cron (Pro plan).
// 1. Hits PF responseLink → marks lead as replied on PF, extracts lead phone
// 2. Sends pf3 WhatsApp template via Trengo Portal Leads channel → opens ticket assigned to Afifa

import { readCRMState, writeCRMState, ghRead, TRENGO_API, CRM_FILE, REF_MAP_FILE } from '../../lib/crm.js';

const PF_API        = 'https://atlas.propertyfinder.com';
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

// Read a JSON file from GitHub repo — uses lib/crm.js ghRead
async function fetchGHJson(filePath) {
  const { data } = await ghRead(filePath);
  return data || {};
}

// Build the {{1}} template value for a given PF ref:
// 1. Use the actual PF listing URL (ref_url_map) — lead can tap to see the property
// 2. Fall back to "BED in BUILDING" from ref_mapping
// 3. If ref looks like a standard PF ref (PF-HH-AR-XXXXX) but isn't mapped yet, return raw ref
// 4. Non-standard ref (not starting with PF-) → return generic fallback to avoid sending raw codes
function listingValueFromRef(ref, refMapping, refUrlMap) {
  if (!ref) return null;
  const url = refUrlMap[ref];
  if (url) return url;
  const mapping = refMapping[ref];
  if (mapping) return `${mapping.bed_type} in ${mapping.building}`;
  // Only use raw ref if it looks like a real PF reference number; otherwise use generic fallback
  if (ref.startsWith('PF-')) return ref;
  return 'one of our available properties';
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

const TRENGO_FIELD_LOCATION = 624322;
const TRENGO_FIELD_SIZE     = 624323;

async function updateTrengoTicketFields(ticketId, building, bedType) {
  const token = process.env.TRENGO_TOKEN;
  if (!token || !ticketId) return;
  const updates = [];
  if (building) updates.push({ custom_field_id: TRENGO_FIELD_LOCATION, value: building });
  if (bedType)  updates.push({ custom_field_id: TRENGO_FIELD_SIZE,     value: bedType  });
  await Promise.all(updates.map(body =>
    fetch(`${TRENGO_API}/tickets/${ticketId}/custom_fields`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    }).catch(err => console.error('[Trengo] updateTicketField error:', err.message))
  ));
  if (updates.length) console.log(`[Trengo] ticket ${ticketId} fields set: ${building} / ${bedType}`);
}

async function updateTrengoContactName(ticketId, name) {
  const token = process.env.TRENGO_TOKEN;
  if (!token || !ticketId || !name) return;
  try {
    const tr = await fetch(`${TRENGO_API}/tickets/${ticketId}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    if (!tr.ok) return;
    const ticket = await tr.json();
    const contactId = ticket.contact?.id;
    if (!contactId) return;
    await fetch(`${TRENGO_API}/contacts/${contactId}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ name }),
    });
    console.log(`[Trengo] contact ${contactId} renamed to "${name}"`);
  } catch (err) {
    console.error('[Trengo] updateContactName error:', err.message);
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

// readCRMState / writeCRMState — imported from lib/crm.js (Redis primary, GitHub fallback)

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

    // ── CIRCUIT BREAKER: Empty/tiny CRM state = data loss, NOT "all leads are new" ─────
    // Normal CRM has 100+ leads. If readCRMState returns < 10 entries,
    // something is critically wrong (Redis flush, GitHub empty, migration lost).
    // NEVER treat 50 "new" leads as real — that's the 600-ticket loop bug.
    const crmSize = Object.keys(crmState).length;
    if (crmSize < 10) {
      console.error(`[cron] CIRCUIT BREAKER: CRM state has only ${crmSize} entries — refusing to process. Fix data source.`);
      return res.status(200).json({
        ok: false,
        circuit_breaker: true,
        crm_size: crmSize,
        message: `CRM state suspiciously small (${crmSize} leads). Halting to prevent mass-send loop.`,
      });
    }

    // Only leads not yet auto-responded and with a responseLink
    const newLeads = rawLeads.filter(l => l.responseLink && !crmState[l.id]?.auto_responded);

    // ── BATCH LIMIT: Never send more than 5 templates in a single cron run ────────
    // Normal flow: 1-3 new leads per hour. If we see 10+, something is wrong
    // (stale CRM, duplicate cron invocations, PF API returning old leads).
    // Process at most 5, log a warning for the rest.
    const MAX_BATCH = 5;
    if (newLeads.length > MAX_BATCH) {
      console.warn(`[cron] BATCH LIMIT: ${newLeads.length} "new" leads detected — capping to ${MAX_BATCH}. Possible stale CRM state.`);
    }
    const cappedLeads = newLeads.slice(0, MAX_BATCH);

    if (cappedLeads.length === 0) {
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

    for (const lead of cappedLeads) {
      // 1. Hit PF responseLink → marks lead replied on PF, extracts lead phone
      const phone = await autoRespond(lead.responseLink);

      // 2. Build listing value: URL from ref_url_map, or title from ref_mapping
      const ref          = lead.listing?.reference || null;
      const listingTitle = listingValueFromRef(ref, refMapping, refUrlMap);

      let trengoTicketId = null;
      if (phone) {
        // 3. Check dedup BEFORE creating ticket — if phone already messaged in 24h, skip entirely
        //    Previously: ticket was created first, then template skipped → ghost ticket with no message
        //    (this caused bug tickets like 938428134: created + assigned but empty, not in CRM)
        const alreadyMessaged = recentlyMessaged.has(phone) || phonesThisBatch.has(phone);
        if (alreadyMessaged) {
          console.log(`[cron] Skipping lead ${lead.id} — phone ${phone} already sent template in last 24h (no ticket created)`);
        } else {
          // 4. Create Trengo ticket only when we will actually send a template
          trengoTicketId = await createTrengoTicket(phone);

          if (trengoTicketId) {
            // 5. Send pf3 template
            const templateSent = await sendTrengoTemplate(trengoTicketId, listingTitle);
            if (templateSent) phonesThisBatch.add(phone);
            // 6. Assign to Faysal — bot replies as Faysal, team picks up on escalation
            await assignTrengoTicket(trengoTicketId, 141332);
          }
        }
      }

      const leadName = lead.sender?.name || null;
      const mapping  = ref ? refMapping[ref] : null;
      // 6. Update Trengo contact name so inbox shows lead name not phone number
      if (trengoTicketId && leadName) await updateTrengoContactName(trengoTicketId, leadName);
      // 7. Set Location + Size ticket fields from ref mapping
      if (trengoTicketId && mapping) await updateTrengoTicketFields(trengoTicketId, mapping.building, mapping.bed_type);
      results.push({ id: lead.id, phone, listingTitle, trengoTicketId, leadName });
    }

    // Re-read CRM state right before writing to get fresh sha and detect race conditions.
    // Two cron instances can both read the same initial state (before either has written),
    // process the same leads, and create duplicate Trengo tickets. Re-reading here means:
    // - We use the current sha (avoid GitHub 409 conflict error)
    // - Any leads already written by the concurrent instance are skipped (no double-entry)
    const { state: freshState, sha: freshSha } = await readCRMState();

    for (const { id, phone, listingTitle, trengoTicketId, leadName } of results) {
      // Skip if another cron instance already processed this lead
      if (freshState[id]?.auto_responded) {
        console.log(`[cron] Race condition detected — lead ${id} already processed by another instance, skipping write`);
        continue;
      }
      freshState[id] = freshState[id] || { stage: 'new', notes: [] };
      freshState[id].auto_responded    = true;
      freshState[id].auto_responded_at = new Date().toISOString();
      if (phone)          freshState[id].pf_phone         = phone;
      if (listingTitle)   freshState[id].listing_title    = listingTitle;
      if (trengoTicketId) freshState[id].trengo_ticket_id = trengoTicketId;
      if (leadName)       freshState[id].lead_name        = leadName;
    }

    await writeCRMState(freshState, freshSha);

    const trengoCount = results.filter(r => r.trengoTicketId).length;
    console.log(`[cron] Responded: ${cappedLeads.length} PF leads, ${trengoCount} Trengo tickets created`);

    return res.status(200).json({
      ok: true,
      responded:      cappedLeads.length,
      total_new:       newLeads.length,
      batch_capped:    newLeads.length > MAX_BATCH,
      trengo_tickets:  trengoCount,
      crm_size:        crmSize,
      details:         results.map(r => ({ id: r.id, phone: r.phone, trengo: r.trengoTicketId })),
    });

  } catch (err) {
    console.error('[cron/auto-respond]', err);
    return res.status(500).json({ error: err.message });
  }
}
