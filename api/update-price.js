// fam Living — Update listing price endpoint
// POST /api/update-price
// Body: { ref: "PF-HH-AR-XXXXX", price: 8000 }
// Finds the listing by ref, sends PATCH to PF API to update monthly price.

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

  // Password check
  const syncPass = process.env.SYNC_PASSWORD;
  if (syncPass) {
    const provided = req.headers['x-sync-password'] || '';
    if (provided !== syncPass) {
      return res.status(401).json({ error: 'Incorrect password' });
    }
  }

  let body = req.body;
  // Vercel may not parse body automatically for all runtimes
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { return res.status(400).json({ error: 'Invalid JSON' }); }
  }

  const { ref, price } = body || {};
  if (!ref || !price) return res.status(400).json({ error: 'ref and price are required' });

  const numPrice = parseInt(price, 10);
  if (isNaN(numPrice) || numPrice < 500 || numPrice > 10_000_000) {
    return res.status(400).json({ error: `Invalid price: ${price}` });
  }

  try {
    const token = await getToken();

    // Find listing by ref (scan all pages — typically 1 page of 62)
    let listing = null;
    let page = 1;
    while (true) {
      const r = await fetch(`${PF_API}/v1/listings?perPage=100&page=${page}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) throw new Error(`Listings fetch failed: ${r.status}`);
      const d = await r.json();
      listing = d.results.find(l => l.reference === ref);
      if (listing || !d.pagination.nextPage) break;
      page++;
    }

    if (!listing) return res.status(404).json({ error: `Listing ${ref} not found` });

    // PATCH the listing price
    const patchR = await fetch(`${PF_API}/v1/listings/${listing.id}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        price: {
          amounts: { monthly: numPrice },
        },
      }),
    });

    if (!patchR.ok) {
      const errBody = await patchR.text();
      console.error(`[update-price] PATCH failed ${patchR.status}: ${errBody}`);
      return res.status(patchR.status).json({
        error: `PF API returned ${patchR.status}`,
        detail: errBody,
      });
    }

    const result = await patchR.json();
    console.log(`[update-price] ✅ ${ref} → ${numPrice} AED/mo`);

    return res.status(200).json({
      success: true,
      ref,
      price: numPrice,
      listing_id: listing.id,
    });

  } catch (err) {
    console.error('[update-price]', err);
    return res.status(500).json({ error: err.message });
  }
}
