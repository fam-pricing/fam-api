/**
 * GET /api/property-lookup
 *
 * Trengo HelpMate action endpoint.
 * Returns price, availability, listing URL and photos link for a fäm Living property.
 *
 * Query params:
 *   building  — building name (fuzzy matched, e.g. "act two", "aykon", "palm tower") — optional if area provided
 *   beds      — bedroom type (optional, e.g. "studio", "1br", "1", "2br", "2")
 *   area      — location/neighbourhood (optional, e.g. "business bay", "downtown", "marina", "palm")
 *
 * Response (200):
 *   { found: true, results: [ { building, area, beds, price, currency, available, listing_url, photos_url } ] }
 *
 * Response (404):
 *   { found: false, message: "..." }
 */

const path   = require('path');
const fs     = require('fs');

const DATA   = path.join(__dirname, '..', 'data');

function loadJson(file) {
  return JSON.parse(fs.readFileSync(path.join(DATA, file), 'utf8'));
}

// Normalise a string for fuzzy comparison
function norm(s) {
  return (s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Normalise bedroom param → canonical form ("Studio","1BR","2BR",...)
function normBeds(b) {
  if (!b) return null;
  const s = b.toLowerCase().trim();
  if (s === 'studio' || s === '0' || s === '0br') return 'Studio';
  const m = s.match(/^(\d+)/);
  if (m) return `${m[1]}BR`;
  return null;
}

// Build a reverse map: (norm_building, beds) → [{ ref, url }]
function buildLookup(refMap, urlMap) {
  const lookup = {};
  for (const [ref, info] of Object.entries(refMap)) {
    const key = norm(info.building) + '||' + info.bed_type;
    if (!lookup[key]) lookup[key] = [];
    lookup[key].push({ ref, url: urlMap[ref] || null });
  }
  return lookup;
}

// Score how well a listing building matches the query
function score(listingBuilding, query) {
  const lb = norm(listingBuilding);
  const q  = norm(query);
  if (lb === q) return 100;
  if (lb.includes(q) || q.includes(lb)) return 80;
  // word overlap
  const lw = new Set(lb.split(' '));
  const qw = q.split(' ');
  const overlap = qw.filter(w => w.length > 2 && lw.has(w)).length;
  return overlap > 0 ? 40 + overlap * 10 : 0;
}

module.exports = async function handler(req, res) {
  // CORS for Trengo
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { building, beds } = req.query;

  const hasBuilding = building && building.trim().length >= 2;
  const hasArea     = req.query.area && req.query.area.trim().length >= 2;

  if (!hasBuilding && !hasArea) {
    return res.status(400).json({
      found: false,
      message: 'Please provide a building name or area (e.g. ?building=Aykon+City or ?area=Business+Bay&beds=2BR)'
    });
  }

  try {
    const listings  = loadJson('listings.json');  // [{ building, area, beds, price }]
    const refMap    = loadJson('ref_mapping.json');
    const urlMap    = loadJson('ref_url_map.json');
    const refLookup = buildLookup(refMap, urlMap);

    const wantedBeds = normBeds(beds);
    const areaQuery  = req.query.area ? norm(req.query.area) : null;

    // ── Step 1: filter / score by building name ──────────────────────────────
    let pool = listings;

    if (hasBuilding) {
      pool = pool
        .map(l => ({ ...l, _score: score(l.building, building) }))
        .filter(l => l._score >= 40)
        .sort((a, b) => b._score - a._score);
    } else {
      // No building filter — give everything a neutral score
      pool = pool.map(l => ({ ...l, _score: 50 }));
    }

    // ── Step 2: filter by area ───────────────────────────────────────────────
    if (areaQuery) {
      const areaFiltered = pool.filter(l => {
        const la = norm(l.area || '');
        return la.includes(areaQuery) || areaQuery.includes(la) ||
               // word overlap for partial matches (e.g. "downtown" matches "Downtown Dubai")
               areaQuery.split(' ').some(w => w.length > 2 && la.includes(w));
      });
      // Fall back to unfiltered pool if area produced nothing (avoid empty result)
      if (areaFiltered.length > 0) pool = areaFiltered;
    }

    // ── Step 3: filter by beds ───────────────────────────────────────────────
    const filtered = wantedBeds ? pool.filter(l => l.beds === wantedBeds) : pool;

    const scored = filtered; // alias for error messages below

    if (filtered.length === 0) {
      const topBuildings = [...new Set(pool.map(l => l.building))];
      if (topBuildings.length === 0) {
        return res.status(404).json({
          found: false,
          message: `No fäm Living properties found matching "${building || req.query.area}"${wantedBeds ? ` with ${wantedBeds}` : ''}. Please check the building name or area.`
        });
      }
      return res.status(404).json({
        found: false,
        message: `Found properties in that area but no ${wantedBeds || 'units'} available. Sizes available: ${[...new Set(pool.map(l => l.beds))].join(', ')}`
      });
    }

    // Build enriched results (attach listing URL)
    const results = filtered.map(l => {
      const key  = norm(l.building) + '||' + l.beds;
      const refs = refLookup[key] || [];
      const listingUrl = refs.length > 0 ? refs[0].url : null;

      return {
        building:    l.building,
        area:        l.area || 'Dubai',
        beds:        l.beds,
        price:       l.price,
        currency:    'AED',
        price_label: `AED ${l.price.toLocaleString()}/month`,
        available:   true,
        availability_note: 'Available now — monthly rentals always available immediately',
        listing_url: listingUrl,
        photos_url:  listingUrl,  // PF listing page has the full photo gallery
        all_inclusive: true,
        inclusive_note: 'Price is all-inclusive: water, electricity, internet, VAT — nothing more to pay except the deposit'
      };
    });

    return res.status(200).json({
      found:   true,
      count:   results.length,
      results
    });

  } catch (err) {
    console.error('[property-lookup] error:', err);
    return res.status(500).json({ found: false, message: 'Internal error — please try again.' });
  }
};
