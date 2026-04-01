import { getListingMapsUrl } from '../../lib/guesty.js';

const GUESTY_API = 'https://open-api.guesty.com';
const GUESTY_TIMEOUT_MS = 8000;

async function fetchWithTimeout(url, opts, timeoutMs = GUESTY_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetch(url, { ...opts, signal: controller.signal }); }
  finally { clearTimeout(timer); }
}

async function getToken() {
  const clientId = process.env.GUESTY_CLIENT_ID;
  const clientSecret = process.env.GUESTY_CLIENT_SECRET;
  if (!clientId || !clientSecret) return { error: 'No Guesty creds' };
  const r = await fetchWithTimeout(GUESTY_API + '/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'open-api:read', client_id: clientId, client_secret: clientSecret }).toString(),
  });
  if (!r.ok) return { error: 'Token failed: ' + r.status };
  const d = await r.json();
  return { token: d.access_token };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const building = req.query?.building || 'Reehan 1 Old Town';
  
  const { token, error } = await getToken();
  if (error) return res.status(200).json({ error });

  // Raw Guesty search
  const url = `${GUESTY_API}/v1/listings?limit=10&fields=address,nickname,title&searchTerm=${encodeURIComponent(building)}`;
  const r = await fetchWithTimeout(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  const d = await r.json();
  const listings = d.results || d.data || [];
  
  // Also try getListingMapsUrl
  const mapsUrl = await getListingMapsUrl(building);
  
  return res.status(200).json({
    building,
    mapsUrl,
    guestyResultCount: listings.length,
    guestyListings: listings.map(l => ({
      title: l.title,
      nickname: l.nickname,
      address: l.address?.full,
      lat: l.address?.lat,
      lng: l.address?.lng,
      city: l.address?.city,
    })),
  });
}
