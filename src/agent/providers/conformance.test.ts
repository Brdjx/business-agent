/**
 * The two adapters, given the same request, must carry the same meaning.
 *
 * ── Why this file exists, and exactly what it is worth ──
 *
 * Only one of the two providers has ever answered a live question. Every figure
 * in the README, all five recorded eval suites and the whole write path went
 * through BEDROCK. The Anthropic adapter is the documented default — it needs
 * only a key, where Bedrock needs an AWS account — and its request mapping has
 * been read, unit-tested and never executed.
 *
 * That asymmetry cannot be closed without a funded key, so this narrows it
 * instead. Both adapters map from the same `CompletionRequest` in `types.ts`, and
 * one of those mappings is known good because a suite of seventeen mechanical
 * cases passed through it against three different datasets. So if the untested
 * mapping carries the same SEMANTIC content as the tested one — the same tool
 * names and schemas, the same messages in the same order, the same tool_use ids
 * threaded to the same results, the cache breakpoint in the same place — then a
 * defect in it would have to be a defect the verified one shares.
 *
 * ── What this does NOT establish, said plainly ──
 *
 * Nothing here proves the Anthropic WIRE FORMAT is what the API accepts. Both
 * adapters could agree about meaning and one could still spell a field wrongly:
 * `input_schema` versus `inputSchema`, `max_tokens` versus `maxTokens`. Those
 * spellings are the part only a live call can confirm, and the live call is what
 * is missing. What is tested here is that the two adapters do not DISAGREE about
 * what was asked, which is a different and smaller claim.
 *
 * It is worth having because the failure it rules out is the plausible one. A
 * mapping that drops the system prompt, loses a tool, reorders messages, or fails
 * to thread a tool_use id to its result is the kind of bug that produces a
 * confusing 400 two steps into a run. A misspelled field name produces an
 * immediate and specific error message, which the adapter already surfaces
 * verbatim — that is how "your credit balance is too low" arrived as a sentence
 * rather than a stack trace.
 */

import { describe, it, expect } from 'vitest';

import { toWireRequest, fromWireResponse } from './anthropic';
import { toConverseRequest, fromConverseResponse } from './bedrock';
import type { CompletionRequest } from './types';

/**
 * One request that exercises every branch of both mappers.
 *
 * Deliberately not minimal: the branches that matter are the ones a simple
 * request never reaches — a tool result that is an error, a second system block
 * after the cache breakpoint, an assistant turn being replayed with its tool_use
 * still attached.
 */
const REQUEST: CompletionRequest = {
  model: 'a-model',
  system: [
    { text: 'the cached instructions', cacheBreakpoint: true },
    { text: 'the notes, which change' },
  ],
  messages: [
    { role: 'user', content: [{ type: 'text', text: 'how much is outstanding?' }] },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'I will look that up.' },
        { type: 'tool_use', id: 'call_1', name: 'invoice_summary', input: { days: 30 } },
        { type: 'tool_use', id: 'call_2', name: 'find_client', input: { name: 'Halden' } },
      ],
    },
    {
      role: 'user',
      content: [
        { type: 'tool_result', toolUseId: 'call_1', content: '11 invoices on file.' },
        { type: 'tool_result', toolUseId: 'call_2', content: 'No client matches.', isError: true },
      ],
    },
  ],
  tools: [
    {
      name: 'invoice_summary',
      description: 'Totals across invoices.',
      inputSchema: { type: 'object', properties: { days: { type: 'integer' } } },
    },
    {
      name: 'find_client',
      description: 'One client by name.',
      inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    },
  ],
  maxTokens: 2048,
};

/* ─── reading each wire format back into the same shape ─── */

type Semantic = {
  model: string;
  maxTokens: number | undefined;
  /** System text in order, with a marker where the cache breakpoint sits. */
  system: string[];
  tools: Array<{ name: string; description: string; schema: unknown }>;
  messages: Array<{ role: string; blocks: string[] }>;
};

/**
 * The text inside a tool result, whichever way the vendor wrapped it.
 *
 * Anthropic: [{ type: 'text', text }].  Converse: [{ text }].  Both are correct,
 * and both adapters produce the right one — which is precisely why a comparison
 * that means to be about SEMANTICS has to reach past the wrapper. Reading the text
 * is the assertion; reading the shape would be asserting that two APIs are the
 * same API.
 */
const resultText = (content: unknown): string =>
  Array.isArray(content)
    ? content.map((c) => String((c as { text?: unknown }).text ?? '')).join('')
    : String(content ?? '');

/** A block reduced to the facts both formats must agree on. */
const anthropicBlocks = (content: unknown[]): string[] =>
  content.map((raw) => {
    const b = raw as Record<string, unknown>;
    switch (b.type) {
      case 'text':
        return `text:${String(b.text)}`;
      case 'tool_use':
        return `use:${String(b.id)}:${String(b.name)}:${JSON.stringify(b.input)}`;
      case 'tool_result':
        // The TEXT, not the wrapper. Both formats carry a content array here and
        // spell its elements differently on purpose — {type:'text',text} against
        // {text} — so stringifying the wrapper compares vendor spellings, which is
        // the one thing this file is not for. The first version of this comparator
        // did exactly that and reported a disagreement that was its own.
        return `result:${String(b.tool_use_id)}:${b.is_error === true ? 'error' : 'ok'}:${resultText(b.content)}`;
      default:
        return `unknown:${JSON.stringify(b)}`;
    }
  });

const converseBlocks = (content: unknown[]): string[] =>
  content.map((raw) => {
    const b = raw as Record<string, any>;
    if (typeof b.text === 'string') return `text:${b.text}`;
    if (b.toolUse) return `use:${b.toolUse.toolUseId}:${b.toolUse.name}:${JSON.stringify(b.toolUse.input)}`;
    if (b.toolResult) {
      const status = b.toolResult.status === 'error' ? 'error' : 'ok';
      return `result:${b.toolResult.toolUseId}:${status}:${resultText(b.toolResult.content)}`;
    }
    return `unknown:${JSON.stringify(b)}`;
  });

function fromAnthropic(): Semantic {
  const w = toWireRequest(REQUEST) as unknown as Record<string, any>;
  return {
    model: w.model,
    maxTokens: w.max_tokens,
    // cache_control sits ON the block it applies to here.
    system: (w.system as any[]).map((b) => (b.cache_control ? `${b.text}<cache>` : b.text)),
    tools: (w.tools as any[]).map((t) => ({
      name: t.name,
      description: t.description,
      schema: t.input_schema,
    })),
    messages: (w.messages as any[]).map((m) => ({
      role: m.role,
      blocks: anthropicBlocks(m.content),
    })),
  };
}

function fromBedrock(): Semantic {
  const w = toConverseRequest(REQUEST) as unknown as Record<string, any>;
  // A cachePoint is its own ELEMENT here, after the block it applies to, so it is
  // folded back onto that block to be comparable. This asymmetry is the whole
  // reason the boundary in types.ts spells it as a flag rather than as a block.
  const system: string[] = [];
  for (const b of w.system as any[]) {
    if (b.cachePoint) {
      system[system.length - 1] = `${system[system.length - 1]}<cache>`;
      continue;
    }
    system.push(b.text);
  }
  return {
    model: w.modelId,
    maxTokens: w.inferenceConfig?.maxTokens,
    system,
    tools: ((w.toolConfig?.tools ?? []) as any[]).map((t) => ({
      name: t.toolSpec.name,
      description: t.toolSpec.description,
      schema: t.toolSpec.inputSchema.json,
    })),
    messages: (w.messages as any[]).map((m) => ({
      role: m.role,
      blocks: converseBlocks(m.content),
    })),
  };
}

describe('the two adapters agree about what was asked', () => {
  it('carries the same model and token ceiling', () => {
    const a = fromAnthropic();
    const b = fromBedrock();
    expect(a.model).toBe(b.model);
    expect(a.maxTokens).toBe(b.maxTokens);
    expect(a.maxTokens).toBe(2048);
  });

  it('carries the same system prompt, in order, with the breakpoint in the same place', () => {
    // The single most consequential thing to get wrong: an adapter that drops the
    // second system block loses the notes, and the agent then answers without
    // knowing what it was told. It would not error — it would just be wrong.
    expect(fromAnthropic().system).toEqual(fromBedrock().system);
    expect(fromAnthropic().system).toEqual([
      'the cached instructions<cache>',
      'the notes, which change',
    ]);
  });

  it('carries every tool, with the same name, description and schema', () => {
    const a = fromAnthropic();
    const b = fromBedrock();
    expect(a.tools).toEqual(b.tools);
    // A dropped tool is a tool the model cannot call, which reads as the agent
    // choosing not to use it rather than as a mapping bug.
    expect(a.tools.map((t) => t.name)).toEqual(['invoice_summary', 'find_client']);
    expect(a.tools[1].schema).toEqual(REQUEST.tools[1].inputSchema);
  });

  it('carries every message, in order, with every block intact', () => {
    expect(fromAnthropic().messages).toEqual(fromBedrock().messages);
  });

  it('threads each tool_use id to its own result, and keeps the error flag', () => {
    const a = fromAnthropic();
    const b = fromBedrock();
    const results = (s: Semantic) => s.messages[2].blocks;

    // Two calls in one round, two results in the next turn. A mapping that
    // reuses one id, or swaps them, produces a run where the model reads the
    // wrong answer to its own question — and nothing in the response says so.
    expect(results(a)).toEqual(results(b));
    expect(results(a)[0]).toContain('result:call_1:ok');
    expect(results(a)[1]).toContain('result:call_2:error');

    // And the ids came from the request rather than being regenerated.
    expect(results(a)[0]).toContain('call_1');
    expect(a.messages[1].blocks[1]).toContain('use:call_1:invoice_summary');
  });

  it('does not silently drop anything: block counts match per message', () => {
    const a = fromAnthropic();
    const b = fromBedrock();
    expect(a.messages.map((m) => m.blocks.length)).toEqual(b.messages.map((m) => m.blocks.length));
    expect(a.messages.map((m) => m.blocks.length)).toEqual([1, 3, 2]);
  });
});

describe('the two adapters agree about what came back', () => {
  /**
   * The same turn in each vendor's response shape. Written by hand from each
   * API's documented format rather than captured, which is the honest limit of
   * this half: a captured Bedrock response would make the Bedrock side real
   * evidence, and there is no captured Anthropic one to pair it with.
   */
  it('reads an equivalent turn into an equivalent Completion', () => {
    const fromA = fromWireResponse({
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'a-model',
      content: [
        { type: 'text', text: 'Looking that up.' },
        { type: 'tool_use', id: 'call_9', name: 'invoice_summary', input: { days: 30 } },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 1200, output_tokens: 80 },
    } as never);

    const fromB = fromConverseResponse({
      output: {
        message: {
          role: 'assistant',
          content: [
            { text: 'Looking that up.' },
            { toolUse: { toolUseId: 'call_9', name: 'invoice_summary', input: { days: 30 } } },
          ],
        },
      },
      stopReason: 'tool_use',
      usage: { inputTokens: 1200, outputTokens: 80 },
    } as never);

    expect(fromA.content).toEqual(fromB.content);
    expect(fromA.stopReason).toBe(fromB.stopReason);
    expect(fromA.stopReason).toBe('tool_use');
    expect(fromA.usage).toEqual(fromB.usage);
  });

  it('normalises an end_turn the same way from both', () => {
    const a = fromWireResponse({
      content: [{ type: 'text', text: 'Done.' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 2 },
    } as never);
    const b = fromConverseResponse({
      output: { message: { role: 'assistant', content: [{ text: 'Done.' }] } },
      stopReason: 'end_turn',
      usage: { inputTokens: 10, outputTokens: 2 },
    } as never);
    expect(a).toEqual(b);
  });
});
