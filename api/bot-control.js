// fäm Living — GET /api/bot-control
// Trengo Custom Sidebar App — rendered as an iframe in the ticket sidebar.
// Trengo automatically appends ?ticket_id=XXX&auth_token=YYY to the configured URL.

const GH_API   = 'https://api.github.com';
const REPO     = 'fam-pricing/fam-api';
const CRM_FILE = 'data/crm_state.json';

async function readCRMState() {
  const ghToken = process.env.GH_TOKEN;
  if (!ghToken) return { state: {}, sha: null };
  const r = await fetch(`${GH_API}/repos/${REPO}/contents/${CRM_FILE}`, {
    headers: { Authorization: `Bearer ${ghToken}`, Accept: 'application/vnd.github.v3+json' },
  });
  if (!r.ok) return { state: {}, sha: null };
  const d = await r.json();
  try {
    return {
      state: JSON.parse(Buffer.from(d.content.replace(/\n/g, ''), 'base64').toString('utf8')),
      sha: d.sha,
    };
  } catch { return { state: {}, sha: d.sha }; }
}

export default async function handler(req, res) {
  const { ticket_id, auth_token } = req.query || {};

  // Validate auth token if configured
  const expectedToken = process.env.SIDEBAR_AUTH_TOKEN;
  if (expectedToken && auth_token !== expectedToken) {
    res.setHeader('Content-Type', 'text/html');
    return res.status(401).send('<body style="font-family:sans-serif;padding:16px;color:#e74c3c">Unauthorized</body>');
  }

  const ticketId = parseInt(ticket_id) || null;

  // Load CRM
  const { state: crmState } = await readCRMState();
  const leadId   = ticketId
    ? Object.keys(crmState).find(k => String(crmState[k].trengo_ticket_id) === String(ticketId))
    : null;
  const lead     = leadId ? crmState[leadId] : null;

  const leadName   = lead?.lead_name   || 'Unknown';
  const isPaused   = lead?.bot_paused  || false;
  const pauseReason= lead?.bot_paused_reason || '';
  const botReplies = lead?.bot_reply_count   || 0;
  const lastReplyRaw = lead?.last_bot_reply_at;
  const lastReply  = lastReplyRaw
    ? new Date(lastReplyRaw).toLocaleString('en-GB', { timeZone: 'Asia/Dubai', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
    : 'Never';

  const inCRM      = !!lead;
  const statusColor= !inCRM ? '#aaa' : isPaused ? '#e74c3c' : '#27ae60';
  const statusText = !inCRM ? 'Not in CRM' : isPaused ? 'PAUSED' : 'ACTIVE';
  const btnColor   = isPaused ? '#27ae60' : '#e74c3c';
  const btnLabel   = isPaused ? '▶ Resume Bot' : '⏸ Pause Bot';
  const btnAction  = isPaused ? 'resume' : 'pause';

  // The toggle-bot endpoint URL (same origin as this page)
  const toggleUrl  = '/api/crm/toggle-bot';

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#fff;padding:14px;color:#222;font-size:13px;line-height:1.4}
  h3{font-size:13px;font-weight:700;margin-bottom:10px;color:#111}
  .badge{display:inline-block;padding:3px 10px;border-radius:20px;font-size:11px;font-weight:700;color:#fff;letter-spacing:.3px;margin-bottom:12px;background:${statusColor}}
  .row{display:flex;justify-content:space-between;align-items:center;margin-bottom:5px}
  .lbl{color:#888;font-size:11px}
  .val{font-size:11px;font-weight:600;color:#333;text-align:right;max-width:60%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .reason{background:#fff8e1;border-left:3px solid #f39c12;border-radius:0 6px 6px 0;padding:8px 10px;margin:10px 0;font-size:11px;color:#7d5a00}
  .input{width:100%;padding:7px 9px;border:1px solid #ddd;border-radius:7px;font-size:12px;margin-top:10px;outline:none;color:#333}
  .input:focus{border-color:#3498db}
  .btn{width:100%;margin-top:8px;padding:9px;border:none;border-radius:8px;font-size:13px;font-weight:700;cursor:pointer;color:#fff;background:${btnColor};transition:opacity .15s}
  .btn:hover{opacity:.88}
  .btn:disabled{opacity:.45;cursor:not-allowed}
  .success{margin-top:8px;font-size:12px;color:#27ae60;display:none;text-align:center}
  .error{margin-top:8px;font-size:12px;color:#e74c3c;display:none;text-align:center}
  .no-crm{background:#f8f9fa;border:1px solid #e9ecef;border-radius:10px;padding:14px;text-align:center;color:#6c757d}
  .no-crm .icon{font-size:24px;margin-bottom:6px}
  .divider{border:none;border-top:1px solid #f0f0f0;margin:12px 0}
</style>
</head>
<body>
${!inCRM ? `
<div class="no-crm">
  <div class="icon">🤖</div>
  <strong style="font-size:12px">Ticket #${ticketId || '?'}</strong><br>
  <span style="font-size:11px;margin-top:4px;display:block">This conversation is not in the fäm Bot CRM. Bot is not active here.</span>
</div>
` : `
<h3>🤖 fäm Bot Control</h3>
<span class="badge">${statusText}</span>

<div class="row"><span class="lbl">Lead</span><span class="val">${leadName}</span></div>
<div class="row"><span class="lbl">Bot replies sent</span><span class="val">${botReplies}</span></div>
<div class="row"><span class="lbl">Last reply</span><span class="val">${lastReply}</span></div>

${isPaused && pauseReason ? `<div class="reason">⏸ ${pauseReason}</div>` : '<hr class="divider">'}

${!isPaused ? `<input class="input" id="reason" placeholder="Pause reason (optional)" maxlength="100" />` : ''}

<button class="btn" id="btn" onclick="toggle()">${btnLabel}</button>
<div class="success" id="success">✅ Done! Reloading...</div>
<div class="error" id="err">❌ Something went wrong. Try again.</div>

<script>
async function toggle() {
  const btn = document.getElementById('btn');
  const success = document.getElementById('success');
  const err = document.getElementById('err');
  const reasonEl = document.getElementById('reason');
  const reason = reasonEl ? reasonEl.value.trim() : '';

  btn.disabled = true;
  btn.textContent = 'Updating...';
  err.style.display = 'none';

  try {
    const r = await fetch('${toggleUrl}', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ticket_id: ${ticketId},
        action: '${btnAction}',
        reason: reason || (${isPaused} ? 'Manually resumed via sidebar' : 'Manually paused via sidebar'),
        auth_token: '${auth_token || ''}'
      })
    });
    const d = await r.json();
    if (d.ok) {
      success.style.display = 'block';
      setTimeout(() => location.reload(), 1200);
    } else {
      throw new Error(d.error || 'Failed');
    }
  } catch(e) {
    btn.textContent = '${btnLabel}';
    btn.disabled = false;
    err.style.display = 'block';
  }
}
</script>
`}
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('X-Frame-Options', 'ALLOWALL');
  res.setHeader('Content-Security-Policy', "frame-ancestors *;");
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).send(html);
}
