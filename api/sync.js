// fam Living — Sync endpoint
// GET /api/sync
// Returns fresh pub prices, listing tiers, and lead counts from PF Enterprise API.
// No browser needed — all data from atlas.propertyfinder.com.

const PF_API = 'https://atlas.propertyfinder.com';
const GH_API  = 'https://api.github.com';
const REPO     = 'fam-pricing/fam-api';
const LISTINGS_FILE = 'data/listings.json';

// PF publicProfile ID → display name (same as leads.js)
const AGENT_MAP = {
  239575: 'Afifa Al Shami',
  280624: 'Ahmed A.',
  237124: 'Joel V.',
};

const BED_OVERRIDES = {
  'Burj Crown|3BR':        '4BR',
  'Sunrise Bay T1|3BR':    '4BR',
  'Reehan 1 Old Town|2BR': '3BR',
  'Marina Star|Studio':    '1BR',
  'City Walk B18B|2BR':    '3BR',
  'City Walk B19|3BR':     '4BR',
};

const BUILDING_AREA_MAP = {
  'Act One Tower 1': 'Downtown',
  'Act Two Tower 2': 'Business Bay',
  'Address Opera': 'Downtown',
  'Ahad Residences': 'Business Bay',
  'Al Majara Dubai Marina': 'JBR',
  'ANWA Omniyat': 'Dubai Maritime City',
  'Aykon City': 'Business Bay',
  'Bayz by Danube': 'Business Bay',
  'Binghatti Amber': 'JVC',
  'Binghatti Azure': 'JVC',
  'Binghatti Gateway': 'Al Jadaf',
  'Bluewaters Building 4': 'Bluewaters',
  'Burj Crown': 'Downtown',
  'Canal Residence Arabian': 'Dubai Sports City',
  'City Walk B10': 'City Walk',
  'City Walk B18B': 'City Walk',
  'City Walk B19': 'City Walk',
  'City Walk B22': 'City Walk',
  'City Walk B2A': 'City Walk',
  'City Walk B3B': 'City Walk',
  'City Walk B6A': 'City Walk',
  'Collective 2.0': 'Dubai Hills',
  'Creek Gate Tower 1': 'Dubai Creek Harbour',
  'Creek Rise Tower 2': 'Dubai Creek Harbour',
  'DAMAC Lagoons': 'Dubai Golf City',
  'DAMAC Maison Prive': 'Business Bay',
  'Elite Business Bay': 'Business Bay',
  'Elite Residence Marina': 'Dubai Marina',
  'Executive Residence 2': 'Dubai Hills',
  'Grande Downtown': 'Downtown',
  'Imperial Avenue': 'Downtown',
  'Island Park 1': 'Dubai Creek Harbour',
  'Jadeel': 'Madinat Jumeirah Living',
  'Kensington Waters': 'Sobha Hartland',
  'MAG 318': 'Business Bay',
  'Marina Star': 'Dubai Marina',
  'Marina Vista T2': 'Dubai Harbour',
  'Nobles Tower': 'Business Bay',
  'Palm Tower': 'Palm Jumeirah',
  'Park Point C': 'Dubai Hills',
  'Peninsula Five': 'Business Bay',
  'Peninsula Three': 'Business Bay',
  'Polo Residences': 'Nad Al Shiba',
  'RP Heights': 'Downtown',
  'Reehan 1 Old Town': 'Downtown Old Town',
  'Rimal 2 Marina': 'Dubai Marina',
  'Samana Park View': 'Arjan',
  'Seaside Hills Residences': 'Al Zorah, Ajman',
  'Shams 1 JBR': 'JBR',
  'Sulafa Tower': 'Dubai Marina',
  'Sunrise Bay T1': 'Emaar Beachfront',
  'Sunrise Bay T2': 'Dubai Harbour',
  'The Bay Business Bay': 'Business Bay',
  'The Crest Sobha Hartland': 'Sobha Hartland',
  'Trillionaire Residences': 'Business Bay',
  'Upside Living': 'Business Bay',
  'Urban Oasis': 'Business Bay',
  'Vida Dubai Mall': 'Downtown',
  'Viridian Central Park': 'City Walk',
  'Wellcube JVT': 'JVT',
  'Yansoon 6': 'Downtown Old Town',
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

      // Resolve agent name from publicProfile ID
      const profileId = l.publicProfile?.id ?? null;
      const agent = profileId ? (AGENT_MAP[profileId] || `Agent #${profileId}`) : '—';

      const row = {
        time:     timeStr,
        agent:    agent,
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

    // Write active listings to data/listings.json for the bot to read
    try {
      const ghToken = process.env.GH_TOKEN;
      if (ghToken) {
        const activeListings = listing_tiers
          .filter(l => l.price > 0 && portal_prices[`${l.building}|${l.bed}`])
          .map(l => ({
            building: l.building,
            area: BUILDING_AREA_MAP[l.building] || '',
            beds: l.bed,
            price: portal_prices[`${l.building}|${l.bed}`],
          }))
          .sort((a, b) => (a.area + a.building).localeCompare(b.area + b.building));

        // Deduplicate (take lowest price per building+bed)
        const seen = new Set();
        const dedupedListings = activeListings.filter(l => {
          const key = `${l.building}|${l.beds}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });

        const existingR = await fetch(`${GH_API}/repos/${REPO}/contents/${LISTINGS_FILE}`, {
          headers: { Authorization: `Bearer ${ghToken}`, Accept: 'application/vnd.github.v3+json' },
        });
        const existingSha = existingR.ok ? (await existingR.json()).sha : null;

        const newContent = Buffer.from(JSON.stringify(dedupedListings, null, 2)).toString('base64');
        await fetch(`${GH_API}/repos/${REPO}/contents/${LISTINGS_FILE}`, {
          method: 'PUT',
          headers: { Authorization: `Bearer ${ghToken}`, Accept: 'application/vnd.github.v3+json', 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: 'Sync: update active listings for bot',
            content: newContent,
            ...(existingSha ? { sha: existingSha } : {}),
          }),
        });
        console.log(`[sync] listings.json updated: ${dedupedListings.length} active listings`);
      }
    } catch (e) {
      console.warn('[sync] listings.json update failed:', e?.message);
    }

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
