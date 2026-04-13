// fäm Living — POST /api/crm/auto-reply
// Trengo webhook handler for both INBOUND (lead) and OUTBOUND (agent) messages.
//
// Bot active hours (currently 9 PM – 6 AM Dubai time, expanding to 24/7 soon):
//   INBOUND → AI reads message, generates reply, posts back via Trengo
//   Bot escalates to Faysal when unsure:
//     → sends WhatsApp to Faysal via Trengo (FAYSAL_TICKET_ID)
//     → stores Q in pending_escalations.json
//     → Faysal replies on WhatsApp → bot learns, updates playbook, follows up with lead
//
// Outside active hours (currently 6 AM – 9 PM Dubai):
//   INBOUND → bot stays silent, Faysal handles manually
//   OUTBOUND from Faysal → bot reads and learns from the reply:
//     → if bot escalated a specific Q, extract Q&A and log to playbook
//     → if bot is paused (manual takeover), pair lead's last message + Faysal's reply → playbook rule
//
// Kill switches:
//   AUTOBOT_ENABLED env var must = 'true' (global off switch)
//   bot_paused flag in crm_state disables per-lead (Afifa can flip this)

// ── lib/crm.js — dual-backend CRM (Upstash Redis primary, GitHub fallback) ──
import {
  ghRead, ghWrite, ghReadText as _libGhReadText,
  readCRMState, writeCRMState,
  readPendingEsc, writePendingEsc,
  loadPlaybook,
  CRM_FILE, PENDING_FILE, PLAYBOOK_FILE, LISTINGS_FILE, REF_MAP_FILE, METRICS_FILE,
  TRENGO_API, getDubaiHour, isNightShift, DUBAI_OFFSET_HOURS,
} from '../../lib/crm.js';
import { Redis } from '@upstash/redis';
import { getListingMapsUrl } from '../../lib/guesty.js';

const GH_API     = 'https://api.github.com';
const REPO       = 'fam-pricing/fam-api';
const REF_URL_FILE    = 'data/ref_url_map.json';
const NIGHT_START = 21;
const NIGHT_END   = 6;

const READ_DELAY_BASE      = 2000; // base delay to simulate reading
const READ_DELAY_JITTER    = 3000; // random jitter (0-3s) to desynchronize concurrent webhooks
const AGENT_COOLDOWN_MS    = 90 * 1000; // 90s — reduced from 3 min; limits damage if cooldown fires incorrectly
const PENDING_GRACE_MS     = 15000; // 15s grace: treat msgs arriving up to 15s BEFORE last bot reply as still pending
                                    // Fixes race condition: lead sent msg 1s before bot reply → was silently dropped
const TICKET_LOCK_TTL_S    = 25;   // Per-ticket Redis lock TTL — must be < Vercel 30s timeout so lock auto-expires if function crashes
const ATTACHMENT_TYPES     = new Set(['IMAGE', 'DOCUMENT', 'AUDIO', 'VIDEO', 'FILE']);

// ── Per-ticket Redis lock (prevents duplicate replies from concurrent webhooks) ─
// Uses Redis SETNX with TTL. If two webhooks arrive for the same ticket simultaneously,
// only the first one acquires the lock. The second sees the lock and returns 200 immediately.
// This is the root fix for the duplicate message bug (ticket 938813587).

let _lockRedis = null;
function getLockRedis() {
  if (_lockRedis) return _lockRedis;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  _lockRedis = new Redis({ url, token });
  return _lockRedis;
}

async function acquireTicketLock(ticketId) {
  const redis = getLockRedis();
  if (!redis) return true; // no Redis → no lock → proceed (graceful degradation)
  try {
    // SET key value NX EX ttl — returns 'OK' if set, null if already exists
    const result = await redis.set(`fam:lock:${ticketId}`, Date.now(), { nx: true, ex: TICKET_LOCK_TTL_S });
    return result === 'OK';
  } catch (e) {
    console.warn('[auto-reply] Redis lock acquire failed, proceeding without lock:', e?.message);
    return true; // graceful degradation
  }
}

async function releaseTicketLock(ticketId) {
  const redis = getLockRedis();
  if (!redis) return;
  try {
    await redis.del(`fam:lock:${ticketId}`);
  } catch (e) {
    console.warn('[auto-reply] Redis lock release failed:', e?.message);
    // TTL will auto-expire, so this is not critical
  }
}

// ── Time helpers (imported from lib/crm.js, kept for night-shift check) ──────
// getDubaiHour, isNightShift, DUBAI_OFFSET_HOURS — all from lib/crm.js import above

// ── Metrics collection ─────────────────────────────────────────────────────────
// Fire-and-forget metrics write with 7-day rolling retention and separate SHA tracking

async function appendMetricsEvent(event) {
  // Non-blocking fire-and-forget — don't await or catch
  (async () => {
    try {
      const ghToken = process.env.GH_TOKEN;
      if (!ghToken) return;

      // Read current metrics (with separate SHA for metrics file)
      const metricsResp = await fetch(`${GH_API}/repos/${REPO}/contents/${METRICS_FILE}`, {
        headers: { Authorization: `Bearer ${ghToken}`, Accept: 'application/vnd.github.v3+json' },
      });
      let metricsSha = null;
      let currentMetrics = [];
      if (metricsResp.ok) {
        const metricsData = await metricsResp.json();
        metricsSha = metricsData.sha;
        try {
          currentMetrics = JSON.parse(Buffer.from(metricsData.content.replace(/\n/g, ''), 'base64').toString('utf8')) || [];
        } catch { currentMetrics = []; }
      }

      // Append new event
      currentMetrics.push(event);

      // Keep only last 7 days of events
      const sevenDaysAgo = Date.now() - 7 * 24 * 3600 * 1000;
      currentMetrics = currentMetrics.filter(e => {
        try {
          return new Date(e.ts).getTime() > sevenDaysAgo;
        } catch { return false; }
      });

      // Write back to GitHub
      const content = Buffer.from(JSON.stringify(currentMetrics, null, 2)).toString('base64');
      await fetch(`${GH_API}/repos/${REPO}/contents/${METRICS_FILE}`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${ghToken}`, Accept: 'application/vnd.github.v3+json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'Metrics: append event', content, sha: metricsSha }),
      });
    } catch (e) {
      // Silent fail — metrics loss is acceptable, never block webhook response
      console.warn('[metrics] append failed silently:', e?.message);
    }
  })();
}

// ── Playbook (GitHub-backed) ───────────────────────────────────────────────────

// ghReadText/ghWriteText — lib/crm.js exports ghReadText (returns {text,sha}) and ghWrite (handles strings)
// Wrapper keeps {content,sha} API used by appendToPlaybook below
async function ghReadText(file) {
  const { text, sha } = await _libGhReadText(file);
  return { content: text || '', sha };
}

// appendToPlaybook — kept local to preserve date-stamped "## Learned" format
async function appendToPlaybook(newRule) {
  try {
    const { content, sha } = await ghReadText(PLAYBOOK_FILE);
    const today = new Date().toISOString().split('T')[0];
    const entry = `\n## Learned (${today})\n${newRule}\n`;
    await ghWrite(PLAYBOOK_FILE, content + entry, sha, 'Bot: playbook updated');
    console.log('[auto-reply] Playbook updated on GitHub');
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

// Check if the most recent real message in the thread is from a HUMAN agent (not the bot).
// If the lead spoke last, the bot should reply regardless.
// If the BOT spoke last, that's NOT a human agent — bot should still reply to new inbound.
// Only blocks when a real human (Faysal, Afifa, etc.) was the last to speak.
async function hasRecentAgentReplyInTrengo(ticketId, leadMeta) {
  const messages = await getTrengoMessages(ticketId);
  if (!messages.length) return false;

  // Sort by created_at descending, ignoring internal notes
  const realMessages = messages.filter(m => !m.internal_note);
  if (!realMessages.length) return false;

  realMessages.sort((a, b) => {
    const tsA = a.created_at ? (typeof a.created_at === 'number' ? a.created_at * 1000 : new Date(a.created_at).getTime()) : 0;
    const tsB = b.created_at ? (typeof b.created_at === 'number' ? b.created_at * 1000 : new Date(b.created_at).getTime()) : 0;
    return tsB - tsA;
  });

  // If the last message is inbound (from lead), bot should reply — no blocking
  const lastMsg = realMessages[0];
  const lastIsOutbound = (lastMsg.type || '').toUpperCase() === 'OUTBOUND';
  if (!lastIsOutbound) return false;

  // Last message IS outbound — but was it the bot or a human agent?
  // Use dual detection: content match + time-based (same logic as OUTBOUND webhook handler)
  const normEcho = s => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const lastBotContent = normEcho(leadMeta?.last_bot_reply_content || '');
  const lastMsgContent = normEcho(lastMsg.body || lastMsg.message || '');

  // Method 1: Content match — last outbound message matches the bot's last known reply
  const isBotByContent = lastBotContent && lastMsgContent === lastBotContent;

  // Method 2: Time-based — outbound within 60s of bot's last reply is almost certainly the bot
  // (Using 60s here vs 30s in echo handler — this runs later so more margin needed)
  const BOT_WINDOW_MS = 60000;
  const lastBotAt = leadMeta?.last_bot_reply_at ? new Date(leadMeta.last_bot_reply_at).getTime() : 0;
  const lastMsgAt = lastMsg.created_at
    ? (typeof lastMsg.created_at === 'number' ? lastMsg.created_at * 1000 : new Date(lastMsg.created_at).getTime())
    : 0;
  const isBotByTime = lastBotAt && lastMsgAt && Math.abs(lastMsgAt - lastBotAt) < BOT_WINDOW_MS;

  if (isBotByContent || isBotByTime) {
    console.log(`[auto-reply] Live agent guard: last outbound on ${ticketId} is BOT (content=${isBotByContent} time=${isBotByTime}) — NOT blocking`);
    return false; // Bot's own reply — don't block
  }

  // Last outbound was NOT from the bot → a human agent spoke last → block the bot
  console.log(`[auto-reply] Live agent guard: real human agent reply detected on ${ticketId} — blocking bot`);
  return true;
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

async function attachTrengoLabel(ticketId, labelId) {
  const token = process.env.TRENGO_TOKEN;
  try {
    const r = await fetch(`${TRENGO_API}/tickets/${ticketId}/labels`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ label_id: labelId }),
    });
    if (!r.ok) console.error('[auto-reply] label attach failed:', r.status);
    else console.log(`[auto-reply] Label ${labelId} attached to ticket ${ticketId}`);
  } catch (e) { console.error('[auto-reply] label attach error:', e?.message); }
}

const LABEL_LEAD    = 1816534; // "Lead" — attached on first bot reply
const LABEL_VIEWING = 1816630; // "viewing" — attached when viewing is requested

async function postTrengoNote(ticketId, note) {
  const token = process.env.TRENGO_TOKEN;
  try {
    const r = await fetch(`${TRENGO_API}/tickets/${ticketId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ message: note, internal_note: true }),
    });
    if (!r.ok) console.error('[auto-reply] note post failed:', r.status);
  } catch (e) { console.error('[auto-reply] note post failed:', e?.message); }
}

// ── Assign / unassign ticket ──────────────────────────────────────────────────

const FAYSAL_USER_ID = 141332;

async function assignTicket(ticketId, userId) {
  const token = process.env.TRENGO_TOKEN;
  try {
    // Use the /assign sub-endpoint with type:'user' — same as auto-respond cron (confirmed working)
    const r = await fetch(`${TRENGO_API}/tickets/${ticketId}/assign`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ ticket_id: ticketId, user_id: userId, note: null, type: 'user' }),
    });
    const body = await r.text();
    if (!r.ok) console.error('[auto-reply] assignTicket failed:', r.status, body);
    else console.log(`[auto-reply] Ticket ${ticketId} assigned to user ${userId}`);
  } catch (e) { console.error('[auto-reply] assignTicket error:', e?.message); }
}

async function unassignTicket(ticketId) {
  const token = process.env.TRENGO_TOKEN;
  try {
    // Assign to team Reservations (id: 78822) — confirmed working via live test on 2026-03-31.
    // type:'user' with user_id:null returns 422. PATCH assignee_id:null returns 200 but does nothing.
    // Only working method: POST /assign with type:'team' + team_id:78822.
    const r = await fetch(`${TRENGO_API}/tickets/${ticketId}/assign`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ ticket_id: ticketId, type: 'team', team_id: 78822 }),
    });
    const body = await r.text();
    if (!r.ok) console.error('[auto-reply] unassignTicket failed:', r.status, body);
    else console.log(`[auto-reply] Ticket ${ticketId} assigned to team Reservations`);
  } catch (e) { console.error('[auto-reply] unassignTicket error:', e?.message); }
}

// ── Escalate ticket to team ───────────────────────────────────────────────────
// Posts internal note with full context, unassigns ticket, pauses bot.

async function escalateTicket(leadName, property, reason, trengoTicketId, conversation, crmState, leadId) {
  const dubaiTime = new Date(Date.now() + DUBAI_OFFSET_HOURS * 3600000)
    .toISOString().replace('T', ' ').substring(0, 16) + ' Dubai';

  // Build a short conversation summary (last 5 messages)
  const recentMsgs = (conversation || [])
    .filter(m => {
      const txt = m.message || m.body || '';
      return txt && txt.trim() && !m.internal_note;
    })
    .slice(-5)
    .map(m => {
      const who = (m.type || '').toUpperCase() === 'OUTBOUND' ? 'Bot' : leadName;
      return `${who}: ${(m.message || m.body || '').substring(0, 120)}`;
    })
    .join('\n');

  const note =
    `🚨 BOT ESCALATION — ${dubaiTime}\n\n` +
    `Lead: ${leadName}\n` +
    `Property: ${property || 'unknown'}\n` +
    `Reason: ${reason}\n\n` +
    `Recent conversation:\n${recentMsgs || '(no messages logged)'}\n\n` +
    `Bot paused. Please pick up this conversation.\n\n` +
    `@faysal141332 @afifa340123 @chahana470168 @junaid731578 @abdul315306\n— fäm Bot`;

  await postTrengoNote(trengoTicketId, note);
  await unassignTicket(trengoTicketId);

  if (crmState && leadId) {
    crmState[leadId].bot_paused        = true;
    crmState[leadId].last_escalated_at = new Date().toISOString();
    // last_escalated_question is ALWAYS null now.
    // The teaching-ticket system (Faysal replies on dedicated WA thread) is retired.
    // Escalations now use internal notes + unassign. When Faysal manually replies on
    // the lead's ticket, learnFromAgentReply() paused-bot path handles learning using
    // the actual last lead message — not the bot's internal escalation reason string.
    // Setting reason as last_escalated_question caused garbage playbook entries like
    // "If lead asks: [3-paragraph bot summary] → Reply: [Faysal's full answer]".
    crmState[leadId].last_escalated_question = null;
  }

  console.log(`[auto-reply] Ticket ${trengoTicketId} escalated — "${reason}" — bot paused`);
}

// ── Classify whether Faysal's message is a playbook rule ─────────────────────
// Returns true = real rule to save, false = casual chat (greeting, test, ack)

async function classifyAsRule(message) {
  // Fast path: obvious non-rules (very short greetings / single words)
  const lower = message.toLowerCase().trim();
  const obvious = /^(hi|hello|hey|ok|okay|yes|no|test|testing|good|great|thanks|thank you|sure|yep|nope|lol|haha|nice|cool|got it|noted|👍|😊|😄|check|ping|just testing|hi ;|hello ;)/.test(lower);
  if (obvious || message.length < 6) return false;

  // AI classification for anything ambiguous
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    // Without AI, require message to have at least one instruction-like word
    return /never|always|don't|do not|make sure|remember|if|when|reply|say|tell|avoid|use|don't|must|should/.test(lower);
  }

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 10,
        messages: [{
          role: 'user',
          content: `Is this message a business rule or instruction that should be saved to a sales playbook? Answer only YES or NO.\n\nMessage: "${message}"`,
        }],
      }),
    });
    if (!r.ok) return true; // default to saving on API error
    const d = await r.json();
    const answer = (d?.content?.[0]?.text || '').trim().toUpperCase();
    return answer.startsWith('YES');
  } catch {
    return true; // default to saving if classification fails
  }
}

// ── Rephrase a raw rule into clean playbook language ─────────────────────────
// Takes Faysal's informal/rough instruction and rewrites it as a crisp rule.

async function rephraseRule(rawMessage) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return rawMessage; // fallback to original if no key

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 120,
        messages: [{
          role: 'user',
          content: `You are editing a sales playbook for a Dubai holiday home rental company.

Faysal (the owner) just sent this raw instruction:
"${rawMessage}"

Rewrite it as a single, clean playbook rule. Fix typos, tighten the language, make it clear and actionable. Keep the exact meaning and intent — do not change what is being said. Output ONLY the rewritten rule, nothing else. No quotes, no labels, no explanation.`,
        }],
      }),
    });
    if (!r.ok) return rawMessage;
    const d = await r.json();
    const rephrased = (d?.content?.[0]?.text || '').trim();
    return rephrased || rawMessage;
  } catch {
    return rawMessage; // fallback to original on error
  }
}

// ── Handle Faysal's teaching reply ───────────────────────────────────────────
// Called when Faysal replies on his dedicated WA teaching conversation.

async function handleFaysalTeachingReply(faysalTicketId, answer) {
  const { esc, sha: escSha } = await readPendingEsc();
  const pending = (esc.pending || []).filter(e => !e.answered_at);

  // Strip common trigger phrases ("update playbook", "remember", etc.)
  const cleanAnswer = answer
    .replace(/^(update playbook[,:]?\s*|remember[,:]?\s*|add to playbook[,:]?\s*)/i, '')
    .replace(/\s*(update playbook|add to playbook)\.?$/i, '')
    .trim();

  if (!pending.length) {
    // No pending questions — check if this is a real rule or just casual chat
    if (cleanAnswer) {
      const isRule = await classifyAsRule(cleanAnswer);
      if (!isRule) {
        // Casual message (greeting, test, acknowledgment, etc.) — just reply naturally
        await postTrengoMessage(faysalTicketId,
          `Hey! No pending questions right now — all quiet. Send me a rule to add anytime, or I'll ping you here when I get stuck with a lead.`);
        return;
      }
      // Rephrase into clean playbook language before saving
      const polishedRule = await rephraseRule(cleanAnswer);
      const newRule = `- ${polishedRule}\n  (Taught by Faysal)`;
      await appendToPlaybook(newRule);
      // Increment direct teachings counter so dashboard shows it
      esc.direct_teachings_count = (esc.direct_teachings_count || 0) + 1;
      await writePendingEsc(esc, escSha);
      await postTrengoMessage(faysalTicketId,
        `Got it — saved to playbook as:\n\n"${polishedRule}"\n\nSend another rule anytime, or I'll ping you here when I get stuck with a lead.`);
    } else {
      await postTrengoMessage(faysalTicketId, `Hey! No pending questions right now. Send me a rule to add to my playbook anytime.`);
    }
    return;
  }

  // There ARE pending questions — Faysal's message answers the current one
  const current = pending.sort((a, b) => new Date(b.escalated_at) - new Date(a.escalated_at))[0];

  console.log(`[auto-reply] Faysal answered Q: "${current.question}" → "${answer}"`);

  // Rephrase Faysal's answer into a clean playbook rule before saving
  const polishedAnswer = await rephraseRule(`If a lead asks "${current.question}", reply: "${cleanAnswer || answer}"`);
  const newRule = `- ${polishedAnswer}\n  (Taught by Faysal for ${current.lead_name})`;
  await appendToPlaybook(newRule);

  // Mark as answered
  const idx = esc.pending.findIndex(e => e.id === current.id);
  if (idx !== -1) {
    esc.pending[idx].answered_at = new Date().toISOString();
    esc.pending[idx].answer      = answer;
  }

  // If there are more pending escalations, set the next one as current
  const remaining = esc.pending.filter(e => !e.answered_at);
  esc.current_question_id = remaining.length ? remaining[0].id : null;
  await writePendingEsc(esc, escSha);

  // Follow up with the lead if their ticket is still active
  if (current.lead_ticket_id) {
    const replyToLead = answer; // Send Faysal's answer directly to the lead
    await postTrengoMessage(current.lead_ticket_id, replyToLead);
    console.log(`[auto-reply] Followed up with lead ticket ${current.lead_ticket_id}`);

    // If this lead had a viewing escalated, mark as team_responded so bot won't re-escalate
    if (current.lead_id) {
      try {
        const { state: crmNow, sha: crmSha } = await readCRMState();
        if (crmNow[current.lead_id] && crmNow[current.lead_id].viewing_status === 'escalated') {
          crmNow[current.lead_id].viewing_status = 'team_responded';
          await writeCRMState(crmNow, crmSha);
          console.log(`[auto-reply] Viewing status → team_responded for ${current.lead_name}`);
        }
      } catch (e) { console.warn('[auto-reply] viewing status update failed:', e?.message); }
    }
  }

  // Confirm to Faysal
  const nextPending = remaining.filter(e => e.id !== current.id);
  let confirmMsg = `✅ *Got it!* Playbook updated and lead notified.\n\n*Rule added:*\n"${current.question}" → use your answer ✓`;
  if (nextPending.length > 0) {
    const next = nextPending[0];
    confirmMsg += `\n\n❓ *Next question:*\n*Lead:* ${next.lead_name} | *Property:* ${next.property}\n"${next.question}"`;
  } else {
    confirmMsg += `\n\nNo more pending questions — you're all caught up! 🎉`;
  }
  await postTrengoMessage(faysalTicketId, confirmMsg);
}

// ── Learn from Faysal's manual replies ───────────────────────────────────────
// Two learning paths:
//   1. Escalated Q&A — bot asked a question, Faysal answered it (within 24h)
//   2. Paused-bot reply — bot is paused, Faysal manually handled the lead;
//      capture the last lead message + Faysal's reply as a playbook rule

async function learnFromAgentReply(ticketId, agentMessage, leadMeta, crmState, leadId, sha) {
  const leadName = leadMeta.lead_name || 'Lead';
  const property = leadMeta.listing_title || 'unknown property';

  // ── Path 1: Bot escalated a specific question and Faysal answered it ──────
  const question    = leadMeta.last_escalated_question;
  const escalatedAt = leadMeta.last_escalated_at ? new Date(leadMeta.last_escalated_at).getTime() : 0;
  const ageHours    = (Date.now() - escalatedAt) / 3600000;

  if (question && ageHours <= 24) {
    console.log(`[auto-reply] Learning (escalation path): Q="${question}" → A="${agentMessage}"`);
    const newRule = `- If a lead asks: "${question}" → Reply: "${agentMessage}"\n  (Learned from Faysal handling ${leadName} re ${property})`;
    await appendToPlaybook(newRule);
    crmState[leadId].last_escalated_question = null;
    crmState[leadId].last_learned_at         = new Date().toISOString();
    await writeCRMState(crmState, sha);
    await postTrengoNote(ticketId, `✅ Bot learned from your reply and updated the playbook.`);
    return;
  }

  // ── Path 2: Bot is paused — Faysal manually handled the lead ─────────────
  // Capture: last inbound (lead) message + this outbound (Faysal) reply → Q&A rule
  if (leadMeta.bot_paused) {
    // Fetch last few messages to find the most recent lead message
    let lastLeadMessage = null;
    try {
      const messages = await getTrengoMessages(ticketId);
      const sorted = messages
        .filter(m => (m.message || m.body || '').trim())
        .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
      const lastInbound = sorted.find(m => (m.type || '').toUpperCase() === 'INBOUND');
      if (lastInbound) lastLeadMessage = (lastInbound.message || lastInbound.body || '').trim();
    } catch (e) {
      console.warn('[auto-reply] Could not fetch messages for paused-bot learning:', e?.message);
    }

    if (!lastLeadMessage) return; // nothing to pair with

    // Skip if Faysal's reply is too short to be a real answer (greeting, ack, etc.)
    const isRule = await classifyAsRule(agentMessage);
    if (!isRule) return;

    // Skip if Faysal's reply is too specific to be a general playbook rule:
    // — Contains a URL (listing links, maps, etc.) → situation-specific, not reusable
    // — Longer than 300 chars → almost certainly a full portfolio answer, not a rule
    // — Contains specific AED prices → stale immediately as prices change
    const hasUrl = /https?:\/\//i.test(agentMessage);
    const tooLong = agentMessage.length > 300;
    const hasSpecificPrice = /AED\s[\d,]+/i.test(agentMessage);
    if (hasUrl || tooLong || hasSpecificPrice) {
      console.log(`[auto-reply] Skipping paused-bot learning — reply too specific (url=${hasUrl} long=${tooLong} price=${hasSpecificPrice}): "${agentMessage.substring(0, 80)}..."`);
      return;
    }

    console.log(`[auto-reply] Learning (paused-bot path): lead said "${lastLeadMessage}" → Faysal replied "${agentMessage}"`);
    const polishedRule = await rephraseRule(
      `If a lead says: "${lastLeadMessage}" → Reply: "${agentMessage}"`
    );
    const newRule = `- ${polishedRule}\n  (Learned from Faysal handling ${leadName} re ${property})`;
    await appendToPlaybook(newRule);
    crmState[leadId].last_learned_at = new Date().toISOString();
    await writeCRMState(crmState, sha);
    await postTrengoNote(ticketId, `✅ Bot observed your reply and updated the playbook.`);
  }
}

// ── Portfolio lookup ──────────────────────────────────────────────────────────
// Reads data/listings.json (refreshed on every Sync) to answer portfolio questions.

// Build a map of "building|beds" → PF listing URL
async function buildListingUrlMap() {
  try {
    const [{ data: refMap }, { data: urlMap }] = await Promise.all([
      ghRead(REF_MAP_FILE),
      ghRead(REF_URL_FILE),
    ]);
    if (!refMap || !urlMap) return {};
    const result = {};
    for (const [ref, info] of Object.entries(refMap)) {
      const url = urlMap[ref];
      if (url && info?.building && info?.bed_type) {
        const key = `${info.building}|${info.bed_type}`.toLowerCase();
        result[key] = url;
      }
    }
    return result;
  } catch {
    return {};
  }
}

async function getPortfolioListings(messageText) {
  try {
    const [{ data }, urlMap] = await Promise.all([
      ghRead(LISTINGS_FILE),
      buildListingUrlMap(),
    ]);
    if (!data || !Array.isArray(data)) return null;

    // Try to detect a specific area from the message
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

    // Group by area, include PF listing URL where available
    const byArea = {};
    listings.forEach(l => {
      const a = l.area || 'Other';
      if (!byArea[a]) byArea[a] = [];
      const key = `${l.building}|${l.beds}`.toLowerCase();
      const url = urlMap[key];
      const line = `${l.beds} in ${l.building} — AED ${Number(l.price).toLocaleString()}/mo${url ? ` — Photos/listing: ${url}` : ''}`;
      byArea[a].push(line);
    });

    return Object.entries(byArea)
      .map(([area, items]) => `${area}:
${items.map(i => `  • ${i}`).join('\n')}`)
      .join('\n\n');
  } catch (e) {
    console.warn('[auto-reply] portfolio lookup failed:', e?.message);
    return null;
  }
}

// Returns true if the message is asking about available listings/options
function isPortfolioQuestion(text) {
  const t = text.toLowerCase();
  // Broad match — any message asking about listings, options, availability, or portfolio
  return /option|propert|listing|available|avail|apartment|studio|\bunit\b|what else|show me|give me|what.*have|have.*what|portfolio|inventory|what do you|do you have/.test(t);
}

// ── Conversation arc — detect where the lead is in the buying journey ─────────
// Pure code analysis (zero latency), injected into Claude's system prompt so it
// adapts tone, detail level, and next-step suggestions to the lead's actual stage.

function detectBuyingStage(conversation, leadMeta) {
  const inboundMsgs = conversation.filter(m =>
    (m.type || '').toUpperCase() === 'INBOUND' || m.from === 'lead'
  );
  const allText = inboundMsgs
    .map(m => (m.body || m.text || m.message || '').toLowerCase())
    .join(' ');
  const msgCount = inboundMsgs.length;

  // Check from most advanced stage to least
  if (/pay(ment)?|transfer|card|cash|contract|sign|move.?in|check.?in|when can i|start date|keys/.test(allText))
    return 'READY_TO_BOOK';
  if (/budget|too (much|expensive|high)|can('t| not) afford|over.?budget|cheaper|lower price/.test(allText))
    return 'OBJECTING';
  if (/view(ing)?|visit|see (the|it)|deposit|document|process|what('s| is) next|book(ing)?|reserve|lock.?in/.test(allText))
    return 'ENGAGED';
  if (/price|how much|availab|bed|bedroom|\bbr\b|studio|area|building|option|what.*have|do you have/.test(allText))
    return 'INTERESTED';
  if (msgCount <= 2) return 'BROWSING';
  return 'INTERESTED';
}

const STAGE_GUIDANCE = {
  BROWSING:      'LEAD STAGE: BROWSING — This lead just arrived and is saying hello. Be warm and welcoming. Ask what they are looking for or if they have questions about the property. Keep it light, do not dump information.',
  INTERESTED:    'LEAD STAGE: INTERESTED — This lead is asking about specific properties, prices, or availability. Be precise and informative. Answer their exact question. Do NOT offer or suggest a viewing unprompted. One cross-sell max.',
  ENGAGED:       'LEAD STAGE: ENGAGED — This lead is discussing viewings, deposits, or the booking process. They are serious. Be efficient, clear, and move them toward locking in. Remove friction.',
  READY_TO_BOOK: 'LEAD STAGE: READY TO BOOK — This lead is asking about payment, contracts, or move-in. They want to close. Be direct, guide them to the next concrete step (contract, payment, check-in). No fluff.',
  OBJECTING:     'LEAD STAGE: OBJECTING — This lead has raised budget or price concerns. Do NOT push or repeat the price. If this is the FIRST time they object, acknowledge their concern, ask for their budget, and offer alternatives. If they have ALREADY objected before and you already responded, do NOT repeat yourself — escalate to Faysal immediately. A human can negotiate flexibly, you cannot. Repeating the same price floor is the fastest way to lose this lead.',
};

// ── Self-critique — fast quality gate before any reply reaches the lead ───────
// Uses Sonnet for quality. Checks the draft reply against core rules.
// If it fails, Sonnet rewrites it. Adds ~1-2s per message and catches the
// mistakes that lose leads: missed questions, repetition, rule leaks, bad tone.

// ── Pre-escalation critic — fires BEFORE any escalation reaches the lead ─────
// When Claude decides to escalate_to_faysal, this critic reviews whether the
// escalation is genuinely justified, or whether the bot CAN and SHOULD answer
// itself using the available portfolio and conversation context.
// Completely invisible to the lead — no message is sent, no delay they see.
// Returns: { shouldEscalate: true|false, reason: string }
// If shouldEscalate = false, caller retries Claude with a nudge to answer directly.

async function preEscalationCritic(escalationReason, holdingMessage, conversation, newMessage, leadName, portfolioContext, property) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { shouldEscalate: true }; // no key → don't block

  const recentHistory = conversation.slice(-8).map(m => {
    const isIn = (m.type || '').toUpperCase() === 'INBOUND' || m.from === 'lead';
    return `${isIn ? 'Lead' : 'Bot/Agent'}: ${(m.body || m.text || m.message || '').trim().slice(0, 200)}`;
  }).join('\n');

  const criticPrompt = `You are a quality gate for a Dubai holiday home rental bot. The bot wants to escalate to a human manager instead of answering the lead itself.

LEAD: ${leadName}
PROPERTY: ${property}

CONVERSATION:
${recentHistory}

LEAD'S LATEST MESSAGE: "${newMessage}"

BOT'S ESCALATION REASON: "${escalationReason}"

AVAILABLE PORTFOLIO:
${portfolioContext || '(no portfolio data)'}

JUDGE: Is this escalation GENUINELY necessary, or can the bot handle this itself?

Things the bot CAN and MUST handle without escalating:
- Availability questions ("available from October?", "available in April?")
- Contract length questions ("yearly contract?", "6 months?", "monthly?")
- Pricing questions — use the portfolio data above
- Viewing scheduling (any day 9am-6pm)
- Deposit questions (damage deposit: 1K studio, 1.5K 1BR, 2K 2BR+)
- Multiple unit requests — show what's available in the portfolio
- Short-term requests — show options and let Faysal confirm if lead proceeds
- General availability of buildings in portfolio

Things that GENUINELY require escalation:
- Lead explicitly asks to speak to a human
- Property cannot be identified at all (ref not in any mapping)
- Pricing beyond 3 months (after quoting monthly rate and explaining 3-month blocks)
- Unit not in portfolio and lead is serious about it specifically
- Custom deal terms or legal questions

Respond with EXACTLY one of these two formats:
HANDLE_IT: [one sentence on what the bot should say/do instead]
ESCALATE_OK: [one sentence on why this genuinely requires human]`;

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 120,
        messages: [{ role: 'user', content: criticPrompt }],
      }),
    });
    if (!r.ok) {
      console.warn('[auto-reply] Pre-escalation critic API error, allowing escalation');
      return { shouldEscalate: true };
    }
    const d = await r.json();
    const out = (d?.content?.[0]?.text || '').trim();
    console.log(`[auto-reply] Pre-escalation critic verdict: "${out.substring(0, 120)}"`);

    if (/^HANDLE_IT:/i.test(out)) {
      const guidance = out.replace(/^HANDLE_IT:\s*/i, '').trim();
      return { shouldEscalate: false, guidance };
    }
    // ESCALATE_OK or anything else → allow escalation
    return { shouldEscalate: true };
  } catch (e) {
    console.warn('[auto-reply] Pre-escalation critic failed, allowing escalation:', e?.message);
    return { shouldEscalate: true };
  }
}

async function critiqueReply(draftReply, conversation, newMessage, leadName) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || !draftReply) return { pass: true, finalReply: draftReply };

  const recentHistory = conversation.slice(-8).map(m => {
    const isIn = (m.type || '').toUpperCase() === 'INBOUND' || m.from === 'lead';
    return `${isIn ? 'Lead' : 'Bot/Agent'}: ${(m.body || m.text || m.message || '').trim().slice(0, 200)}`;
  }).join('\n');

  const criticPrompt = `You are a quality gate for a WhatsApp sales bot at fäm Living (Dubai holiday homes). Review this draft reply and check every rule below. Be strict.

CONVERSATION:
${recentHistory}

LEAD'S LATEST MESSAGE(S): "${newMessage}"

BOT'S DRAFT REPLY:
"${draftReply}"

CHECK EACH RULE:
1. ANSWERED ALL QUESTIONS — Did the draft address EVERY question or request in the lead's message(s)? If the lead asked multiple things, ALL must be answered. Check the UNANSWERED LEAD MESSAGES section carefully.
2. ENGAGED WITH LEAD CONTEXT — If the lead provided specific information (move-in date, contract length, budget, payment preference, timeline), does the draft acknowledge it? A reply that ignores context the lead provided is a FAIL.
3. NO REPETITION — Does the draft restate information already given in previous Bot messages above?
4. NO RULE LEAKAGE — Does the draft mention internal rule names, instructions, or reasoning? (e.g. "Per the BUDGET rule", "According to my instructions", "The lead has said")
5. SOUNDS HUMAN — Does it sound like a real person on WhatsApp? Hard FAIL on: bullet points, "Certainly!", "I'd be happy to help!", multiple exclamation marks, overly formal language.
6. NO DEAD-END CTA — Does the draft end with "let me know if you have any questions", "feel free to ask", "what would you like to know?", "do not hesitate to contact me", "hope that helps", or any other generic open-ended offer? These are FAQ-bot phrases that kill conversations. FAIL and replace the ending with a specific, contextual question or next step that moves the conversation toward booking. For example: "Shall I get the contract started?" or "Want me to send the listing link?" or "Does April 4 still work for you?" — something concrete tied to what was just discussed.
7. CORRECT PROPERTY — Does the draft reference the correct property? Does it invent details not present in the conversation?
8. NO UNSOLICITED TOPICS — Does the draft bring up topics the lead never asked about (deposits, cleaning, policies, pets)?
9. NO EM DASHES — Does the draft contain — or – characters?
10. NO GREETING OPENER — Does the draft start with "Hi [Name]!", "Hello [Name]!", "Hey [Name]!" or any greeting+name combo as the first words? FAIL. The reply must get straight to the substance. The lead's name can appear mid-sentence but NEVER as a greeting opener.
11. NO PUSHY CTA — Does the draft suggest paperwork, contracts, signing, booking, or payment when the lead has NOT explicitly asked to proceed? If this is an early enquiry (lead asked about price, availability, or info) and the draft ends with "Shall I get the paperwork started?", "Want me to send the contract?", "Ready to book?", or similar commitment-pressure CTA — FAIL. Replace with a soft, informational CTA like "Would you like to see it first?" or "Any other questions about the property?"
12. NO PRICE PARROT — Look at the previous Bot messages in the conversation. If the bot already stated the price AND what's included (water, electricity, internet), does the draft restate any of that? If yes — FAIL. Strip out the repeated price/amenity info and keep only the NEW information the draft adds. The lead already knows the price. Repeating it is the most robotic thing the bot can do.
13. TOO LONG — Is the draft more than 5 sentences or 3 paragraphs? FAIL. WhatsApp replies must be short. Rewrite to 2-3 sentences max.
14. NO VIEWING DETAILS PARROT — Look at the previous Bot messages. If the bot has ALREADY confirmed a viewing day/time (e.g. "tomorrow at 4pm", "Friday 11am") AND asked for passport/Emirates ID in a prior message, the draft MUST NOT restate the viewing day/time, the property name/bed type, the move-in date, or the full ID request sentence. If the lead is just acknowledging ("yes sure", "ok", "perfect"), the draft should be ONE short line max with NO viewing context. If the lead asked an unrelated question, the draft should answer ONLY that question with no viewing summary appended. Restating "tomorrow at 4pm for the Polo Residences 1BR is confirmed. Could you send a photo of your passport or Emirates ID..." when the bot already said this once — FAIL. Strip everything except the new info.

If ALL checks pass, respond with exactly one word: APPROVED

If ANY check fails:
- Your ENTIRE response must be two parts only — nothing else before or after:
- Part 1: the single word FAIL on its own line
- Part 2: the corrected message text ONLY, exactly as it should be sent to the customer on WhatsApp
- CRITICAL: Do NOT write anything before the word FAIL. No preamble, no "Wait", no "Let me redo", no thinking out loud. FAIL must be the very first word you write.
- CRITICAL: Do NOT include any explanation, bullet points, rule names, "Issues fixed:", or any commentary after the corrected reply. Nothing after the corrected reply.`;

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 400,
        messages: [{ role: 'user', content: criticPrompt }],
      }),
    });

    if (!r.ok) {
      console.warn('[auto-reply] Critic API error, using original reply');
      return { pass: true, finalReply: draftReply };
    }

    const d = await r.json();
    const out = (d?.content?.[0]?.text || '').trim();

    if (/^APPROVED/i.test(out)) {
      console.log('[auto-reply] Critic: APPROVED');
      return { pass: true, finalReply: draftReply };
    }

    // Extract corrected reply — find FAIL wherever it appears (not assumed to be line 0)
    // Critic sometimes writes preamble/self-talk before FAIL (e.g. "Wait, still an em dash. Let me redo:\n\nFAIL\n...")
    const lines = out.split('\n');
    const failIdx = lines.findIndex(l => /^FAIL$/i.test(l.trim()));
    if (failIdx === -1) {
      // No FAIL found — treat as approved (critic rambled without a clear verdict)
      console.log('[auto-reply] Critic: no FAIL found, treating as APPROVED');
      return { pass: true, finalReply: draftReply };
    }
    const failLine = lines[failIdx];
    let correctedLines = lines.slice(failIdx + 1);

    // Safety: strip any line that looks like reasoning/commentary leaked in
    // Stop at the first line that starts with **, --, "Issues", "Note:", "Rule", etc.
    const reasoningPattern = /^(\*\*|--|Issues|Note:|Rule\s*\d|Actually,|Let me|I need|Re-check)/i;
    const cutoff = correctedLines.findIndex(l => reasoningPattern.test(l.trim()));
    if (cutoff !== -1) correctedLines = correctedLines.slice(0, cutoff);

    // Also strip surrounding quotes if the critic wrapped the reply in them
    let corrected = correctedLines.join('\n').trim();
    if (corrected.startsWith('"') && corrected.includes('"', 1)) {
      const end = corrected.lastIndexOf('"');
      corrected = corrected.slice(1, end).trim();
    }

    if (corrected && corrected.length > 10) {
      console.log(`[auto-reply] Critic: ${failLine} — using revised reply`);
      // Strip em/en dashes, leftover FAIL artifacts, and any tag artefacts from critic output
      const clean = corrected
        .replace(/\s*\u2014\s*/g, ', ')
        .replace(/\s*\u2013\s*/g, ', ')
        .replace(/\bFAIL\b/gi, '')       // strip any leftover FAIL word from critic output
        .replace(/\bAPPROVED\b/gi, '')   // strip any leftover APPROVED word
        .replace(/^\s*[\n\r]+/, '')       // clean leading blank lines after stripping
        .trim();
      if (clean.length < 10) {
        // Stripping left nothing useful — fall back to original draft
        console.log('[auto-reply] Critic: corrected reply empty after cleanup, using original');
        return { pass: true, finalReply: draftReply };
      }
      return { pass: false, finalReply: clean, reason: failLine };
    }

    return { pass: true, finalReply: draftReply };
  } catch (e) {
    console.warn('[auto-reply] Critic failed, using original:', e?.message);
    return { pass: true, finalReply: draftReply };
  }
}

// ── Lead quality scoring ──────────────────────────────────────────────────────
// Analyses conversation signals to score lead intent and urgency.
// Score: 0-100. Updated in CRM after every bot reply.
// Posted as internal note on first score above 40 so Faysal sees priority at a glance.

function scoreLeadQuality(conversation, leadMeta, newMessage) {
  const allInbound = conversation
    .filter(m => (m.type || '').toUpperCase() === 'INBOUND' || m.from === 'lead')
    .map(m => (m.body || m.text || m.message || '').toLowerCase());
  const allText = allInbound.join(' ');
  const msgCount = allInbound.length;

  let score = 0;
  const signals = [];

  // Engagement depth — more messages = more engaged
  if (msgCount >= 5) { score += 15; signals.push('high engagement (5+ messages)'); }
  else if (msgCount >= 3) { score += 10; signals.push('moderate engagement'); }
  else if (msgCount >= 1) { score += 5; }

  // Timeline urgency
  if (/today|tonight|tomorrow|this week|asap|urgent|immediately|right away/.test(allText)) {
    score += 25; signals.push('urgent timeline');
  } else if (/next week|next month|soon|april|may|june/.test(allText)) {
    score += 15; signals.push('near-term timeline');
  }

  // Buying intent signals
  if (/move.?in|check.?in|start date|when can i|keys|contract|sign/.test(allText)) {
    score += 25; signals.push('move-in intent');
  }
  if (/pay(ment)?|transfer|card|cash|deposit|book(ing)?|reserve|lock.?in|secure/.test(allText)) {
    score += 20; signals.push('payment/booking intent');
  }
  if (/view(ing)?|visit|see (the|it|this)|come.*look|walk.?through/.test(allText)) {
    score += 15; signals.push('viewing interest');
  }
  if (/price|how much|cost|rate|rent|per month/.test(allText)) {
    score += 10; signals.push('pricing enquiry');
  }

  // Budget fit (negative signals)
  if (/budget|too (much|expensive|high)|can('t| not) afford|over.?budget|cheaper/.test(allText)) {
    score -= 10; signals.push('budget concern');
  }

  // Property specificity — asking about specific unit = higher intent
  if (/\d\s*b(ed)?r(oom)?|\bstudio\b|\b(1|2|3|4)\s*bed/.test(allText)) {
    score += 10; signals.push('specific unit type');
  }

  // Clamp 0-100
  score = Math.max(0, Math.min(100, score));

  // Label
  let label;
  if (score >= 70) label = 'HOT';
  else if (score >= 40) label = 'WARM';
  else if (score >= 20) label = 'COOL';
  else label = 'COLD';

  return { score, label, signals };
}

// ── Prompt injection defence ─────────────────────────────────────────────────
// Strips known injection patterns from lead messages before they reach Claude.
// Logs attempts for security review. Does NOT block the message — just sanitises.

function sanitizeInput(text) {
  if (!text) return text;
  const INJECTION_PATTERNS = [
    /ignore\s+(your|all|previous|prior|above)\s+(instructions?|rules?|prompts?|system)/gi,
    /you\s+are\s+now\s+(a|an|my)/gi,
    /forget\s+(your|all|everything|the)\s+(instructions?|rules?|training)/gi,
    /override\s+(your|the|all)\s+(rules?|instructions?|system)/gi,
    /system\s*prompt/gi,
    /\bact\s+as\s+(if|a|an|my)\b/gi,
    /\brole\s*play\b/gi,
    /\bpretend\s+(you('re| are)|to be)\b/gi,
    /\bjailbreak\b/gi,
    /\bDAN\b/g,   // "Do Anything Now" jailbreak
    /reveal\s+(your|the)\s+(instructions?|prompt|system|rules)/gi,
    /what\s+(are|is)\s+your\s+(instructions?|prompt|system|rules)/gi,
  ];

  let cleaned = text;
  let injectionDetected = false;
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(cleaned)) {
      injectionDetected = true;
      cleaned = cleaned.replace(pattern, '').trim();
    }
  }

  if (injectionDetected) {
    console.warn(`[auto-reply] ⚠️ Prompt injection attempt detected and sanitised: "${text.slice(0, 100)}"`);
  }

  return cleaned || text; // if sanitisation emptied it, use original (could be false positive)
}

// ── Claude AI reply ───────────────────────────────────────────────────────────

async function generateReply(conversation, leadMeta, newMessage, leadName, pendingMessages, _retryingAfterCritic = false, _criticNudge = '', _conversationWallContext = '') {
  const apiKey  = process.env.ANTHROPIC_API_KEY;
  const playbook = await loadPlaybook();

  if (!apiKey) return { reply: null, escalate: true, reason: 'No API key' };

  // Always inject live portfolio so bot never escalates on availability questions
  let portfolioContext = '';
  const listings = await getPortfolioListings(newMessage);
  if (listings) {
    portfolioContext = `\n\n## Active fäm Living Portfolio (live prices — use this to answer any question about what we have available):\n${listings}\n`;
  }

  const history = conversation
    .slice(-20)
    .filter(m => m.message || m.body || m.text)
    .map(m => {
      const isInbound = m.type?.toUpperCase() === 'INBOUND';
      // Distinguish bot replies from Faysal's manual replies using user_id
      // Bot messages have no user_id (or user_id 0); Faysal's manual messages have user_id 141332
      // Use String() comparison — Trengo sometimes returns user_id as "141332" (string) not 141332 (int)
      const uid = String(m.user_id || m.user?.id || '');
      const isAgentManual = !isInbound && uid === String(FAYSAL_USER_ID);
      const speaker = isInbound ? leadName : (isAgentManual ? 'Agent (Faysal)' : 'Bot');
      return `${speaker}: ${(m.message || m.body || m.text || '').trim()}`;
    })
    .join('\n');

  // Resolve raw PF refs (e.g. "PF-HH-AR-109427") to "BED in BUILDING" using ref_mapping
  // If listing_title is still a raw ref, the bot has no idea what property to talk about → hallucination risk
  let rawListing = leadMeta?.listing_title || null;
  let property = rawListing || 'the property';
  if (rawListing && /^PF-HH-AR-/i.test(rawListing)) {
    try {
      const { data: refMap } = await ghRead(REF_MAP_FILE);
      const mapping = refMap?.[rawListing];
      if (mapping?.building && mapping?.bed_type) {
        property = `${mapping.bed_type} in ${mapping.building}`;
      } else {
        property = 'unknown property (ref not in mapping)';
      }
    } catch {
      property = 'unknown property';
    }
  }

  // Viewing state context — prevents re-escalation loop
  let viewingContext = '';
  if (leadMeta?.viewing_status === 'pending_id') {
    viewingContext = `\n\nVIEWING PENDING ID: You have ALREADY confirmed the viewing for ${leadMeta.viewing_day || 'the requested day'} at ${leadMeta.viewing_time || 'the requested time'} AND asked the lead for their passport or Emirates ID. Both of these are DONE. The lead already knows.

CRITICAL ANTI-REPETITION RULES FOR THIS STATE:
- NEVER re-state the viewing day/time. Not "tomorrow at 4pm", not "${leadMeta.viewing_day || ''} at ${leadMeta.viewing_time || ''}", not any restatement. The lead already saw it.
- NEVER re-confirm the property name, bed type, move-in date, contract length, or any context the lead already gave you. Do NOT write "Polo Residences 1BR confirmed" or "May 1 move-in noted". The lead remembers what they said.
- NEVER re-issue the full ID request sentence "Could you send a photo of your passport or Emirates ID so I can register you with building management." It is already pending.
- If the lead just acknowledges ("Yes sure", "ok", "yes it's good", "perfect", thumbs up), do NOT reply with a fresh viewing summary. Either stay quiet (escalate_to_faysal with reason "lead acknowledged, awaiting ID, no reply needed" + holding message "" if you must) OR send ONE short line max, e.g. "Perfect. Just send the ID photo whenever you have it." That's it. No viewing details, no property name, no time.
- If the lead asks an UNRELATED question (e.g. "Building number??"), answer ONLY that question in 1 sentence. Do NOT append the viewing summary or full ID request. At most a 5-word ID nudge: "And the ID when you can." NOT a full sentence.
- If the lead wants to cancel or change the time, handle that.

The ONLY new info that should appear in your reply is the answer to whatever the lead's latest message actually contains. Nothing else.`;
  } else if (leadMeta?.viewing_status === 'team_responded') {
    viewingContext = `\n\nVIEWING STATUS: The team has ALREADY confirmed viewing availability for this lead (requested: ${leadMeta.viewing_requested || 'a viewing'}). The lead is now confirming the time. Do NOT escalate again. Do NOT say "let me check with the team." Just acknowledge warmly, e.g. "You're all set for [time]! Our team will coordinate with you shortly." Then reply normally.`;
  } else if (leadMeta?.viewing_status === 'confirmed') {
    viewingContext = `\n\nVIEWING STATUS: A viewing is already confirmed for this lead. No need to discuss viewing scheduling further unless the lead brings it up again to change the time.`;
  }

  // ── Conversation arc: detect lead's buying stage and adapt tone ──
  const buyingStage = detectBuyingStage(conversation, leadMeta);
  const stageContext = STAGE_GUIDANCE[buyingStage] || '';

  // ── Tool definitions for structured output ──────────────────────────────────
  // Instead of parsing [ESCALATE:] and [VIEWING:] tags from free text, we define
  // tools that Claude calls with structured arguments. This eliminates:
  // - Regex parsing failures, partial tags leaking to customers
  // - Reasoning preamble leakage (tool input is separate from text)
  // - Ambiguous tag placement (mid-sentence, missing brackets, etc.)
  const TOOLS = [
    {
      name: 'send_reply',
      description: 'Send a WhatsApp reply to the lead. Use this for ALL normal replies where you are confident in your answer.',
      input_schema: {
        type: 'object',
        properties: {
          message: {
            type: 'string',
            description: 'The WhatsApp message to send to the lead. Must be warm, human, short. No internal reasoning, no rule references, no em dashes.',
          },
        },
        required: ['message'],
      },
    },
    {
      name: 'escalate_to_faysal',
      description: 'Escalate to Faysal (the human manager) when you are NOT confident in the answer, the lead asks to speak to a human, the lead asks about long-term pricing beyond 3 months, or you cannot identify the property. Always include a short holding message for the lead.',
      input_schema: {
        type: 'object',
        properties: {
          reason: {
            type: 'string',
            description: 'Internal reason for escalation (only Faysal sees this). Be specific.',
          },
          holding_message: {
            type: 'string',
            description: 'Short, warm message to send to the lead while Faysal takes over. E.g. "Let me check that for you and come back shortly!"',
          },
        },
        required: ['reason', 'holding_message'],
      },
    },
    {
      name: 'book_viewing',
      description: 'Book a property viewing ONLY when the lead has given a SPECIFIC day AND time (e.g. "tomorrow at 3pm", "Friday 11am"). Viewings are available 9am-6pm any day. Do NOT call this tool if the lead just says "can I see it" without a specific time. Do NOT call with TBD times.',
      input_schema: {
        type: 'object',
        properties: {
          property: {
            type: 'string',
            description: 'The property name/description for the viewing.',
          },
          day: {
            type: 'string',
            description: 'The day of the viewing (e.g. "today", "tomorrow", "Friday", "April 2").',
          },
          time: {
            type: 'string',
            description: 'The specific time (e.g. "3pm", "11am", "14:00"). Must be between 9am-6pm.',
          },
          confirmation_message: {
            type: 'string',
            description: 'Warm confirmation message to the lead, e.g. "3pm tomorrow works! Our team will coordinate with you shortly."',
          },
        },
        required: ['property', 'day', 'time', 'confirmation_message'],
      },
    },
  ];

  const systemPrompt = `${playbook}${portfolioContext}${viewingContext}${_conversationWallContext}

You are a warm, human WhatsApp sales agent for fäm Living. Lead: ${leadName}. Property: ${property}.
${stageContext}

RULES — follow exactly, no exceptions:
- The Active fäm Living Portfolio above lists ALL live listings. Use it for any availability/options question. Never escalate for this.
- PORTFOLIO STRICT RULE: ONLY suggest or mention buildings that appear in the Active Portfolio list above with a price. If a building is not in that list, it is NOT currently available, do not mention it, do not suggest it, do not cross-sell it. Aykon City and any other building not in the list must never be suggested.
- PROPERTY CONTEXT RULE: The "Property" field above tells you exactly which unit this lead enquired about. Always answer based on that specific property. If the Property field says "unknown property" or you cannot identify it, do NOT guess. Use escalate_to_faysal with reason "cannot identify listing for lead ${leadName}" and holding message "Let me pull up the details for you."
- NO HALLUCINATION: NEVER invent property details (bed type, building name, price, area) that are not explicitly in the Property field or the Active Portfolio. If you are not 100% certain of a detail, escalate. A wrong answer is worse than escalating.
- STAY ON TOPIC: Only discuss topics the lead has actually brought up. NEVER introduce new subjects (pets, cleaning fees, policies, amenities, etc.) unless the lead explicitly asked about them. If the lead's message is unclear, ask a short clarifying question instead of guessing what they mean.
- DEPOSIT STRICT RULE: There are TWO separate deposits: (1) DAMAGE SECURITY DEPOSIT — AED 1,000 for studio, AED 1,500 for 1 bedroom, AED 2,000 for 2 bedrooms and above. Fully refundable within 14 working days after check-out. (2) GUARANTEE OF AVAILABILITY — first month + last month payment to reserve the unit. These are DIFFERENT topics. If the lead asks ONLY about the security or damage deposit, answer ONLY with the correct amount for their unit type. Do NOT bring up Guarantee of Availability unless the lead is explicitly asking about reserving/booking the unit.
- HOUSEKEEPING UPSELL: When a lead is discussing move-in, confirming a viewing, or finalising booking details, you may proactively mention that fäm Living offers a paid housekeeping service (linen change, vacuuming, mopping, trash disposal, amenity replenishment). Quote the price for their unit size: 1BR AED 160/visit, 2BR AED 265/visit, 3BR AED 315/visit, 4BR AED 420/visit, Penthouse/Duplex AED 650/visit. Keep it brief. Do NOT mention housekeeping if the conversation is purely about pricing, availability, or viewings.
- NEVER BE CONDESCENDING: Do not say "I see the confusion here", "Let me clarify", "I think you mean", "Actually...", or anything that implies the lead is wrong or confused.
- READ THE FULL CONVERSATION: Before replying, read the entire conversation history above carefully. Understand what the lead has said across ALL messages, not just the last one. If the lead corrected themselves, act on the correction.
- ANSWER ALL PENDING QUESTIONS: Leads often send several messages in a row before you reply. A summary of ALL unanswered lead messages will be listed below under "UNANSWERED LEAD MESSAGES". You MUST address EVERY question, request, and piece of information from ALL of these messages in your reply. Do not skip any.
- ENGAGE WITH EVERYTHING THE LEAD SAYS: When a lead provides specific information (move-in date, contract length, budget, number of months, payment preference, timeline), you MUST acknowledge it specifically in your reply. For example: if the lead says "I move 4 April" and "6 months contract, pay monthly", your reply must reference April 4, 6 months, and monthly payment. NEVER reply with just the price and "What would you like to know?" when the lead has given you context to work with.
- NEGOTIATE AND ADAPT: You are a world-class sales agent, not a FAQ bot. When a lead gives budget info, work with it. When they state preferences, confirm you can accommodate. When they share move-in dates, confirm availability for that date. Be proactive, not reactive. Connect the dots between what they said and what you can offer.
- AGENT OVERRIDE, HIGHEST PRIORITY: If you see messages from "Agent (Faysal)" in the conversation history, those are manual interventions by the human manager. Any specific price, exception, condition, or promise made by Agent (Faysal) is an ABSOLUTE OVERRIDE of your standard rules. Honor it exactly, no exceptions.
- Keep it short, warm, human. No em dashes or en dashes, use commas or periods instead. No emojis of any kind in replies.
- REPLY LENGTH: Your replies should be SHORT. 1-3 sentences for simple answers. Max 4-5 sentences for complex ones. NEVER write multi-paragraph walls. If a lead asks a simple question, give a simple answer. You are on WhatsApp, not writing an email. Long messages scream "robot".
- NEVER self-correct inside the message field. Do NOT write "Wait, I used...", "Wait, no em dashes", "Let me redo", "FAIL", or any revision notes into the message. If you make a mistake, just fix it silently. The message field must contain ONLY the final reply text, nothing else.
- NEVER REPEAT YOURSELF: Do NOT restate facts, prices, policies, or information you have already told this lead in a prior message.
- NEVER PARROT PRICE + AMENITIES: If you already told the lead the price and what's included (water, electricity, internet, VAT) in a previous message, do NOT say it again. The lead already knows. Repeating "AED X/month, all-inclusive, covering water, electricity, and internet" in every reply is the #1 thing that makes you sound like a broken robot. ONLY state the price once, in your FIRST reply. After that, refer to it only if the lead specifically asks about it again. If the lead asks a different question (photos, viewing, duration), just answer THAT question, do not re-dump the price breakdown.
- NEVER REPEAT A CTA: If you already offered a next step (e.g., "Want me to send the contract?", "Shall I get payment details?") and the lead did NOT respond to it — they kept asking other questions instead — do NOT repeat that offer. Just answer what they asked. Repeating ignored CTAs is pushy and destroys trust.
- NO DEAD-END CTAs: NEVER end a reply with "let me know if you have any questions", "feel free to ask", "what would you like to know?", "is there anything else I can help you with?", or any similar generic phrase. These sound like a chatbot, not a person. Instead, end with a specific contextual question or next step that moves the conversation forward — tied to what the lead just said. Examples: "Shall I get the contract started?" / "Does April 4 still work as move-in?" / "Want me to send the listing link with photos?"
- BUDGET OBJECTION: If the lead says ANYTHING suggesting the price is too high or over budget, do NOT repeat the price. First ask what budget they are working with. If they give a specific number and the gap is 10% or less, you may offer up to 10% off the listed price as a direct discount (e.g. listed at 5,500 and lead wants 5,000, offer 5,000 directly). If the gap is more than 10%, suggest a cheaper alternative from the portfolio OR escalate with reason "budget gap too large, needs manager". NEVER repeat the original price after a budget objection.
- SELF-AWARENESS — READ THE ROOM: You are Claude, a world-class AI. Before replying, STOP and assess: Is this conversation going well or going in circles? If the lead has stated the same thing twice (price demand, complaint, request) and you already responded to it, DO NOT reply with the same refusal or information again. That is looping and it destroys trust. Instead, escalate to Faysal. A human can negotiate, you cannot. Repeating yourself is the single worst thing you can do.
- NEVER HIT THE SAME WALL TWICE: If you already told the lead a price is the lowest, and they push back again, you MUST escalate. Do NOT say "6,500 is the lowest" a second time. Ever. One refusal is professional. Two is a broken record. Three is insulting. Use escalate_to_faysal with reason "lead insists on different terms, needs human negotiation."
- FRUSTRATION DETECTION: If the lead sends "?????", "hello???", repeated messages with no new content, angry/short messages, or says anything suggesting they feel ignored or unheard, escalate IMMEDIATELY. Do not try to salvage it with a clever reply. The lead is already upset. Only a human can recover this.
- MULTIPLE REQUESTS IN ONE TURN: When the lead mentions multiple things (e.g. price AND wanting to see the apartment), you MUST address ALL of them. Never cherry-pick the easy one and ignore the rest.
- PRICING MATH: Prices are seasonal and only locked for 3 months. NEVER calculate or quote a total for more than 3 months. If asked about 4+ months, quote the current monthly rate, explain rates are confirmed in 3-month blocks, then escalate with reason "lead asking about long-term pricing beyond 3 months".
- NEVER PROMISE TO CHECK: NEVER say "let me check and get back to you", "let me verify", "I'll find out and come back". If you can answer — answer now. If you cannot answer — escalate immediately with escalate_to_faysal. There is no middle ground. "Let me check" is a broken promise that leaves the lead waiting forever.
- DO NOT OVER-ESCALATE: You can and should answer simple questions yourself. Availability dates ("available from October?"), contract lengths ("yearly contract?"), move-in timelines, pricing, deposit info, viewing scheduling are ALL within your capability. ONLY escalate when you truly cannot answer (unknown property, technical issue, lead demands a human, pricing beyond 3 months, custom negotiations you have no data for). When in doubt, answer confidently using the portfolio and conversation context.
- HUMAN/AGENT REQUESTS: If a lead asks to speak to a human, agent, person, or anyone from the team, or asks for a phone number, escalate immediately with reason "lead requesting human agent" and holding message "Of course, let me get someone from the team for you right away."
- VIDEO/MEDIA REQUESTS: If a lead asks for a video, virtual tour, video walkthrough, or any visual media of the property — escalate immediately with reason "lead requesting video for [property]" and holding message "Let me get that arranged for you right away." Never ignore a video request or pretend to answer it without providing one.
- VIEWING RULES: NEVER proactively suggest, offer, or propose a viewing. Only discuss viewings if the lead explicitly asks to visit, see, or view the property. When a lead does ask: viewings are available any day 9am-6pm. ONLY call book_viewing when the lead gives a SPECIFIC day AND time. If they ask without a time, ask "Sure! What day and time works for you? Viewings are available any day between 9am and 6pm." Do NOT say "let me check" or "let me confirm". If the time is outside 9am-6pm, tell them the window and ask for another time.
- NO GREETINGS: NEVER start a reply with "Hi [Name]!", "Hello [Name]!", "Hey [Name]!", or any greeting+name opener. Get straight to the point. The lead's name can appear naturally mid-sentence when relevant, but NEVER as the first words of a reply. This is a hard rule — no exceptions. Starting every reply with "Hi Lisa!" makes you sound like a broken chatbot.
- CONVERSATION CLOSURE: When the conversation is clearly over — the lead said goodbye, thanks, or declined — and you have ALREADY sent a farewell or closing message, STOP. Do NOT reply to courtesy follow-ups like "thank you", "you too", "thanks", "ok bye", thumbs up emoji, or any polite sign-off that comes AFTER your own goodbye. Let the conversation close naturally. Replying to goodbyes with more goodbyes makes you sound desperate and robotic.
- NO PUSHY SALES TACTICS: NEVER suggest paperwork, contracts, signing, booking, or payment on a first enquiry or early conversation. The lead just asked a question — answer it. Do NOT end with "Shall I get the paperwork started?", "Want me to send the contract?", "Ready to book?", or anything that pressures commitment. These CTAs are ONLY appropriate when the lead has explicitly said they want to proceed, asked about contracts, or confirmed they want to book. Until then, your CTA should be soft and informational: "Would you like to see it first?" / "Want me to send photos?" / "Any other questions about the property?" Pushing contracts on someone who just enquired is cheap and destroys trust.

You MUST call exactly one tool. Choose the right tool based on your confidence level.`;

  // Build explicit list of ALL unanswered lead messages (not just the latest webhook message)
  // This ensures Claude sees every question/statement the lead sent since the bot's last reply
  let pendingSection = '';
  if (pendingMessages && pendingMessages.length > 0) {
    const pendingTexts = pendingMessages
      .map(m => (m.body || m.text || m.message || '').trim())
      .filter(t => t && t !== '[attachment]');
    if (pendingTexts.length > 1) {
      pendingSection = `\n\nUNANSWERED LEAD MESSAGES (you MUST address ALL of these):\n${pendingTexts.map((t, i) => `${i + 1}. "${t}"`).join('\n')}`;
    } else if (pendingTexts.length === 1) {
      pendingSection = `\n\nUNANSWERED LEAD MESSAGES (you MUST address ALL of these):\n1. "${pendingTexts[0]}"`;
    }
  }

  const userMessage = `Conversation so far:\n${history}${pendingSection}\n\nLead just sent: "${newMessage}"${_criticNudge}`;

  // Retry up to 3 times for transient Anthropic errors (529 overloaded, 503, 500)
  // before giving up and escalating. Delays: 3s, 6s, 12s.
  const RETRY_STATUSES = new Set([429, 500, 503, 529]);
  let r, lastStatus;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      const delayMs = 3000 * Math.pow(2, attempt - 1); // 3s, 6s
      console.warn(`[auto-reply] Anthropic ${lastStatus} — retry ${attempt}/2 in ${delayMs}ms`);
      await new Promise(res => setTimeout(res, delayMs));
    }
    try {
      r = await fetch('https://api.anthropic.com/v1/messages', {
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
      lastStatus = r.status;
      if (r.ok || !RETRY_STATUSES.has(r.status)) break; // success or non-retryable error
    } catch (fetchErr) {
      console.error('[auto-reply] Anthropic fetch exception:', fetchErr?.message);
      lastStatus = 0;
    }
  }

  try {
    if (!r || !r.ok) {
      const err = r ? await r.text().catch(() => String(r.status)) : 'fetch failed';
      console.error('[auto-reply] Anthropic error after retries:', lastStatus, err);
      return { reply: null, escalate: true, reason: `Anthropic ${lastStatus}` };
    }

    const d = await r.json();

    // ── Parse structured tool_use response ──────────────────────────────────
    const toolBlock = d?.content?.find(b => b.type === 'tool_use');

    if (!toolBlock) {
      // Fallback: if Claude returned text instead of a tool call (shouldn't happen with tool_choice: any)
      const textBlock = d?.content?.find(b => b.type === 'text');
      const fallbackText = textBlock?.text?.trim();
      if (fallbackText) {
        console.warn('[auto-reply] Claude returned text instead of tool call, using as reply');
        const cleanFallback = fallbackText
          .replace(/\[(?:ESCALAT|VIEWING)[^\]]*\]?/gi, '')
          .replace(/\s*\u2014\s*/g, ', ')
          .replace(/\s*\u2013\s*/g, ', ')
          .trim();
        return { reply: cleanFallback, escalate: false, reason: null, viewing: null };
      }
      return { reply: null, escalate: true, reason: 'No tool call or text in response' };
    }

    const toolName = toolBlock.name;
    const toolArgs = toolBlock.input || {};

    // ── Clean helper: strip em/en dashes + surrounding quotes from any customer-facing text ──
    const cleanMsg = (s) => {
      let t = (s || '')
        .replace(/\s*\u2014\s*/g, ', ')
        .replace(/\s*\u2013\s*/g, ', ')
        .trim();
      // If Claude wrote self-critique inside the message field (e.g. "...\n\nWait, I used an em dash.\n\nFAIL\ncorrected reply"),
      // extract only the final corrected part — everything after the last FAIL line.
      const failLines = t.split('\n');
      const lastFailIdx = failLines.map((l,i) => /^FAIL$/i.test(l.trim()) ? i : -1).filter(i => i !== -1).pop();
      if (lastFailIdx !== undefined) {
        t = failLines.slice(lastFailIdx + 1).join('\n').trim();
        console.warn('[auto-reply] cleanMsg: stripped FAIL self-critique preamble from tool message');
      }
      // Strip surrounding quotes if Claude wrapped the reply in them (e.g. "Yes, available!")
      if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
        t = t.slice(1, -1).trim();
      }
      return t;
    };

    if (toolName === 'send_reply') {
      const reply = cleanMsg(toolArgs.message);
      if (!reply) return { reply: null, escalate: true, reason: 'Empty send_reply message' };
      return { reply, escalate: false, reason: null, viewing: null };
    }

    if (toolName === 'escalate_to_faysal') {
      const reason = (toolArgs.reason || 'Unknown reason').trim();
      const holding = cleanMsg(toolArgs.holding_message) || "Let me check that for you and come back shortly!";

      // ── Pre-escalation critic: should this really escalate? ────────────────
      // Completely invisible to the lead. Adds ~1s. Only runs once (no infinite loop).
      // If critic says HANDLE_IT → retry Claude with a strong nudge to answer directly.
      if (!_retryingAfterCritic) {
        const { shouldEscalate, guidance } = await preEscalationCritic(
          reason, holding, conversation, newMessage, leadName, portfolioContext, property
        );
        if (!shouldEscalate) {
          console.log(`[auto-reply] Pre-escalation critic blocked escalation — retrying with nudge. Guidance: "${guidance}"`);
          // Build retry user message with an explicit nudge injected at the end
          const nudge = `\n\nINTERNAL QUALITY CHECK (not visible to lead): You were about to escalate with reason "${reason}". This escalation was blocked. ${guidance} You MUST use send_reply and answer directly using the portfolio data and conversation above. Do NOT call escalate_to_faysal.`;
          // Single retry — _retryingAfterCritic=true prevents infinite loop
          return await generateReply(conversation, leadMeta, newMessage, leadName, pendingMessages, true, nudge);
        }
      }

      return { reply: holding, escalate: true, reason, viewing: null };
    }

    if (toolName === 'book_viewing') {
      const { day, time, confirmation_message } = toolArgs;
      const viewingProperty = toolArgs.property || property;
      // Guard: reject if no specific time digits (catches "TBD" or vague times)
      const hasTime = /\d/.test(time || '');
      const hasTBD = /\bTBD\b/i.test(time || '') || /\bTBD\b/i.test(day || '');
      if (!hasTime || hasTBD) {
        console.log(`[auto-reply] book_viewing rejected (no confirmed time): day="${day}" time="${time}" — treating as normal reply`);
        const fallback = cleanMsg(confirmation_message) || "Sure! What day and time works for you? Viewings are available any day between 9am and 6pm.";
        return { reply: fallback, escalate: false, reason: null, viewing: null, pendingViewing: null };
      }
      // Guard: reject times outside 9am-6pm viewing window
      const hourMatch = (time || '').match(/(\d{1,2})(?:\s*:\s*\d{2})?\s*(am|pm)?/i);
      if (hourMatch) {
        let hour = parseInt(hourMatch[1], 10);
        const ampm = (hourMatch[2] || '').toLowerCase();
        if (ampm === 'pm' && hour !== 12) hour += 12;
        if (ampm === 'am' && hour === 12) hour = 0;
        if (hour < 9 || hour >= 18) {
          console.log(`[auto-reply] book_viewing rejected (outside 9am-6pm): time="${time}" → ${hour}h`);
          return { reply: `Viewings are available between 9am and 6pm. Could you pick another time that works for you?`, escalate: false, reason: null, viewing: null, pendingViewing: null };
        }
      }
      // Viewing time confirmed — ask for passport/EID before completing booking.
      // Bot stays ACTIVE (not paused) until ID is received.
      // pendingViewing stores the viewing details in CRM; the old `viewing` field is left null
      // so the old "immediately unassign+pause" block does NOT fire.
      const confirmBase = cleanMsg(confirmation_message) || `${time} on ${day} works!`;
      const replyWithIdRequest = `${confirmBase} To arrange building access, I'll need a photo of your passport or Emirates ID. Could you please send it here?`;
      return {
        reply: replyWithIdRequest,
        escalate: false,
        reason: null,
        viewing: null,          // ← intentionally null: don't trigger the old viewing block
        pendingViewing: { day, time, property: viewingProperty },
      };
    }

    // Unknown tool — treat as escalation for safety
    console.warn(`[auto-reply] Unknown tool call: ${toolName}`);
    return { reply: null, escalate: true, reason: `Unknown tool: ${toolName}` };

  } catch (err) {
    console.error('[auto-reply] Claude call failed:', err?.message);
    return { reply: null, escalate: true, reason: err?.message };
  }
}

// ── Main webhook handler ───────────────────────────────────────────────────────

function createMetricsEvent(ticketId, leadId, action, toolUsed, responseTimeMs, criticPass = null, leadQuality = null, buyingStage = null, skipReason = null) {
  return {
    ts: new Date().toISOString(),
    ticket_id: ticketId,
    lead_id: leadId,
    action,
    tool_used: toolUsed,
    response_time_ms: responseTimeMs,
    critic_pass: criticPass,
    lead_quality: leadQuality,
    buying_stage: buyingStage,
    skip_reason: skipReason,
  };
}

function metricsResponse(res, status, body, event) {
  // Fire-and-forget metrics append (non-blocking)
  if (event && event.ticket_id) {
    appendMetricsEvent(event);
  }
  return res.status(status).json(body);
}

export default async function handler(req, res) {
  const webhookStartTime = Date.now();

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (process.env.AUTOBOT_ENABLED !== 'true') {
    return res.status(200).json({ ok: true, skipped: 'Bot disabled (AUTOBOT_ENABLED != true)' });
  }

  const webhookSecret = process.env.TRENGO_WEBHOOK_SECRET;
  if (webhookSecret) {
    const providedSecret = req.query?.secret || '';
    if (providedSecret !== webhookSecret) {
      console.warn('[auto-reply] Invalid webhook secret');
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  let body = req.body;
  if (!body || typeof body === 'string') {
    try { body = JSON.parse(body); } catch { return res.status(400).json({ error: 'Invalid JSON' }); }
  }

  // RAW PAYLOAD LOG — saves incoming body to GitHub for debugging
  try {
    const ghTok = process.env.GH_TOKEN;
    const logData = { ts: new Date().toISOString(), query: req.query, body };
    const logB64 = Buffer.from(JSON.stringify(logData, null, 2)).toString('base64');
    let logSha = null;
    try {
      const lr = await fetch('https://api.github.com/repos/fam-pricing/fam-api/contents/data/webhook_capture.json', { headers: { Authorization: 'token ' + ghTok } });
      if (lr.ok) { const ld = await lr.json(); logSha = ld.sha; }
    } catch {}
    await fetch('https://api.github.com/repos/fam-pricing/fam-api/contents/data/webhook_capture.json', {
      method: 'PUT',
      headers: { Authorization: 'token ' + ghTok, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'log: incoming webhook', content: logB64, ...(logSha ? { sha: logSha } : {}) })
    });
  } catch (logErr) { console.warn('log failed', logErr.message); }

  // Trengo sends FLAT payloads: { ticket_id, message, contact_id, user_id, ... }
  // NOT nested { ticket: { id }, message: { body, type } }
  // We must handle both formats (flat = real Trengo, nested = curl tests / API calls)
  const isFlat = typeof body?.message === 'string' || body?.ticket_id != null;

  const ticketId = parseInt(body?.ticket?.id      // nested test format
                || body?.ticket_id               // flat Trengo format — Trengo sends as STRING
                || body?.message?.ticket_id
                || 0) || null;

  let messageText = (isFlat ? (body?.message || '') : '')  // flat: body.message IS the text
                    || body?.message?.message                  // nested variants
                    || body?.message?.body
                    || body?.message?.text
                    || '';

  // Flat inbound has no user_id; flat outbound has user_id (agent who sent it)
  const messageType = (body?.message?.type       // nested format
                    || body?.type
                    || (isFlat
                        ? (body?.user_id ? 'OUTBOUND' : 'INBOUND')
                        : '')
                    ).toUpperCase();

  console.log(`[auto-reply] ticket=${ticketId} type=${messageType} text="${String(messageText).substring(0,50)}" flat=${isFlat}`);

  if (!ticketId) return res.status(200).json({ ok: true, skipped: 'No ticket ID' });

  // ── Faysal teaching via FAYSAL_TICKET_ID is retired — escalations now use
  //    internal notes + unassign. Owner phone guard below still handles direct
  //    teaching messages from Faysal's own phone number.

  // Load CRM state
  const { state: crmState, sha } = await readCRMState();
  const leadId   = Object.keys(crmState).find(k => String(crmState[k].trengo_ticket_id) === String(ticketId));
  if (!leadId) return res.status(200).json({ ok: true, skipped: 'Ticket not in CRM' });

  // ── Owner phone guard ──────────────────────────────────────────────────────
  // If this ticket belongs to Faysal's own phone number, treat as teaching — never as a lead.
  const OWNER_PHONE = process.env.OWNER_PHONE || '971502725428';
  const leadPhone = crmState[leadId]?.pf_phone || '';
  if (leadPhone === OWNER_PHONE) {
    if (messageType === 'INBOUND' && messageText) {
      const faysalTicketId = process.env.FAYSAL_TICKET_ID ? parseInt(process.env.FAYSAL_TICKET_ID, 10) : null;
      await handleFaysalTeachingReply(faysalTicketId || ticketId, messageText);
    }
    return res.status(200).json({ ok: true, action: 'owner_phone_guard' });
  }

  const leadMeta = crmState[leadId];
  const leadName = leadMeta.lead_name || 'there';

  // ── OUTBOUND webhook — must distinguish bot echo from Faysal's manual reply ──
  // Both the bot and Faysal post under user_id 141332 (bot uses Faysal's Trengo token).
  // When the bot sends a message, Trengo immediately fires an OUTBOUND webhook for it.
  // If we treat this as an "agent reply", last_agent_reply_at gets set → 3-min cooldown
  // fires after EVERY bot reply → lead messages go unanswered.
  //
  // FIX (2026-04-01): Content comparison was failing due to Redis race conditions — bot
  // writes last_bot_reply_content but the OUTBOUND webhook reads stale CRM state.
  // New approach: TWO detection methods (either one = bot echo):
  //   1. Content match (original, still useful when CRM is fresh)
  //   2. Time-based: if OUTBOUND arrives within 30s of last_bot_reply_at, it's almost
  //      certainly the bot's own echo (Trengo echoes arrive within 1-5s)
  if (messageType === 'OUTBOUND' && messageText) {
    // Method 1: Content comparison (CRM state — may be stale if OUTBOUND webhook arrives
    //           before writeCRMState completes after sending)
    const normEcho = s => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
    let lastBotContent = normEcho(leadMeta.last_bot_reply_content || '');

    // Method 1b: Fast Redis echo key — flushed ~1ms after postTrengoMessage, always fresh.
    // This catches the race condition where OUTBOUND webhook arrives before CRM write.
    // Root fix for ticket 939283788 (bot went silent after first reply).
    if (!lastBotContent) {
      try {
        const redis = getLockRedis();
        if (redis) {
          const echoContent = await redis.get(`lead:${leadId}:echo`);
          if (echoContent) {
            lastBotContent = normEcho(echoContent);
            console.log(`[auto-reply] Used Redis echo key for bot echo detection on ${ticketId}`);
          }
        }
      } catch (e) {
        console.warn('[auto-reply] Redis echo read failed (non-fatal):', e?.message);
      }
    }

    const isBotEchoContent = lastBotContent && normEcho(messageText) === lastBotContent;

    // Method 2: Time-based — OUTBOUND within 30s of bot's last reply is almost certainly the echo
    const BOT_ECHO_WINDOW_MS = 30000; // 30 seconds
    const lastBotAt = leadMeta.last_bot_reply_at ? new Date(leadMeta.last_bot_reply_at).getTime() : 0;
    const isBotEchoTime = lastBotAt && (Date.now() - lastBotAt < BOT_ECHO_WINDOW_MS);

    if (isBotEchoContent || isBotEchoTime) {
      console.log(`[auto-reply] Bot echo ignored on ticket ${ticketId} — content=${isBotEchoContent} time=${isBotEchoTime} (${lastBotAt ? Math.round((Date.now() - lastBotAt)/1000) + 's ago' : 'no ts'})`);
      return res.status(200).json({ ok: true, action: 'bot_echo_ignored' });
    }
    // Content is different AND more than 30s since last bot reply → Faysal typed this manually
    crmState[leadId].last_agent_reply_at = new Date().toISOString();
    await learnFromAgentReply(ticketId, messageText, leadMeta, crmState, leadId, sha);
    return res.status(200).json({ ok: true, action: 'agent_reply_tracked' });
  }

  // ── INBOUND (lead is speaking) or attachment (IMAGE/DOCUMENT) ─────────────
  // Standard text = type 'INBOUND'. WhatsApp images/documents = type 'IMAGE' or 'DOCUMENT'.
  // Trengo treats both as inbound semantically but uses different type fields.
  const isAttachmentMsg  = ATTACHMENT_TYPES.has(messageType);
  // Extract attachment URL from multiple possible locations in the Trengo webhook payload
  const attachmentUrl    = body?.attachment_url
                        || body?.attachment?.url
                        || body?.media_url
                        || body?.message?.attachment?.url
                        || null;

  if (messageType !== 'INBOUND' && !isAttachmentMsg) {
    return res.status(200).json({ ok: true, skipped: `Message type ${messageType} ignored` });
  }

  // Attachment messages may have empty text — valid. Placeholder keeps logging consistent.
  if (!messageText && isAttachmentMsg) messageText = '[attachment]';
  if (!messageText) return res.status(200).json({ ok: true, skipped: 'Empty message' });

  // ── Prompt injection sanitisation ─────────────────────────────────────────
  messageText = sanitizeInput(messageText);

  // ── Auto-responder detection — skip WhatsApp Business auto-replies ──────────
  // Fires when we message a lead who has a WA Business auto-responder set up.
  // Their phone instantly replies with a canned message. We should ignore it silently.
  const AUTO_RESPONDER_PATTERNS = [
    /thank you for (your message|contacting|reaching out)/i,
    /we('re| are) (currently )?(unavailable|away|offline|out of office)/i,
    /we will (respond|get back|reply).{0,40}(soon|as soon as possible|shortly)/i,
    /how (may|can) (i|we) help you/i,
    /this is an? (auto(mated)?|automatic) (reply|response|message)/i,
    /i('m| am) (currently )?unavailable/i,
    /please (leave|send) (a message|your (details|enquiry))/i,
    /our (team|staff|office) (will|is)/i,
  ];
  const matchesAutoPattern = AUTO_RESPONDER_PATTERNS.some(p => p.test(messageText));
  // Guard: real leads sometimes START with a polite phrase ("Yes, thank you for contacting")
  // but then ask a real question. Auto-responders are short canned messages (< 120 chars)
  // and never contain question marks. If the message is long or has a ?, it's a real person.
  const isAutoResponder = matchesAutoPattern && messageText.length < 120 && !messageText.includes('?');
  if (isAutoResponder) {
    console.log(`[auto-reply] Auto-responder detected on ticket ${ticketId} — posting internal note`);
    await postTrengoNote(ticketId,
      `⚠️ Auto-responder detected — this appears to be a WhatsApp Business auto-reply, not a real lead message.\n\nA human team member should review this lead and follow up manually if needed.\n— fäm Bot`
    );
    const autoRespEvent = createMetricsEvent(ticketId, leadId, 'skipped', null, Date.now() - webhookStartTime, null, leadMeta.lead_quality_score || null, leadMeta.lead_quality_label || null, 'auto_responder');
    return metricsResponse(res, 200, { ok: true, skipped: 'Auto-responder detected — internal note posted' }, autoRespEvent);
  }

  // ── Pure emoji / acknowledgment guard ─────────────────────────────────────
  // Lead sent ❤️, 👍, "ok", "thanks" etc. — no question, no request.
  // Bot replying to these creates a loop of repeated info (seen in ticket 939121850).
  // Skip silently — no reply, no escalation, no logging noise.
  const trimmedMsg = messageText.trim();
  const isPureEmoji = /^[\p{Emoji}\s]+$/u.test(trimmedMsg) && trimmedMsg.length <= 10;
  const isPureAck = /^(ok|okay|thanks|thank you|great|perfect|good|nice|cool|noted|alright|sure|understood|got it|k|👍|❤️|🙏|👌|😊|🔥|👏|✅)$/i.test(trimmedMsg);
  if (isPureEmoji || isPureAck) {
    console.log(`[auto-reply] Acknowledgment/emoji message on ticket ${ticketId} — skipping reply: "${trimmedMsg}"`);
    const ackEvent = createMetricsEvent(ticketId, leadId, 'skipped', null, Date.now() - webhookStartTime, null, leadMeta.lead_quality_score || null, leadMeta.lead_quality_label || null, 'acknowledgment_skip');
    return metricsResponse(res, 200, { ok: true, skipped: 'Acknowledgment or emoji — no reply needed' }, ackEvent);
  }

  const dubaiHour = getDubaiHour();
  console.log(`[auto-reply] Inbound on ticket ${ticketId} | Dubai hour: ${dubaiHour} | Bot: 24/7 active`);

  // BOT RUNS 24/7

  if (leadMeta.bot_paused) {
    const pausedEvent = createMetricsEvent(ticketId, leadId, 'skipped', null, Date.now() - webhookStartTime, null, leadMeta.lead_quality_score || null, leadMeta.lead_quality_label || null, 'bot_paused');
    return metricsResponse(res, 200, { ok: true, skipped: 'Bot paused for this lead' }, pausedEvent);
  }

  const lastAgentAt = leadMeta.last_agent_reply_at ? new Date(leadMeta.last_agent_reply_at).getTime() : 0;
  if (Date.now() - lastAgentAt < AGENT_COOLDOWN_MS) {
    const cooldownEvent = createMetricsEvent(ticketId, leadId, 'skipped', null, Date.now() - webhookStartTime, null, leadMeta.lead_quality_score || null, leadMeta.lead_quality_label || null, 'agent_cooldown');
    return metricsResponse(res, 200, { ok: true, skipped: 'Agent cooldown active' }, cooldownEvent);
  }

  // Extract message ID early for dedup (needed both inside and outside lock)
  const incomingMsgId_raw = String(body?.message_id || body?.message?.id || '');

  // ── Per-ticket Redis lock — prevent duplicate replies from concurrent webhooks ──
  // Must be BEFORE any AI call or message send. If another instance is already handling
  // this ticket, bail out immediately. Lock is released at end of handler or on early exit.
  const lockAcquired = await acquireTicketLock(ticketId);
  if (!lockAcquired) {
    console.log(`[auto-reply] Ticket ${ticketId} locked by another instance — skipping to prevent duplicate reply`);
    const lockEvent = createMetricsEvent(ticketId, leadId, 'skipped', null, Date.now() - webhookStartTime, null, leadMeta.lead_quality_score || null, leadMeta.lead_quality_label || null, 'ticket_locked');
    return metricsResponse(res, 200, { ok: true, skipped: 'Ticket locked by another instance' }, lockEvent);
  }

  // From here on, we hold the lock. Use try/finally to guarantee release.
  try {
    return await handleInboundWithLock(req, res, body, ticketId, leadId, leadMeta, leadName, crmState, sha, messageText, messageType, isAttachmentMsg, attachmentUrl, incomingMsgId_raw, webhookStartTime);
  } finally {
    await releaseTicketLock(ticketId);
  }
}

// ── Locked inbound handler (all logic that runs under per-ticket Redis lock) ──
async function handleInboundWithLock(req, res, body, ticketId, leadId, leadMeta, leadName, crmState, sha, messageText, messageType, isAttachmentMsg, attachmentUrl, incomingMsgId_raw, webhookStartTime) {

  const dubaiHour = getDubaiHour();

  // Message-ID deduplication: skip if this exact message was already processed
  // (prevents double-reply when Trengo fires the same webhook twice)
  const incomingMsgId = incomingMsgId_raw;
  if (incomingMsgId && leadMeta.last_processed_message_id === incomingMsgId) {
    const dupEvent = createMetricsEvent(ticketId, leadId, 'skipped', null, Date.now() - webhookStartTime, null, leadMeta.lead_quality_score || null, leadMeta.lead_quality_label || null, 'duplicate_message_id');
    return metricsResponse(res, 200, { ok: true, skipped: `Duplicate message_id ${incomingMsgId}` }, dupEvent);
  }

  // Early conversation fetch — used only for viewing_id attachment scanning and the
  // stale-webhook check below. Will be refreshed after the read delay (see below).
  let conversation = await getTrengoMessages(ticketId);

  // ── Viewing ID collection ─────────────────────────────────────────────────
  // Bot is waiting for passport/EID after confirming a viewing time.
  // Handle BEFORE the pendingInbound stale-webhook check — image messages may not
  // appear as type='INBOUND' in the conversation thread so the check would skip them.
  //
  // IMPORTANT (2026-04-01): Trengo sends image messages as type:"INBOUND" with
  // message:"Image" (NOT type:"IMAGE"). No attachment_url is included in the webhook.
  // Same pattern for "Video", "Document", "Audio", "Sticker", "Contact card", "Location".
  // We detect these by matching the message text against known Trengo placeholder strings.
  const TRENGO_ATTACHMENT_PLACEHOLDERS = /^(image|video|document|audio|sticker|contact card|location|gif)$/i;
  const isTrengoAttachmentText = TRENGO_ATTACHMENT_PLACEHOLDERS.test((messageText || '').trim());

  if (leadMeta.viewing_status === 'pending_id') {
    // Auto-escalate if pending ID for too long (6 hours) — lead may have lost interest
    const pendingSince = leadMeta.viewing_pending_since ? new Date(leadMeta.viewing_pending_since).getTime() : 0;
    const pendingHours = pendingSince ? (Date.now() - pendingSince) / 3600000 : 0;
    if (pendingHours > 6) {
      console.warn(`[auto-reply] Viewing ID pending for ${Math.round(pendingHours)}h on ticket ${ticketId} — auto-escalating`);
      await escalateTicket(leadName, leadMeta.listing_title || null, `Viewing ID pending for ${Math.round(pendingHours)} hours — lead may need follow-up`, ticketId, conversation, crmState, leadId);
      await writeCRMState(crmState, sha);
      return res.status(200).json({ ok: true, action: 'pending_id_timeout_escalated' });
    }
    // Try to get the attachment URL from the webhook payload first,
    // then fall back to scanning the conversation for the latest IMAGE/DOCUMENT message.
    let receivedAttachmentUrl = attachmentUrl || null;

    if (!receivedAttachmentUrl) {
      // Search conversation for the most recent image/document from the lead
      const attachMsg = conversation.slice().reverse().find(m => {
        const t = (m.type || '').toUpperCase();
        return ATTACHMENT_TYPES.has(t) && !m.user_id; // no user_id = from lead, not agent
      });
      if (attachMsg) {
        receivedAttachmentUrl = attachMsg.attachment?.url
          || attachMsg.media_url
          || attachMsg.attachment_url
          || null;
        console.log(`[auto-reply] Found attachment in conversation for pending_id: ${receivedAttachmentUrl}`);
      }
    }

    // Detect attachment via: explicit type (IMAGE/DOCUMENT), URL found, OR Trengo's
    // placeholder text ("Image", "Document", etc.) — Trengo sends images as type:INBOUND
    // with message:"Image" and no attachment_url (confirmed via webhook capture 2026-04-01).
    if (isAttachmentMsg || receivedAttachmentUrl || isTrengoAttachmentText) {
      // ── ID received — send Maps link, post internal note, assign team, pause ──
      console.log(`[auto-reply] Viewing ID received for ${leadName} (ticket ${ticketId})`);

      // Resolve building name from listing_title for Guesty lookup
      // listing_title can be: PF ref ("PF-HH-AR-109427"), PF URL, "1BR in Building", or building name
      const rawListing   = leadMeta.listing_title || '';
      let buildingForMaps = rawListing;
      try {
        const [{ data: refMap }, { data: urlMap }] = await Promise.all([
          ghRead(REF_MAP_FILE),
          ghRead(REF_URL_FILE),
        ]);
        if (/^PF-HH-AR-/i.test(rawListing)) {
          // Direct PF ref lookup
          const m = refMap?.[rawListing];
          if (m?.building) buildingForMaps = m.building;
        } else if (/propertyfinder\.ae/i.test(rawListing) && urlMap) {
          // listing_title is a PF URL — reverse-lookup: find which PF ref maps to this URL
          const matchingRef = Object.entries(urlMap).find(([, url]) => url === rawListing);
          if (matchingRef && refMap?.[matchingRef[0]]?.building) {
            buildingForMaps = refMap[matchingRef[0]].building;
            console.log(`[auto-reply] Resolved PF URL → ${matchingRef[0]} → ${buildingForMaps}`);
          }
        }
      } catch {}

      // Fetch Google Maps URL from Guesty — STRICT: only real coordinates, no fallback URLs
      const mapsUrl = await getListingMapsUrl(buildingForMaps);

      const dubaiTime = new Date(Date.now() + DUBAI_OFFSET_HOURS * 3600000)
        .toISOString().replace('T', ' ').substring(0, 16) + ' Dubai';

      if (!mapsUrl) {
        // ── Guesty has no coordinates — escalate, do NOT send maps link to lead ──
        console.warn(`[auto-reply] No Guesty coords for "${buildingForMaps}" — escalating viewing ID flow`);

        const holdingMsg = `Thank you for sending your ID. Our team will be in touch shortly to confirm the property location and all viewing details.`;
        const typingMs   = Math.min(6000, Math.max(2000, holdingMsg.length * 35));
        await new Promise(r => setTimeout(r, typingMs));
        await postTrengoMessage(ticketId, holdingMsg);

        const escalationNote =
          `⚠️ VIEWING ID RECEIVED — MAPS ESCALATION\n\n` +
          `Lead: ${leadName}\n` +
          `Property: ${rawListing || 'the property'} (building: "${buildingForMaps}")\n` +
          `Viewing: ${leadMeta.viewing_day || '?'} at ${leadMeta.viewing_time || '?'}\n` +
          `ID document: ${receivedAttachmentUrl || '(check WhatsApp thread — lead sent image)'}\n` +
          `Maps URL: NOT AVAILABLE — Guesty has no coordinates for this building.\n\n` +
          `ACTION REQUIRED — please send the Maps link manually and confirm viewing details.\n\n` +
          `@faysal141332 @afifa340123 @chahana470168 @junaid731578 @abdul315306\n— fäm Bot`;

        await postTrengoNote(ticketId, escalationNote);
        await attachTrengoLabel(ticketId, LABEL_VIEWING);
        await unassignTicket(ticketId);

        crmState[leadId].bot_paused              = true;
        crmState[leadId].viewing_status          = 'id_received_no_coords';
        crmState[leadId].viewing_id_url          = receivedAttachmentUrl || null;
        crmState[leadId].last_bot_reply_at       = new Date().toISOString();
        crmState[leadId].last_bot_reply_content  = holdingMsg.trim();
        crmState[leadId].bot_reply_count         = (leadMeta.bot_reply_count || 0) + 1;
        if (incomingMsgId) crmState[leadId].last_processed_message_id = incomingMsgId;
        await writeCRMState(crmState, sha);

        console.log(`[auto-reply] No-coords escalation complete for ${leadName} — bot paused, team notified`);
        return metricsResponse(res, 200, { ok: true, action: 'viewing_id_no_coords_escalated' },
          createMetricsEvent(ticketId, leadId, 'viewing_id_no_coords_escalated', 'book_viewing', Date.now() - webhookStartTime));
      }

      // ── Coordinates found — send Maps link, confirm, hand off to team ──
      const mapsMsg  = `Perfect, thank you! Here is the property location: ${mapsUrl}\n\nOur team will be in touch shortly to confirm all details.`;
      const typingMs = Math.min(8000, Math.max(2000, mapsMsg.length * 35));
      await new Promise(r => setTimeout(r, typingMs));
      await postTrengoMessage(ticketId, mapsMsg);

      // Internal note for team
      const viewingNote =
        `📅 VIEWING CONFIRMED — ${dubaiTime}\n\n` +
        `Lead: ${leadName}\n` +
        `Property: ${rawListing || 'the property'}\n` +
        `Viewing: ${leadMeta.viewing_day || '?'} at ${leadMeta.viewing_time || '?'}\n` +
        `ID document: ${receivedAttachmentUrl || '(check WhatsApp thread — lead sent image)'}\n` +
        `Maps: ${mapsUrl}\n` +
        `\nACTION REQUIRED — Ground Operations:\n` +
        `Farhan / Abdul Rehman / Junaid — coordinate key access and meet the lead at the property.\n\n` +
        `@faysal141332 @afifa340123 @chahana470168 @junaid731578 @abdul315306\n— fäm Bot`;

      await postTrengoNote(ticketId, viewingNote);
      await attachTrengoLabel(ticketId, LABEL_VIEWING);
      await unassignTicket(ticketId);

      crmState[leadId].bot_paused              = true;
      crmState[leadId].viewing_status          = 'id_received';
      crmState[leadId].viewing_id_url          = receivedAttachmentUrl || null;
      crmState[leadId].last_bot_reply_at       = new Date().toISOString();
      crmState[leadId].last_bot_reply_content  = mapsMsg.trim();
      crmState[leadId].bot_reply_count         = (leadMeta.bot_reply_count || 0) + 1;
      if (incomingMsgId) crmState[leadId].last_processed_message_id = incomingMsgId;
      await writeCRMState(crmState, sha);

      console.log(`[auto-reply] Viewing flow complete for ${leadName} — ID stored, Maps sent, team notified, bot paused`);
      return metricsResponse(res, 200, { ok: true, action: 'viewing_id_received' },
        createMetricsEvent(ticketId, leadId, 'viewing_id_received', 'book_viewing', Date.now() - webhookStartTime));

    } else {
      // ── Text message while pending ID ─────────────────────────────────────
      // Fall through to generateReply() — Claude reads the message first and
      // responds intelligently (handles cancellations, time changes, questions).
      // The pending_id viewingContext (injected below in generateReply) tells
      // Claude to end any normal reply with a brief ID reminder.
      console.log(`[auto-reply] Pending ID for ${leadName} — text received, passing to Claude`);
      // (no return — falls through to pendingInbound check and generateReply)
    }
  }

  // ── Smart pending-message check (replaces flat 5s cooldown) ───────────────
  // Look at the live conversation thread. If there are inbound messages that arrived
  // AFTER the bot's last reply → those are genuinely unanswered → always process.
  // If there are NO such messages → this webhook is stale (Trengo re-fired for a
  // message the bot already answered) → skip safely.
  // This ensures the bot never misses a message when the lead sends multiple questions
  // in rapid succession, and still avoids duplicate replies.
  const lastBotReplyTime = leadMeta.last_bot_reply_at
    ? new Date(leadMeta.last_bot_reply_at).getTime()
    : 0;
  const lastBotAt = lastBotReplyTime; // Alias for optimistic lock check later

  const filterPending = (conv) => conv.filter(m => {
    const isInbound = (m.type || '').toUpperCase() === 'INBOUND' || m.from === 'lead';
    if (!isInbound) return false;
    const msgTime = m.created_at
      ? (typeof m.created_at === 'number' ? m.created_at * 1000 : new Date(m.created_at).getTime())
      : Date.now();
    return msgTime > (lastBotReplyTime - PENDING_GRACE_MS);
  });

  // Early stale-webhook check — bail fast if nothing to answer yet
  let pendingInbound = filterPending(conversation);
  if (pendingInbound.length === 0) {
    console.log(`[auto-reply] No unanswered inbound messages on ticket ${ticketId} — stale webhook, skipping`);
    const staleEvent = createMetricsEvent(ticketId, leadId, 'skipped', null, Date.now() - webhookStartTime, null, leadMeta.lead_quality_score || null, leadMeta.lead_quality_label || null, 'stale_webhook');
    return metricsResponse(res, 200, { ok: true, skipped: 'No pending unanswered messages — stale webhook' }, staleEvent);
  }

  // Short read pause + random jitter to desynchronize concurrent webhooks
  const jitter = Math.floor(Math.random() * READ_DELAY_JITTER);
  await new Promise(r => setTimeout(r, READ_DELAY_BASE + jitter));
  console.log(`[auto-reply] Read delay: ${READ_DELAY_BASE + jitter}ms (jitter: ${jitter}ms)`);

  // ── Re-fetch conversation AFTER the delay ─────────────────────────────────
  // Critical: the lead may send multiple messages in quick succession. If we use the
  // conversation fetched BEFORE the delay, we only see the first message and reply to
  // it alone — ignoring everything the lead typed during the 2-5s wait window.
  // Root cause of ticket 939283788: Sandra sent "Is this available?" then "Do you have
  // a video?" 25s later. Bot fetched early, saw only the first message, sent a reply
  // about availability and pricing with no mention of the video request.
  // Fix: re-fetch after delay → all messages are now visible → bot answers everything.
  conversation = await getTrengoMessages(ticketId);
  pendingInbound = filterPending(conversation);

  if (pendingInbound.length === 0) {
    // Became stale during the delay (e.g. another instance replied first)
    const staleEvent2 = createMetricsEvent(ticketId, leadId, 'skipped', null, Date.now() - webhookStartTime, null, leadMeta.lead_quality_score || null, leadMeta.lead_quality_label || null, 'stale_after_delay');
    return metricsResponse(res, 200, { ok: true, skipped: 'No pending messages after delay — another instance replied' }, staleEvent2);
  }

  if (pendingInbound.length > 1) {
    console.log(`[auto-reply] ${pendingInbound.length} unanswered messages on ticket ${ticketId} — bot will address all`);
  }

  // ── Live agent guard — check Trengo thread for recent agent reply ──────────
  // Prevents bot from piling on after Afifa or Faysal already responded.
  const agentAlreadyReplied = await hasRecentAgentReplyInTrengo(ticketId, leadMeta);
  if (agentAlreadyReplied) {
    crmState[leadId].last_agent_reply_at = new Date().toISOString(); // sync CRM
    await writeCRMState(crmState, sha);
    console.log(`[auto-reply] Live agent guard triggered on ticket ${ticketId} — agent replied recently, bot standing down`);
    const agentGuardEvent = createMetricsEvent(ticketId, leadId, 'skipped', null, Date.now() - webhookStartTime, null, leadMeta.lead_quality_score || null, leadMeta.lead_quality_label || null, 'live_agent_guard');
    return metricsResponse(res, 200, { ok: true, skipped: 'Agent replied recently in Trengo — bot standing down', dubaiHour }, agentGuardEvent);
  }

  // ── PRE-CLAUDE GUARD 1: Audio/voice message → immediate escalation ────────
  // Bot cannot process audio. Don't acknowledge, don't ask to type — just escalate.
  // The lead sent a voice note because they want a human conversation.
  const pendingTexts = pendingInbound.map(m => (m.body || m.text || m.message || '').trim().toLowerCase());
  const hasAudioMessage = pendingTexts.some(t => /^audio$/i.test(t)) || messageType === 'AUDIO';
  if (hasAudioMessage) {
    console.log(`[auto-reply] Audio/voice message detected on ticket ${ticketId} — immediate escalation`);
    const holdingMsg = 'Let me get someone from the team to help you right away.';
    const typingMs = Math.min(4000, Math.max(1500, holdingMsg.length * 30));
    await new Promise(r => setTimeout(r, typingMs));
    await postTrengoMessage(ticketId, holdingMsg);
    crmState[leadId].last_bot_reply_content = holdingMsg;
    await escalateTicket(leadName, leadMeta.listing_title, 'Lead sent voice note(s) — bot cannot process audio, needs human follow-up', ticketId, conversation, crmState, leadId);
    await writeCRMState(crmState, sha);
    const audioEvent = createMetricsEvent(ticketId, leadId, 'escalate', 'escalate_to_faysal', Date.now() - webhookStartTime, null, leadMeta.lead_quality_score || null, leadMeta.lead_quality_label || null, 'audio_message');
    return metricsResponse(res, 200, { ok: true, action: 'escalated', reason: 'audio_message' }, audioEvent);
  }

  // ── PRE-CLAUDE GUARD 2: Frustration / anger detection → immediate escalation ─
  // When a lead is clearly frustrated (repeated ?'s, calling out the bot, angry),
  // no AI reply will help. Escalate immediately to a human.
  const allPendingText = pendingTexts.join(' ');
  const frustrationSignals = [
    /\?{3,}/.test(allPendingText),                              // "?????" — repeated question marks
    /robot|bot|machine|automat/i.test(allPendingText),           // calling out the bot
    /speak.*(human|person|real|agent|someone)/i.test(allPendingText), // wants a human
    /waste.*time|losing.*client|lose.*client|worst.*service/i.test(allPendingText), // threatening/angry
    /disgusting|pathetic|useless|terrible|horrible|incompetent/i.test(allPendingText), // insults
    /stop.*message|stop.*reply|leave me|go away/i.test(allPendingText), // wants bot to stop
  ];
  const frustrationCount = frustrationSignals.filter(Boolean).length;
  if (frustrationCount >= 1) {
    console.log(`[auto-reply] Frustration detected on ticket ${ticketId} (${frustrationCount} signals) — immediate escalation`);
    const holdingMsg = 'Apologies for any inconvenience. Let me get someone from the team to assist you personally.';
    const typingMs = Math.min(4000, Math.max(1500, holdingMsg.length * 30));
    await new Promise(r => setTimeout(r, typingMs));
    await postTrengoMessage(ticketId, holdingMsg);
    crmState[leadId].last_bot_reply_content = holdingMsg;
    await escalateTicket(leadName, leadMeta.listing_title, `Lead is frustrated — signals: ${frustrationSignals.map((s, i) => s ? ['repeated_question_marks', 'called_out_bot', 'wants_human', 'threatening', 'insults', 'wants_bot_to_stop'][i] : null).filter(Boolean).join(', ')}`, ticketId, conversation, crmState, leadId);
    await writeCRMState(crmState, sha);
    const frustrationEvent = createMetricsEvent(ticketId, leadId, 'escalate', 'escalate_to_faysal', Date.now() - webhookStartTime, null, leadMeta.lead_quality_score || null, leadMeta.lead_quality_label || null, 'frustration_detected');
    return metricsResponse(res, 200, { ok: true, action: 'escalated', reason: 'frustration_detected' }, frustrationEvent);
  }

  // ── PRE-CLAUDE GUARD 3: Repetition / conversation wall detection ─────────
  // Analyse the conversation for repeated objections hitting the same wall.
  // If the lead has stated the same position 2+ times and the bot kept refusing,
  // inject a STRONG escalation signal into Claude's context (or force-escalate on 3+).
  let conversationWallContext = '';
  const botMessages = conversation.filter(m => (m.type || '').toUpperCase() === 'OUTBOUND' && !String(m.user_id || m.user?.id || '').match(/^(141332|340123|470168|315306|731578)$/));
  const leadMessages = conversation.filter(m => (m.type || '').toUpperCase() === 'INBOUND');
  // Count how many times the lead repeated the same price/request
  const leadPriceRequests = leadMessages.filter(m => {
    const txt = (m.body || m.text || m.message || '').toLowerCase();
    return /\b(5k|5,?000|5000|five thousand|same price|only.*k|only.*thousand)\b/i.test(txt) || /\b\d[,.]\d{3}\b/.test(txt);
  });
  const botPriceRefusals = botMessages.filter(m => {
    const txt = (m.body || m.text || m.message || '').toLowerCase();
    return /(lowest|can't do|cannot do|isn't something|not something|as low as)/i.test(txt);
  });
  const priceWallCount = Math.min(leadPriceRequests.length, botPriceRefusals.length);

  if (priceWallCount >= 3) {
    // 3+ rounds of the same wall — force escalation, the bot has failed
    console.log(`[auto-reply] Price negotiation wall (${priceWallCount} rounds) on ticket ${ticketId} — force escalation`);
    const holdingMsg = 'I hear you. Let me get my manager involved to see what we can work out.';
    const typingMs = Math.min(4000, Math.max(1500, holdingMsg.length * 30));
    await new Promise(r => setTimeout(r, typingMs));
    await postTrengoMessage(ticketId, holdingMsg);
    crmState[leadId].last_bot_reply_content = holdingMsg;
    await escalateTicket(leadName, leadMeta.listing_title, `Price negotiation wall — lead insisted ${leadPriceRequests.length}x, bot refused ${botPriceRefusals.length}x. Lead wants a lower price, bot cannot offer one. Needs human negotiation.`, ticketId, conversation, crmState, leadId);
    await writeCRMState(crmState, sha);
    const wallEvent = createMetricsEvent(ticketId, leadId, 'escalate', 'escalate_to_faysal', Date.now() - webhookStartTime, null, leadMeta.lead_quality_score || null, leadMeta.lead_quality_label || null, 'price_wall_' + priceWallCount);
    return metricsResponse(res, 200, { ok: true, action: 'escalated', reason: 'price_negotiation_wall' }, wallEvent);
  } else if (priceWallCount >= 2) {
    // 2 rounds — inject strong context telling Claude to escalate this time
    conversationWallContext = `\n\nCRITICAL — CONVERSATION WALL DETECTED: The lead has pushed back on the price ${leadPriceRequests.length} times and you have already refused ${botPriceRefusals.length} times. You are going in circles. DO NOT refuse the price again. DO NOT repeat that 6,500 is the lowest. You MUST use escalate_to_faysal now with reason "price negotiation — lead insists on lower price, needs human negotiation" and a warm holding message like "Let me get my manager involved to see what we can work out for you."`;
  }

  // ── PRE-CLAUDE GUARD 4: Courtesy goodbye — conversation is over, stop replying ──
  // If bot already said goodbye/farewell AND lead's new message is just a courtesy reply,
  // do NOT reply. Let the conversation close naturally.
  const courtesyPatterns = /^(thanks?|thank you|thx|ty|ok bye|bye|okay bye|cheers|you too|take care|no worries|no problem|have a good|good night|good day|👍|🙏|😊|👋|okay|ok|sure|alright|got it|noted|cool|great|perfect|will do|appreciate it|much appreciated)\.?!?\s*$/i;
  const lastBotReply = (leadMeta.last_bot_reply_content || '').toLowerCase();
  const botSaidGoodbye = /(good luck|all the best|take care|wish you|best of luck|happy to help|anytime|cheers|bye|farewell|have a great|if you ever need|don'?t hesitate|glad .* help|pleasure|was nice)/i.test(lastBotReply);
  const allPendingAreCourtesy = pendingTexts.length > 0 && pendingTexts.every(t => courtesyPatterns.test(t));

  if (botSaidGoodbye && allPendingAreCourtesy) {
    console.log(`[auto-reply] Courtesy goodbye on ticket ${ticketId} — bot already closed, lead sent "${pendingTexts.join('; ')}" — NOT replying`);
    const courtesyEvent = createMetricsEvent(ticketId, leadId, 'skipped', null, Date.now() - webhookStartTime, null, leadMeta.lead_quality_score || null, leadMeta.lead_quality_label || null, 'courtesy_goodbye');
    return metricsResponse(res, 200, { ok: true, skipped: 'courtesy_goodbye', dubaiHour }, courtesyEvent);
  }

  let { reply, escalate, reason, viewing, pendingViewing } = await generateReply(conversation, leadMeta, messageText, leadName, pendingInbound, false, '', conversationWallContext);

  // ── Self-critique gate — Sonnet reviews the reply before it reaches the lead ──
  // Only runs for normal replies (not escalations/viewings — those have their own logic)
  if (reply && !escalate && !viewing) {
    const { pass, finalReply, reason: criticReason } = await critiqueReply(reply, conversation, messageText, leadName);
    if (!pass && finalReply) {
      reply = finalReply;
    }
  }

  if (escalate) {
    if (reply) {
      // Simulate typing the holding message before sending
      const holdingDelay = Math.min(6000, Math.max(2000, reply.length * 30));
      await new Promise(r => setTimeout(r, holdingDelay));
      await postTrengoMessage(ticketId, reply);
      crmState[leadId].last_bot_reply_content = reply.trim(); // needed for bot-echo detection on OUTBOUND webhook
    }
    // Track viewing status in CRM so we don't re-escalate when lead confirms
    if (viewing) {
      crmState[leadId].viewing_status    = 'escalated';
      crmState[leadId].viewing_requested = viewing;
    }
    await escalateTicket(leadName, leadMeta.listing_title, reason, ticketId, conversation, crmState, leadId);
    await writeCRMState(crmState, sha);
    const escalateEvent = createMetricsEvent(ticketId, leadId, 'escalate', 'escalate_to_faysal', Date.now() - webhookStartTime, null, leadMeta.lead_quality_score || null, leadMeta.lead_quality_label || null, reason);
    return metricsResponse(res, 200, { ok: true, action: 'escalated', reason }, escalateEvent);
  }

  // Simulate human typing speed (~3 chars/sec on mobile WhatsApp)
  // 2s read time already elapsed above; now add typing time for the reply
  const typingMs = Math.min(10000, Math.max(3000, reply.length * 40)); // Capped at 10s to stay within Vercel 30s function limit
  await new Promise(r => setTimeout(r, typingMs));

  // ── Optimistic lock: re-read CRM to detect if another instance already replied ──
  // Two webhooks can arrive simultaneously, both pass cooldown, both generate replies.
  // By re-checking here (after delays + AI call), the slower one will see the faster
  // one already updated last_bot_reply_at and bail out instead of double-replying.
  try {
    const { state: freshCRM } = await readCRMState();
    const freshMeta = freshCRM[leadId];
    if (freshMeta) {
      const freshBotAt = freshMeta.last_bot_reply_at ? new Date(freshMeta.last_bot_reply_at).getTime() : 0;
      if (freshBotAt > lastBotAt) {
        console.log(`[auto-reply] OPTIMISTIC LOCK: another instance replied while we were generating. Bailing out.`);
        const lockEvent = createMetricsEvent(ticketId, leadId, 'skipped', null, Date.now() - webhookStartTime, null, leadMeta.lead_quality_score || null, leadMeta.lead_quality_label || null, 'optimistic_lock');
        return metricsResponse(res, 200, { ok: true, skipped: 'Optimistic lock — another instance replied first' }, lockEvent);
      }
      if (freshMeta.bot_paused) {
        console.log(`[auto-reply] OPTIMISTIC LOCK: bot was paused while generating. Bailing out.`);
        const pauseEvent = createMetricsEvent(ticketId, leadId, 'skipped', null, Date.now() - webhookStartTime, null, leadMeta.lead_quality_score || null, leadMeta.lead_quality_label || null, 'paused_during_generation');
        return metricsResponse(res, 200, { ok: true, skipped: 'Bot paused during generation' }, pauseEvent);
      }
    }
  } catch (e) {
    console.warn('[auto-reply] Optimistic lock check failed, proceeding anyway:', e?.message);
  }

  // ── Content similarity guard — never send same reply twice ──────────────────
  // Compares new reply to last bot message in conversation to catch semantic duplicates
  // that slip past the message-id dedup (different webhook events, same AI output)
  // Find the last OUTBOUND message sent by the bot (not by Faysal or other agents).
  // Bot messages have no user_id (or user_id 0/null); agent messages have a real user_id.
  const lastBotMsg = conversation
    .slice().reverse()
    .find(m => {
      if (m.type?.toUpperCase() !== 'OUTBOUND') return false;
      const uid = String(m.user_id || m.user?.id || '');
      // Bot messages have empty/0 user_id. Faysal = 141332, Afifa = 340123, etc.
      return !uid || uid === '0' || uid === '';
    });
  if (lastBotMsg) {
    const prev = (lastBotMsg.message || lastBotMsg.body || lastBotMsg.text || '').trim().toLowerCase();
    const curr = reply.trim().toLowerCase();
    // Strip punctuation/spaces for comparison
    const normalize = s => s.replace(/[\s\W]+/g, '');
    if (normalize(curr) === normalize(prev)) {
      console.log(`[auto-reply] Content similarity guard: reply identical to last bot message — skipping`);
      const dupReplyEvent = createMetricsEvent(ticketId, leadId, 'skipped', null, Date.now() - webhookStartTime, null, leadMeta.lead_quality_score || null, leadMeta.lead_quality_label || null, 'duplicate_content');
      return metricsResponse(res, 200, { ok: true, skipped: 'Identical reply to last bot message' }, dupReplyEvent);
    }
  }

  // ── Pre-send contamination gate — NEVER send a contaminated message to a lead ──
  // Last line of defence before anything reaches the customer.
  // If the final reply (after cleanMsg + critic) still contains self-critique, internal
  // reasoning, or any FAIL artifacts — block it hard and escalate instead.
  const PRESEND_BLOCK_PATTERNS = [
    /\bFAIL\b/,
    /wait,?\s+i (used|have|wrote|made)/i,
    /wait,?\s+let me/i,           // catches "wait, let me check that"
    /wait,?\s+no\s+(em|en)\s*dash/i, // catches "wait, no em dashes" self-talk leakage
    /no\s+(em|en)\s*dash/i,       // catches "no em dashes" anywhere
    /let me redo/i,
    /let me re-?write/i,
    /let me try again/i,
    /let me check (that|this|on that|on this)/i,
    /i (need to|should) (fix|correct|revise|rewrite)/i,
    /per the .+ rule/i,
    /according to (the|my) (playbook|instructions|rules)/i,
    /issues fixed/i,
    /\[ESCALATE/i,
    /\[VIEWING/i,
  ];
  const contaminationMatch = PRESEND_BLOCK_PATTERNS.find(p => p.test(reply));
  if (contaminationMatch) {
    console.error(`[auto-reply] PRE-SEND GATE BLOCKED reply on ticket ${ticketId} — pattern: ${contaminationMatch}`);
    await escalateTicket(
      leadName,
      leadMeta.listing_title || null,
      `Pre-send contamination detected (pattern: ${contaminationMatch}) — bot reply blocked before reaching customer`,
      ticketId, conversation, crmState, leadId
    );
    await writeCRMState(crmState, sha);
    return res.status(200).json({ ok: true, action: 'presend_gate_blocked' });
  }

  const sent = await postTrengoMessage(ticketId, reply);
  if (!sent) {
    console.error(`[auto-reply] postTrengoMessage FAILED on ticket ${ticketId} — escalating instead of going silent`);
    await escalateTicket(leadName, leadMeta.listing_title || null, 'Message delivery failed — Trengo API error', ticketId, conversation, crmState, leadId);
    await writeCRMState(crmState, sha);
    return res.status(200).json({ ok: true, action: 'send_failed_escalated' });
  }

  // ── CRITICAL: flush bot echo content to Redis IMMEDIATELY after sending ──────
  // Trengo fires an OUTBOUND webhook the instant we send. If that webhook arrives
  // before we write last_bot_reply_content, the echo comparison fails → bot treats
  // its own message as a Faysal manual reply → triggers 3-min agent cooldown →
  // lead's next message gets silently skipped. (Root cause of ticket 939283788.)
  // Writing to Redis here (~1ms) guarantees the OUTBOUND handler sees the correct
  // content even if it arrives during label attachment / scoring below.
  crmState[leadId].last_bot_reply_content = reply.trim();
  crmState[leadId].last_bot_reply_at      = new Date().toISOString();
  try {
    const redis = getLockRedis();
    if (redis) {
      await redis.set(`lead:${leadId}:echo`, reply.trim(), { ex: 120 }); // 2-min TTL, only for echo detection
      console.log(`[auto-reply] Flushed bot echo content to Redis for ${leadId}`);
    }
  } catch (e) {
    console.warn('[auto-reply] Redis echo flush failed (non-fatal):', e?.message);
  }

  // Viewing time confirmed — bot asked for ID (pendingViewing), store details + stay active
  // NOTE: viewing is always null when pendingViewing is set (intentional — old block must not fire)
  if (pendingViewing) {
    crmState[leadId].viewing_status       = 'pending_id';
    crmState[leadId].viewing_day          = pendingViewing.day;
    crmState[leadId].viewing_time         = pendingViewing.time;
    crmState[leadId].viewing_property     = pendingViewing.property;
    crmState[leadId].viewing_pending_since = new Date().toISOString();
    console.log(`[auto-reply] Viewing pending ID for ${leadName} — ${pendingViewing.day} at ${pendingViewing.time}`);
  }

  // On first bot reply: attach label + assign ticket to Faysal
  const isFirstBotReply = !leadMeta.bot_reply_count || leadMeta.bot_reply_count === 0;
  if (isFirstBotReply) {
    await attachTrengoLabel(ticketId, LABEL_LEAD);
    await assignTicket(ticketId, FAYSAL_USER_ID);
  }

  crmState[leadId].lead_replied              = true;
  crmState[leadId].lead_replied_at           = new Date().toISOString();
  crmState[leadId].last_bot_reply_at         = new Date().toISOString();
  crmState[leadId].last_bot_reply_content    = reply.trim(); // used to detect bot echo in OUTBOUND webhooks
  crmState[leadId].bot_reply_count           = (leadMeta.bot_reply_count || 0) + 1;
  if (incomingMsgId) crmState[leadId].last_processed_message_id = incomingMsgId;
  // Reset follow-up flags so cron can re-trigger if lead goes silent after this exchange
  crmState[leadId].unanswered_alert_sent     = false;

  // ── Lead quality scoring — update after every reply ───────────────────────
  const { score, label, signals } = scoreLeadQuality(conversation, leadMeta, messageText);
  const prevLabel = crmState[leadId].lead_quality_label || null;
  crmState[leadId].lead_quality_score  = score;
  crmState[leadId].lead_quality_label  = label;
  crmState[leadId].lead_quality_signals = signals;

  // Post internal note when lead first becomes WARM or HOT, or upgrades to HOT
  const upgraded = (label === 'HOT' && prevLabel !== 'HOT') ||
                   (label === 'WARM' && !prevLabel);
  if (upgraded) {
    const emoji = label === 'HOT' ? '🔥' : '🟡';
    await postTrengoNote(ticketId,
      `${emoji} Lead scored ${label} (${score}/100)\n` +
      `Signals: ${signals.join(', ')}\n` +
      `Property: ${leadMeta.listing_title || 'unknown'}\n— fäm Bot`
    );
    console.log(`[auto-reply] Lead ${leadName} scored ${label} (${score}) — internal note posted`);
  }

  // If viewing was team_responded and bot just replied normally (not escalating), mark confirmed
  if (leadMeta.viewing_status === 'team_responded') {
    crmState[leadId].viewing_status = 'confirmed';
    console.log(`[auto-reply] Viewing status → confirmed for ${leadName}`);
  }

  await writeCRMState(crmState, sha);

  // Emit metrics for successful reply
  const { score: finalScore, label: finalLabel } = scoreLeadQuality(conversation, crmState[leadId], messageText);
  const toolUsed = viewing ? 'book_viewing' : 'send_reply';
  const replyEvent = createMetricsEvent(ticketId, leadId, 'reply', toolUsed, Date.now() - webhookStartTime, null, finalScore || null, finalLabel || null, null);
  return metricsResponse(res, 200, { ok: true, action: 'replied', sent, dubaiHour, viewing: viewing || null }, replyEvent);
}
