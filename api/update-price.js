// fam Living — Update listing price endpoint
// POST /api/update-price
// Body: { ref: "PF-HH-AR-XXXXX", price: 8000 }
//
// Strategy: find listing by ref → PATCH price in-place (same ULID, same reference).
// PATCH endpoint uses AWS SigV4 (API Gateway IAM auth). GET uses Bearer JWT.

import crypto from 'crypto';

const PF_API  = 'https://atlas.propertyfinder.com';
const PF_HOST = 'atlas.propertyfinder.com';
const AWS_REGION  = 'me-central-1';
const AWS_SERVICE = 'execute-api';

// ── AWS SigV4 helpers ──────────────────────────────────────────────────────

function sha256hex(data) {
  return crypto.createHash('sha256').update(data, 'utf8').digest('hex');
}
function hmacSha256(key, data) {
  return crypto.createHmac('sha256', key).update(data, 'utf8').digest();
}
function getSigningKey(secret, dateStamp, region, service) {
  const kDate    = hmacSha256('AWS4' + secret, dateStamp);
  const kRegion  = hmacSha256(kDate, region);
  const kService = hmacSha256(kRegion, service);
  return hmacSha256(kService, 'aws4_request');
}

function buildSigV4Headers(method, path, bodyStr, accessKey, secretKey) {
  const now       = new Date();
  const amzDate   = now.toISOString().replace(/[:-]|\.\d{3}/g, '').slice(0, 15) + 'Z';
  const dateStamp = amzDate.slice(0, 8);
  const bodyHash  = sha256hex(bodyStr || '');

  const canonHeaders  = `content-type:application/json\nhost:${PF_HOST}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = 'content-type;host;x-amz-date';

  const canonRequest = [method, path, '', canonHeaders, signedHeaders, bodyHash].join('\n');

  const credScope  = `${dateStamp}/${AWS_REGION}/${AWS_SERVICE}/aws4_request`;
  const strToSign  = ['AWS4-HMAC-SHA256', amzDate, credScope, sha256hex(canonRequest)].join('\n');

  const signingKey = getSigningKey(secretKey, dateStamp, AWS_REGION, AWS_SERVICE);
  const signature  = crypto.createHmac('sha256', signingKey).update(strToSign, 'utf8').digest('hex');

  return {
    'Content-Type':  'application/json',
    'X-Amz-Date':    amzDate,
    Authorization:   `AWS4-HMAC-SHA256 Credential=${accessKey}/${credScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

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

    // No-op guard
    if (oldPrice === numPrice) {
      return res.status(200).json({
        success: true, noop: true,
        ref, price: numPrice, listing_id: listingId,
        message: 'Price unchanged — no update needed.',
      });
    }

    console.log(`[update-price] ${ref} (${listingId}): ${oldPrice} → ${numPrice} AED/mo`);

    // ── Step 2: PATCH price in-place ─────────────────────────────────────────
    // PF Atlas PATCH endpoint uses key=value auth, not Bearer JWT.
    // Format: Authorization: apiKey=xxx&apiSecret=xxx
    const patchBody = {
      price: {
        amounts:             { monthly: numPrice },
        minimalRentalPeriod: listing.price?.minimalRentalPeriod ?? 2000,
        numberOfCheques:     listing.price?.numberOfCheques     ?? 1,
        paymentMethods:      listing.price?.paymentMethods      ?? ['installments'],
        type:                listing.price?.type                ?? 'monthly',
        utilitiesInclusive:  listing.price?.utilitiesInclusive  ?? false,
      },
    };

    const patchBodyStr = JSON.stringify(patchBody);
    const sigV4Headers = buildSigV4Headers(
      'PATCH',
      `/v1/listings/${listingId}`,
      patchBodyStr,
      process.env.PF_API_KEY,
      process.env.PF_API_SECRET,
    );

    const patchR = await fetch(`${PF_API}/v1/listings/${listingId}`, {
      method:  'PATCH',
      headers: sigV4Headers,
      body:    patchBodyStr,
    });

    const patchText  = await patchR.text();
    console.log(`[update-price] PATCH ${listingId} → ${patchR.status}: ${patchText.substring(0, 300)}`);

    if (!patchR.ok) {
      // Return the raw PF error so we can see what auth format it wants
      return res.status(500).json({
        error:      `PATCH failed ${patchR.status}`,
        pf_response: patchText,
        listing_id: listingId,
        ref,
      });
    }

    // ── Step 3: Re-publish to push updated price live ─────────────────────────
    const pubR = await fetch(`${PF_API}/v1/listings/${listingId}/publish`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    });
    const pubText = await pubR.text();
    console.log(`[update-price] PUBLISH ${listingId} → ${pubR.status}: ${pubText.substring(0, 200)}`);

    return res.status(200).json({
      success:    patchR.ok,
      ref,
      price:      numPrice,
      old_price:  oldPrice,
      listing_id: listingId,
      patch_status:   patchR.status,
      publish_status: pubR.status,
      message: patchR.ok
        ? `Price updated to ${numPrice.toLocaleString()} AED/mo in-place on listing ${listingId}`
        : `PATCH failed — see pf_response`,
    });

  } catch (err) {
    console.error('[update-price]', err);
    return res.status(500).json({ error: err.message });
  }
}
