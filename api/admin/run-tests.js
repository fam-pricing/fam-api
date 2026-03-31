// fäm Living — GET /api/admin/run-tests?password=XXX
// Runs the 14-scenario bot simulation test suite and returns an HTML report.
// Password-protected with SYNC_PASSWORD env var.
// Each scenario calls Claude Sonnet with tool_use and validates the response.

const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';

const TOOLS = [
  {
    name: 'send_reply',
    description: 'Send a WhatsApp reply to the lead. Use this for ALL normal replies where you are confident in your answer.',
    input_schema: {
      type: 'object',
      properties: { message: { type: 'string' } },
      required: ['message'],
    },
  },
  {
    name: 'escalate_to_faysal',
    description: 'Escalate to Faysal when NOT confident, lead asks for a human, asks about long-term pricing beyond 3 months, or property is unknown.',
    input_schema: {
      type: 'object',
      properties: {
        reason: { type: 'string' },
        holding_message: { type: 'string' },
      },
      required: ['reason', 'holding_message'],
    },
  },
  {
    name: 'book_viewing',
    description: 'Book a viewing ONLY when lead gives a SPECIFIC day AND time.',
    input_schema: {
      type: 'object',
      properties: {
        property: { type: 'string' },
        day: { type: 'string' },
        time: { type: 'string' },
        confirmation_message: { type: 'string' },
      },
      required: ['property', 'day', 'time', 'confirmation_message'],
    },
  },
];

const TEST_PORTFOLIO = `
| Building | Beds | Area | Price/mo |
|----------|------|------|----------|
| Elite Residence | 1BR | Dubai Marina | AED 7,000 |
| Elite Residence | 2BR | Dubai Marina | AED 11,000 |
| MAG 318 | Studio | Business Bay | AED 5,500 |
| MAG 318 | 2BR | Business Bay | AED 9,500 |
| Executive Residences 2 | 1BR | Dubai Hills | AED 7,900 |
| Palm Tower | Studio | Palm Jumeirah | AED 8,000 |
| Trillionaire Residences | Studio | Business Bay | AED 5,500 |
`;

const SCENARIOS = [
  {
    name: 'Basic pricing question',
    property: '1BR in Elite Residence',
    history: 'Lead: Hi, how much is the 1BR?',
    newMessage: 'Hi, how much is the 1BR?',
    leadName: 'Ahmed',
    expect: { tool: 'send_reply', mustContain: ['7,000'], mustNotContain: ['ESCALATE', 'per the', 'according to'] },
  },
  {
    name: 'Vague viewing — no time given',
    property: '2BR in MAG 318',
    history: 'Bot: The 2BR at MAG 318 is AED 9,500/month all-inclusive.\nLead: Can I see the apartment?',
    newMessage: 'Can I see the apartment?',
    leadName: 'Sarah',
    expect: { tool: 'send_reply', mustContain: ['9am', '6pm'], mustNotContain: [] },
    note: 'Should ask for time, NOT book a viewing',
  },
  {
    name: 'Specific viewing — tomorrow 3pm',
    property: '1BR in Elite Residence',
    history: 'Bot: The 1BR at Elite Residence is AED 7,000/month.\nLead: Can I view tomorrow at 3pm?',
    newMessage: 'Can I view tomorrow at 3pm?',
    leadName: 'Mark',
    // Accept any time format: 3pm / 3:00 PM / 15:00 — bot called right tool, time is in the args
    expect: { tool: 'book_viewing', mustContain: ['tomorrow'], mustNotContain: ['let me check', 'let me confirm'] },
    note: 'Bot must call book_viewing and include tomorrow — accepts any time format (3pm / 3:00 PM)',
  },
  {
    name: 'Budget objection',
    property: 'Studio in Palm Tower',
    history: 'Bot: The studio at Palm Tower is AED 8,000/month all-inclusive.\nLead: That is too expensive for me',
    newMessage: 'That is too expensive for me',
    leadName: 'Fatima',
    expect: { tool: 'send_reply', mustContain: ['budget'], mustNotContain: ['8,000', '8000'] },
    note: 'Must NOT repeat the price after a budget objection',
  },
  {
    name: 'Lead asks to speak to a human',
    property: '1BR in Executive Residences 2',
    history: 'Lead: Can I speak to a real person?',
    newMessage: 'Can I speak to a real person?',
    leadName: 'James',
    expect: { tool: 'escalate_to_faysal', mustContain: [], mustNotContain: [] },
  },
  {
    name: 'Long-term pricing — 6 months (explain + escalate)',
    property: '1BR in Elite Residence',
    history: 'Bot: The 1BR is AED 7,000/month all-inclusive.\nLead: I want to stay for 6 months, what is the price?',
    newMessage: 'I want to stay for 6 months, what is the price?',
    leadName: 'Diana',
    expect: {
      tool: 'escalate_to_faysal',
      mustNotContain: ['42,000', '84,000', '84000'],
    },
    note: 'Bot must explain 3-month blocks then escalate. Must NOT multiply to total. escalate_to_faysal is correct for any 4+ month inquiry.',
  },
  {
    name: 'Unknown property — must escalate',
    property: 'unknown property (ref not in mapping)',
    history: 'Lead: Hi, is this still available?',
    newMessage: 'Hi, is this still available?',
    leadName: 'Ravi',
    expect: { tool: 'escalate_to_faysal', mustContain: [], mustNotContain: [] },
    note: 'Property is unknown — bot MUST escalate, not offer generic listings',
  },
  {
    name: 'Security deposit question only',
    property: 'Studio in MAG 318',
    history: 'Lead: What is the security deposit?',
    newMessage: 'What is the security deposit?',
    leadName: 'Lisa',
    expect: { tool: 'send_reply', mustContain: ['1,000'], mustNotContain: ['first month', 'last month', 'guarantee', '3,000', '5,000'] },
    note: 'Must answer security deposit only (AED 1,000 for studio) — NOT bundle GoA, NOT use old amounts',
  },
  {
    name: 'Hallucination trap — Aykon City',
    property: '1BR in Elite Residence',
    history: 'Bot: The 1BR at Elite Residence is available.\nLead: Do you have anything in Aykon City?',
    newMessage: 'Do you have anything in Aykon City?',
    leadName: 'Omar',
    expect: { tool: 'send_reply', mustNotContain: ['Aykon City is available', 'we have in Aykon'] },
    note: 'Must NOT hallucinate Aykon City as available',
  },
  {
    name: 'Viewing outside hours — 8pm',
    property: '2BR in Elite Residence',
    history: 'Lead: Can I view at 8pm today?',
    newMessage: 'Can I view at 8pm today?',
    leadName: 'Nina',
    expect: { tool: 'send_reply', mustContain: ['9am', '6pm'], mustNotContain: [] },
    note: 'Must NOT book — 8pm is outside viewing hours',
  },
  {
    name: 'No em dashes in reply',
    property: '1BR in Elite Residence',
    history: 'Lead: Tell me about the property',
    newMessage: 'Tell me about the property',
    leadName: 'Carlos',
    expect: { tool: 'send_reply', noDashes: true, mustNotContain: [] },
  },
  {
    name: 'Arabic message — must reply in Arabic',
    property: '1BR in Elite Residence',
    history: 'Lead: مرحبا، هل الشقة متاحة؟',
    newMessage: 'مرحبا، هل الشقة متاحة؟',
    leadName: 'خالد',
    expect: { tool: 'send_reply', arabicResponse: true, mustNotContain: [] },
  },
  {
    name: 'No quotes wrapping reply (ticket 938549183 regression)',
    property: '2BR in Elite Residence',
    history: 'Bot: The 2BR at Elite Residence is AED 11,000/month all-inclusive.\nLead: Is it available?',
    newMessage: 'Is it available?',
    leadName: 'Gabriela',
    expect: { tool: 'send_reply', noWrappingQuotes: true, mustNotContain: ['Issues fixed', 'FAIL', '**Rule'] },
    note: 'Message must NOT start/end with quote marks. No critic reasoning leaked.',
  },
  {
    name: 'Critic reasoning must not reach customer',
    property: 'Studio in MAG 318',
    history: 'Bot: Studio in MAG 318 is AED 5,500/month.\nLead: Can I pay monthly?',
    newMessage: 'Can I pay monthly?',
    leadName: 'Tom',
    expect: {
      tool: 'send_reply',
      noWrappingQuotes: true,
      mustNotContain: ['Issues fixed', '**Rule', 'FAIL\n', 'Let me re-check', 'Actually, re-reviewing', 'per the BUDGET rule', 'according to my instructions'],
    },
    note: 'Must not contain any internal reasoning, self-critique, or rule commentary in the reply.',
  },
];

function buildSystemPrompt(property) {
  return `# fäm Living — AI Lead Communication Playbook
You are a warm, human WhatsApp sales agent for fäm Living (Dubai holiday homes).

## Active fäm Living Portfolio (live prices):
${TEST_PORTFOLIO}

Property: ${property}.

RULES:
- ONLY suggest buildings from the Active Portfolio above. If not in the list, it is NOT available.
- CRITICAL — UNKNOWN PROPERTY: If the Property field contains the word "unknown", you MUST call escalate_to_faysal immediately. No exceptions. Do NOT call send_reply. Do NOT offer alternatives. Do NOT say we have availability. Escalate only.
- LONG-TERM PRICING: Prices are seasonal and only locked for 3 months. NEVER calculate or quote a total for more than 3 months. If asked about 4+ months, quote the current monthly rate, explain rates are confirmed in 3-month blocks, then escalate with reason "lead asking about long-term pricing beyond 3 months".
- CRITICAL — NO EMOJIS: Never use any emoji in any reply. No 😊 🏠 🔑 👍 or any other emoji. Zero. This is an absolute rule.
- No hallucination. Never invent details not in the portfolio.
- No em dashes (—) or en dashes (–). Use commas instead.
- Budget objection: ask "What budget are you working with?" Do NOT repeat the price.
- VIEWING RULES: NEVER proactively suggest, offer, or propose a viewing. Only discuss viewings if the lead explicitly asks to visit, see, or view the property. Viewings: 9am-6pm any day. Only call book_viewing with a SPECIFIC day AND time. If no time given, ask.
- If lead asks for a human or agent, escalate immediately.
- Damage security deposit: AED 1,000 for studio, AED 1,500 for 1 bedroom, AED 2,000 for 2 bedrooms and above. Only mention when asked. Do NOT mention first month/last month deposit.
- If lead writes in Arabic, respond in Arabic.
- All prices are all-inclusive (water, electricity, internet, no extras).
- You MUST call exactly one tool.`;
}

async function callClaude(apiKey, systemPrompt, userMessage) {
  const r = await fetch(ANTHROPIC_API, {
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
  if (!r.ok) throw new Error(`Anthropic ${r.status}: ${await r.text().catch(() => '')}`);
  return r.json();
}

function parseResponse(response) {
  const toolBlock = response?.content?.find(b => b.type === 'tool_use');
  if (!toolBlock) {
    const text = response?.content?.find(b => b.type === 'text')?.text || '';
    return { tool: null, args: {}, text };
  }
  const args = toolBlock.input || {};
  const text = args.message || args.holding_message || args.confirmation_message || '';
  return { tool: toolBlock.name, args, text };
}

function validate(scenario, result) {
  const failures = [];
  const { expect } = scenario;
  const { tool, args, text } = result;
  const allText = JSON.stringify(args).toLowerCase();

  if (expect.tool && tool !== expect.tool) {
    failures.push(`Wrong tool: expected <strong>${expect.tool}</strong>, got <strong>${tool || 'none'}</strong>`);
  }
  for (const phrase of (expect.mustContain || [])) {
    if (!allText.includes(phrase.toLowerCase())) {
      failures.push(`Missing expected phrase: "<em>${phrase}</em>"`);
    }
  }
  for (const phrase of (expect.mustNotContain || [])) {
    if (allText.includes(phrase.toLowerCase())) {
      failures.push(`Contains forbidden phrase: "<em>${phrase}</em>"`);
    }
  }
  if (expect.noDashes && (text.includes('\u2014') || text.includes('\u2013'))) {
    failures.push('Reply contains an em dash or en dash');
  }
  // Emoji check — applies to ALL customer-facing text (bot rules: no emojis ever)
  const emojiRegex = /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u;
  if (emojiRegex.test(text)) {
    failures.push('Reply contains an emoji (no emojis allowed per voice rules)');
  }
  if (expect.arabicResponse && !/[\u0600-\u06FF]/.test(text)) {
    failures.push('Expected Arabic reply but got English');
  }
  // Quote-wrapping check — message must not start/end with literal quote marks
  if (expect.noWrappingQuotes || true) {
    const trimmed = text.trim();
    if ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
        (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
      failures.push('Reply is wrapped in quote marks — bot is quoting itself instead of sending plain text');
    }
  }
  if (tool === 'book_viewing') {
    if (!args.day) failures.push('book_viewing: missing day');
    if (!args.time) failures.push('book_viewing: missing time');
    if (/tbd/i.test(args.time || '')) failures.push('book_viewing: time is TBD');
  }
  if (tool === 'escalate_to_faysal') {
    if (!args.reason) failures.push('escalation: missing reason');
    if (!args.holding_message) failures.push('escalation: missing holding_message');
  }
  // Reasoning leakage check — catch internal self-critique leaking into customer messages
  const leakPatterns = [
    /per the .+ rule/i,
    /according to (the|my) (playbook|instructions)/i,
    /the lead (has said|said|mentioned)/i,
    /issues fixed/i,
    /\*\*rule\s*\d/i,
    /let me re-?check/i,
    /actually,\s*re-?reviewing/i,
    /re-?reviewing my own/i,
    /critic(ism|al review)?:/i,
  ];
  for (const p of leakPatterns) {
    if (p.test(allText)) failures.push(`Reasoning leakage detected: matched pattern <em>${p}</em>`);
  }
  return failures;
}

function toolBadge(tool) {
  const colors = { send_reply: '#22c55e', escalate_to_faysal: '#f59e0b', book_viewing: '#3b82f6' };
  const color = colors[tool] || '#6b7280';
  return `<span style="background:${color};color:#000;padding:2px 8px;border-radius:12px;font-size:11px;font-weight:700;">${tool || 'none'}</span>`;
}

function renderHTML(results, elapsed) {
  const passed = results.filter(r => r.failures.length === 0).length;
  const failed = results.filter(r => r.failures.length > 0).length;
  const passRate = Math.round((passed / results.length) * 100);
  const avgMs = Math.round(results.reduce((s, r) => s + r.elapsed, 0) / results.length);

  const rows = results.map((r, i) => {
    const pass = r.failures.length === 0;
    const icon = pass ? '✓' : '✗';
    const rowColor = pass ? 'rgba(34,197,94,0.08)' : 'rgba(239,68,68,0.08)';
    const borderColor = pass ? '#22c55e' : '#ef4444';
    const failureHtml = r.failures.length
      ? `<div style="margin-top:8px;">${r.failures.map(f => `<div style="color:#fca5a5;font-size:12px;margin-top:3px;">✗ ${f}</div>`).join('')}</div>`
      : '';
    const replyPreview = r.result?.text
      ? `<div style="color:#94a3b8;font-size:12px;margin-top:6px;font-style:italic;">"${r.result.text.slice(0, 120)}${r.result.text.length > 120 ? '...' : ''}"</div>`
      : '';
    const note = r.scenario.note
      ? `<div style="color:#64748b;font-size:11px;margin-top:4px;">Note: ${r.scenario.note}</div>`
      : '';
    return `
      <div style="background:${rowColor};border-left:3px solid ${borderColor};border-radius:8px;padding:14px 16px;margin-bottom:10px;">
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
          <span style="color:${borderColor};font-weight:700;font-size:16px;width:20px;">${icon}</span>
          <span style="color:#e2e8f0;font-weight:600;">[${i + 1}] ${r.scenario.name}</span>
          ${toolBadge(r.result?.tool)}
          <span style="color:#64748b;font-size:12px;margin-left:auto;">${r.elapsed}ms</span>
        </div>
        ${note}${failureHtml}${replyPreview}
      </div>`;
  }).join('');

  const scoreColor = passRate === 100 ? '#22c55e' : passRate >= 75 ? '#f59e0b' : '#ef4444';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>fäm Bot — Test Results</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #0f172a; color: #e2e8f0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; padding: 24px; }
  h1 { color: #fbbf24; font-size: 24px; margin-bottom: 4px; }
  .subtitle { color: #64748b; font-size: 14px; margin-bottom: 24px; }
  .stats { display: flex; gap: 16px; flex-wrap: wrap; margin-bottom: 28px; }
  .stat { background: #1e293b; border-radius: 10px; padding: 16px 20px; min-width: 120px; }
  .stat-val { font-size: 28px; font-weight: 800; }
  .stat-label { color: #64748b; font-size: 12px; margin-top: 2px; }
  .results { max-width: 860px; }
</style>
</head>
<body>
<h1>fäm Bot — Test Results</h1>
<div class="subtitle">Run at ${new Date().toLocaleString('en-GB', { timeZone: 'Asia/Dubai' })} Dubai time · ${results.length} scenarios · ${(elapsed / 1000).toFixed(1)}s total</div>
<div class="stats">
  <div class="stat"><div class="stat-val" style="color:${scoreColor}">${passRate}%</div><div class="stat-label">Pass Rate</div></div>
  <div class="stat"><div class="stat-val" style="color:#22c55e">${passed}</div><div class="stat-label">Passed</div></div>
  <div class="stat"><div class="stat-val" style="color:#ef4444">${failed}</div><div class="stat-label">Failed</div></div>
  <div class="stat"><div class="stat-val" style="color:#94a3b8">${avgMs}ms</div><div class="stat-label">Avg Response</div></div>
</div>
<div class="results">${rows}</div>
</body>
</html>`;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const password = process.env.SYNC_PASSWORD;
  if (!password || req.query?.password !== password) {
    return res.status(401).send('Unauthorized — add ?password=YOUR_SYNC_PASSWORD to the URL');
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).send('ANTHROPIC_API_KEY not configured in Vercel env vars');

  const results = [];
  const suiteStart = Date.now();

  for (const scenario of SCENARIOS) {
    const systemPrompt = buildSystemPrompt(scenario.property);
    const userMessage = `Conversation so far:\n${scenario.history}\n\nLead just sent: "${scenario.newMessage}"`;
    const start = Date.now();
    try {
      const response = await callClaude(apiKey, systemPrompt, userMessage);
      const result = parseResponse(response);
      const failures = validate(scenario, result);
      results.push({ scenario, result, failures, elapsed: Date.now() - start });
    } catch (e) {
      results.push({
        scenario,
        result: { tool: null, args: {}, text: '' },
        failures: [`API error: ${e.message}`],
        elapsed: Date.now() - start,
      });
    }
  }

  const totalElapsed = Date.now() - suiteStart;
  res.setHeader('Content-Type', 'text/html');
  return res.status(200).send(renderHTML(results, totalElapsed));
}
