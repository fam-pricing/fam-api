// fäm Living — POST /api/crm/auto-reply
// Trengo webhook handler: reads inbound lead messages, generates AI reply via Claude,
// posts response back to the lead on WhatsApp via Trengo.
//
// ⚠️  NOT LIVE — bot_active flag in crm_state must be true per lead to fire.
//     Set globally via AUTOBOT_ENABLED=true env var to enable across all leads.
//
// Flow:
//   Trengo fires webhook → we validate → load context (lead + playbook + history)
//   → Claude generates reply → post to Trengo → update crm_state
//   → If Claude is unsure → email Faysal with the question (teaching loop)

import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname     = path.dirname(fileURLToPath(import.meta.url));
const PLAYBOOK_PATH = path.join(__dirname, '../../data/playbook.md');

const GH_API        = 'https://api.github.com';
const TRENGO_API    = 'https://app.trengo.com/api/v2';
const REPO          = 'fam-pricing/fam-api';
const CRM_FILE      = 'data/crm_state.json';

const FAYSAL_EMAIL  = 'faysalyayoubi@gmail.com';

// How long to wait before replying — feels more human, avoids instant-bot vibe
const REPLY_DELAY_MS = 3000;

// If an agent manually replied in the last N minutes, don't auto-reply
const AGENT_COOLDOWN_MS = 15 * 60 * 1000; // 15 minutes

// ── Helpers ───────────────────────────────────────────────────────────────────

function loadPlaybook() {
  try {
    if (fs.existsSync(PLAYBOOK_PATH)) return fs.readFileSync(PLAYBOOK_PATH, 'utf8').trim();
  } catch (e) {
    console.warn('[auto-reply] playbook load failed:', e?.message);
  }
  return '';
}

async function fetchGHJson(filePath) {
  const ghToken = process.env.GH_TOKEN;
  if (!ghToken) return {};
  try {
    const r = await fetch(`${GH_API}/repos/${REPO}/contents/${filePath}`, {
      headers: { Authorization: `Bearer ${ghToken}`, Accept: 'application/vnd.github.v3+json' },
    });
    if (!r.ok) return {};
    const d = await r.json();
    return JSON.parse(Buffer.from(d.content.replace(/\n/g, ''), 'base64').toString('utf8'));
  } catch { return {}; }
}

async function readCRMState() {
  const ghToken = process.env.GH_TOKEN;
  if (!ghToken) return { state: {}, sha: null };
  const r = await fetch(`${GH_API}/repos/${REPO}/contents/${CRM_FILE}`, {
    headers: { Authorization: `Bearer ${ghToken}`, Accept: 'application/vnd.github.v3+json' },
  });
  if (!r.ok) return { state: {}, sha: null };
  const d = await r.json();
  try {
    return { state: JSON.parse(Buffer.from(d.content.replace(/\n/g, ''), 'base64').toString('utf8')), sha: d.sha };
  } catch { return { state: {}, sha: d.sha }; }
}

async function writeCRMState(state, sha) {
  const ghToken = process.env.GH_TOKEN;
  if (!ghToken) return;
  const content = Buffer.from(JSON.stringify(state, null, 2)).toString('base64');
  await fetch(`${GH_API}/repos/${REPO}/contents/${CRM_FILE}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${ghToken}`, Accept: 'application/vnd.github.v3+json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'CRM: auto-reply [bot]', content, sha }),
  });
}

// Fetch last N messages from Trengo ticket
async function getTrengoMessages(ticketId) {
  const token = process.env.TRENGO_TOKEN;
  try {
    const r = await fetch(`${TRENGO_API}/tickets/${ticketId}/messages`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    if (!r.ok) return [];
    const d = await r.json();
    return d.data || d.messages || [];
  } catch { return []; }
}

// Post a reply message to a Trengo ticket
async function postTrengoMessage(ticketId, message) {
  const token = process.env.TRENGO_TOKEN;
  try {
    const r = await fetch(`${TRENGO_API}/tickets/${ticketId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ message, type: 'OUTBOUND' }),
    });
    const d = await r.json();
    if (!r.ok) { console.error('[auto-reply] post message failed:', r.status, JSON.stringify(d)); return false; }
    console.log('[auto-reply] message sent, id:', d.id || d.message?.id);
    return true;
  } catch (err) {
    console.error('[auto-reply] postMessage error:', err.message);
    return false;
  }
}

// Send escalation email to Faysal when Claude doesn't know the answer
async function emailFaysal(leadName, property, question, ticketId) {
  // Uses Trengo's internal note as a fallback visible to the team
  // + logs clearly so Faysal knows to check
  const token = process.env.TRENGO_TOKEN;
  const note  = `🤖 Bot escalation — doesn't know how to answer:\n\nLead: ${leadName}\nProperty: ${property}\nTicket: ${ticketId}\n\nQuestion from lead:\n"${question}"\n\nReply to this note or WhatsApp Faysal (+971502725428) with the answer.`;

  console.log('[auto-reply] ESCALATION:', note);

  // Post as internal note on the ticket so Afifa sees it in Trengo
  try {
    await fetch(`${TRENGO_API}/tickets/${ticketId}/notes`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ message: note }),
    });
  } catch (e) {
    console.error('[auto-reply] note post failed:', e?.message);
  }

  // TODO: Send email to FAYSAL_EMAIL via SendGrid or similar when email service is wired
  // TODO: Send WhatsApp to +971502725428 via HSM template once Meta template is approved
  //       Template message: "❓ Lead question from {{1}} re {{2}}: {{3}} — what should I reply?"
}

// ── Claude AI reply generator ─────────────────────────────────────────────────

async function generateReply(conversation, leadMeta, newMessage, leadName) {
  const apiKey  = process.env.ANTHROPIC_API_KEY;
  const playbook = loadPlaybook();

  if (!apiKey) {
    console.error('[auto-reply] No ANTHROPIC_API_KEY');
    return { reply: null, escalate: true, reason: 'No API key' };
  }

  // Build conversation history (last 10 messages for context)
  const history = conversation
    .slice(-10)
    .filter(m => m.message || m.body || m.text)
    .map(m => {
      const isInbound = m.type?.toUpperCase() === 'INBOUND';
      return `${isInbound ? leadName : 'Agent'}: ${(m.message || m.body || m.text || '').trim()}`;
    })
    .join('\n');

  const property = leadMeta?.listing_title || 'the property';

  const prompt = `${playbook}

---

You are handling a WhatsApp conversation for fäm Living. The lead's name is ${leadName} and they enquired about: ${property}.

Conversation so far:
${history}

The lead just sent:
"${newMessage}"

Instructions:
- Reply naturally, as a warm human team member would on WhatsApp. Short, friendly, direct.
- Follow all the rules in the playbook above — pricing, discounts, tone, cross-sell, etc.
- If you are confident in your reply, output ONLY the message to send. No labels, no "Reply:", nothing else.
- If you are NOT confident — you don't know the price, the availability of a specific date, or anything specific — output exactly this format on the first line: [ESCALATE: reason]
  Then on the next line, write the holding message to send to the lead (e.g. "Let me check that for you and come back shortly! 😊").

Be concise. Sound human. Never sound like an AI.`;

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key':         apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type':      'application/json',
      },
      body: JSON.stringify({
        model:      'claude-haiku-4-5-20251001',
        max_tokens: 300,
        messages:   [{ role: 'user', content: prompt }],
      }),
    });

    if (!r.ok) {
      const err = await r.text().catch(() => String(r.status));
      console.error('[auto-reply] Anthropic error:', r.status, err);
      return { reply: null, escalate: true, reason: `Anthropic error ${r.status}` };
    }

    const d    = await r.json();
    const text = d?.content?.[0]?.text?.trim() || '';

    if (!text) return { reply: null, escalate: true, reason: 'Empty AI response' };

    // Check if Claude flagged an escalation
    if (text.startsWith('[ESCALATE:')) {
      const lines       = text.split('\n');
      const reason      = lines[0].replace('[ESCALATE:', '').replace(']', '').trim();
      const holdingMsg  = lines.slice(1).join('\n').trim() || "Let me check that for you and come back shortly! 😊";
      return { reply: holdingMsg, escalate: true, reason };
    }

    return { reply: text, escalate: false, reason: null };

  } catch (err) {
    console.error('[auto-reply] Claude call failed:', err?.message);
    return { reply: null, escalate: true, reason: err?.message };
  }
}

// ── Main webhook handler ───────────────────────────────────────────────────────

export default async function handler(req, res) {
  // Only accept POST from Trengo
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // ⚠️  GLOBAL KILL SWITCH — must be explicitly enabled in Vercel env vars
  if (process.env.AUTOBOT_ENABLED !== 'true') {
    return res.status(200).json({ ok: true, skipped: 'AUTOBOT_ENABLED is not true — bot is off' });
  }

  // Validate Trengo webhook secret
  const webhookSecret = process.env.TRENGO_WEBHOOK_SECRET;
  if (webhookSecret) {
    const sig = req.headers['x-trengo-signature'] || req.headers['x-hub-signature'] || '';
    if (!sig.includes(webhookSecret)) {
      console.warn('[auto-reply] Invalid webhook signature');
      return res.status(401).json({ error: 'Invalid signature' });
    }
  }

  // Parse webhook body
  let body = req.body;
  if (!body || typeof body === 'string') {
    try { body = JSON.parse(body); } catch { return res.status(400).json({ error: 'Invalid JSON' }); }
  }

  // Trengo webhook payload — we care about new inbound messages
  const messageType = body?.message?.type?.toUpperCase() || body?.type?.toUpperCase() || '';
  const ticketId    = body?.ticket?.id || body?.message?.ticket_id || null;
  const messageText = body?.message?.message || body?.message?.body || body?.message?.text || '';

  // Only process inbound messages (from leads), not our own outbound
  if (messageType !== 'INBOUND') {
    return res.status(200).json({ ok: true, skipped: 'Not an inbound message' });
  }

  if (!ticketId || !messageText) {
    return res.status(200).json({ ok: true, skipped: 'Missing ticket ID or message text' });
  }

  console.log('[auto-reply] Inbound message on ticket', ticketId, ':', messageText.substring(0, 60));

  try {
    // Load CRM state — find which lead this ticket belongs to
    const { state: crmState, sha } = await readCRMState();
    const leadId = Object.keys(crmState).find(k => crmState[k].trengo_ticket_id === ticketId);

    if (!leadId) {
      console.warn('[auto-reply] No CRM lead found for ticket', ticketId);
      return res.status(200).json({ ok: true, skipped: 'Ticket not in CRM' });
    }

    const leadMeta = crmState[leadId];

    // Per-lead kill switch — Afifa or Faysal can set bot_paused: true on a lead to take over manually
    if (leadMeta.bot_paused) {
      return res.status(200).json({ ok: true, skipped: 'Bot paused for this lead' });
    }

    const leadName = leadMeta.lead_name || 'there';

    // Don't auto-reply if an agent replied manually in the last 15 minutes
    const lastAgentAt = leadMeta.last_agent_reply_at ? new Date(leadMeta.last_agent_reply_at).getTime() : 0;
    if (Date.now() - lastAgentAt < AGENT_COOLDOWN_MS) {
      console.log('[auto-reply] Agent cooldown active — skipping');
      return res.status(200).json({ ok: true, skipped: 'Agent cooldown' });
    }

    // Load conversation history from Trengo
    const conversation = await getTrengoMessages(ticketId);

    // Wait before replying — feels more human
    await new Promise(r => setTimeout(r, REPLY_DELAY_MS));

    // Generate AI reply
    const { reply, escalate, reason } = await generateReply(conversation, leadMeta, messageText, leadName);

    if (escalate) {
      console.log('[auto-reply] Escalating to Faysal — reason:', reason);
      // Send the holding message to the lead (if Claude generated one)
      if (reply) {
        await postTrengoMessage(ticketId, reply);
      }
      // Alert Faysal via internal note (+ email/WhatsApp when wired)
      await emailFaysal(leadName, leadMeta.listing_title || 'unknown property', messageText, ticketId);

      crmState[leadId].last_escalated_at = new Date().toISOString();
      crmState[leadId].last_escalation_reason = reason;
      await writeCRMState(crmState, sha);
      return res.status(200).json({ ok: true, action: 'escalated', reason });
    }

    // Send the reply
    const sent = await postTrengoMessage(ticketId, reply);

    if (sent) {
      crmState[leadId].last_bot_reply_at  = new Date().toISOString();
      crmState[leadId].bot_reply_count    = (leadMeta.bot_reply_count || 0) + 1;
      crmState[leadId].lead_replied       = true;
      crmState[leadId].lead_replied_at    = new Date().toISOString();
      await writeCRMState(crmState, sha);
    }

    return res.status(200).json({ ok: true, action: 'replied', sent });

  } catch (err) {
    console.error('[auto-reply] handler error:', err);
    return res.status(500).json({ error: err.message });
  }
}
