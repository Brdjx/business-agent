/**
 * The Converse mapping, without an AWS account.
 *
 * Only the pure mappers are exercised: `complete` needs the SDK, credentials and
 * a live model, and none of the three belong in a suite that has to run on every
 * commit. So what is checked here is that this adapter spells the same boundary
 * in Bedrock's vocabulary — which is the whole reason a second adapter exists.
 *
 * NOT checked, and worth saying plainly: nothing in this port has ever run
 * against Bedrock. The request shape is matched to the one in production in the
 * private original; the usage fold makes an assumption recorded in bedrock.ts.
 */

import { fromConverseResponse, toConverseRequest } from './bedrock';
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
