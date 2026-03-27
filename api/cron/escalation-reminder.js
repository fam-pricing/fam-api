// fäm Living — GET /api/cron/escalation-reminder
// Runs hourly. Checks for pending bot escalations > 6h without a Faysal reply.
// Sends a WhatsApp reminder to Faysal so he doesn't forget.

const GH_API  = 'https://api.github.com';
const REPO    = 'fam-pricing/fam-api';
const PENDING_FILE = 'data/pending_escalations.json';
const TRENGO_API   = 'https://app.trengo.com/api/v2';

const REMINDER_AFTER_MS = 6 * 60 * 60 * 1000; // 6 hours
const DUBAI_OFFSET = 4;

async function ghRead(file) {
  const ghToken = process.env.GH_TOKEN;
  if (!ghToken) return { data: null, sha: null };
  const r = await fetch(`${GH_API}/repos/${REPO}/contents/${file}`, {
    headers: { Authorization: `Bearer ${ghToken}`, Accept: 'application/vnd.github.v3+json' },
  });
  if (!r.ok) return { data: null, sha: null };
  const d = await r.json();
  try {
    return { data: JSON.parse(Buffer.from(d.content.replace(/\n/g, ''), 'base64').toString('utf8')), sha: d.sha };
  } catch { return { data: null, sha: d.sha }; }
}

async function ghWrite(file, data, sha, message) {
  const ghToken = process.env.GH_TOKEN;
  if (!ghToken) return;
  const content = Buffer.from(JSON.stringify(data, null, 2)).toString('base64');
  await fetch(`${GH_API}/repos/${REPO}/contents/${file}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${ghToken}`, Accept: 'application/vnd.github.v3+json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, content, sha }),
  });
}

async function sendWA(ticketId, message) {
  const token = process.env.TRENGO_TOKEN;
  if (!ticketId || !token) return false;
  try {
    const r = await fetch(`${TRENGO_API}/tickets/${ticketId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ message, type: 'OUTBOUND' }),
    });
    return r.ok;
  } catch { return false; }
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  if (process.env.AUTOBOT_ENABLED !== 'true') {
    return res.status(200).json({ ok: true, skipped: 'Bot disabled' });
  }

  try {
    const { data: esc, sha } = await ghRead(PENDING_FILE);
    if (!esc || !esc.pending?.length) {
      return res.status(200).json({ ok: true, reminders: 0, message: 'No pending escalations' });
    }

    const faysalTicketId = process.env.FAYSAL_TICKET_ID
      ? parseInt(process.env.FAYSAL_TICKET_ID, 10)
      : esc.faysal_ticket_id || null;

    if (!faysalTicketId) {
      return res.status(200).json({ ok: true, reminders: 0, message: 'No Faysal ticket ID configured' });
    }

    const now = Date.now();
    const overdue = esc.pending.filter(e => {
      if (e.answered_at) return false; // Already answered
      const age = now - new Date(e.escalated_at).getTime();
      if (age < REMINDER_AFTER_MS) return false; // Not old enough yet
      if (e.reminded_at) {
        // Already reminded — only remind once every 6h after that
        const reminderAge = now - new Date(e.reminded_at).getTime();
        return reminderAge >= REMINDER_AFTER_MS;
      }
      return true;
    });

    if (!overdue.length) {
      return res.status(200).json({ ok: true, reminders: 0, message: 'No reminders due' });
    }

    // Build reminder message
    const dubaiTime = new Date(now + DUBAI_OFFSET * 3600000)
      .toISOString().replace('T', ' ').substring(0, 16);

    let msg = `🔔 *Reminder — pending lead questions (${dubaiTime} GST)*\n\n`;
    overdue.forEach((e, i) => {
      const ageH = Math.floor((now - new Date(e.escalated_at).getTime()) / 3600000);
      msg += `*${i + 1}.* ${e.lead_name} re ${e.property} (${ageH}h ago)\n"${e.question}"\n\n`;
    });
    msg += `Reply here with the answer and I'll handle the rest 📚`;

    const sent = await sendWA(faysalTicketId, msg);

    if (sent) {
      // Update reminded_at for all reminded escalations
      const now_iso = new Date().toISOString();
      overdue.forEach(e => {
        const idx = esc.pending.findIndex(p => p.id === e.id);
        if (idx !== -1) esc.pending[idx].reminded_at = now_iso;
      });
      await ghWrite(PENDING_FILE, esc, sha, 'Bot: escalation reminders sent');
    }

    console.log(`[escalation-reminder] Reminded Faysal about ${overdue.length} pending Q(s), sent=${sent}`);
    return res.status(200).json({ ok: true, reminders: overdue.length, sent });

  } catch (err) {
    console.error('[escalation-reminder]', err);
    return res.status(500).json({ error: err.message });
  }
}
