import { getListingMapsUrl } from '../../lib/guesty.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const pw = req.query?.password;
  if (pw !== process.env.SYNC_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  
  const building = req.query?.building || 'Reehan 1 Old Town';
  const mapsUrl = await getListingMapsUrl(building);
  return res.status(200).json({ building, mapsUrl, found: !!mapsUrl });
}
