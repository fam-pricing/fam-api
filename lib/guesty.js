// fäm Living — Guesty Open API helper
// Fetches listing coordinates for Google Maps links in viewing confirmations.
//
// Auth: OAuth2 client_credentials (GUESTY_CLIENT_ID + GUESTY_CLIENT_SECRET env vars)
// Token is cached per serverless instance (re-fetched when expired).
// PURE READ-ONLY — no writes to Guesty. No messages to leads or guests.

const GUESTY_API = 'https://open-api.guesty.com';
const GUESTY_TIMEOUT_MS = 8000; // 8s timeout for all Guesty API calls

let _token      = null;
let _tokenExpiry = 0;

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
        scope:         'open-api:read',
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

// ── Extract building name from listing_title ──────────────────────────────────
// listing_title may be a raw PF ref ("PF-HH-AR-109427"), a resolved string
// ("1BR in Dubai Hills Estate"), or a freeform property description.
// Returns the cleanest building name for Guesty search.

function extractBuildingName(listingTitle) {
  if (!listingTitle) return null;
  // Already resolved: "1BR in Dubai Hills Estate" → "Dubai Hills Estate"
  const inMatch = listingTitle.match(/\b(?:studio|[1-9]\d*BR)\s+in\s+(.+)$/i);
  if (inMatch) return inMatch[1].trim();
  // Raw PF ref — can't resolve without ref_mapping, return null to fall through
  if (/^PF-HH-AR-/i.test(listingTitle)) return null;
  // Use as-is
  return listingTitle.trim();
}

// ── Search Guesty listings by building name ───────────────────────────────────
// Returns { lat, lng, address } of best match, or null if not found.

async function searchGuestyListing(buildingName) {
  const token = await getGuestyToken();
  if (!token || !buildingName) return null;

  try {
    const url = `${GUESTY_API}/v1/listings?limit=10&fields=address,nickname,title&searchTerm=${encodeURIComponent(buildingName)}`;
    const r = await fetchWithTimeout(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    if (!r.ok) {
      console.warn('[guesty] Listings search failed:', r.status);
      return null;
    }
    const d = await r.json();
    const listings = d.results || d.data || [];
    if (!listings.length) {
      console.warn(`[guesty] No listings found for "${buildingName}"`);
      return null;
    }

    // Prefer the listing whose title/nickname best matches the building name
    const norm = s => (s || '').toLowerCase().replace(/[^a-z0-9]/g, ' ').trim();
    const q = norm(buildingName);
    const scored = listings.map(l => {
      const title   = norm(l.title || '');
      const nick    = norm(l.nickname || '');
      const address = norm(l.address?.full || '');
      let score = 0;
      if (title.includes(q) || address.includes(q)) score += 3;
      if (nick.includes(q))  score += 2;
      // word overlap
      const qWords = q.split(' ').filter(w => w.length > 2);
      const overlap = qWords.filter(w => title.includes(w) || address.includes(w)).length;
      score += overlap;
      return { ...l, _score: score };
    }).sort((a, b) => b._score - a._score);

    const best = scored[0];
    const lat  = best.address?.lat;
    const lng  = best.address?.lng;

    // Validate lat/lng are real numbers in valid coordinate ranges
    if (typeof lat !== 'number' || typeof lng !== 'number' || !isFinite(lat) || !isFinite(lng)) {
      console.warn(`[guesty] Listing found for "${buildingName}" but lat/lng are invalid:`, lat, lng);
      return null;
    }
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      console.warn(`[guesty] Coordinates out of range for "${buildingName}":`, lat, lng);
      return null;
    }

    return { lat, lng, address: best.address?.full || null };
  } catch (e) {
    console.warn('[guesty] searchGuestyListing error:', e?.message);
    return null;
  }
}

// ── Main export: get Google Maps URL for a property ───────────────────────────
// buildingName   — building name string (e.g. "Dubai Hills Estate")
// Returns a Google Maps URL string using ONLY real lat/lng coordinates from Guesty.
// Returns null if coordinates are not available for any reason — caller MUST escalate.
// STRICT: no fallback URLs. No address-based searches. Coordinates or nothing.

export async function getListingMapsUrl(buildingName) {
  if (!buildingName) return null;

  const clean = extractBuildingName(buildingName) || buildingName;

  try {
    const result = await searchGuestyListing(clean);
    if (!result) {
      console.warn(`[guesty] No listing found for "${clean}" — caller should escalate`);
      return null;
    }

    const { lat, lng } = result;

    if (lat && lng) {
      console.log(`[guesty] Coordinates for "${clean}": ${lat},${lng}`);
      return `https://www.google.com/maps?q=${lat},${lng}`;
    }

    // Listing found in Guesty but no lat/lng stored
    console.warn(`[guesty] Listing found for "${clean}" but no coordinates in Guesty — caller should escalate`);
    return null;
  } catch (e) {
    console.warn('[guesty] getListingMapsUrl error:', e?.message);
    return null;
  }
}
