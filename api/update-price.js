// fam Living — Update listing price endpoint
// POST /api/update-price
// Body: { ref: "PF-HH-AR-XXXXX", price: 8000 }
//
// Strategy: GET listing by ref → PUT full listing body with new price → same ULID, no clone.
// Auth: Bearer JWT from apiKey+apiSecret (same token used for GET).

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

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Sync-Password');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const syncPass = process.env.SYNC_PASSWORD;
  if (syncPass) {
    const provided = req.headers['x-sync-password'] || '';
    if (provided !== syncPass) return res.status(401).json({ error: 'Incorrect password' });
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

    // ── Step 1: Find listing by ref ───────────────────────────────────────────
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

    const listingId = listing.id;
    const oldPrice  = listing.price?.amounts?.monthly;

    if (oldPrice === numPrice) {
      return res.status(200).json({
        success: true, noop: true,
        ref, price: numPrice, listing_id: listingId,
        message: 'Price unchanged — no update needed.',
      });
    }

    console.log(`[update-price] ${ref} (${listingId}): ${oldPrice} → ${numPrice} AED/mo`);

    // ── Step 2: PUT full listing with updated price ───────────────────────────
    const putBody = {
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
      media:            listing.media,
      ownerName:        listing.ownerName,
      parkingSlots:     listing.parkingSlots,
      price: {
        amounts:             { monthly: numPrice },
        minimalRentalPeriod: listing.price?.minimalRentalPeriod ?? 2000,
        numberOfCheques:     listing.price?.numberOfCheques     ?? 1,
        paymentMethods:      listing.price?.paymentMethods      ?? ['installments'],
        type:                listing.price?.type                ?? 'monthly',
        utilitiesInclusive:  listing.price?.utilitiesInclusive  ?? false,
      },
      reference:  listing.reference,
      size:       listing.size,
      title:      listing.title,
      type:       listing.type,
      uaeEmirate: listing.uaeEmirate,
      unitNumber: listing.unitNumber,
      updatedBy:  listing.updatedBy,
    };

    const putR    = await fetch(`${PF_API}/v1/listings/${listingId}`, {
      method:  'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify(putBody),
    });
    const putText = await putR.text();
    console.log(`[update-price] PUT ${listingId} → ${putR.status}`);

    if (!putR.ok) {
      return res.status(500).json({
        error:       `PUT failed ${putR.status}`,
        pf_response:  putText,
        listing_id:   listingId,
        ref,
      });
    }

    // ── Step 3: Re-publish (non-fatal — listing stays live after PUT) ─────────
    const pubR    = await fetch(`${PF_API}/v1/listings/${listingId}/publish`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    });
    console.log(`[update-price] PUBLISH ${listingId} → ${pubR.status}`);

    return res.status(200).json({
      success:        true,
      ref,
      price:          numPrice,
      old_price:      oldPrice,
      listing_id:     listingId,
      message:        `Price updated to ${numPrice.toLocaleString()} AED/mo on listing ${listingId}`,
    });

  } catch (err) {
    console.error('[update-price]', err);
    return res.status(500).json({ error: err.message });
  }
}
