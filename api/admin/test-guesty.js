import { getListingMapsUrl } from '../../lib/guesty.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  // Temporary open endpoint for coords verification — will be removed
  const building = req.query?.building || 'Reehan 1 Old Town';
  const mapsUrl = await getListingMapsUrl(building);
  return res.status(200).json({ building, mapsUrl, found: !!mapsUrl });
}
