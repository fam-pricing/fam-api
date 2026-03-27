// fäm Living — POST /api/crm/playground
// Simulates the night-shift bot using the live playbook.
// Faysal types as a lead; the bot replies exactly as it would at night.
// Auth: owner role only (playground is a private testing tool)

import { requireAuth } from '../_auth.js';

const GH_API       = 'https://api.github.com';
const REPO         = 'fam-pricing/fam-api';
const PLAYBOOK_FILE = 'data/playbook.md';
const LISTINGS_FILE = 'data/listings.json';

// ── Load live playbook from GitHub ────────────────────────────────────────────

async function loadPlaybook() {
  const token = process.env.GH_TOKEN;
  if (!token) return '';
  try {
    const r = await fetch(`${GH_API}/repos/${REPO}/contents/${PLAYBOOK_FILE}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github.v3+json' },
    });
    if (!r.ok) return '';
    const d = await r.json();
    return Buffer.from(d.content.replace(/\n/g, ''), 'base64').toString('utf8').trim();
  } catch {
    return '';
  }
}

// ── Append a rule to the playbook ─────────────────────────────────────────────

async function appendToPlaybook(newEntry) {
  const token = process.env.GH_TOKEN;
  if (!token) return false;
  try {
    // Get current file + SHA
    const r1 = await fetch(`${GH_API}/repos/${REPO}/contents/${PLAYBOOK_FILE}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github.v3+json' },
    });
    if (!r1.ok) return false;
    const d1  = await r1.json();
    const sha  = d1.sha;
    const current = Buffer.from(d1.content.replace(/\n/g, ''), 'base64').toString('utf8');
    const updated  = current.trimEnd() + '\n\n' + newEntry.trim() + '\n';
    const encoded  = Buffer.from(updated).toString('base64');

    const r2 = await fetch(`${GH_API}/repos/${REPO}/contents/${PLAYBOOK_FILE}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github.v3+json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Playbook update via Simulator', content: encoded, sha }),
    });
    return r2.ok;
  } catch {
    return false;
  }
}

// ── Rephrase a raw correction into clean playbook language ────────────────────

async function rephraseRule(rawMessage) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return rawMessage;
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 150,
        messages: [{
          role: 'user',
          content: `You are editing a WhatsApp sales playbook for a Dubai holiday home company.

Rewrite the following into a single, clean playbook rule. Fix typos, tighten the language, keep the exact meaning. Output ONLY the rule text — no labels, no bullet point, no explanation.

Raw input: "${rawMessage}"`,
        }],
      }),
    });
    if (!r.ok) return rawMessage;
    const d = await r.json();
    return d?.content?.[0]?.text?.trim() || rawMessage;
  } catch {
    return rawMessage;
  }
}

// ── Bot reply using Claude (same logic as auto-reply.js) ──────────────────────


// ── Portfolio lookup (mirrors auto-reply.js) ──────────────────────────────────

async function ghReadJSON(file) {
  const ghToken = process.env.GH_TOKEN;
  if (!ghToken) return null;
  const r = await fetch(`https://api.github.com/repos/fam-pricing/fam-api/contents/${file}`, {
    headers: { Authorization: `Bearer ${ghToken}`, Accept: 'application/vnd.github.v3+json' },
  });
  if (!r.ok) return null;
  const d = await r.json();
  try { return JSON.parse(Buffer.from(d.content.replace(/\n/g, ''), 'base64').toString('utf8')); }
  catch { return null; }
}

async function getPortfolioListings(messageText) {
  try {
    const data = await ghReadJSON(LISTINGS_FILE);
    if (!data || !Array.isArray(data)) return null;

    const msg = messageText.toLowerCase();
    const areaKeywords = {
      'business bay': 'Business Bay',
      'downtown': 'Downtown',
      'city walk': 'City Walk',
      'jvc': 'JVC',
      'dubai marina': 'Dubai Marina',
      'dubai hills': 'Dubai Hills',
      'creek harbour': 'Dubai Creek Harbour',
      'dubai creek': 'Dubai Creek Harbour',
      'sports city': 'Dubai Sports City',
      'palm': 'Palm Jumeirah',
      'marina': 'Dubai Marina',
      'jbr': 'JBR',
    };

    let filter = null;
    for (const [kw, area] of Object.entries(areaKeywords)) {
      if (msg.includes(kw)) { filter = area; break; }
    }

    const listings = filter
      ? data.filter(l => l.area && l.area.toLowerCase().includes(filter.toLowerCase()))
      : data;

    if (!listings.length) return null;

    const byArea = {};
    listings.forEach(l => {
      const a = l.area || 'Other';
      if (!byArea[a]) byArea[a] = [];
      byArea[a].push(`${l.beds} in ${l.building} — AED ${Number(l.price).toLocaleString()}/mo`);
    });

    return Object.entries(byArea)
      .map(([area, items]) => `${area}:\n${items.map(i => `  • ${i}`).join('\n')}`)
      .join('\n\n');
  } catch (e) {
    console.warn('[playground] portfolio lookup failed:', e?.message);
    return null;
  }
}

function isPortfolioQuestion(text) {
  const t = text.toLowerCase();
  return /option|propert|listing|available|avail|apartment|studio|\bunit\b|what else|show me|give me|what.*have|have.*what|portfolio|inventory|what do you|do you have/.test(t);
}

async function generateReply(history, newMessage, leadName, property, playbook) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { reply: null, escalate: true, reason: 'No ANTHROPIC_API_KEY configured' };

  // Always inject live portfolio so bot never escalates on availability questions
  let portfolioContext = '';
  const listings = await getPortfolioListings(newMessage);
  if (listings) {
    portfolioContext = `\n\n## Active fäm Living Portfolio (live prices — use this to answer any question about what we have available):\n${listings}\n`;
  }

  const transcript = history
    .slice(-10)
    .map(m => `${m.from === 'lead' ? leadName : 'Agent'}: ${m.text}`)
    .join('\n');

  const systemPrompt = `${playbook}${portfolioContext}

You are a warm, human WhatsApp sales agent for fäm Living. Lead: ${leadName}. Property: ${property}.

RULES — follow exactly, no exceptions:
- The Active fäm Living Portfolio above lists ALL live listings. Use it for any availability/options question. Never escalate for this.
- Output ONLY the reply message text. Absolutely zero reasoning, thinking, or internal monologue before or after.
- Your very first character must be part of the actual message to the customer.
- Never write "Let me", "I need to", "I should", "Looking at", or any self-reflection.
- If confident → reply directly.
- If NOT confident → [ESCALATE: reason] on line 1, short holding message on line 2.
- If confirming a viewing → [VIEWING: day at time] on line 1, message on line 2.
- Keep it short, warm, human.
- PRICING MATH — CRITICAL: Prices are seasonal and only locked for 3 months at a time. NEVER calculate or quote a total for more than 3 months. If a lead asks about 4, 6, 12 months or a full year: quote the current monthly rate and say our rates are confirmed in 3-month blocks, you can lock in the current rate for the first 3 months, and for beyond that the rate depends on the season and you will need to confirm with the team. Then [ESCALATE: lead asking about long-term pricing beyond 3 months]. Do NOT multiply price by 12 or 6 or any number above 3.`;

  const userMessage = `Conversation so far:\n${transcript || '(no messages yet)'}\n\nLead just sent: "${newMessage}"`;

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 300,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }],
      }),
    });

    if (!r.ok) {
      const err = await r.text().catch(() => String(r.status));
      return { reply: null, escalate: true, reason: `Anthropic error ${r.status}: ${err}` };
    }

    const d    = await r.json();
    const text = d?.content?.[0]?.text?.trim() || '';
    if (!text) return { reply: null, escalate: true, reason: 'Empty AI response' };

    if (text.startsWith('[ESCALATE:')) {
      const lines      = text.split('\n');
      const reason     = lines[0].replace('[ESCALATE:', '').replace(']', '').trim();
      const holdingMsg = lines.slice(1).join('\n').trim() || 'Let me check that for you and come back shortly!';
      return { reply: holdingMsg, escalate: true, reason, viewing: null };
    }

    if (text.startsWith('[VIEWING:')) {
      const lines     = text.split('\n');
      const when      = lines[0].replace('[VIEWING:', '').replace(']', '').trim();
      const replyText = lines.slice(1).join('\n').trim() || text;
      return { reply: replyText, escalate: false, reason: null, viewing: when };
    }

    return { reply: text, escalate: false, reason: null, viewing: null };

  } catch (err) {
    return { reply: null, escalate: true, reason: err?.message || 'Unknown error', viewing: null };
  }
}

// ── Handler ───────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const user = requireAuth(req, res, 'owner');
  if (!user) return;

  let body = req.body;
  if (!body || typeof body === 'string') {
    try { body = JSON.parse(body); } catch { return res.status(400).json({ error: 'Invalid JSON' }); }
  }

  // ── Test-note action: post a test internal note to a Trengo ticket ───────────
  if (body.action === 'test-note') {
    const ticketId = body.ticket_id || 937595459;
    const token = process.env.TRENGO_TOKEN;
    const note =
      `🧪 fäm Bot — internal note test\n\n` +
      `Tagging the team:\n` +
      `@junaid731578 @farhan731560 @chahana470168 @afifa340123 @abdul315306\n\n` +
      `If you can see this, internal notes with @mentions are working correctly.\n— fäm Bot`;
    try {
      const r = await fetch(`https://app.trengo.com/api/v2/tickets/${ticketId}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ message: note, internal_note: true }),
      });
      const d = await r.json().catch(() => ({}));
      return res.status(200).json({ ok: r.ok, status: r.status, ticket_id: ticketId, trengo: d });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  }

  // ── Teach action: save a correction to the playbook ──────────────────────────
  if (body.action === 'teach') {
    const rawRule = (body.rule || '').trim();
    if (!rawRule) return res.status(400).json({ error: 'rule is required' });

    const polished = await rephraseRule(rawRule);
    const today    = new Date().toISOString().slice(0, 10);
    const entry    = `## Learned (${today})\n- ${polished}\n  (Taught via Simulator by Faysal)`;
    const saved    = await appendToPlaybook(entry);

    return res.status(200).json({ ok: true, saved_as: polished, persisted: saved });
  }

  // ── Normal simulator reply ─────────────────────────────────────────────────
  const { message, history = [], lead_name, property, listing_price } = body;

  if (!message || !message.trim()) {
    return res.status(400).json({ error: 'message is required' });
  }

  const leadName    = (lead_name  || 'Ahmed').trim();
  const propertyStr = listing_price
    ? `${property || 'unknown property'} — AED ${Number(listing_price).toLocaleString()}/month`
    : (property || 'unknown property');

  try {
    const playbook = await loadPlaybook();
    const { reply, escalate, reason, viewing } = await generateReply(history, message.trim(), leadName, propertyStr, playbook);

    return res.status(200).json({
      ok:      true,
      reply,
      escalate,
      reason:  escalate ? reason : null,
      viewing: viewing || null,
    });

  } catch (err) {
    console.error('[playground]', err);
    return res.status(500).json({ error: err.message });
  }
}
