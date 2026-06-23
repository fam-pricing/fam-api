// api/admin/prune-crm.js — one-time CRM prune: ARCHIVE inert old leads (reversible).
// Dry run (no auth):  GET /api/admin/prune-crm?dry=1[&days=60]   -> counts only, writes nothing
// Real run:           GET /api/admin/prune-crm?secret=CRON_SECRET[&days=60]
// Archives leads with no activity in N days into data/crm_archive.json (never deletes).
import { readCRMState, writeCRMState, ghRead, ghWrite } from '../../lib/crm.js';

const ARCHIVE_FILE = 'data/crm_archive.json';

export default async function handler(req, res) {
  const days = parseInt(req.query.days || '60', 10);
  const cutoff = Date.now() - days * 86400000;

  const { state, sha } = await readCRMState();
  const total = Object.keys(state).length;
  // Safety: never act on a bad/partial read
  if (total < 50) {
    return res.status(200).json({ ok: false, reason: `Only ${total} leads read — aborting to avoid data loss`, total });
  }

  const keep = {}, archive = {};
  for (const [id, lead] of Object.entries(state)) {
    const tsStr = lead.updated_at || lead.auto_responded_at || lead.created_at;
    const ts = tsStr ? Date.parse(tsStr) : NaN;
    // Archive ONLY leads with a valid timestamp older than the cutoff. Keep everything else.
    if (!isNaN(ts) && ts < cutoff) archive[id] = lead;
    else keep[id] = lead;
  }
  const archived = Object.keys(archive).length;
  const kept = Object.keys(keep).length;

  if (req.query.dry === '1') {
    return res.status(200).json({ ok: true, dryRun: true, cutoffDays: days, total, wouldKeep: kept, wouldArchive: archived });
  }

  // Real run requires the secret
  const secret = process.env.CRON_SECRET;
  const provided = req.query.secret || (req.headers.authorization || '').replace('Bearer ', '');
  if (!secret || provided !== secret) {
    return res.status(401).json({ error: 'Unauthorized — add ?secret=CRON_SECRET (or use ?dry=1 to preview)' });
  }
  if (archived === 0) {
    return res.status(200).json({ ok: true, total, kept, archived: 0, note: 'nothing older than cutoff' });
  }

  // Merge into any existing archive, then write the trimmed live state.
  const { data: existingArch, sha: archSha } = await ghRead(ARCHIVE_FILE);
  const mergedArch = Object.assign({}, existingArch || {}, archive);
  await ghWrite(ARCHIVE_FILE, mergedArch, archSha, `CRM: archive ${archived} inert leads`);
  await writeCRMState(keep, sha);

  return res.status(200).json({ ok: true, total, kept, archived });
}
