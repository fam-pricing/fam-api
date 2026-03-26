// fam Living — Update listing price endpoint
// POST /api/update-price
// Body: { ref: "PF-HH-AR-XXXXX", price: 8000 }
//
// Strategy: clone the existing live listing with the new price → publish clone → unpublish original.
// This mirrors how the PF portal itself handles price updates (update-and-relist flow).
// All calls use Bearer JWT from apiKey+apiSecret — no portal session needed.

const PF_API = 'https://atlas.propertyfinder.com';

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
