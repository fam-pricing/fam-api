// fäm Living — GET /api/admin/migrate-redis?password=XXX
// One-time migration: seeds Upstash Redis from GitHub JSON files.
// Run ONCE after setting UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN env vars in Vercel.

import { migrateGitHubToRedis } from '../../lib/crm.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const password = process.env.SYNC_PASSWORD;
  if (!password || req.query?.password !== password) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    return res.status(400).json({ error: 'UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN env vars required' });
  }

  try {
    const result = await migrateGitHubToRedis();
    return res.status(200).json({ ok: true, migrated: result });
  } catch (e) {
    return res.status(500).json({ error: e?.message });
  }
}
