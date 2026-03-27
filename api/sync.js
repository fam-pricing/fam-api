// fam Living — Sync endpoint
// GET /api/sync
// Returns fresh pub prices, listing tiers, and lead counts from PF Enterprise API.
// No browser needed — all data from atlas.propertyfinder.com.

const PF_API = 'https://atlas.propertyfinder.com';

const BED_OVERRIDES = {
  'Burj Crown|3BR':        '4BR',
  'Sunrise Bay T1|3BR':    '4BR',
  'Reehan 1 Old Town|2BR': '3BR',
  'Marina Star|Studio':    '1BR',
  'City Walk B18B|2BR':    '3BR',
  'City Walk B19|3BR':     '4BR',
};

async function getToken() {
  const r = await fetch(`${PF_API}/v1/auth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiKey: process.env.PF_API_KEY, apiSecret: process.env.PF_API_SECRET }),
  });
  if (!r.ok) throw new Error(`Auth failed: ${r.status}`);
  const d = await r.json();
  if (!d.accessToken) throw new Error('No accessToken in auth response');
  return d.accessToken;
}

async function fetchAllListings(token) {
  const all = [];
  let page = 1;
  while (true) {
    const r = await fetch(`${PF_API}/v1/listings?perPage=100&page=${page}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) throw new Error(`Listings fetch failed: ${r.status}`);
    const d = await r.json();
    all.push(...d.results);
    if (!d.pagination.nextPage) break;
    page++;
  }
  return all;
}

async function fetchLeads(token) {
  const all = [];
  const now = new Date();
  const from = new Date(now.getTime() - 7 * 24 * 3600 * 1000);
  const fromStr = from.toISOString().replace('.000Z', 'Z');
  const toStr   = now.toISOString().replace('.000Z', 'Z');
  let page = 1;
  while (true) {
    const r = await fetch(
      `${PF_API}/v1/leads?perPage=50&page=${page}&createdAtFrom=${fromStr}&createdAtTo=${toStr}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!r.ok) break; // leads are non-critical — don't throw
    const d = await r.json();
    all.push(...(d.data || d.results || []));
    if (!d.pagination?.nextPage) break;
    page++;
  }
  return all;
}

import { requireAuth } from './_auth.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  // Any authenticated user (admin or viewer) can sync
  const user = requireAuth(req, res);
  if (!user) return;

  try {
    const token = await getToken();
    const [rawListings, leads] = await Promise.all([fetchAllListings(token), fetchLeads(token)]);

    // Load ref mappings (bundled in /data/)
    const refMapping = require('../data/ref_mapping.json');
    const refUrlMap  = require('../data/ref_url_map.json');

    const listing_tiers = [];
    const portal_prices = {};

    for (const lst of rawListings) {
      const ref     = lst.reference;
      const mapping = refMapping[ref];
      if (!mapping) continue; // hotel / unknown — skip

      const beds_raw = lst.bedrooms || '';
      let bed = beds_raw === 'studio' ? 'Studio' : (beds_raw ? `${beds_raw}BR` : '');
      const bldg = mapping.building;
      bed = BED_OVERRIDES[`${bldg}|${bed}`] || bed;

      const price  = lst.price?.amounts?.monthly ?? 0;
      const isLive = lst.portals?.propertyfinder?.isLive ?? false;

      const prods = lst.products || {};
      let tier = 'standard';
      if (prods.premium)       tier = 'premium';
      else if (prods.featured) tier = 'featured';

      if (price && isLive) {
        const k = `${bldg}|${bed}`;
        if (!portal_prices[k] || price < portal_prices[k]) portal_prices[k] = price;
      }

      listing_tiers.push({
        ref, tier, building: bldg, neighborhood: '',
        bed, price,
        listing_url: refUrlMap[ref] || '',
        hotel: false,
        listing_id: lst.id || '',   // ULID — used by update-price endpoint
      });
    }

    // Leads summary (Dubai = UTC+4)
    const nowDubai   = new Date(Date.now() + 4 * 3600_000);
    const todayStr   = nowDubai.toISOString().slice(0, 10);
    const yestStr    = new Date(nowDubai.getTime() - 86400_000).toISOString().slice(0, 10);
    let leads_today = 0, leads_yesterday = 0;
    const leads_today_detail    = [];
    const leads_yesterday_detail = [];

    for (const l of leads) {
      const createdDubai = new Date(new Date(l.createdAt).getTime() + 4 * 3600_000);
      const dayStr = createdDubai.toISOString().slice(0, 10);
      const timeStr = createdDubai.toISOString().slice(11, 16); // HH:MM

      // Resolve building from listing reference
      const ref = l.listing?.reference || '';
      const mapping = refMapping[ref] || null;
      // Only show the ref if it's a proper PF-HH-AR-XXXXX format; otherwise show dash
      const building = mapping ? mapping.building : (ref.startsWith('PF-HH-AR-') ? ref : '—');

      // Resolve published price via portal_prices cross-reference
      // refMapping already has the bed_type — use it directly
      let price = '';
      if (mapping) {
        const bed = BED_OVERRIDES[`${building}|${mapping.bed_type}`] || mapping.bed_type;
        const ppKey = `${building}|${bed}`;
        if (portal_prices[ppKey]) price = portal_prices[ppKey];
      }

      const row = {
        time:     timeStr,
        building: building,
        price:    price,
        status:   (l.status || 'SENT').toUpperCase(), // PF returns lowercase, dashboard expects uppercase
      };

      if (dayStr === todayStr) {
        leads_today++;
        leads_today_detail.push(row);
      } else if (dayStr === yestStr) {
        leads_yesterday++;
        leads_yesterday_detail.push(row);
      }
    }

    // Sort detail by time ascending
    leads_today_detail.sort((a, b) => a.time.localeCompare(b.time));
    leads_yesterday_detail.sort((a, b) => a.time.localeCompare(b.time));

    // Timestamp in Dubai time
    const tsDate = nowDubai.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
    const tsTime = nowDubai.toISOString().slice(11, 16);
    const timestamp = `${tsDate} ${tsTime}`;

    return res.status(200).json({
      listing_tiers,
      portal_prices,
      leads_today,
      leads_yesterday,
      leads_today_detail,
      leads_yesterday_detail,
      timestamp,
    });

  } catch (err) {
    console.error('[sync]', err);
    return res.status(500).json({ error: err.message });
  }
}
