/**
 * The loop, tested without a model and without a database.
 *
 * The private original could only be exercised against the live model, which
 * meant every mechanic in it — the tool round trip, the budget wall, the
 * parallel dispatch, the token attribution — cost money to check and could not
 * run in CI. Here the provider is an ordinary object implementing `Provider`,
 * fed a scripted list of completions. That is the whole reason `runAgent` takes
 * the provider as an argument rather than importing one: nothing below mocks a
 * module, so nothing below can pass because the mock was wrong.
 *
 * What this file does NOT answer: whether the agent is any good. That is the
 * eval suite's question, it needs a live model and real records, and it is a
 * script rather than a test. What this file answers is whether the harness
 * works — and every assertion here gives the same answer twice.
 */

import { runAgent, type RunEvent } from './loop';
import { summarizeTrace } from './trace';
import { registerTools, type Tool, type ToolContext } from './tools';
import type { Completion, CompletionRequest, Provider, Usage } from './providers/types';

/* ─── the fake provider ─── */

const USAGE: Usage = { input: 100, output: 50 };

const answers = (text: string, usage: Usage = USAGE): Completion => ({
  content: [{ type: 'text', text }],
  stopReason: 'end_turn',
  usage,
});

const wantsTools = (
  calls: Array<{ id: string; name: string; input: unknown }>,
  usage: Usage = USAGE
): Completion => ({
  content: calls.map((c) => ({ type: 'tool_use' as const, id: c.id, name: c.name, input: c.input })),
  stopReason: 'tool_use',
  usage,
});

/**
 * Scripted completions, in order.
 *
 * Running off the end of the script THROWS rather than answering, so a loop that
 * takes one step more than the test expected fails loudly instead of quietly
 * looking correct. `repeat` is the opt-in for the runaway cases, where the point
 * is that the model never stops asking.
 */
class FakeProvider implements Provider {
  readonly id = 'fake';
  readonly requests: CompletionRequest[] = [];
  private index = 0;

  constructor(
    private readonly script: Completion[],
    private readonly opts: { repeat?: boolean } = {}
  ) {}

  get calls(): number {
    return this.requests.length;
  }

  async complete(request: CompletionRequest): Promise<Completion> {
    this.requests.push(request);
    const next = this.script[this.index];
    if (next === undefined) {
      throw new Error(
        `the fake provider ran out of scripted completions after ${this.index} call(s)`
      );
    }
    if (!this.opts.repeat) this.index += 1;
    return next;
  }
}

/** A provider that never answers until its request is abandoned. */
const hangingProvider = (): Provider => ({
  id: 'hangs',
  complete: (request) =>
    new Promise((_resolve, reject) => {
      request.signal?.addEventListener('abort', () => reject(new Error('request aborted')), {
        once: true,
      });
    }),
});

const failingProvider = (message: string) => {
  const state = { calls: 0 };
  const provider: Provider = {
    id: 'broken',
    async complete() {
      state.calls += 1;
      throw new Error(message);
    },
  };
  return { provider, state };
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ─── the tools under the loop ─── */

const seen: { contexts: ToolContext[]; runs: number } = { contexts: [], runs: 0 };

const tool = (over: Partial<Tool> & { name: string }): Tool => ({
  description: 'A tool that exists only in this test file.',
  inputSchema: { type: 'object', properties: {} },
  validate: () => ({}),
  run: async () => ({ content: 'ok', evidence: [] }),
  ...over,
});

registerTools([
  tool({
    name: 'test_find_client',
    run: async (_args, ctx) => {
      seen.contexts.push(ctx);
      return {
        content: 'Halden Freight — active, engagement_kind client.',
        evidence: [{ table: 'clients', id: 'c1', label: 'Halden Freight' }],
      };
    },
  }),
  // Same row again, plus one more, so dedupe has something to do across steps.
  tool({
    name: 'test_find_invoices',
    run: async () => ({
      content: 'INV-1008 is open and 40 days overdue.',
      evidence: [
        { table: 'clients', id: 'c1', label: 'Halden Freight' },
        { table: 'invoices', id: 'i8', label: 'INV-1008' },
      ],
    }),
  }),
  tool({
    name: 'test_boom',
    run: async () => {
      throw new Error('the database went away');
    },
  }),
  tool({
    name: 'test_slow',
    run: async () => {
      await sleep(200);
      return { content: 'eventually', evidence: [] };
    },
  }),
  tool({
    name: 'test_overlaps',
    run: async () => {
      await sleep(150);
      return { content: 'done waiting', evidence: [] };
    },
  }),
  tool({
    name: 'test_costly',
    run: async (_args, ctx) => {
      // A tool that called a model of its own. The loop never sees that
      // request; this is the only way its cost enters the accounts.
      ctx.spend?.(1_500);
      return { content: 'drafted something', evidence: [] };
    },
  }),
  tool({
    name: 'test_counts',
    run: async () => {
      seen.runs += 1;
      return { content: 'counted', evidence: [] };
    },
  }),
  tool({
    name: 'test_reports_mode',
    run: async (_args, ctx) => ({
      content: ctx.allowWrites ? 'writes are ON' : 'writes are OFF',
      evidence: [],
    }),
  }),
]);

/**
 * The model is passed in, never defaulted in the loop — a run whose model came
 * from an environment variable read at some other time is a run nobody can
 * attribute. Any string does here; nothing in this file talks to a model.
 */
const MODEL = 'test-model-1';

const ask = (provider: Provider, over: Partial<Parameters<typeof runAgent>[0]> = {}) =>
  runAgent({
    question: 'How much is outstanding?',
    userId: 'u1',
    provider,
    model: MODEL,
    ...over,
  });

beforeEach(() => {
  seen.contexts = [];
  seen.runs = 0;
});

/* ─── the four lines ─── */

describe('the loop', () => {
  it('answers directly when the model asks for no tools', async () => {
    const provider = new FakeProvider([answers('Nothing is outstanding.')]);
    const run = await ask(provider);

    expect(run.answer).toBe('Nothing is outstanding.');
    expect(run.stopReason).toBe('answered');
    expect(run.steps).toBe(1);
    expect(run.evidence).toEqual([]);
    // What answered, recorded on the run rather than looked up afterwards.
    expect(run.model).toBe(MODEL);
    expect(provider.requests[0]!.model).toBe(MODEL);
    expect(run.provider).toBe('fake');
  });

  it('executes a tool and hands the result back as a user turn', async () => {
    const provider = new FakeProvider([
      wantsTools([{ id: 't1', name: 'test_find_client', input: { name: 'Halden' } }]),
      answers('Halden Freight is active.'),
    ]);
    const run = await ask(provider);

    expect(run.answer).toBe('Halden Freight is active.');
    expect(run.steps).toBe(2);

    // The result must reference the tool_use id. Without it the next request is
    // rejected for answering a call the provider cannot find.
    const second = provider.requests[1]!;
    const toolTurn = second.messages[second.messages.length - 1]!;
    expect(toolTurn.role).toBe('user');
    expect(toolTurn.content[0]).toMatchObject({
      type: 'tool_result',
      toolUseId: 't1',
      isError: false,
    });
  });

  it('returns the assistant turn verbatim, tool-use blocks and all', async () => {
    const first = wantsTools([{ id: 't1', name: 'test_find_client', input: {} }]);
    const provider = new FakeProvider([first, answers('done')]);
    await ask(provider);

    const assistantTurn = provider.requests[1]!.messages.find((m) => m.role === 'assistant');
    // Reconstructing this turn instead of echoing it is the classic way to lose
    // the tool-use id and get a 400 on every subsequent request.
    expect(assistantTurn?.content).toBe(first.content);
  });

  it('sends each request a copy of the conversation, not the live array', async () => {
    const provider = new FakeProvider([
      wantsTools([{ id: 't1', name: 'test_find_client', input: {} }]),
      answers('done'),
    ]);
    await ask(provider);

    // The loop appended two more turns after the first request went out. If the
    // request held the live reference, this would now read 3 — and every
    // recorded request would be a description of the final state.
    expect(provider.requests[0]!.messages).toHaveLength(1);
    expect(provider.requests[1]!.messages).toHaveLength(3);
  });

  it('sends the registered tools, and caches the instructions but not the date', async () => {
    const provider = new FakeProvider([answers('ok')]);
    await ask(provider);

    const request = provider.requests[0]!;
    expect(request.tools.map((t) => t.name)).toContain('test_find_client');

    // Everything up to the breakpoint is identical on every step of every run.
    // Anything that changes per run goes after it — today's date now, the
    // operator's notes when memory lands.
    expect(request.system[0]!.cacheBreakpoint).toBe(true);
    expect(request.system[1]!.cacheBreakpoint).toBeUndefined();
    expect(request.system[1]!.text).toMatch(/^Today is \d{4}-\d{2}-\d{2}\./);
    expect(request.system[0]!.text).not.toMatch(/Today is/);
  });

  it('asks for temperature 0 and leaves it to the adapter to drop', async () => {
    const provider = new FakeProvider([answers('ok')]);
    await ask(provider);
    // Comparable runs are worth something; which models still accept the field
    // is a vendor fact, and it lives in one place — the adapter's allowlist —
    // rather than in a list of model ids in the loop.
    expect(provider.requests[0]!.temperature).toBe(0);
  });
});

/* ─── the budget ─── */

describe('the budget stops a runaway loop', () => {
  it('stops at the step limit, before spending the step that would break it', async () => {
    const provider = new FakeProvider(
      [wantsTools([{ id: 't1', name: 'test_find_client', input: {} }])],
      { repeat: true }
    );
    const run = await ask(provider, { limits: { maxSteps: 3 } });

    expect(run.stopReason).toBe('step_limit');
    expect(run.steps).toBe(3);
    // The wall is checked BEFORE the call. A fourth request would mean the
    // limit was an observation rather than a limit.
    expect(provider.calls).toBe(3);
    // Never an empty answer: a run that hit a wall still owes an explanation.
    expect(run.answer).toContain('3 steps');
    expect(run.stopDetail).toContain('narrower');
  });

  it('stops at the token limit rather than buying another step', async () => {
    const provider = new FakeProvider(
      [wantsTools([{ id: 't1', name: 'test_find_client', input: {} }], { input: 40_000, output: 20_000 })],
      { repeat: true }
    );
    const run = await ask(provider, { limits: { maxSteps: 10, maxTokens: 100_000 } });

    expect(run.stopReason).toBe('token_limit');
    expect(run.steps).toBe(2);
    expect(provider.calls).toBe(2);
    expect(run.tokens).toBe(120_000);
  });

  it('does not execute a tool the run can no longer afford', async () => {
    const provider = new FakeProvider(
      [wantsTools([{ id: 't1', name: 'test_counts', input: {} }])],
      { repeat: true }
    );
    const run = await ask(provider, { limits: { maxSteps: 1 } });

    // The wall is checked before the tools as well as before the model. Without
    // that second check the calls this turn asked for all run, and only then
    // does the loop notice it had already finished — which is a limit noticed
    // afterwards, i.e. not a limit.
    expect(run.stopReason).toBe('step_limit');
    expect(seen.runs).toBe(0);
    expect(run.trace.filter((s) => s.kind === 'tool')).toHaveLength(0);
  });

  it('charges a step even when the provider reports no usage', async () => {
    const provider = new FakeProvider([answers('ok', { input: 0, output: 0 })]);
    const run = await ask(provider);
    // Reporting nothing is not evidence that nothing was spent.
    expect(run.tokens).toBeGreaterThan(0);
  });

  it('gives up after repeated tool failures instead of looping forever', async () => {
    const provider = new FakeProvider(
      [wantsTools([{ id: 't1', name: 'no_such_tool', input: {} }])],
      { repeat: true }
    );
    const run = await ask(provider, {
      limits: { maxSteps: 20, maxConsecutiveToolErrors: 2 },
    });

    expect(run.stopReason).toBe('tool_error_limit');
    // The unknown name came back as a readable result, not an exception: the
    // run ended on the budget, not on a crash.
    expect(run.trace.some((s) => s.output?.includes('no tool called'))).toBe(true);
  });

  it('stops on the wall clock before making any call at all', async () => {
    const provider = new FakeProvider([answers('ok')]);
    const run = await ask(provider, { limits: { maxMs: 0 } });

    expect(run.stopReason).toBe('time_limit');
    expect(run.steps).toBe(0);
    expect(provider.calls).toBe(0);
    expect(run.answer).toContain('Stopped after');
  });

  it('abandons a request that outlives the wall clock, and says so in the trace', async () => {
    const run = await ask(hangingProvider(), { limits: { maxMs: 120 } });

    // Without a signal on the request, the wall clock is only checked BETWEEN
    // steps, so a hung request is bounded by nothing at all.
    expect(run.stopReason).toBe('time_limit');
    expect(run.trace).toHaveLength(1);
    expect(run.trace[0]!.output).toContain('abandoned in flight');
  });

  it('reports a cancelled run as cancelled, not as an answer', async () => {
    const before = new AbortController();
    before.abort();
    const cancelledEarly = await ask(new FakeProvider([answers('ok')]), { signal: before.signal });
    expect(cancelledEarly.stopReason).toBe('aborted');
    expect(cancelledEarly.steps).toBe(0);

    const midFlight = new AbortController();
    setTimeout(() => midFlight.abort(), 20);
    const cancelledLate = await ask(hangingProvider(), { signal: midFlight.signal });
    expect(cancelledLate.stopReason).toBe('aborted');
    expect(cancelledLate.stopDetail).toContain('cancelled');
  });
});

/* ─── failures that must not end the run ─── */

describe('a failing tool is a tool result, not a dead run', () => {
  it('turns a thrown tool into an error result the model can read', async () => {
    const provider = new FakeProvider([
      wantsTools([{ id: 't1', name: 'test_boom', input: {} }]),
      answers('I could not reach the records.'),
    ]);
    const run = await ask(provider);

    expect(run.stopReason).toBe('answered');
    expect(run.answer).toBe('I could not reach the records.');

    const failed = run.trace.find((s) => s.toolName === 'test_boom');
    expect(failed?.ok).toBe(false);
    expect(failed?.output).toContain('the database went away');

    const results = provider.requests[1]!.messages.at(-1)!.content;
    expect(results[0]).toMatchObject({ type: 'tool_result', toolUseId: 't1', isError: true });
    // A failed call contributes no evidence: there is nothing to point at.
    expect(run.evidence).toEqual([]);
  });

  it('abandons one slow tool without spending the whole run on it', async () => {
    const provider = new FakeProvider([
      wantsTools([{ id: 't1', name: 'test_slow', input: {} }]),
      answers('That lookup was too slow.'),
    ]);
    const run = await ask(provider, { toolTimeoutMs: 20 });

    const step = run.trace.find((s) => s.toolName === 'test_slow');
    expect(step?.ok).toBe(false);
    expect(step?.output).toContain('took longer than 20ms');
    expect(run.stopReason).toBe('answered');
  });

  it('lets a provider failure end the run, and does not retry it here', async () => {
    const { provider, state } = failingProvider('502 from the endpoint');
    await expect(ask(provider)).rejects.toThrow('502 from the endpoint');
    // Retry-for-throttling lives in the adapter, which is the only layer that
    // knows which of a vendor's errors are transient. Retrying a 400 here would
    // just produce the same error more slowly.
    expect(state.calls).toBe(1);
  });

  it('finishes the run even when the caller\'s listener throws', async () => {
    const provider = new FakeProvider([answers('fine.')]);
    const run = await ask(provider, {
      onEvent: () => {
        throw new Error('the client hung up');
      },
    });

    // A caller whose stream has closed has a broken connection, not a broken
    // agent. The narration is lost; the answer is not.
    expect(run.answer).toBe('fine.');
    expect(run.stopReason).toBe('answered');
  });
});

/* ─── evidence, attribution, truncation ─── */

describe('what the run carries out with it', () => {
  it('accumulates evidence across steps and dedupes by table:id', async () => {
    const provider = new FakeProvider([
      wantsTools([{ id: 't1', name: 'test_find_client', input: {} }]),
      wantsTools([{ id: 't2', name: 'test_find_invoices', input: {} }]),
      answers('Halden Freight owes $16,500 on INV-1008.'),
    ]);
    const run = await ask(provider);

    // The client came back from both tools; it is one row and appears once.
    expect(run.evidence).toEqual([
      { table: 'clients', id: 'c1', label: 'Halden Freight' },
      { table: 'invoices', id: 'i8', label: 'INV-1008' },
    ]);
  });

  it('charges a tool\'s own model tokens to the run and attributes them to the step', async () => {
    const provider = new FakeProvider([
      wantsTools([{ id: 't1', name: 'test_costly', input: {} }]),
      answers('here it is'),
    ]);
    const events: RunEvent[] = [];
    const run = await ask(provider, { onEvent: (e) => events.push(e) });

    // Two model steps at 150 reported tokens each, plus the tool's own 1,500.
    // Uncounted, an expensive run reports as a cheap one.
    expect(run.tokens).toBe(1_800);
    expect(run.trace.find((s) => s.toolName === 'test_costly')?.tokens).toBe(1_500);
    // A step that took twenty seconds is then explainable rather than silent.
    const done = events.find((e) => e.kind === 'tool_done');
    expect(done).toMatchObject({ name: 'test_costly', ok: true, tokens: 1_500 });
    // Tokens without a step: the step count is what bounds the loop, and
    // inflating it would stop a run early for the wrong reason.
    expect(run.steps).toBe(2);
  });

  it('reports a truncated turn as a wall rather than as an answer', async () => {
    const provider = new FakeProvider([
      {
        content: [{ type: 'text', text: 'Outstanding is made up of INV-1008, INV-' }],
        stopReason: 'max_tokens',
        rawStopReason: 'max_tokens',
        usage: USAGE,
      },
    ]);
    const run = await ask(provider);

    // An answer that stopped mid-sentence and a complete one look identical to
    // a caller, and only one of them should be believed.
    expect(run.stopReason).toBe('token_limit');
    expect(run.stopDetail).toContain('cut off');
    // Whatever it had established is still returned.
    expect(run.answer).toContain('INV-1008');
  });

  it('does not report an empty turn as an answer', async () => {
    const provider = new FakeProvider([
      { content: [], stopReason: 'other', rawStopReason: 'content_filtered', usage: USAGE },
    ]);
    const run = await ask(provider);

    expect(run.stopReason).not.toBe('answered');
    expect(run.stopDetail).toContain('content_filtered');
    expect(run.answer).toContain('no answer');
  });

  it('records the mode the run was in, and passes it to every tool', async () => {
    const readOnly = new FakeProvider([
      wantsTools([{ id: 't1', name: 'test_reports_mode', input: {} }]),
      answers('read-only'),
    ]);
    const run = await ask(readOnly);
    expect(run.writesAllowed).toBe(false);
    expect(run.trace.find((s) => s.toolName === 'test_reports_mode')?.output).toBe('writes are OFF');

    const writable = new FakeProvider([answers('ok')]);
    const armed = await ask(writable, { allowWrites: true });
    expect(armed.writesAllowed).toBe(true);
  });

  it('passes the operator through to the tool and never takes it from the model', async () => {
    const provider = new FakeProvider([
      wantsTools([{ id: 't1', name: 'test_find_client', input: { userId: 'someone-else' } }]),
      answers('ok'),
    ]);
    await ask(provider, { userId: 'the-real-operator' });
    expect(seen.contexts[0]?.userId).toBe('the-real-operator');
  });
});

/* ─── dispatching a turn's calls together ─── */

describe('independent tool calls run together', () => {
  it('dispatches one turn\'s calls concurrently and reassembles them in order', async () => {
    const provider = new FakeProvider([
      wantsTools([
        { id: 't1', name: 'test_overlaps', input: { n: 1 } },
        { id: 't2', name: 'test_overlaps', input: { n: 2 } },
      ]),
      answers('both done'),
    ]);

    const startedAt = Date.now();
    const run = await ask(provider);
    const elapsed = Date.now() - startedAt;

    const toolSteps = run.trace.filter((s) => s.kind === 'tool');
    expect(toolSteps).toHaveLength(2);
    // Both began at effectively the same moment. Two 150ms lookups in series
    // would put 150ms between these, and would spend the wall-clock budget on
    // waiting.
    expect(Math.abs(toolSteps[0]!.offsetMs! - toolSteps[1]!.offsetMs!)).toBeLessThan(50);
    expect(elapsed).toBeLessThan(280);

    // Results come back in the order the model asked for them, because it
    // refers to them positionally as well as by id.
    const results = provider.requests[1]!.messages.at(-1)!.content;
    expect(results.map((r) => (r.type === 'tool_result' ? r.toolUseId : null))).toEqual(['t1', 't2']);
  });
});

/* ─── narrating the run ─── */

describe('narrating the run as it happens', () => {
  it('announces each round and each tool, in the order they occur', async () => {
    const provider = new FakeProvider([
      wantsTools([{ id: 't1', name: 'test_find_client', input: {} }]),
      answers('Halden Freight is active.'),
    ]);

    const kinds: string[] = [];
    const run = await ask(provider, { onEvent: (e) => kinds.push(e.kind) });

    // Thinking before the call that spends, the tool bracketed by start and
    // finish, then the second round. A caller can render progress from this
    // without waiting for the answer.
    expect(kinds).toEqual(['thinking', 'thought', 'tool', 'tool_done', 'thinking', 'thought']);
    expect(run.answer).toBe('Halden Freight is active.');
  });

  it('carries what a caller needs to draw the step', async () => {
    const provider = new FakeProvider([
      wantsTools([{ id: 't1', name: 'test_find_client', input: { name: 'Halden' } }]),
      answers('ok'),
    ]);

    const events: RunEvent[] = [];
    await ask(provider, { onEvent: (e) => events.push(e) });

    expect(events.find((e) => e.kind === 'tool')).toMatchObject({
      name: 'test_find_client',
      args: { name: 'Halden' },
    });
    const done = events.find((e) => e.kind === 'tool_done');
    expect(done).toMatchObject({ name: 'test_find_client', ok: true });
    expect(typeof (done as { ms: number }).ms).toBe('number');
    expect((done as { preview: string }).preview.length).toBeGreaterThan(0);
  });

  it('says which wall it hit', async () => {
    const provider = new FakeProvider(
      [wantsTools([{ id: 't1', name: 'test_find_client', input: {} }])],
      { repeat: true }
    );

    const walls: RunEvent[] = [];
    await ask(provider, {
      limits: { maxSteps: 2 },
      onEvent: (e) => {
        if (e.kind === 'wall') walls.push(e);
      },
    });

    expect(walls).toHaveLength(1);
    expect(walls[0]).toMatchObject({ reason: 'step_limit' });
  });
});

/* ─── the summary a person reads ─── */

describe('summarizeTrace', () => {
  it('leads with the outcome and names the rows the answer rests on', async () => {
    const provider = new FakeProvider([
      wantsTools([{ id: 't1', name: 'test_find_invoices', input: {} }]),
      answers('INV-1008 is overdue.'),
    ]);
    const summary = summarizeTrace(await ask(provider));

    expect(summary.split('\n')[0]).toBe('answered: Answered.');
    expect(summary).toContain('2 step(s)');
    expect(summary).toContain('read-only');
    expect(summary).toContain(`fake/${MODEL}`);
    expect(summary).toContain('1. model');
    // A tool step carries the number of the model step that asked for it, so a
    // reader can see which round of thinking each lookup belonged to.
    expect(summary).toContain('1. test_find_invoices');
    expect(summary).toContain('2. model');
    expect(summary).toContain('evidence: clients/Halden Freight, invoices/INV-1008');
  });

  it('marks a failed step and does not print an unreported cost as free', async () => {
    const provider = new FakeProvider([
      wantsTools([{ id: 't1', name: 'test_boom', input: {} }], { input: 0, output: 0 }),
      answers('could not reach it', { input: 0, output: 0 }),
    ]);
    const summary = summarizeTrace(await ask(provider));

    expect(summary).toContain('test_boom FAILED');
    expect(summary).toContain('usage not reported');
    expect(summary).toContain('evidence: none');
  });
});
