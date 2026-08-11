/**
 * The Converse mapping, without an AWS account.
 *
 * Only the pure mappers are exercised: `complete` needs the SDK, credentials and
 * a live model, and none of the three belong in a suite that has to run on every
 * commit. So what is checked here is that this adapter spells the same boundary
 * in Bedrock's vocabulary — which is the whole reason a second adapter exists.
 *
 * The retry POLICY is checked here too, because it is the part most likely to be
 * wrong and the part a unit test can actually reach without credentials. It was
 * wrong: see the ECONNRESET note in bedrock.ts.
 *
 * What is still NOT checked here: the live round trip. This adapter has answered
 * real questions against Bedrock — the eval suite and every CLI example in the
 * README ran through it — but that happened by hand, not in this file, and no
 * assertion here would notice if the wire shape drifted.
 */

import { fromConverseResponse, toConverseRequest, isRetryable, isTransport } from './bedrock';
import type { CompletionRequest } from './types';

function request(overrides: Partial<CompletionRequest> = {}): CompletionRequest {
  return {
    model: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
    system: [{ text: 'instructions', cacheBreakpoint: true }],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'how many clients?' }] }],
    tools: [],
    maxTokens: 1024,
    ...overrides,
  };
}

describe('toConverseRequest', () => {
  // The breakpoint means "cache up to and including this block", which on this
  // API is an element AFTER the block rather than a field on it.
  it('emits the cache breakpoint as its own array element, after the block', () => {
    const wire = toConverseRequest(
      request({ system: [{ text: 'cached prefix', cacheBreakpoint: true }, { text: 'notes' }] })
    );
    expect(wire.system).toEqual([
      { text: 'cached prefix' },
      { cachePoint: { type: 'default' } },
      { text: 'notes' },
    ]);
  });

  it('wraps tools in a toolSpec with the schema under inputSchema.json', () => {
    const inputSchema = { type: 'object', properties: {}, required: [] };
    const wire = toConverseRequest(
      request({ tools: [{ name: 'overdue_invoices', description: 'Open and past due.', inputSchema }] })
    );
    expect(wire.toolConfig).toEqual({
      tools: [
        {
          toolSpec: {
            name: 'overdue_invoices',
            description: 'Open and past due.',
            inputSchema: { json: inputSchema },
          },
        },
      ],
    });
  });

  // `toolConfig: { tools: [] }` is a validation error here, where the Anthropic
  // API would accept an empty list. One of the two places the adapters differ.
  it('omits toolConfig entirely when there are no tools', () => {
    expect('toolConfig' in toConverseRequest(request({ tools: [] }))).toBe(false);
  });

  it('maps tool use and results into the toolUse/toolResult spelling with a status', () => {
    const wire = toConverseRequest(
      request({
        messages: [
          {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'tooluse_7', name: 'find_client', input: { name: 'x' } }],
          },
          {
            role: 'user',
            content: [{ type: 'tool_result', toolUseId: 'tooluse_7', content: 'no match', isError: true }],
          },
        ],
      })
    );
    expect(wire.messages[0].content[0]).toEqual({
      toolUse: { toolUseId: 'tooluse_7', name: 'find_client', input: { name: 'x' } },
    });
    expect(wire.messages[1].content[0]).toEqual({
      toolResult: {
        toolUseId: 'tooluse_7',
        content: [{ text: 'no match' }],
        status: 'error',
      },
    });
  });

  it('puts maxTokens and temperature in inferenceConfig, with the same model rule', () => {
    const older = toConverseRequest(request({ temperature: 0 }));
    expect(older.inferenceConfig).toEqual({ maxTokens: 1024, temperature: 0 });

    // The cross-region prefix must not defeat the model check: this is the same
    // model as `claude-opus-5` on the other provider, and it rejects the field.
    const current = toConverseRequest(
      request({ model: 'us.anthropic.claude-opus-5', temperature: 0 })
    );
    expect(current.inferenceConfig).toEqual({ maxTokens: 1024 });
    expect(current.additionalModelRequestFields).toEqual({ thinking: { type: 'disabled' } });
  });
});

describe('fromConverseResponse', () => {
  it('reads blocks out of output.message.content, keeping ids and order', () => {
    const completion = fromConverseResponse({
      output: {
        message: {
          role: 'assistant',
          content: [
            { text: 'looking' },
            { toolUse: { toolUseId: 'tooluse_3', name: 'invoice_totals', input: { status: 'open' } } },
          ],
        },
      },
      stopReason: 'tool_use',
      usage: { inputTokens: 5, outputTokens: 1 },
    });
    expect(completion.content).toEqual([
      { type: 'text', text: 'looking' },
      { type: 'tool_use', id: 'tooluse_3', name: 'invoice_totals', input: { status: 'open' } },
    ]);
    expect(completion.stopReason).toBe('tool_use');
  });

  it('narrows a guardrail stop to other and keeps the service word for the trace', () => {
    const stopped = fromConverseResponse({ stopReason: 'guardrail_intervened' });
    expect(stopped.stopReason).toBe('other');
    expect(stopped.rawStopReason).toBe('guardrail_intervened');
  });

  it('folds cache reads and writes into input', () => {
    expect(
      fromConverseResponse({
        usage: { inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 9_000, cacheWriteInputTokens: 500 },
      }).usage
    ).toEqual({ input: 9_600, output: 20 });
  });

  it('returns an empty turn rather than throwing when the response carries no message', () => {
    expect(fromConverseResponse({}).content).toEqual([]);
  });

  it('fails loudly on a block it cannot carry', () => {
    expect(() =>
      fromConverseResponse({ output: { message: { content: [{ reasoningContent: {} }] } } })
    ).toThrow(/reasoningContent/);
  });
});

/* ═══ the retry policy ═══ */

describe('what is worth trying again', () => {
  // A socket reset means the request never reached the service, so nothing was
  // processed and trying again is safe. This is the case that was missing, and
  // the eval suite is what found it: two of seventeen cases came back
  // "ERROR — read ECONNRESET" and were reported as the agent being wrong.
  it('retries a connection reset, which carries no status and no AWS name', () => {
    const err = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
    expect(isTransport(err)).toBe(true);
    expect(isRetryable(err)).toBe(true);
  });

  it('retries a socket that died mid-response, which carries no code at all', () => {
    expect(isRetryable(new Error('The pending stream has been canceled'))).toBe(true);
  });

  // The SDK wraps, so the errno is often a cause or two down.
  it('finds the errno through a wrapped cause', () => {
    const inner = Object.assign(new Error('socket failure'), { code: 'EPIPE' });
    const outer = new Error('Converse failed', { cause: inner });
    expect(isRetryable(outer)).toBe(true);
  });

  it('still retries throttling and 5xx by name and by status', () => {
    expect(isRetryable(Object.assign(new Error('slow down'), { name: 'ThrottlingException' }))).toBe(true);
    expect(isRetryable({ $metadata: { httpStatusCode: 503 } })).toBe(true);
    expect(isRetryable({ $metadata: { httpStatusCode: 429 } })).toBe(true);
  });

  /**
   * The assertion that stops the fix from being too broad.
   *
   * A ValidationException is a malformed request that will fail identically
   * forever, and its message can easily contain a word from the transient list —
   * "aborted" is the obvious one. Retrying it three times turns an instant, clear
   * error into a slow one with the message buried under two pointless attempts.
   * The transport check therefore runs only when there was no service response.
   */
  it('does not retry a validation error, even one whose message says aborted', () => {
    const err = Object.assign(new Error('Request aborted: invalid tool schema'), {
      name: 'ValidationException',
      $metadata: { httpStatusCode: 400 },
    });
    expect(isRetryable(err)).toBe(false);
  });

  it('does not retry credentials or a 404 model id from the other provider', () => {
    expect(isRetryable(Object.assign(new Error('no credentials'), { name: 'CredentialsProviderError' }))).toBe(false);
    expect(isRetryable({ $metadata: { httpStatusCode: 404 } })).toBe(false);
  });

  it('does not treat a permanent DNS failure as transient', () => {
    // ENOTFOUND is a wrong endpoint or no network; EAI_AGAIN is the transient one.
    expect(isTransport(Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }))).toBe(false);
    expect(isTransport(Object.assign(new Error('getaddrinfo EAI_AGAIN'), { code: 'EAI_AGAIN' }))).toBe(true);
  });
});
