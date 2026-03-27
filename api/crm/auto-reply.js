// fäm Living — POST /api/crm/auto-reply
// Trengo webhook handler for both INBOUND (lead) and OUTBOUND (agent) messages.
//
// Night shift mode (9 PM – 6 AM Dubai time):
//   INBOUND → AI reads message, generates reply, posts back via Trengo
//   Bot escalates to Faysal when unsure, posts holding msg to lead
//
// Day shift (6 AM – 9 PM Dubai):
//   INBOUND → bot stays silent, Afifa handles
//   OUTBOUND from Afifa → bot reads and logs as learning opportunity
//     → if Afifa replied after a bot escalation, extract Q&A, log for playbook update
//
// Kill switches:
//   AUTOBOT_ENABLED env var must = 'true' (global off switch)
//   bot_paused flag in crm_state disables per-lead (Afifa can flip this)

import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname     = path.dirname(fileURLToPath(import.meta.url));
const PLAYBOOK_PATH = path.join(__dirname, '../../data/playbook.md');

const GH_API     = 'https://api.github.com';
const TRENGO_API = 'https://app.trengo.com/api/v2';
const REPO       = 'fam-pricing/fam-api';
const CRM_FILE   = 'data/crm_state.json';

// Dubai = UTC+4
const DUBAI_OFFSET_HOURS = 4;
// Night shift: 21:00 – 06:00 Dubai time
const NIGHT_START = 21;
const NIGHT_END   = 6;

const REPLY_DELAY_MS    = 3000;  // 3s pause before replying (feels human)
const AGENT_COOLDOWN_MS = 15 * 60 * 1000; // 15 min cooldown after agent reply

// ── Time helpers ──────────────────────────────────────────────────────────────

function getDubaiHour() {
  return (new Date().getUTCHours() + DUBAI_OFFSET_HOURS) % 24;
}

function isNightShift() {
  const h = getDubaiHour();
  // Night shift wraps midnight: 21, 22, 23, 0, 1, 2, 3, 4, 5
  return h >= NIGHT_START || h < NIGHT_END;
}

// ── GitHub helpers ────────────────────────────────────────────────────────────

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

// ── Playbook ──────────────────────────────────────────────────────────────────

function loadPlaybook() {
  try {
    if (fs.existsSync(PLAYBOOK_PATH)) return fs.readFileSync(PLAYBOOK_PATH, 'utf8').trim();
  } catch (e) { console.warn('[auto-reply] playbook load failed:', e?.message); }
  return '';
}

async function appendToPlaybook(newRule) {
  try {
    const existing = fs.existsSync(PLAYBOOK_PATH) ? fs.readFileSync(PLAYBOOK_PATH, 'utf8') : '';
    const today    = new Date().toISOString().split('T')[0];
    const entry    = `\n## Learned from Afifa (${today})\n${newRule}\n`;
    fs.writeFileSync(PLAYBOOK_PATH, existing + entry, 'utf8');
    console.log('[auto-reply] Playbook updated with new learning');
  } catch (e) {
    console.error('[auto-reply] Failed to update playbook:', e?.message);
  }
}

// ── Trengo helpers ────────────────────────────────────────────────────────────

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

async function postTrengoMessage(ticketId, message) {
  const token = process.env.TRENGO_TOKEN;
  try {
    const r = await fetch(`${TRENGO_API}/tickets/${ticketId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ message, type: 'OUTBOUND' }),
    });
    const d = await r.json();
    if (!r.ok) { console.error('[auto-reply] post failed:', r.status, JSON.stringify(d)); return false; }
    return true;
  } catch (err) { console.error('[auto-reply] postMessage error:', err.message); return false; }
}

async function postTrengoNote(ticketId, note) {
  const token = process.env.TRENGO_TOKEN;
  try {
    await fetch(`${TRENGO_API}/tickets/${ticketId}/notes`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ message: note }),
    });
  } catch (e) { console.error('[auto-reply] note post failed:', e?.message); }
}

// ── Escalation to Faysal ──────────────────────────────────────────────────────

async function escalateToFaysal(leadName, property, question, ticketId, crmState, leadId, sha) {
  const dubaiTime = new Date(Date.now() + DUBAI_OFFSET_HOURS * 3600000)
    .toISOString().replace('T', ' ').substring(0, 16) + ' Dubai';

  // Store the escalated question so when Afifa answers we can learn from it
  if (crmState && leadId) {
    crmState[leadId].last_escalated_at       = new Date().toISOString();
    crmState[leadId].last_escalated_question = question;
  }

  // Internal Trengo note so Afifa sees it when she comes on shift
  const note = `🤖 Night bot couldn't answer (${dubaiTime}):\n\n"${question}"\n\nPlease reply to this lead when you're on shift. If you answer in the chat, I'll learn from it automatically.`;
  await postTrengoNote(ticketId, note);

  // TODO: Once Meta template approved, send WhatsApp to Faysal (+971502725428)
  //   Template: "❓ [Lead Name] re [Property] asked: [Question] — what should I reply?"
  console.log(`[auto-reply] ESCALATION logged for ticket ${ticketId}: "${question}"`);
}

// ── Learn from Afifa ──────────────────────────────────────────────────────────
// Called when an OUTBOUND message from an agent arrives during day shift.
// If this ticket had a recent bot escalation, Afifa's reply is the answer
// to the question the bot didn't know — extract it and update the playbook.

async function learnFromAfifaReply(ticketId, agentMessage, leadMeta, crmState, leadId, sha) {
  const question = leadMeta.last_escalated_question;
  if (!question) return; // No pending escalation — nothing to learn

  const escalatedAt = leadMeta.last_escalated_at ? new Date(leadMeta.last_escalated_at).getTime() : 0;
  const ageHours    = (Date.now() - escalatedAt) / 3600000;
  if (ageHours > 24) return; // Too old — probably unrelated

  const leadName  = leadMeta.lead_name || 'Lead';
  const property  = leadMeta.listing_title || 'unknown property';

  console.log(`[auto-reply] Learning from Afifa: Q="${question}" → A="${agentMessage}"`);

  // Build a new playbook rule from this Q&A
  const newRule = `- If a lead asks: "${question}" → Reply: "${agentMessage}"\n  (Learned from Afifa handling ${leadName} re ${property})`;
  await appendToPlaybook(newRule);

  // Clear the escalation so we don't re-learn it
  crmState[leadId].last_escalated_question = null;
  crmState[leadId].last_learned_at         = new Date().toISOString();
  await writeCRMState(crmState, sha);

  // Post a quiet internal note so Afifa knows the bot learned
  await postTrengoNote(ticketId, `✅ Bot learned from your reply and updated the playbook.`);
}

// ── Claude AI reply ───────────────────────────────────────────────────────────

async function generateReply(conversation, leadMeta, newMessage, leadName) {
  const apiKey  = process.env.ANTHROPIC_API_KEY;
  const playbook = loadPlaybook();

  if (!apiKey) return { reply: null, escalate: true, reason: 'No API key' };

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

You are handling a WhatsApp conversation for fäm Living. Lead name: ${leadName}. Property enquiry: ${property}.

Conversation so far:
${history}

The lead just sent:
"${newMessage}"

Instructions:
- Reply naturally as a warm human team member on WhatsApp. Short, friendly, direct.
- Follow ALL rules in the playbook above — pricing, discounts, tone, cross-sell, etc.
- If confident: output ONLY the message to send. Nothing else. No labels.
- If NOT confident (don't know price, availability, a specific detail): output [ESCALATE: reason] on line 1, then the holding message on line 2 (e.g. "Let me check that for you and come back shortly! 😊").

Sound human. Never sound like AI.`;

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 300, messages: [{ role: 'user', content: prompt }] }),
    });

    if (!r.ok) {
      const err = await r.text().catch(() => String(r.status));
      console.error('[auto-reply] Anthropic error:', r.status, err);
      return { reply: null, escalate: true, reason: `Anthropic ${r.status}` };
    }

    const d    = await r.json();
    const text = d?.content?.[0]?.text?.trim() || '';
    if (!text) return { reply: null, escalate: true, reason: 'Empty response' };

    if (text.startsWith('[ESCALATE:')) {
      const lines      = text.split('\n');
      const reason     = lines[0].replace('[ESCALATE:', '').replace(']', '').trim();
      const holdingMsg = lines.slice(1).join('\n').trim() || "Let me check that for you and come back shortly! 😊";
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
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Global kill switch
  if (process.env.AUTOBOT_ENABLED !== 'true') {
    return res.status(200).json({ ok: true, skipped: 'Bot disabled (AUTOBOT_ENABLED != true)' });
  }

  // Parse body
  let body = req.body;
  if (!body || typeof body === 'string') {
    try { body = JSON.parse(body); } catch { return res.status(400).json({ error: 'Invalid JSON' }); }
  }

  const messageType = (body?.message?.type || body?.type || '').toUpperCase();
  const ticketId    = body?.ticket?.id || body?.message?.ticket_id || null;
  const messageText = body?.message?.message || body?.message?.body || body?.message?.text || '';
  const agentName   = body?.message?.agent?.name || body?.agent?.name || null;

  if (!ticketId) return res.status(200).json({ ok: true, skipped: 'No ticket ID' });

  // Load CRM state
  const { state: crmState, sha } = await readCRMState();
  const leadId   = Object.keys(crmState).find(k => crmState[k].trengo_ticket_id === ticketId);
  if (!leadId) return res.status(200).json({ ok: true, skipped: 'Ticket not in CRM' });

  const leadMeta = crmState[leadId];
  const leadName = leadMeta.lead_name || 'there';

  // ── OUTBOUND (agent reply — Afifa is speaking) ─────────────────────────────
  // During day shift: learn from Afifa's answers to previously escalated questions
  if (messageType === 'OUTBOUND' && messageText) {
    // Track last agent reply time (for cooldown logic)
    crmState[leadId].last_agent_reply_at = new Date().toISOString();

    // Learning: if there was a pending bot escalation, extract the Q&A
    await learnFromAfifaReply(ticketId, messageText, leadMeta, crmState, leadId, sha);

    return res.status(200).json({ ok: true, action: 'agent_reply_tracked' });
  }

  // ── INBOUND (lead is speaking) ─────────────────────────────────────────────
  if (messageType !== 'INBOUND') {
    return res.status(200).json({ ok: true, skipped: `Message type ${messageType} ignored` });
  }

  if (!messageText) return res.status(200).json({ ok: true, skipped: 'Empty message' });

  const nightShift = isNightShift();
  const dubaiHour  = getDubaiHour();
  console.log(`[auto-reply] Inbound on ticket ${ticketId} | Dubai hour: ${dubaiHour} | Night shift: ${nightShift}`);

  // DAY SHIFT — Afifa is on, bot stays silent on inbound
  if (!nightShift) {
    // Just mark the lead as having replied so CRM summary shows it
    crmState[leadId].lead_replied    = true;
    crmState[leadId].lead_replied_at = new Date().toISOString();
    await writeCRMState(crmState, sha);
    return res.status(200).json({ ok: true, skipped: 'Day shift — Afifa handles', dubaiHour });
  }

  // NIGHT SHIFT — bot is on

  // Per-lead pause (Afifa can flip this on any ticket)
  if (leadMeta.bot_paused) {
    return res.status(200).json({ ok: true, skipped: 'Bot paused for this lead' });
  }

  // Agent cooldown — if Afifa replied in last 15 min, bot stays quiet
  const lastAgentAt = leadMeta.last_agent_reply_at ? new Date(leadMeta.last_agent_reply_at).getTime() : 0;
  if (Date.now() - lastAgentAt < AGENT_COOLDOWN_MS) {
    return res.status(200).json({ ok: true, skipped: 'Agent cooldown active' });
  }

  // Load conversation history
  const conversation = await getTrengoMessages(ticketId);

  // Human-feeling delay
  await new Promise(r => setTimeout(r, REPLY_DELAY_MS));

  // Generate reply
  const { reply, escalate, reason } = await generateReply(conversation, leadMeta, messageText, leadName);

  if (escalate) {
    // Send holding message to lead
    if (reply) await postTrengoMessage(ticketId, reply);
    // Alert Faysal + log for Afifa
    await escalateToFaysal(leadName, leadMeta.listing_title, messageText, ticketId, crmState, leadId, sha);
    await writeCRMState(crmState, sha);
    return res.status(200).json({ ok: true, action: 'escalated', reason });
  }

  // Send reply
  const sent = await postTrengoMessage(ticketId, reply);

  crmState[leadId].lead_replied       = true;
  crmState[leadId].lead_replied_at    = new Date().toISOString();
  crmState[leadId].last_bot_reply_at  = new Date().toISOString();
  crmState[leadId].bot_reply_count    = (leadMeta.bot_reply_count || 0) + 1;
  await writeCRMState(crmState, sha);

  return res.status(200).json({ ok: true, action: 'replied', sent, dubaiHour });
}
