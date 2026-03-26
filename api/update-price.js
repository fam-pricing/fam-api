// fam Living — Update listing price endpoint
// POST /api/update-price
// Body: { ref: "PF-HH-AR-XXXXX", price: 8000 }
//
// Strategy: clone the existing live listing with the new price → publish clone → unpublish original.
// This mirrors how the PF portal itself handles price updates (update-and-relist flow).
// All calls use Bearer JWT from apiKey+apiSecret — no portal session needed.
//
// After each successful price change the listing gets a new ULID as its reference.
// We automatically update ref_mapping.json and ref_url_map.json in the fam-api GitHub repo
// so that the next Sync can find the listing by its new ref.

const PF_API = 'https://atlas.propertyfinder.com';
const GH_API = 'https://api.github.com';
const GH_REPO = 'fam-pricing/fam-api';

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

function buildCloneBody(listing, newPrice) {
  return {
    amenities:        listing.amenities || [],
    assignedTo:       listing.assignedTo,
    availableFrom:    listing.availableFrom,
    bathrooms:        listing.bathrooms,
    bedrooms:         listing.bedrooms,
    category:         listing.category,
    createdBy:        listing.createdBy,
    description:      listing.description,
    finishingType:    listing.finishingType,
    furnishingType:   listing.furnishingType,
    hasKitchen:       listing.hasKitchen,
    hasParkingOnSite: listing.hasParkingOnSite,
    location:         listing.location,
    ownerName:        listing.ownerName,
    parkingSlots:     listing.parkingSlots,
    price: {
      amounts:             { monthly: newPrice },
      minimalRentalPeriod: listing.price?.minimalRentalPeriod ?? 2000,
      numberOfCheques:     listing.price?.numberOfCheques     ?? 1,
      paymentMethods:      listing.price?.paymentMethods      ?? ['installments'],
      type:                listing.price?.type                ?? 'monthly',
      utilitiesInclusive:  listing.price?.utilitiesInclusive  ?? false,
    },
    size:       listing.size,
    title:      listing.title,
    type:       listing.type,
    uaeEmirate: listing.uaeEmirate,
    unitNumber: listing.unitNumber,
    media:      listing.media,
    updatedBy:  listing.updatedBy,
  };
}

// ── GitHub file update helpers ─────────────────────────────────────────────

async function ghGet(path, token) {
  const r = await fetch(`${GH_API}/repos/${GH_REPO}/contents/${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github.v3+json' },
  });
  if (!r.ok) throw new Error(`GH GET ${path} failed: ${r.status}`);
  return r.json();  // { sha, content (base64) }
}

async function ghPut(path, content, sha, message, token) {
  const encoded = Buffer.from(JSON.stringify(content, null, 2)).toString('base64');
  const r = await fetch(`${GH_API}/repos/${GH_REPO}/contents/${path}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ message, content: encoded, sha }),
  });
  if (!r.ok) {
    const e = await r.text();
    throw new Error(`GH PUT ${path} failed ${r.status}: ${e}`);
  }
  return r.json();
}

/**
 * After a successful price change the old ref is replaced by newId in both mapping files.
 * Non-fatal — logs errors but does not fail the main response.
 */
async function updateRefMappings(oldRef, newId) {
  const ghToken = process.env.GH_TOKEN;
  if (!ghToken) {
    console.warn('[update-price] GH_TOKEN not set — skipping ref_mapping update');
    return;
  }

  try {
    // ── ref_mapping.json ──────────────────────────────────────────────────
    const rmFile  = await ghGet('data/ref_mapping.json', ghToken);
    const rmData  = JSON.parse(Buffer.from(rmFile.content, 'base64').toString('utf8'));
    const entry   = rmData[oldRef];
    if (entry) {
      delete rmData[oldRef];
      rmData[newId] = entry;
      await ghPut(
        'data/ref_mapping.json', rmData, rmFile.sha,
        `chore: rotate ref ${oldRef} → ${newId}`,
        ghToken,
      );
      console.log(`[update-price] ref_mapping: ${oldRef} → ${newId}`);
    } else {
      console.warn(`[update-price] ref_mapping: ${oldRef} not found — no rotation needed`);
    }

    // ── ref_url_map.json ──────────────────────────────────────────────────
    const ruFile  = await ghGet('data/ref_url_map.json', ghToken);
    const ruData  = JSON.parse(Buffer.from(ruFile.content, 'base64').toString('utf8'));
    const urlVal  = ruData[oldRef];
    if (urlVal) {
      delete ruData[oldRef];
      ruData[newId] = urlVal;   // keep old URL slug — building page stays same
      await ghPut(
        'data/ref_url_map.json', ruData, ruFile.sha,
        `chore: rotate url ref ${oldRef} → ${newId}`,
        ghToken,
      );
      console.log(`[update-price] ref_url_map: ${oldRef} → ${newId}`);
    }
  } catch (err) {
    console.error('[update-price] ref_mapping update failed (non-fatal):', err.message);
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Sync-Password');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Password check
  const syncPass = process.env.SYNC_PASSWORD;
  if (syncPass) {
    const provided = req.headers['x-sync-password'] || '';
    if (provided !== syncPass) {
      return res.status(401).json({ error: 'Incorrect password' });
    }
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { return res.status(400).json({ error: 'Invalid JSON' }); }
  }

  const { ref, price } = body || {};
  if (!ref || price === undefined) return res.status(400).json({ error: 'ref and price are required' });

  const numPrice = parseInt(price, 10);
  if (isNaN(numPrice) || numPrice < 500 || numPrice > 10_000_000) {
    return res.status(400).json({ error: `Invalid price: ${price}` });
  }

  try {
    const token = await getToken();

    // ── Step 1: Find current live listing by ref or ULID ─────────────────────
    let listing = null;
    let page = 1;
    while (true) {
      const r = await fetch(`${PF_API}/v1/listings?perPage=100&page=${page}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) throw new Error(`Listings fetch failed: ${r.status}`);
      const d = await r.json();
      listing = d.results.find(l => l.reference === ref || l.id === ref);
      if (listing || !d.pagination.nextPage) break;
      page++;
    }
    if (!listing) return res.status(404).json({ error: `Listing ${ref} not found` });

    const oldId    = listing.id;
    const oldPrice = listing.price?.amounts?.monthly;

    // No-op guard
    if (oldPrice === numPrice) {
      return res.status(200).json({
        success: true, noop: true,
        ref, price: numPrice, listing_id: oldId,
        message: 'Price unchanged — no update needed.',
      });
    }

    console.log(`[update-price] ${ref}: ${oldPrice} → ${numPrice} AED/mo`);

    // ── Step 2: Clone the listing with the new price ──────────────────────────
    const cloneBody = buildCloneBody(listing, numPrice);
    const postR = await fetch(`${PF_API}/v1/listings`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(cloneBody),
    });
    if (!postR.ok) {
      const e = await postR.text();
      throw new Error(`Create clone failed ${postR.status}: ${e}`);
    }
    const newListing = await postR.json();
    const newId = newListing.id;
    if (!newId) throw new Error('Clone created but no id returned');
    console.log(`[update-price] Clone created: ${newId}`);

    // ── Step 3: Publish the clone ─────────────────────────────────────────────
    const pubR = await fetch(`${PF_API}/v1/listings/${newId}/publish`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    });
    if (!pubR.ok) {
      const e = await pubR.text();
      throw new Error(`Publish clone failed ${pubR.status}: ${e}`);
    }
    console.log(`[update-price] Clone ${newId} → pending_publishing ✅`);

    // ── Step 4: Unpublish the original ────────────────────────────────────────
    const unR = await fetch(`${PF_API}/v1/listings/${oldId}/unpublish`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    });
    if (!unR.ok) {
      const e = await unR.text();
      // Non-fatal — log but don't fail
      console.warn(`[update-price] Unpublish original ${oldId} failed ${unR.status}: ${e}`);
    } else {
      console.log(`[update-price] Original ${oldId} → live_pending_unpublishing ✅`);
    }

    // ── Step 5: Rotate ref_mapping + ref_url_map in GitHub ───────────────────
    // Must await before returning — Vercel terminates the function after res.json()
    await updateRefMappings(oldId, newId);

    return res.status(200).json({
      success:        true,
      ref,
      price:          numPrice,
      old_listing_id: oldId,
      new_listing_id: newId,
      message: `Price updated to ${numPrice.toLocaleString()} AED/mo. New listing ID: ${newId}`,
    });

  } catch (err) {
    console.error('[update-price]', err);
    return res.status(500).json({ error: err.message });
  }
}
