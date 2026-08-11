/**
 * What this can and cannot check.
 *
 * The mapping, the stop-reason normalisation, the usage fold and the retry
 * policy are all decisions this file makes, and all of them are checkable with
 * no key and no network — `fetch` is injected. What is NOT checked here is
 * whether the API agrees with the wire shape being sent: that needs a live call,
 * and a suite that spends money on every commit stops being run. So these tests
 * pin the adapter's own behaviour, not the vendor's.
 */

import { createAnthropicProvider, fromWireResponse, toWireRequest } from './anthropic';
import type { CompletionRequest } from './types';

function request(overrides: Partial<CompletionRequest> = {}): CompletionRequest {
  return {
    model: 'claude-opus-5',
    system: [{ text: 'instructions', cacheBreakpoint: true }],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'how many clients?' }] }],
    tools: [],
    maxTokens: 1024,
    ...overrides,
  };
}

/** A fetch that hands back scripted responses and records what it was sent. */
function scriptedFetch(responses: Array<() => Response>) {
  const bodies: string[] = [];
  const impl = (async (_url: unknown, init?: RequestInit) => {
    bodies.push(String(init?.body ?? ''));
    const make = responses[Math.min(bodies.length - 1, responses.length - 1)];
    return make();
  }) as unknown as typeof fetch;
  return { impl, bodies, get calls() { return bodies.length; } };
}

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

const answered = {
  content: [{ type: 'text', text: 'four' }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 10, output_tokens: 2 },
};

describe('toWireRequest', () => {
  it('puts the cache breakpoint on the block that carries it', () => {
    const wire = toWireRequest(
      request({ system: [{ text: 'cached prefix', cacheBreakpoint: true }, { text: 'notes' }] })
    );
    expect(wire.system).toEqual([
      { type: 'text', text: 'cached prefix', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'notes' },
    ]);
  });

  // The way this happens: a notes block rendered for an operator who has been
  // told nothing. An empty text block is a 400.
  it('drops empty system blocks', () => {
    const wire = toWireRequest(request({ system: [{ text: 'kept' }, { text: '   ' }] }));
    expect(wire.system).toEqual([{ type: 'text', text: 'kept' }]);
  });

  it('omits system and tools entirely rather than sending them empty', () => {
    const wire = toWireRequest(request({ system: [], tools: [] }));
    expect('system' in wire).toBe(false);
    expect('tools' in wire).toBe(false);
  });

  it('maps a tool spec to input_schema, passing the schema through untouched', () => {
    const inputSchema = { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] };
    const wire = toWireRequest(
      request({ tools: [{ name: 'find_client', description: 'Find a client.', inputSchema }] })
    );
    expect(wire.tools).toEqual([
      { name: 'find_client', description: 'Find a client.', input_schema: inputSchema },
    ]);
    expect(wire.tools?.[0].input_schema).toBe(inputSchema);
  });

  it('carries tool_use ids and tool_result errors across in the vendor spelling', () => {
    const wire = toWireRequest(
      request({
        messages: [
          {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'toolu_01', name: 'find_client', input: { name: 'x' } }],
          },
          {
            role: 'user',
            content: [{ type: 'tool_result', toolUseId: 'toolu_01', content: 'no match', isError: true }],
          },
        ],
      })
    );
    expect(wire.messages[0].content[0]).toEqual({
      type: 'tool_use',
      id: 'toolu_01',
      name: 'find_client',
      input: { name: 'x' },
    });
    expect(wire.messages[1].content[0]).toEqual({
      type: 'tool_result',
      tool_use_id: 'toolu_01',
      content: [{ type: 'text', text: 'no match' }],
      is_error: true,
    });
  });

  it('substitutes a placeholder for an empty tool result rather than sending a 400', () => {
    const wire = toWireRequest(
      request({
        messages: [{ role: 'user', content: [{ type: 'tool_result', toolUseId: 't1', content: '' }] }],
      })
    );
    expect(wire.messages[0].content[0]).toEqual({
      type: 'tool_result',
      tool_use_id: 't1',
      content: [{ type: 'text', text: '(no output)' }],
    });
  });

  // The failure this prevents: `temperature` is rejected outright by the model
  // `.env.example` ships as the default, so sending it breaks every run.
  it('drops temperature for models that reject it and keeps it for those that do not', () => {
    expect(toWireRequest(request({ model: 'claude-opus-5', temperature: 0 })).temperature).toBeUndefined();
    expect(toWireRequest(request({ model: 'claude-sonnet-4-5', temperature: 0 })).temperature).toBe(0);
    expect(toWireRequest(request({ model: 'claude-opus-4-7', temperature: 0 })).temperature).toBeUndefined();
  });

  // Not a preference about reasoning: a thinking block cannot be represented in
  // ContentBlock, so a turn containing one cannot be replayed.
  it('asks for thinking off only on the models that think by default', () => {
    expect(toWireRequest(request({ model: 'claude-opus-5' })).thinking).toEqual({ type: 'disabled' });
    expect(toWireRequest(request({ model: 'claude-sonnet-5' })).thinking).toEqual({ type: 'disabled' });
    expect(toWireRequest(request({ model: 'claude-sonnet-4-6' })).thinking).toBeUndefined();
  });
});

describe('fromWireResponse', () => {
  it('keeps tool_use ids and both block kinds, in order', () => {
    const completion = fromWireResponse({
      content: [
        { type: 'text', text: 'looking' },
        { type: 'tool_use', id: 'toolu_9', name: 'invoice_totals', input: { status: 'open' } },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    expect(completion.content).toEqual([
      { type: 'text', text: 'looking' },
      { type: 'tool_use', id: 'toolu_9', name: 'invoice_totals', input: { status: 'open' } },
    ]);
    expect(completion.stopReason).toBe('tool_use');
  });

  it('normalises the stop reason and keeps the vendor word for the trace', () => {
    expect(fromWireResponse({ stop_reason: 'end_turn' }).stopReason).toBe('end_turn');
    expect(fromWireResponse({ stop_reason: 'max_tokens' }).stopReason).toBe('max_tokens');

    // A refusal is not an answer, and collapsing it into end_turn is how an
    // empty turn gets reported as one.
    const refused = fromWireResponse({ stop_reason: 'refusal' });
    expect(refused.stopReason).toBe('other');
    expect(refused.rawStopReason).toBe('refusal');
  });

  it('folds cache tokens into input, because the budget cannot see a field it does not know', () => {
    expect(
      fromWireResponse({
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          cache_read_input_tokens: 9_000,
          cache_creation_input_tokens: 500,
        },
      }).usage
    ).toEqual({ input: 9_600, output: 20 });
  });

  // 0 means UNKNOWN at the boundary and the budget charges it pessimistically.
  // An estimate invented here would be charged as though it had been measured.
  it('reports zero rather than a guess when usage is missing', () => {
    expect(fromWireResponse({ content: [] }).usage).toEqual({ input: 0, output: 0 });
  });

  it('fails loudly on a block it cannot carry, naming it', () => {
    expect(() =>
      fromWireResponse({ content: [{ type: 'thinking', thinking: '' }], stop_reason: 'end_turn' })
    ).toThrow(/thinking/);
  });
});

describe('complete', () => {
  it('sends the pinned anthropic-version header and the key', async () => {
    let seen: Record<string, string> = {};
    const impl = (async (_url: unknown, init?: RequestInit) => {
      seen = Object.fromEntries(new Headers(init?.headers).entries());
      return ok(answered);
    }) as unknown as typeof fetch;

    await createAnthropicProvider({ apiKey: 'k-test', fetch: impl }).complete(request());
    expect(seen['anthropic-version']).toBe('2023-06-01');
    expect(seen['x-api-key']).toBe('k-test');
  });

  // A 400 is a malformed request. Retrying it produces the same error more
  // slowly and buries the one sentence that says which field was wrong.
  it('does not retry a 400, and puts the API\'s own message in the error', async () => {
    const script = scriptedFetch([
      () =>
        new Response(
          JSON.stringify({
            type: 'error',
            error: { type: 'invalid_request_error', message: 'temperature: unexpected field' },
          }),
          { status: 400, headers: { 'request-id': 'req_abc' } }
        ),
    ]);
    const provider = createAnthropicProvider({ apiKey: 'k', fetch: script.impl });

    await expect(provider.complete(request())).rejects.toThrow(/temperature: unexpected field/);
    await expect(provider.complete(request())).rejects.toThrow(/req_abc/);
    expect(script.calls).toBe(2); // one per call above, not one per attempt
  });

  it('retries a 429 and returns the answer', async () => {
    const script = scriptedFetch([
      () => new Response('{"error":{"message":"slow down"}}', { status: 429, headers: { 'retry-after': '0' } }),
      () => ok(answered),
    ]);
    const provider = createAnthropicProvider({ apiKey: 'k', fetch: script.impl, maxAttempts: 2 });

    const completion = await provider.complete(request());
    expect(completion.content).toEqual([{ type: 'text', text: 'four' }]);
    expect(script.calls).toBe(2);
  });

  it('gives up after the attempt budget and says how many it made', async () => {
    const script = scriptedFetch([
      () => new Response('{"error":{"message":"overloaded"}}', { status: 529, headers: { 'retry-after': '0' } }),
    ]);
    const provider = createAnthropicProvider({ apiKey: 'k', fetch: script.impl, maxAttempts: 2 });

    await expect(provider.complete(request())).rejects.toThrow(/2 of 2 attempts/);
    expect(script.calls).toBe(2);
  });

  // A captive portal or a proxy error page. The snippet is the useful part,
  // because the status said 200 and nothing else will explain it.
  it('explains a 200 that is not JSON', async () => {
    const script = scriptedFetch([() => new Response('<html>proxy</html>', { status: 200 })]);
    const provider = createAnthropicProvider({ apiKey: 'k', fetch: script.impl });
    await expect(provider.complete(request())).rejects.toThrow(/not JSON: <html>proxy/);
  });

  // A cancelled run is not a failed provider: the name has to survive so the
  // loop can tell "we abandoned it" from "it broke".
  it('passes an abort through untouched and does not retry it', async () => {
    const script = scriptedFetch([
      () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      },
    ]);
    const provider = createAnthropicProvider({ apiKey: 'k', fetch: script.impl });
    await expect(provider.complete(request())).rejects.toMatchObject({ name: 'AbortError' });
    expect(script.calls).toBe(1);
  });
});
