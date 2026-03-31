// fäm Living — Guesty Open API helper
// Fetches listing coordinates for Google Maps links in viewing confirmations.
//
// Auth: OAuth2 client_credentials (GUESTY_CLIENT_ID + GUESTY_CLIENT_SECRET env vars)
// Token is cached per serverless instance (re-fetched when expired).
// PURE READ-ONLY — no writes to Guesty. No messages to leads or guests.

const GUESTY_API = 'https://open-api.guesty.com';

let _token      = null;
let _tokenExpiry = 0;

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
    const r = await fetch(`${GUESTY_API}/oauth2/token`, {
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
  const inMatch = listingTitle.match(/\b(?:studio|[\d]+BR)\s+in\s+(.+)$/i);
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
    const r = await fetch(url, {
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

    return {
      lat,
      lng,
      address: best.address?.full || null,
    };
  } catch (e) {
    console.warn('[guesty] searchGuestyListing error:', e?.message);
    return null;
  }
}

// ── Main export: get Google Maps URL for a property ───────────────────────────
// buildingName   — building name string (e.g. "Dubai Hills Estate")
// Returns a Google Maps URL string, or null if lookup fails.
// Falls back to address-based search URL if no lat/lng available.

export async function getListingMapsUrl(buildingName) {
  if (!buildingName) return null;

  const clean = extractBuildingName(buildingName) || buildingName;

  try {
    const result = await searchGuestyListing(clean);
    if (!result) {
      // Graceful fallback: use building name as a Maps search query
      console.log(`[guesty] No coords found for "${clean}" — using Maps search fallback`);
      return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(clean + ' Dubai')}`;
    }

    const { lat, lng, address } = result;

    if (lat && lng) {
      console.log(`[guesty] Coordinates for "${clean}": ${lat},${lng}`);
      return `https://www.google.com/maps?q=${lat},${lng}`;
    }

    if (address) {
      console.log(`[guesty] Address fallback for "${clean}": ${address}`);
      return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;
    }

    // Final fallback
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(clean + ' Dubai')}`;
  } catch (e) {
    console.warn('[guesty] getListingMapsUrl error:', e?.message);
    // Always return a fallback — never block the viewing flow
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(clean + ' Dubai')}`;
  }
}
