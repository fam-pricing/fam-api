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
        model: 'claude-sonnet-4-6',
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

const TOOLS = [
  {
    name: 'send_reply',
    description: 'Send a WhatsApp reply to the lead. Use this for ALL normal replies where you are confident in your answer.',
    input_schema: {
      type: 'object',
      properties: { message: { type: 'string', description: 'The exact message text to send. Plain text only, no quotes around it, no reasoning.' } },
      required: ['message'],
    },
  },
  {
    name: 'escalate_to_faysal',
    description: 'Escalate to Faysal when you are not confident, lead asks for a human, demands a guaranteed fixed price beyond 3 months, or property is unknown.',
    input_schema: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'Internal reason for escalation (not shown to lead)' },
        holding_message: { type: 'string', description: 'Short warm message to send the lead while escalating' },
      },
      required: ['reason', 'holding_message'],
    },
  },
  {
    name: 'book_viewing',
    description: 'Book a viewing ONLY when the lead has given a SPECIFIC day AND a SPECIFIC time. If either is missing, use send_reply to ask.',
    input_schema: {
      type: 'object',
      properties: {
        property: { type: 'string' },
        day: { type: 'string', description: 'Specific day e.g. "tomorrow", "Saturday", "Monday"' },
        time: { type: 'string', description: 'Specific time e.g. "3pm", "10:00 AM". Must contain a digit.' },
        confirmation_message: { type: 'string', description: 'Confirmation message to send the lead' },
      },
      required: ['property', 'day', 'time', 'confirmation_message'],
    },
  },
];

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

You are a warm, human WhatsApp sales agent for fäm Living (Dubai holiday homes). Lead name: ${leadName}. Property enquired about: ${property}.

RULES — follow every single one, no exceptions:
- ONLY suggest buildings from the Active Portfolio above. If a building is not listed, it is NOT available. Never mention Aykon City or any unlisted building.
- UNKNOWN PROPERTY: If the property is listed as "unknown", call escalate_to_faysal immediately. No exceptions.
- LONG-TERM PRICING: If a lead asks about a stay longer than 3 months, explain the current rate is locked for the first 3 months, and beyond that the rate depends on the season and will be confirmed ahead of each new period. Do NOT multiply the monthly price by months. Only escalate if the lead demands a guaranteed fixed price for the entire period beyond 3 months.
- NO EMOJIS: Never use any emoji. Zero. Absolute rule.
- NO EM DASHES: Never use — or – in replies. Use commas or short sentences instead.
- NO QUOTES: Never wrap your reply in quote marks. Send plain text only.
- NO REASONING LEAKAGE: Never include any internal thinking, self-critique, "Issues fixed:", rule names, or commentary in the reply. The message field must contain ONLY the text to send the customer.
- BUDGET OBJECTION: Ask "What budget are you working with?" — do NOT repeat the price.
- VIEWINGS: Available 9am–6pm any day. Call book_viewing only with a specific day AND time. If no time given, ask for it.
- HUMAN REQUEST: If lead asks for a human/agent/person, call escalate_to_faysal immediately.
- DAMAGE DEPOSIT: AED 3,000 for studio/1BR, AED 5,000 for 2BR+. Only mention when asked. Never mention first/last month deposit.
- ARABIC: If lead writes in Arabic, reply in Arabic.
- All prices are all-inclusive (water, electricity, internet).
- You MUST call exactly one tool per response.`;

  const userMessage = `Conversation so far:\n${transcript || '(no messages yet)'}\n\nLead just sent: "${newMessage}"`;

  // ── Clean helper: strip em/en dashes + surrounding quotes ─────────────────
  const cleanMsg = (s) => {
    let t = (s || '')
      .replace(/\s*\u2014\s*/g, ', ')
      .replace(/\s*\u2013\s*/g, ', ')
      .trim();
    if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
      t = t.slice(1, -1).trim();
    }
    return t;
  };

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 400,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }],
        tools: TOOLS,
        tool_choice: { type: 'any' },
      }),
    });

    if (!r.ok) {
      const err = await r.text().catch(() => String(r.status));
      return { reply: null, escalate: true, reason: `Anthropic error ${r.status}: ${err}` };
    }

    const d = await r.json();
    const toolBlock = d?.content?.find(b => b.type === 'tool_use');

    if (!toolBlock) {
      const text = d?.content?.find(b => b.type === 'text')?.text?.trim() || '';
      return { reply: cleanMsg(text) || null, escalate: !text, reason: text ? null : 'No tool or text in response', viewing: null };
    }

    const toolName = toolBlock.name;
    const toolArgs = toolBlock.input || {};

    if (toolName === 'send_reply') {
      const reply = cleanMsg(toolArgs.message);
      return { reply: reply || null, escalate: false, reason: null, viewing: null };
    }

    if (toolName === 'escalate_to_faysal') {
      const holding = cleanMsg(toolArgs.holding_message) || "Let me check that for you and come back shortly!";
      return { reply: holding, escalate: true, reason: (toolArgs.reason || 'Escalated').trim(), viewing: null };
    }

    if (toolName === 'book_viewing') {
      const { day, time, confirmation_message } = toolArgs;
      const hasTime = /\d/.test(time || '');
      const hasTBD  = /\bTBD\b/i.test(time || '') || /\bTBD\b/i.test(day || '');
      if (!hasTime || hasTBD) {
        const fallback = cleanMsg(confirmation_message) || "Sure! What time works for you? Viewings are available any day between 9am and 6pm.";
        return { reply: fallback, escalate: false, reason: null, viewing: null };
      }
      const viewing = `${toolArgs.property || property} on ${day} at ${time}`;
      const reply   = cleanMsg(confirmation_message) || `${time} on ${day} works! Our team will be in touch to confirm.`;
      return { reply, escalate: false, reason: null, viewing };
    }

    return { reply: "Let me check that for you and come back shortly!", escalate: true, reason: `Unknown tool: ${toolName}`, viewing: null };

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
