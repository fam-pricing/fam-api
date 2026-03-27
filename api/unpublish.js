// fam Living — Unpublish listing endpoint
// POST /api/unpublish
// Body: { ref: "PF-HH-AR-XXXXX" }
// Owner only (faysal). Calls POST /v1/listings/{ULID}/unpublish on PF Atlas API.

import { requireAuth } from './_auth.js';

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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Owner only
  const user = requireAuth(req, res, 'owner');
  if (!user) return;

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { return res.status(400).json({ error: 'Invalid JSON' }); }
  }

  const { ref } = body || {};
  if (!ref) return res.status(400).json({ error: 'ref is required' });

  try {
    const token = await getToken();

    // Find listing by ref
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
    const isLive = listing.portals?.propertyfinder?.isLive ?? false;

    if (!isLive) {
      return res.status(200).json({
        success: true, noop: true,
        ref, listing_id: listingId,
        message: 'Listing is already unpublished.',
      });
    }

    console.log(`[unpublish] ${ref} (${listingId}) — unpublishing by ${user.username}`);

    const unpubR = await fetch(`${PF_API}/v1/listings/${listingId}/unpublish`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    });
    const unpubText = await unpubR.text();
    console.log(`[unpublish] ${listingId} → ${unpubR.status}`);

    if (!unpubR.ok) {
      return res.status(500).json({
        error:       `Unpublish failed ${unpubR.status}`,
        pf_response:  unpubText,
        listing_id:   listingId,
        ref,
      });
    }

    return res.status(200).json({
      success:    true,
      ref,
      listing_id: listingId,
      message:    `Listing ${ref} unpublished successfully.`,
    });

  } catch (err) {
    console.error('[unpublish]', err);
    return res.status(500).json({ error: err.message });
  }
}
