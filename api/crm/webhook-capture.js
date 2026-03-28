// Capture endpoint — saves raw Trengo webhook payload to GitHub for inspection
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'POST') return res.status(200).json({ ok: true });

  const body = req.body;
  const headers = req.headers;

  const capture = {
    captured_at: new Date().toISOString(),
    method: req.method,
    query: req.query,
    headers: {
      'content-type': headers['content-type'],
      'x-trengo-signature': headers['x-trengo-signature'] || null,
      'x-hub-signature': headers['x-hub-signature'] || null,
      'user-agent': headers['user-agent'] || null,
    },
    body: body,
    raw_body_type: typeof body,
  };

  // Save to GitHub
  const GH_TOKEN = process.env.GH_TOKEN;
  const REPO = 'fam-pricing/fam-api';
  const FILE = 'data/webhook_capture.json';

  try {
    // Get current SHA if file exists
    let sha = null;
    try {
      const r = await fetch(`https://api.github.com/repos/${REPO}/contents/${FILE}`, {
        headers: { Authorization: `token ${GH_TOKEN}` }
      });
      if (r.ok) { const d = await r.json(); sha = d.sha; }
    } catch {}

    const payload = {
      message: 'capture: incoming Trengo webhook payload',
      content: btoa(unescape(encodeURIComponent(JSON.stringify(capture, null, 2)))),
      ...(sha ? { sha } : {})
    };

    await fetch(`https://api.github.com/repos/${REPO}/contents/${FILE}`, {
      method: 'PUT',
      headers: { Authorization: `token ${GH_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  } catch (e) {
    console.error('capture save failed:', e.message);
  }

  return res.status(200).json({ ok: true, captured: true });
}
