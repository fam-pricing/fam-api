// fäm Living — GET /api/admin/metrics
// Admin dashboard API endpoint for bot observability metrics
// Password-protected using SYNC_PASSWORD env var (same as sync endpoint)

const GH_API = 'https://api.github.com';
const REPO = 'fam-pricing/fam-api';
const METRICS_FILE = 'data/bot_metrics.json';
const CRM_FILE = 'data/crm_state.json';

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

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  // Password protection — same as sync endpoint
  const SYNC_PASSWORD = process.env.SYNC_PASSWORD || '';
  const providedPassword = req.query?.password || '';
  if (SYNC_PASSWORD && providedPassword !== SYNC_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    // Load metrics and CRM state
    const { data: metrics } = await ghRead(METRICS_FILE);
    const { data: crmState } = await ghRead(CRM_FILE);

    const metricsArray = Array.isArray(metrics) ? metrics : [];
    const crm = crmState || {};

    // Compute today's date (Dubai time: UTC+4)
    const nowDubai = new Date(Date.now() + 4 * 3600_000);
    const todayStr = nowDubai.toISOString().slice(0, 10);

    // Helper: group metrics by date
    function getDateStr(ts) {
      try {
        const d = new Date(ts);
        return new Date(d.getTime() + 4 * 3600_000).toISOString().slice(0, 10);
      } catch { return null; }
    }

    // ── Today's KPIs ──────────────────────────────────────────────────────────
    const todayMetrics = metricsArray.filter(m => getDateStr(m.ts) === todayStr);
    const messages_handled = todayMetrics.filter(m => m.action === 'reply').length;
    const escalations = todayMetrics.filter(m => m.action === 'escalate').length;
    const viewings = todayMetrics.filter(m => m.action === 'reply' && m.tool_used === 'book_viewing').length;
    const errors = todayMetrics.filter(m => m.action === 'error').length;
    const responseTimes = todayMetrics.filter(m => m.response_time_ms != null).map(m => m.response_time_ms);
    const avg_response_time_ms = responseTimes.length > 0
      ? Math.round(responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length)
      : 0;
    const criticRewrites = todayMetrics.filter(m => m.critic_pass === false).length;
    const critic_rewrite_rate = messages_handled > 0 ? ((criticRewrites / messages_handled) * 100).toFixed(2) : '0.00';

    // ── Last 7 days trend ─────────────────────────────────────────────────────
    const last_7_days = {};
    for (let i = 6; i >= 0; i--) {
      const d = new Date(nowDubai.getTime() - i * 86400_000);
      const dateStr = d.toISOString().slice(0, 10);
      const dayMetrics = metricsArray.filter(m => getDateStr(m.ts) === dateStr);
      const dayMsgs = dayMetrics.filter(m => m.action === 'reply').length;
      const dayEsc = dayMetrics.filter(m => m.action === 'escalate').length;
      const dayErr = dayMetrics.filter(m => m.action === 'error').length;
      const dayRTs = dayMetrics.filter(m => m.response_time_ms != null).map(m => m.response_time_ms);
      const dayAvgRT = dayRTs.length > 0 ? Math.round(dayRTs.reduce((a, b) => a + b, 0) / dayRTs.length) : 0;

      last_7_days[dateStr] = {
        messages: dayMsgs,
        escalations: dayEsc,
        errors: dayErr,
        avg_response_time_ms: dayAvgRT,
      };
    }

    // ── Lead funnel from CRM state ────────────────────────────────────────────
    let hot = 0, warm = 0, cool = 0, cold = 0;
    for (const leadId of Object.keys(crm)) {
      const label = crm[leadId].lead_quality_label;
      if (label === 'HOT') hot++;
      else if (label === 'WARM') warm++;
      else if (label === 'COOL') cool++;
      else if (label === 'COLD') cold++;
    }
    const total_leads = Object.keys(crm).length;
    const lead_funnel = { total_leads, hot, warm, cool, cold };

    // ── Tool usage breakdown ──────────────────────────────────────────────────
    const tool_usage = {
      send_reply: metricsArray.filter(m => m.tool_used === 'send_reply').length,
      escalate_to_faysal: metricsArray.filter(m => m.tool_used === 'escalate_to_faysal').length,
      book_viewing: metricsArray.filter(m => m.tool_used === 'book_viewing').length,
    };

    // ── Top escalation reasons ────────────────────────────────────────────────
    const escalationReasons = {};
    metricsArray
      .filter(m => m.action === 'escalate' && m.skip_reason)
      .forEach(m => {
        escalationReasons[m.skip_reason] = (escalationReasons[m.skip_reason] || 0) + 1;
      });
    const top_escalation_reasons = Object.entries(escalationReasons)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([reason, count]) => ({ reason, count }));

    return res.status(200).json({
      today: {
        messages_handled,
        escalations,
        viewings,
        avg_response_time_ms,
        error_count: errors,
        critic_rewrite_rate: parseFloat(critic_rewrite_rate),
      },
      last_7_days,
      lead_funnel,
      tool_usage,
      top_escalation_reasons,
      metadata: {
        total_metrics_events: metricsArray.length,
        metrics_file_size: JSON.stringify(metricsArray).length,
      },
    });

  } catch (err) {
    console.error('[metrics]', err);
    return res.status(500).json({ error: err.message });
  }
}
