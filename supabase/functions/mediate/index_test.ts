const originalServe = Deno.serve;
Object.defineProperty(Deno, 'serve', { configurable: true, value: () => ({}) });
const { handleRequest } = await import('./index.ts');
Object.defineProperty(Deno, 'serve', { configurable: true, value: originalServe });

const caseId = '00000000-0000-0000-0000-000000000001';
const userId = '00000000-0000-0000-0000-000000000002';
const requestId = '00000000-0000-0000-0000-000000000003';
const result = {
  summary: 'Počujem, že situácia je náročná.',
  pace_status: 'active',
  safety_alert: false,
  detected_patterns: ['Obviňovanie'],
  participant_perspectives: [{ name: 'Anna', underlying_need: 'Vypočutie' }],
  suggested_reframe: 'Potrebujem, aby sme sa vypočuli.',
  agreement_proposal: null as string | null,
  updated_memory: { facts: ['Dohodli si rozhovor'], open_questions: ['Kedy?'] },
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

type MockOptions = {
  missingMember?: boolean;
  invalidUser?: boolean;
  retryAfter?: number;
  result?: unknown;
  publishError?: boolean;
};

async function run(
  body: Record<string, unknown>,
  options: MockOptions = {},
): Promise<{ response: Response; calls: { url: URL; body: unknown }[] }> {
  const originalFetch = globalThis.fetch;
  const calls: { url: URL; body: unknown }[] = [];
  Deno.env.set('SUPABASE_URL', 'https://supabase.example');
  Deno.env.set('SUPABASE_ANON_KEY', 'anon-key');
  Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', 'service-key');
  Deno.env.set('GEMINI_API_KEY', 'gemini-key');
  globalThis.fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const data = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ url, body: data });
    const json = (value: unknown, status = 200) =>
      Promise.resolve(new Response(JSON.stringify(value), {
        status, headers: { 'Content-Type': 'application/json' },
      }));
    switch (url.pathname) {
      case '/auth/v1/user':
        return options.invalidUser ? json({ message: 'Invalid JWT' }, 401) : json({ id: userId });
      case '/rest/v1/conflict_cases':
        return json({
          title: 'Prípad', participants: ['Anna', 'Boris'], phase: 'intake',
          case_memory: { facts: [], needs: {}, open_questions: [] }, pace_status: 'calm',
        });
      case '/rest/v1/case_members':
        return json(options.missingMember ? null : { participant_name: 'Anna' });
      case '/rest/v1/rpc/reserve_mediator_request':
        return json({ retry_after: options.retryAfter ?? 0, request_id: requestId });
      case '/rest/v1/chat_messages':
        return json([{ sender_name: 'Anna', message: 'Ahoj', message_type: 'chat' }]);
      case '/v1beta/models/gemini-2.5-flash:generateContent':
        return json({
          candidates: [{
            finishReason: 'STOP',
            content: { parts: [{ text: JSON.stringify(options.result ?? result) }] },
          }],
        });
      case '/rest/v1/rpc/publish_mediator_result':
        return options.publishError ? json({ code: 'P0001', message: 'failed' }, 400) : json(null);
      default:
        throw new Error(`Unexpected request: ${url}`);
    }
  };
  try {
    const response = await handleRequest(new Request('https://function.example', {
      method: 'POST',
      headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }));
    return { response, calls };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

Deno.test('private coaching returns the result without publishing private content', async () => {
  const { response, calls } = await run({
    caseId, action: 'private_coach', mode: 'reframe', draftMessage: 'Súkromný koncept',
  });
  const data = await response.json();
  assert(response.status === 200 && data.coaching.summary === result.summary, 'Missing coaching');
  assert(!calls.some((call) => call.url.pathname.endsWith('publish_mediator_result')), 'Published private content');
  const history = calls.find((call) => call.url.pathname === '/rest/v1/chat_messages');
  assert(history?.url.searchParams.get('case_id') === `eq.${caseId}`, 'History is not case scoped');
  const gemini = calls.find((call) => call.url.hostname === 'generativelanguage.googleapis.com');
  assert(JSON.stringify(gemini?.body).includes('Súkromný koncept'), 'Draft missing from prompt');
  assert(JSON.stringify(gemini?.body).includes('účastníkom vykaj'), 'Formal address missing from prompt');
});

Deno.test('public agreement is published as the validated structured result', async () => {
  const proposal = { ...result, agreement_proposal: 'Stretneme sa v pondelok.' };
  const { response, calls } = await run({ caseId, action: 'mediate', mode: 'agreement' }, { result: proposal });
  assert(response.status === 200, 'Public result failed');
  const publish = calls.find((call) => call.url.pathname.endsWith('publish_mediator_result'));
  assert(JSON.stringify(publish?.body).includes(proposal.agreement_proposal), 'Proposal not published');
  assert(JSON.stringify(publish?.body).includes('"pace_status":"active"'), 'Pace not published');
  const automatic = await run({ caseId, action: 'mediate', mode: 'auto' }, { result: proposal });
  assert(automatic.response.status === 200, 'Auto mode could not propose an agreement');
});

Deno.test('invalid model output and unexpected proposals are not published', async () => {
  for (const invalid of [
    { ...result, pace_status: 'urgent' },
    { ...result, safety_alert: 'true' },
    { ...result, agreement_proposal: 'Unexpected proposal' },
    { ...result, participant_perspectives: [{ name: 'Stranger', underlying_need: 'Need' }] },
  ]) {
    const { response, calls } = await run({ caseId, action: 'mediate', mode: 'needs' }, { result: invalid });
    assert(response.status === 502, 'Invalid output was accepted');
    assert(!calls.some((call) => call.url.pathname.endsWith('publish_mediator_result')), 'Invalid output published');
  }
});

Deno.test('safety alerts slow down and never publish an agreement', async () => {
  const safety = { ...result, safety_alert: true, pace_status: 'slow_down', suggested_reframe: '' };
  const response = await run({ caseId, action: 'mediate', mode: 'auto' }, { result: safety });
  assert(response.response.status === 200, 'Safe intervention was rejected');
  const proposal = await run({ caseId, action: 'mediate', mode: 'auto' }, {
    result: { ...safety, pace_status: 'active', suggested_reframe: 'Message', agreement_proposal: 'Agreement' },
  });
  assert(proposal.response.status === 200, 'Safety alert was lost');
  const published = proposal.calls.find((call) => call.url.pathname.endsWith('publish_mediator_result'));
  const output = (published?.body as { p_result: typeof safety }).p_result;
  assert(output.agreement_proposal === null && output.suggested_reframe === '' &&
    output.pace_status === 'slow_down', 'Unsafe response was not corrected');
  const privateProposal = await run({ caseId, action: 'private_coach', mode: 'agreement' }, {
    result: { ...result, agreement_proposal: 'Agreement' },
  });
  assert(privateProposal.response.status === 502, 'Private agreement was accepted');
});

Deno.test('membership and rate limits block access before invoking Gemini', async () => {
  for (const [options, status] of [[{ missingMember: true }, 404], [{ retryAfter: 5 }, 429]] as const) {
    const { response, calls } = await run({ caseId, action: 'private_coach', mode: 'needs' }, options);
    assert(response.status === status, 'Wrong access or limit response');
    if (status === 429) {
      assert((await response.json()).error === 'Mediátora môžete požiadať znova o chvíľu.', 'Unexpected rate limit message');
    }
    assert(!calls.some((call) => call.url.hostname === 'generativelanguage.googleapis.com'), 'Called Gemini');
  }
});

Deno.test('invalid user tokens are rejected before accessing case data', async () => {
  const { response, calls } = await run({ caseId, action: 'mediate', mode: 'auto' }, { invalidUser: true });
  assert(response.status === 401, 'Invalid user token was accepted');
  assert(!calls.some((call) => call.url.pathname.startsWith('/rest/v1/')), 'Invalid user accessed case data');
});

Deno.test('public draft and failed publication do not report success', async () => {
  const invalid = await run({ caseId, action: 'mediate', mode: 'reframe', draftMessage: 'secret' });
  assert(invalid.response.status === 400 && invalid.calls.length === 0, 'Public draft accepted');
  const failed = await run({ caseId, action: 'mediate', mode: 'needs' }, { publishError: true });
  assert(failed.response.status === 500, 'Publication error ignored');
});
