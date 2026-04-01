// fäm Living — Guesty Open API helper
// Fetches listing coordinates for Google Maps links in viewing confirmations.
//
// Auth: OAuth2 client_credentials (GUESTY_CLIENT_ID + GUESTY_CLIENT_SECRET env vars)
// Token is cached per serverless instance (re-fetched when expired).
// PURE READ-ONLY — no writes to Guesty. No messages to leads or guests.
//
// FIX LOG (2026-04-01):
//   1. scope was 'open-api:read' → Guesty returns 400 invalid_scope. Fixed to 'open-api'.
//   2. searchTerm API doesn't match address.building field → misses most listings.
//      Switched to fetching ALL listings (cached 10 min) and matching locally by
//      address.building / address.street / nickname — same as run_pricing.py.
//   3. fields=address,nickname,title strips response → removed.

const GUESTY_API = 'https://open-api.guesty.com';
const GUESTY_TIMEOUT_MS = 10000;

let _token      = null;
let _tokenExpiry = 0;

// ── Listings cache (in-memory, per serverless instance) ──────────────────────
// Guesty rate limits are tight. Cache all listings for 10 minutes.
let _listingsCache = null;
let _listingsCacheExpiry = 0;
const LISTINGS_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

// ── Timeout-safe fetch wrapper ───────────────────────────────────────────────

async function fetchWithTimeout(url, opts, timeoutMs = GUESTY_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ── OAuth2 token (cached per instance) ───────────────────────────────────────

async function getGuestyToken() {
  if (_token && Date.now() < _tokenExpiry) return _token;

  const clientId     = process.env.GUESTY_CLIENT_ID;
  const clientSecret = process.env.GUESTY_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    console.warn('[guesty] GUESTY_CLIENT_ID or GUESTY_CLIENT_SECRET not set — skipping coordinates lookup');
    return null;
  }

  try {
    const r = await fetchWithTimeout(`${GUESTY_API}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        grant_type:    'client_credentials',
        scope:         'open-api',       // NOT 'open-api:read' — Guesty rejects that scope
        client_id:     clientId,
        client_secret: clientSecret,
      }).toString(),
    });
    if (!r.ok) {
      const err = await r.text().catch(() => r.status);
      console.warn('[guesty] Token fetch failed:', r.status, err);
      return null;
    }
    const d = await r.json();
    if (!d.access_token) {
      console.warn('[guesty] Token response missing access_token');
      return null;
    }
    _token       = d.access_token;
    _tokenExpiry = Date.now() + Math.max(0, (d.expires_in || 3600) - 300) * 1000; // 5-min buffer
    console.log('[guesty] Token fetched successfully');
    return _token;
  } catch (e) {
    console.warn('[guesty] Token fetch error:', e?.message);
    return null;
  }
}

// ── Fetch ALL Guesty listings (cached) ──────────────────────────────────────
// Same pagination approach as run_pricing.py. Results cached for 10 min.

async function getAllListings() {
  if (_listingsCache && Date.now() < _listingsCacheExpiry) {
    return _listingsCache;
  }

  const token = await getGuestyToken();
  if (!token) return [];

  const all = [];
  let skip = 0;
  const limit = 100;

  while (true) {
    try {
      const r = await fetchWithTimeout(`${GUESTY_API}/v1/listings?limit=${limit}&skip=${skip}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      }, 15000);
      if (!r.ok) {
        console.warn(`[guesty] Listings fetch failed at skip=${skip}:`, r.status);
        break;
      }
      const d = await r.json();
      const results = d.results || [];
      all.push(...results);
      if (results.length < limit) break; // last page
      skip += limit;
      // Guesty rate limit: small delay between pages
      await new Promise(r => setTimeout(r, 300));
    } catch (e) {
      console.warn('[guesty] Listings fetch error:', e?.message);
      break;
    }
  }

  if (all.length > 0) {
    _listingsCache = all;
    _listingsCacheExpiry = Date.now() + LISTINGS_CACHE_TTL_MS;
    console.log(`[guesty] Cached ${all.length} listings`);
  }

  return all;
}

// ── Extract building name from listing_title ──────────────────────────────────
// listing_title may be:
//   - A full PF URL ("https://www.propertyfinder.ae/en/plp/rent/apartment-...-grande-14592976.html")
//   - A raw PF ref ("PF-HH-AR-109427")
//   - A resolved string ("1BR in Dubai Hills Estate" or "2BR in Grande Downtown")
//   - A freeform property description
// Returns the cleanest building name for Guesty search.

function extractBuildingName(listingTitle) {
  if (!listingTitle) return null;

  // PF URL — extract building name from the URL slug
  if (/propertyfinder\.ae/i.test(listingTitle)) {
    try {
      const url = new URL(listingTitle);
      const path = url.pathname.replace(/\.html$/, '');
      const parts = path.split('-');
      const lastPart = parts[parts.length - 1];
      const isTrailingId = /^\d{5,}$/.test(lastPart) || /^[A-Za-z0-9]{8,}$/.test(lastPart);
      if (isTrailingId) parts.pop();

      const dubaiPositions = parts.reduce((acc, p, i) => { if (p === 'dubai') acc.push(i); return acc; }, []);
      if (dubaiPositions.length > 0) {
        const AREAS = new Set(['business', 'bay', 'downtown', 'marina', 'creek', 'harbour',
          'hills', 'jumeirah', 'village', 'circle', 'sports', 'city', 'palm', 'walk',
          'beachfront', 'emaar', 'jvc', 'jbr', 'old', 'town', 'opera', 'district',
          'the', 'lagoons', 'nad', 'al', 'shiba', 'dubai', 'beach', 'harbour',
          'residences', 'vida']);

        let startIdx = dubaiPositions[0] + 1;
        while (startIdx < parts.length && (AREAS.has(parts[startIdx]) || /^\d{1,3}$/.test(parts[startIdx]))) startIdx++;

        if (startIdx < parts.length) {
          const buildingParts = parts.slice(startIdx);
          const buildingName = buildingParts.join(' ').replace(/\b\w/g, c => c.toUpperCase());
          if (buildingName.length >= 3) {
            console.log(`[guesty] Extracted building name from PF URL: "${buildingName}"`);
            return buildingName;
          }
        }
      }
    } catch (e) {
      console.warn('[guesty] Failed to parse PF URL:', e?.message);
    }
    return null;
  }

  // Already resolved: "1BR in Dubai Hills Estate" → "Dubai Hills Estate"
  const inMatch = listingTitle.match(/\b(?:studio|[1-9]\d*BR)\s+in\s+(.+)$/i);
  if (inMatch) return inMatch[1].trim();
  // Raw PF ref — can't resolve without ref_mapping, return null to fall through
  if (/^PF-HH-AR-/i.test(listingTitle)) return null;
  // Use as-is
  return listingTitle.trim();
}

// ── Find listing by building name (local fuzzy match) ────────────────────────
// Matches against address.building, address.street, nickname, title.
// Same approach as run_pricing.py _building_name_from_listing + fuzzy match.

async function findListingByBuilding(buildingName) {
  if (!buildingName) return null;

  const listings = await getAllListings();
  if (!listings.length) return null;

  const norm = s => (s || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
  const q = norm(buildingName);
  const qWords = q.split(/\s+/).filter(w => w.length > 1);

  let bestMatch = null;
  let bestScore = 0;

  for (const l of listings) {
    const addr = l.address || {};
    const building = norm(addr.building || '');
    const street   = norm(addr.street || '');
    const full     = norm(addr.full || '');
    const nick     = norm(l.nickname || '');
    const title    = norm(l.title || '');

    let score = 0;

    // Exact substring match in building name (highest signal)
    if (building && (building.includes(q) || q.includes(building))) score += 10;
    // Exact substring in street
    if (street && (street.includes(q) || q.includes(street))) score += 8;
    // Match in nickname
    if (nick && nick.includes(q)) score += 6;
    // Match in title
    if (title && title.includes(q)) score += 4;
    // Match in full address
    if (full && full.includes(q)) score += 3;

    // Word overlap bonus
    const blob = building + ' ' + street + ' ' + nick + ' ' + title + ' ' + full;
    const wordHits = qWords.filter(w => blob.includes(w)).length;
    score += wordHits * 2;

    if (score > bestScore) {
      bestScore = score;
      bestMatch = l;
    }
  }

  // Require a minimum score to avoid false positives
  if (bestScore < 4) {
    console.warn(`[guesty] No confident match for "${buildingName}" (best score: ${bestScore})`);
    return null;
  }

  const addr = bestMatch.address || {};
  const lat = addr.lat;
  const lng = addr.lng;

  console.log(`[guesty] Matched "${buildingName}" → "${bestMatch.nickname}" (score: ${bestScore}) | building: "${addr.building}" | street: "${addr.street}"`);

  if (typeof lat !== 'number' || typeof lng !== 'number' || !isFinite(lat) || !isFinite(lng)) {
    console.warn(`[guesty] Listing found for "${buildingName}" but lat/lng are invalid:`, lat, lng);
    return null;
  }
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    console.warn(`[guesty] Coordinates out of range for "${buildingName}":`, lat, lng);
    return null;
  }

  return { lat, lng, address: addr.full || null };
}

// ── Main export: get Google Maps URL for a property ───────────────────────────
// buildingName   — building name string (e.g. "Reehan 1 Old Town")
// Returns a Google Maps URL string using ONLY real lat/lng coordinates from Guesty.
// Returns null if coordinates are not available for any reason — caller MUST escalate.
// STRICT: no fallback URLs. No address-based searches. Coordinates or nothing.

export async function getListingMapsUrl(buildingName) {
  if (!buildingName) return null;

  const clean = extractBuildingName(buildingName) || buildingName;

  try {
    const result = await findListingByBuilding(clean);
    if (!result) {
      console.warn(`[guesty] No listing found for "${clean}" — caller should escalate`);
      return null;
    }

    const { lat, lng } = result;

    if (lat && lng) {
      console.log(`[guesty] Coordinates for "${clean}": ${lat},${lng}`);
      return `https://www.google.com/maps?q=${lat},${lng}`;
    }

    console.warn(`[guesty] Listing found for "${clean}" but no coordinates in Guesty — caller should escalate`);
    return null;
  } catch (e) {
    console.warn('[guesty] getListingMapsUrl error:', e?.message);
    return null;
  }
}
