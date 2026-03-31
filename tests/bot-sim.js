#!/usr/bin/env node
// fäm Living — Bot Conversation Simulation Test Suite
// Tests bot response quality by sending simulated conversations to Claude
// and validating structured tool_use output.
//
// Usage:
//   ANTHROPIC_API_KEY=sk-... node tests/bot-sim.js
//   ANTHROPIC_API_KEY=sk-... node tests/bot-sim.js --scenario 3
//
// Each scenario simulates a real lead conversation and validates:
//   1. Correct tool called (send_reply / escalate_to_faysal / book_viewing)
//   2. No reasoning leakage in customer-facing text
//   3. No em dashes or en dashes
//   4. No hallucinated properties or prices
//   5. Appropriate escalation triggers
//   6. Viewing booking only with specific times

const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';

// ── Tool definitions (must match auto-reply.js exactly) ──────────────────────

const TOOLS = [
  {
    name: 'send_reply',
    description: 'Send a WhatsApp reply to the lead. Use this for ALL normal replies where you are confident in your answer.',
    input_schema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'The WhatsApp message to send to the lead.' },
      },
      required: ['message'],
    },
  },
  {
    name: 'escalate_to_faysal',
    description: 'Escalate to Faysal when you are NOT confident, the lead asks to speak to a human, asks about long-term pricing beyond 3 months, or you cannot identify the property.',
    input_schema: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'Internal reason for escalation.' },
        holding_message: { type: 'string', description: 'Short message to send to the lead while Faysal takes over.' },
      },
      required: ['reason', 'holding_message'],
    },
  },
  {
    name: 'book_viewing',
    description: 'Book a property viewing ONLY when the lead has given a SPECIFIC day AND time.',
    input_schema: {
      type: 'object',
      properties: {
        property: { type: 'string', description: 'The property for the viewing.' },
        day: { type: 'string', description: 'The day of the viewing.' },
        time: { type: 'string', description: 'The specific time.' },
        confirmation_message: { type: 'string', description: 'Warm confirmation to the lead.' },
      },
      required: ['property', 'day', 'time', 'confirmation_message'],
    },
  },
];

// ── Test portfolio (subset of real listings) ─────────────────────────────────

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

// ── Test scenarios ───────────────────────────────────────────────────────────

const SCENARIOS = [
  {
    name: 'Basic pricing question',
    property: '1BR in Elite Residence',
    history: 'Lead: Hi, how much is the 1BR?',
    newMessage: 'Hi, how much is the 1BR?',
    leadName: 'Ahmed',
    expect: {
      tool: 'send_reply',
      mustContain: ['7,000', 'AED'],
      mustNotContain: ['ESCALATE', 'VIEWING', 'per the', 'according to'],
    },
  },
  {
    name: 'Vague viewing request (no time)',
    property: '2BR in MAG 318',
    history: 'Bot: Hi! The 2BR at MAG 318 is AED 9,500/month all-inclusive.\nLead: Can I see the apartment?',
    newMessage: 'Can I see the apartment?',
    leadName: 'Sarah',
    expect: {
      tool: 'send_reply', // should NOT book_viewing — no specific time given
      mustContain: ['9am', '6pm'],
      mustNotContain: [],
    },
  },
  {
    name: 'Specific viewing request',
    property: '1BR in Elite Residence',
    history: 'Bot: The 1BR at Elite Residence is AED 7,000/month all-inclusive.\nLead: Can I view tomorrow at 3pm?',
    newMessage: 'Can I view tomorrow at 3pm?',
    leadName: 'Mark',
    expect: {
      tool: 'book_viewing',
      mustContain: ['3pm', 'tomorrow'],
      mustNotContain: ['let me check', 'let me confirm'],
    },
  },
  {
    name: 'Budget objection',
    property: 'Studio in Palm Tower',
    history: 'Bot: The studio at Palm Tower is AED 8,000/month all-inclusive.\nLead: That is too expensive for me',
    newMessage: 'That is too expensive for me',
    leadName: 'Fatima',
    expect: {
      tool: 'send_reply',
      mustContain: ['budget'],
      mustNotContain: ['8,000', '8000'], // should NOT repeat the price
    },
  },
  {
    name: 'Human agent request',
    property: '1BR in Executive Residences 2',
    history: 'Lead: Can I speak to a real person?',
    newMessage: 'Can I speak to a real person?',
    leadName: 'James',
    expect: {
      tool: 'escalate_to_faysal',
      mustContain: ['human', 'agent'],
      mustNotContain: [],
    },
  },
  {
    name: 'Long-term pricing (12 months)',
    property: '1BR in Elite Residence',
    history: 'Bot: The 1BR is AED 7,000/month.\nLead: What would 12 months cost?',
    newMessage: 'What would 12 months cost?',
    leadName: 'Diana',
    expect: {
      tool: 'escalate_to_faysal',
      mustContain: ['3-month', '3 month'],
      mustNotContain: ['84,000', '84000'], // must NOT multiply 7000 x 12
    },
  },
  {
    name: 'Unknown property (should escalate)',
    property: 'unknown property (ref not in mapping)',
    history: 'Lead: Hi, is this still available?',
    newMessage: 'Hi, is this still available?',
    leadName: 'Ravi',
    expect: {
      tool: 'escalate_to_faysal',
      mustContain: [],
      mustNotContain: [],
    },
  },
  {
    name: 'Deposit question (security only)',
    property: 'Studio in MAG 318',
    history: 'Lead: What is the security deposit?',
    newMessage: 'What is the security deposit?',
    leadName: 'Lisa',
    expect: {
      tool: 'send_reply',
      mustContain: ['3,000'],
      mustNotContain: ['first month', 'last month', 'guarantee'], // should NOT bundle GoA
    },
  },
  {
    name: 'Hallucination trap (non-existent building)',
    property: '1BR in Elite Residence',
    history: 'Bot: The 1BR at Elite Residence is available.\nLead: Do you have anything in Aykon City?',
    newMessage: 'Do you have anything in Aykon City?',
    leadName: 'Omar',
    expect: {
      tool: 'send_reply',
      mustNotContain: ['Aykon City is available', 'we have.*Aykon'],
      mustNotHallucinate: true, // should say it's not available or redirect
    },
  },
  {
    name: 'Viewing outside hours (8pm)',
    property: '2BR in Elite Residence',
    history: 'Lead: Can I view at 8pm today?',
    newMessage: 'Can I view at 8pm today?',
    leadName: 'Nina',
    expect: {
      tool: 'send_reply', // should NOT book_viewing — outside 9am-6pm
      mustContain: ['9am', '6pm'],
      mustNotContain: [],
    },
  },
  {
    name: 'No em dashes in reply',
    property: '1BR in Elite Residence',
    history: 'Lead: Tell me about the property',
    newMessage: 'Tell me about the property',
    leadName: 'Carlos',
    expect: {
      tool: 'send_reply',
      noDashes: true,
      mustNotContain: [],
    },
  },
  {
    name: 'Arabic language match',
    property: '1BR in Elite Residence',
    history: 'Lead: مرحبا، هل الشقة متاحة؟',
    newMessage: 'مرحبا، هل الشقة متاحة؟',
    leadName: 'خالد',
    expect: {
      tool: 'send_reply',
      mustContain: [],
      mustNotContain: [],
      arabicResponse: true, // reply should be in Arabic
    },
  },
];

// ── System prompt builder (minimal version for testing) ──────────────────────

function buildSystemPrompt(property) {
  return `# fäm Living — AI Lead Communication Playbook
You are a warm, human WhatsApp sales agent for fäm Living (Dubai holiday homes).

## Active fäm Living Portfolio (live prices):
${TEST_PORTFOLIO}

Property: ${property}.

RULES:
- ONLY suggest buildings from the Active Portfolio above. If not in the list, it is NOT available.
- If Property says "unknown property", escalate. Do not guess.
- No hallucination. Never invent details.
- Keep it short, warm, human. No em dashes or en dashes.
- Budget objection: ask "What budget are you working with?" Do not repeat the price.
- Long-term pricing (4+ months): quote monthly rate, explain 3-month blocks, escalate.
- Viewings: 9am-6pm any day. Only call book_viewing with a SPECIFIC day AND time.
- If lead asks for a human/agent, escalate immediately.
- Deposit: AED 3,000 for studio/1BR, AED 5,000 for 2BR+. Only mention when asked about security/damage deposit.
- If lead writes in Arabic, respond in Arabic.
- Never repeat yourself.
- All prices are all-inclusive (water, electricity, internet).

You MUST call exactly one tool.`;
}

// ── Call Claude ───────────────────────────────────────────────────────────────

async function callClaude(systemPrompt, userMessage) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

  const r = await fetch(ANTHROPIC_API, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
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
    throw new Error(`Anthropic ${r.status}: ${err}`);
  }

  return r.json();
}

// ── Parse response ───────────────────────────────────────────────────────────

function parseResponse(response) {
  const toolBlock = response?.content?.find(b => b.type === 'tool_use');
  if (!toolBlock) {
    const textBlock = response?.content?.find(b => b.type === 'text');
    return { tool: null, args: {}, text: textBlock?.text || '', raw: response };
  }
  return {
    tool: toolBlock.name,
    args: toolBlock.input || {},
    text: toolBlock.input?.message || toolBlock.input?.holding_message || toolBlock.input?.confirmation_message || '',
    raw: response,
  };
}

// ── Validate scenario ────────────────────────────────────────────────────────

function validate(scenario, result) {
  const failures = [];
  const { expect } = scenario;
  const { tool, args, text } = result;
  const allText = JSON.stringify(args).toLowerCase();

  // 1. Correct tool
  if (expect.tool && tool !== expect.tool) {
    failures.push(`Wrong tool: expected ${expect.tool}, got ${tool}`);
  }

  // 2. Must contain
  for (const phrase of (expect.mustContain || [])) {
    // Support regex-like patterns with .*
    if (phrase.includes('.*')) {
      const regex = new RegExp(phrase, 'i');
      if (!regex.test(allText)) {
        failures.push(`Missing expected pattern: "${phrase}"`);
      }
    } else if (!allText.includes(phrase.toLowerCase())) {
      failures.push(`Missing expected phrase: "${phrase}"`);
    }
  }

  // 3. Must NOT contain
  for (const phrase of (expect.mustNotContain || [])) {
    if (phrase.includes('.*')) {
      const regex = new RegExp(phrase, 'i');
      if (regex.test(allText)) {
        failures.push(`Contains forbidden pattern: "${phrase}"`);
      }
    } else if (allText.includes(phrase.toLowerCase())) {
      failures.push(`Contains forbidden phrase: "${phrase}"`);
    }
  }

  // 4. No em/en dashes
  if (expect.noDashes) {
    if (text.includes('\u2014') || text.includes('\u2013')) {
      failures.push('Contains em dash or en dash');
    }
  }

  // 5. Arabic response check
  if (expect.arabicResponse) {
    const hasArabic = /[\u0600-\u06FF]/.test(text);
    if (!hasArabic) {
      failures.push('Expected Arabic response but got English');
    }
  }

  // 6. Structural validation for book_viewing
  if (tool === 'book_viewing') {
    if (!args.day) failures.push('book_viewing missing day');
    if (!args.time) failures.push('book_viewing missing time');
    if (!args.property) failures.push('book_viewing missing property');
    if (/tbd/i.test(args.time || '')) failures.push('book_viewing has TBD time');
  }

  // 7. Structural validation for escalate_to_faysal
  if (tool === 'escalate_to_faysal') {
    if (!args.reason) failures.push('escalation missing reason');
    if (!args.holding_message) failures.push('escalation missing holding_message');
  }

  // 8. No reasoning leakage
  const leakPatterns = [
    /per the .+ rule/i,
    /according to (the|my) (playbook|instructions|rules)/i,
    /the lead (has said|said|mentioned)/i,
    /looking at the conversation/i,
    /based on the conversation/i,
    /as per my instructions/i,
  ];
  for (const pattern of leakPatterns) {
    if (pattern.test(text)) {
      failures.push(`Reasoning leakage detected: ${pattern}`);
    }
  }

  return failures;
}

// ── Main runner ──────────────────────────────────────────────────────────────

async function runScenario(scenario, index) {
  const systemPrompt = buildSystemPrompt(scenario.property);
  const userMessage = `Conversation so far:\n${scenario.history}\n\nLead just sent: "${scenario.newMessage}"`;

  const start = Date.now();
  const response = await callClaude(systemPrompt, userMessage);
  const elapsed = Date.now() - start;

  const result = parseResponse(response);
  const failures = validate(scenario, result);

  return { scenario, result, failures, elapsed };
}

async function main() {
  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  fäm Living Bot — Conversation Simulation Tests');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');

  // Parse --scenario flag
  const scenarioArg = process.argv.find(a => a.startsWith('--scenario'));
  const specificScenario = scenarioArg ? parseInt(scenarioArg.split('=')[1] || process.argv[process.argv.indexOf(scenarioArg) + 1]) : null;

  const scenarios = specificScenario
    ? [SCENARIOS[specificScenario - 1]].filter(Boolean)
    : SCENARIOS;

  if (!scenarios.length) {
    console.error(`Scenario ${specificScenario} not found. Available: 1-${SCENARIOS.length}`);
    process.exit(1);
  }

  let passed = 0;
  let failed = 0;
  let totalTime = 0;

  for (let i = 0; i < scenarios.length; i++) {
    const s = scenarios[i];
    const num = specificScenario || (i + 1);

    process.stdout.write(`  [${num}/${SCENARIOS.length}] ${s.name} ... `);

    try {
      const { result, failures, elapsed } = await runScenario(s, i);
      totalTime += elapsed;

      if (failures.length === 0) {
        console.log(`✓ PASS (${elapsed}ms) → ${result.tool}(${result.text.slice(0, 60)}...)`);
        passed++;
      } else {
        console.log(`✗ FAIL (${elapsed}ms) → ${result.tool}`);
        for (const f of failures) {
          console.log(`      ✗ ${f}`);
        }
        if (result.text) {
          console.log(`      Reply: "${result.text.slice(0, 120)}..."`);
        }
        failed++;
      }
    } catch (e) {
      console.log(`✗ ERROR: ${e.message}`);
      failed++;
    }
  }

  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  Results: ${passed} passed, ${failed} failed, ${scenarios.length} total`);
  console.log(`  Total time: ${(totalTime / 1000).toFixed(1)}s (avg ${Math.round(totalTime / scenarios.length)}ms/scenario)`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
