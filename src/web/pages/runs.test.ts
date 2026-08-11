/**
 * The runs surface, with the four queries replaced.
 *
 * What is asserted here is the rendering, which is what this module is: the
 * queries have their own tests one directory up, and driving them through a
 * mocked driver as well would only assert that a function was called twice.
 *
 * Three groups of assertion, and each is here because of something that would
 * otherwise be believed:
 *
 * **The escaping.** A question, an answer, a tool argument, an evidence label
 * and a verdict note all end up in this markup. The answer and the arguments
 * were written by a model reading a database somebody else fills in, so a client
 * called `<script>…</script>` is a name the model will faithfully quote back —
 * onto a page that shares a session with approve buttons. `escape.ts` has its
 * own tests; these check that this file never went around it.
 *
 * **The bar.** It is a figure drawn rather than a decoration, so the scale is
 * asserted: the slowest step is the full width, nothing exceeds it, and a step
 * with a real duration is never invisible. A bar that rendered as nothing would
 * read as a bar that failed to render.
 *
 * **The sentences.** That eval runs are excluded, that a filtered list does not
 * change the figures above it, that a read-only run changed nothing, that no
 * verdict was recorded when one is refused. These are the page's argument rather
 * than its copy, and they are the first things to be lost while tidying up a
 * layout.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { RunDetail, RunHealth, RunSummary } from '../../agent/runs';
// A TYPE from the server, which is erased — a runtime import would start a
// server as a side effect of running this test file.
import type { Ctx, Reply } from '../server';

/**
 * The queries, mocked; everything else in that module, real.
 *
 * `isRunId`, `isRunFilter` and `RUN_FILTERS` are the validators this page decides
 * with, and stubbing them would leave the tests asserting against a second
 * implementation of the rules rather than against the rules.
 */
vi.mock('../../agent/runs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../agent/runs')>()),
  listRuns: vi.fn(),
  getRun: vi.fn(),
  runHealth: vi.fn(),
  toolStats: vi.fn(),
  setVerdict: vi.fn(),
}));

import { getRun, listRuns, runHealth, setVerdict, toolStats } from '../../agent/runs';
import { runPage, runVerdict, runsPage } from './runs';

const USER = '00000000-0000-4000-8000-000000000001';
const RUN = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

/** Only the fields these pages read are ever touched, so `req` and `res` are
 * never dereferenced. They are in `Ctx` for the ask surface, which streams. */
const ctx = (
  url: string,
  over: { form?: URLSearchParams; params?: Record<string, string> } = {}
): Ctx => ({
  req: {} as never,
  res: {} as never,
  url: new URL(url, 'http://localhost'),
  userId: USER,
  params: over.params ?? {},
  form: over.form ?? new URLSearchParams(),
});

const body = (reply: Reply): string => (reply.kind === 'html' ? reply.body : '');

const health = (over: Partial<RunHealth> = {}): RunHealth => ({
  days: 30,
  runs: 12,
  answered: 11,
  walled: 1,
  with_writes: 0,
  tool_calls: 34,
  tool_failures: 2,
  p50_ms: 4_200,
  p95_ms: 9_100,
  total_tokens: 19_518,
  judged: 3,
  wrong: 1,
  ...over,
});

const summary = (over: Partial<RunSummary> = {}): RunSummary => ({
  id: RUN,
  kind: 'operator',
  question: 'how much is outstanding?',
  answer_preview: 'Outstanding: $33,300.00 across 3 open invoices.',
  stop_reason: 'answered',
  steps: 2,
  tokens: 6_506,
  duration_ms: 6_558,
  writes_allowed: false,
  tools: ['invoice_summary'],
  tool_failures: 0,
  evidence_count: 3,
  trace_steps: 4,
  verdict: null,
  verdict_note: null,
  created_at: new Date('2026-08-11T07:06:00Z'),
  ...over,
});

const detail = (over: Partial<RunDetail> = {}): RunDetail => ({
  id: RUN,
  kind: 'operator',
  question: 'how much is outstanding, and how much of it is overdue?',
  answer: 'Outstanding: $33,300.00 across 3 open invoices.',
  stop_reason: 'answered',
  steps: 2,
  tokens: 6_506,
  duration_ms: 6_558,
  writes_allowed: false,
  evidence: [{ table: 'invoices', id: 'de9bcc24-a04f-456f-8a18-791097d91193', label: 'INV-1008' }],
  trace: [
    { step: 1, kind: 'model', ms: 2_800, inputTokens: 1_200, outputTokens: 80, stop: 'tool_use' },
    {
      step: 2,
      kind: 'tool',
      toolName: 'invoice_summary',
      toolArgs: {},
      output: '11 invoice(s) on file.',
      ok: true,
      ms: 284,
    },
  ] as RunDetail['trace'],
  verdict: null,
  verdict_note: null,
  verdict_at: null,
  created_at: new Date('2026-08-11T07:06:00Z'),
  ...over,
});

/** Every `--w` the page set, as numbers. */
const widths = (out: string): number[] =>
  [...out.matchAll(/--w:([\d.]+)%/g)].map((m) => Number(m[1]));

/** Every `--l` the page set: where each bar starts on the run's timeline. */
const lefts = (out: string): number[] =>
  [...out.matchAll(/--l:([\d.]+)%/g)].map((m) => Number(m[1]));

beforeEach(() => {
  vi.mocked(listRuns).mockReset().mockResolvedValue([]);
  vi.mocked(getRun).mockReset().mockResolvedValue(null);
  vi.mocked(runHealth).mockReset().mockResolvedValue(health());
  vi.mocked(toolStats).mockReset().mockResolvedValue([]);
  vi.mocked(setVerdict).mockReset().mockResolvedValue(detail());
});

describe('the figures', () => {
  it('reports the window, and says the suite is not in it', async () => {
    const out = body(await runsPage(ctx('/runs')));
    // A figure without its window is not a measurement, and a figure that
    // silently included seventeen synthetic runs per suite would be a claim about
    // the test suite wearing the clothes of a claim about the business.
    expect(out).toContain('the last 30 days, excluding eval runs');
    expect(out).toContain('Eval runs are excluded from every figure above');
    expect(vi.mocked(runHealth).mock.calls[0]).toEqual([USER, 30]);
  });

  it('shows every figure the page exists for', async () => {
    const out = body(await runsPage(ctx('/runs')));
    for (const label of [
      'runs',
      'hit a wall',
      'median',
      'p95',
      'tool calls',
      'tool failures',
      'tokens',
      'writes allowed',
      'marked wrong',
    ]) {
      expect(out).toContain(`>${label}</span>`);
    }
    expect(out).toContain('19,518');
    expect(out).toContain('4.2s');
    expect(out).toContain('9.1s');
    // The failure rate, not only the count: 2 failures means nothing without the
    // 34 calls under it.
    expect(out).toContain('5.9% of them');
  });

  it('marks a wall, a wrong verdict and an open write door with the accent, and nothing else', async () => {
    const quiet = body(await runsPage(ctx('/runs')));
    vi.mocked(runHealth).mockResolvedValue(health({ walled: 0, wrong: 0, tool_failures: 0 }));
    const calm = body(await runsPage(ctx('/runs')));
    // One accent, and it means "look at this". A run that answered gets no colour
    // at all — there is deliberately no success colour, because a tick beside
    // every answered run trains the eye to skip the one where it mattered.
    expect(quiet.match(/stat is-seal/g)?.length).toBe(3);
    expect(calm).not.toContain('stat is-seal');
  });

  it('reports an empty window as a dash rather than as zero', async () => {
    vi.mocked(runHealth).mockResolvedValue(
      health({ runs: 0, answered: 0, walled: 0, tool_calls: 0, p50_ms: null, p95_ms: null })
    );
    const out = body(await runsPage(ctx('/runs')));
    // "No runs yet" and "every run was instant" are different facts about the
    // agent, and a percentile of 0ms would state the second. Asserted on the
    // figure itself rather than by searching the document for "0ms": the inlined
    // stylesheet contains `120ms ease`, which is how the first version of this
    // passed for the wrong reason.
    expect(out).toContain('<span class="label">median</span>\n    <b>—</b>');
    expect(out).toContain('<span class="label">p95</span>\n    <b>—</b>');
    expect(out).toContain('no calls made');
  });

  it('says the figures failed rather than printing a zero, and still shows the history', async () => {
    vi.mocked(runHealth).mockRejectedValue(new Error('function make_interval(days => integer) does not exist'));
    vi.mocked(toolStats).mockRejectedValue(new Error('the same thing, one query later'));
    vi.mocked(listRuns).mockResolvedValue([summary()]);

    const out = body(await runsPage(ctx('/runs')));
    expect(out).toContain('make_interval');
    expect(out).toContain('could not be read');
    // The list is a separate query and a separate claim. A 500 here would hide
    // the history to report that a percentile failed.
    expect(out).toContain('how much is outstanding?');
    expect(out).toContain('per-tool figures could not be read');
  });
});

describe('the filters', () => {
  it('marks the current view once, and offers the other four', async () => {
    const out = body(await runsPage(ctx('/runs?only=walled')));
    expect(vi.mocked(listRuns).mock.calls[0]?.[1]).toMatchObject({ only: 'walled' });
    // Counted after the stylesheet, which contains `.nav a[aria-current="page"]`
    // and is inlined into every page — the trap `layout.test.ts` records. Two
    // marks in the document: the nav's current surface, and this view.
    expect(out.slice(out.indexOf('</style>')).match(/aria-current="page"/g)?.length).toBe(2);
    expect(out).toContain('href="/runs?only=walled" aria-current="page"');
    for (const label of ['everything', 'hit a wall', 'marked wrong', 'not yet looked at', 'the eval suite']) {
      expect(out).toContain(`>${label}</a>`);
    }
  });

  it('refuses a filter it does not know, without querying', async () => {
    const reply = await runsPage(ctx('/runs?only=evals'));
    expect(reply.kind === 'html' && reply.status).toBe(400);
    // Not an empty list: "no runs match" is a claim about the business, and a
    // typo is not entitled to make it.
    expect(vi.mocked(listRuns)).not.toHaveBeenCalled();
    expect(body(reply)).toContain('only=evals');
    expect(body(reply)).toContain('walled, wrong, unjudged, eval');
  });

  it('says the figures are unchanged when the eval suite is the list', async () => {
    vi.mocked(listRuns).mockResolvedValue([summary({ kind: 'eval' })]);
    const out = body(await runsPage(ctx('/runs?only=eval')));
    expect(out).toContain('the figures above are unchanged');
    expect(out).toContain('still describe real work');
    // And the other kinds are gone from the list, not merely joined by eval.
    expect(out).toContain('excludes the rest');
  });

  it('says what would put something in an empty list, per filter', async () => {
    const cases: Array<[string, RegExp]> = [
      ['/runs', /Ask something on the ask surface/],
      ['/runs?only=walled', /runs out of budget|exhausts its steps/],
      ['/runs?only=wrong', /what an eval case gets written from/],
      ['/runs?only=unjudged', /unjudged until somebody says otherwise/],
      ['/runs?only=eval', /npm run eval/],
    ];
    for (const [url, sentence] of cases) {
      const out = body(await runsPage(ctx(url)));
      expect(out).toMatch(sentence);
    }
    // An empty history is an answer rather than a silence, because the read
    // raises instead of returning [].
    expect(body(await runsPage(ctx('/runs')))).toContain('a failed read raises');
  });
});

describe('the history', () => {
  it('links each run by a short id and keeps repeated tool calls', async () => {
    vi.mocked(listRuns).mockResolvedValue([
      summary({ tools: ['find_client', 'find_client', 'find_client'], tool_failures: 1 }),
    ]);
    const out = body(await runsPage(ctx('/runs')));
    expect(out).toContain(`href="/runs/${RUN}"`);
    expect(out).toContain('cccccccc');
    // Collapsing repeats hides a model going in circles, which is the one thing
    // this column is for.
    expect(out).toContain('find_client, find_client, find_client');
    expect(out).toContain('1 failed');
  });

  it('offers an older page only when this one is full', async () => {
    vi.mocked(listRuns).mockResolvedValue([summary()]);
    const short = body(await runsPage(ctx('/runs')));
    expect(short).not.toContain('older');
    expect(short).toContain('the end of this history');

    vi.mocked(listRuns).mockResolvedValue(Array.from({ length: 30 }, () => summary()));
    const full = body(await runsPage(ctx('/runs?only=walled&offset=30')));
    // The filter travels with the page, and the offset arithmetic is the page's
    // because the read returns no total.
    expect(full).toContain('href="/runs?only=walled&amp;offset=60"');
    expect(full).toContain('href="/runs?only=walled"'); // newer, back to the top
    expect(full).toContain('probably more');
  });

  it('treats an offset that is not a number as the first page', async () => {
    await runsPage(ctx('/runs?offset=potato'));
    expect(vi.mocked(listRuns).mock.calls[0]?.[1]).toMatchObject({ offset: 0, limit: 30 });
    await runsPage(ctx('/runs?offset=-40'));
    expect(vi.mocked(listRuns).mock.calls[1]?.[1]).toMatchObject({ offset: 0 });
  });

  it('escapes a question, an answer preview and a note that came out of the business', async () => {
    vi.mocked(listRuns).mockResolvedValue([
      summary({
        question: '<script>alert(1)</script>',
        answer_preview: '"><img src=x onerror=alert(1)>',
        verdict_note: "it invented O'Brien & Sons",
        verdict: 'wrong',
      }),
    ]);
    const out = body(await runsPage(ctx('/runs')));
    expect(out).not.toContain('<script>alert(1)');
    expect(out).not.toContain('<img src=x');
    expect(out).toContain('&lt;script&gt;');
    expect(out).toContain('O&#39;Brien &amp; Sons');
  });
});

describe('one run', () => {
  it('tells a missing run apart from an id that could not be one', async () => {
    const absent = await runPage(ctx(`/runs/${RUN}`, { params: { id: RUN } }));
    expect(absent.kind === 'html' && absent.status).toBe(404);
    expect(body(absent)).toContain('belongs to another operator');

    const nonsense = await runPage(ctx('/runs/potato', { params: { id: 'potato' } }));
    expect(nonsense.kind === 'html' && nonsense.status).toBe(404);
    expect(body(nonsense)).toContain('cannot be a run id');
    // Reached by uuid or not, both are 404 — but only one of them claims the
    // other operator's row might exist.
    expect(body(nonsense)).not.toContain('another operator');
  });

  it('shows the question, the answer, the evidence with its id, and the row to check it against', async () => {
    vi.mocked(getRun).mockResolvedValue(detail());
    const out = body(await runPage(ctx(`/runs/${RUN}`, { params: { id: RUN } })));
    expect(vi.mocked(getRun).mock.calls[0]).toEqual([USER, RUN]);
    expect(out).toContain('how much is outstanding, and how much of it is overdue?');
    expect(out).toContain('Outstanding: $33,300.00');
    expect(out).toContain('invoices/INV-1008');
    expect(out).toContain('de9bcc24-a04f-456f-8a18-791097d91193');
    // The footer claims that disagreeing with this UI is a query, so the query is
    // on the page. The quotes around the uuid are literal SQL written in this
    // repository, so they are not escaped — only the interpolated id is, and a
    // uuid has nothing in it to escape.
    expect(out).toContain(`from agent_runs where id = '${RUN}';`);
  });

  it('says what has NOT happened on a read-only run', async () => {
    vi.mocked(getRun).mockResolvedValue(detail());
    const out = body(await runPage(ctx(`/runs/${RUN}`, { params: { id: RUN } })));
    expect(out).toContain('nothing in the business changed');
    expect(out).toContain('was not permitted to write');
    // And where the thing it wanted went instead.
    expect(out).toContain('href="/approvals"');
    expect(out).not.toContain('writes were allowed');
  });

  it('gives the accent to a run that was allowed to write', async () => {
    vi.mocked(getRun).mockResolvedValue(detail({ writes_allowed: true }));
    const out = body(await runPage(ctx(`/runs/${RUN}`, { params: { id: RUN } })));
    expect(out).toContain('notice is-seal');
    expect(out).toContain('writes were allowed for this run');
    // Never a claim that something was written: a tool that finds the value
    // already set has nothing to do.
    expect(out).toContain('does not mean anything was written');
  });

  it('names the wall it hit and what that means for the answer above', async () => {
    vi.mocked(getRun).mockResolvedValue(
      detail({ stop_reason: 'step_limit', answer: 'I checked two clients so far…' })
    );
    const out = body(await runPage(ctx(`/runs/${RUN}`, { params: { id: RUN } })));
    expect(out).toContain('stopped at a wall: step_limit');
    expect(out).toContain('not a conclusion');
    expect(out).toContain('never a silent truncation');
  });

  it('renders a wall this file has not been taught rather than nothing', async () => {
    // The budget owns the vocabulary and may grow it, so a new wall must not
    // render as an empty box that reads like a run which stopped for no reason.
    vi.mocked(getRun).mockResolvedValue(detail({ stop_reason: 'provider_gave_up' }));
    const out = body(await runPage(ctx(`/runs/${RUN}`, { params: { id: RUN } })));
    expect(out).toContain('stopped at a wall: provider_gave_up');
    expect(out).toContain('has not been taught');
  });

  it('says an answer is missing rather than leaving a blank', async () => {
    vi.mocked(getRun).mockResolvedValue(detail({ answer: null, stop_reason: 'aborted' }));
    const out = body(await runPage(ctx(`/runs/${RUN}`, { params: { id: RUN } })));
    expect(out).toContain('No answer text');
    expect(out).toContain('not the agent refusing to answer');
  });

  it('marks an eval run as one, and still shows it', async () => {
    vi.mocked(getRun).mockResolvedValue(detail({ kind: 'eval' }));
    const out = body(await runPage(ctx(`/runs/${RUN}`, { params: { id: RUN } })));
    expect(out).toContain('this is a run of the eval suite');
    expect(out).toContain('counted in none of the figures');
  });
});

describe('the trace', () => {
  const slowRun = () =>
    detail({
      duration_ms: 13_000,
      trace: [
        { step: 1, kind: 'model', ms: 12_000, offsetMs: 0, inputTokens: 1_000, outputTokens: 50 },
        // Both tools start at 12_000: one round, called together by the loop.
        {
          step: 2,
          kind: 'tool',
          toolName: 'find_client',
          toolArgs: { name: 'Halden' },
          ms: 2,
          offsetMs: 12_000,
          ok: true,
        },
        {
          step: 3,
          kind: 'tool',
          toolName: 'log_time',
          toolArgs: { hours: 3 },
          ms: 400,
          offsetMs: 12_000,
          ok: false,
          output: 'Refused: which project?',
        },
      ] as RunDetail['trace'],
    });

  it('positions each bar where the step ran, and never past the end', async () => {
    vi.mocked(getRun).mockResolvedValue(slowRun());
    const out = body(await runPage(ctx(`/runs/${RUN}`, { params: { id: RUN } })));

    const drawn = widths(out);
    const at = lefts(out);
    expect(drawn).toHaveLength(3);
    expect(at).toHaveLength(3);

    // The model call starts the run; the tools start where it left off. Against
    // the 13s clock, 12s in is ~92%.
    expect(at[0]).toBe(0);
    expect(at[1]).toBeCloseTo(92.3, 0);

    /**
     * The assertion this change exists for.
     *
     * Both tool calls were made in one round, so they begin at the same instant,
     * and two bars sharing a left edge is the only way that is visible. Scaled to
     * the slowest STEP instead — which is what this did before — every bar starts
     * at zero and a round of parallel calls looks identical to two sequential ones.
     */
    expect(at[1]).toBe(at[2]);

    // A bar is a figure drawn to scale, so none of them may run off the track.
    for (const [i, w] of drawn.entries()) expect(at[i] + w).toBeLessThanOrEqual(100);

    // And the scale is stated. A bar without its scale is a picture rather than a
    // measurement.
    expect(out).toContain('across 13.0s of wall clock');
  });

  it('keeps a fast step visible instead of rendering nothing', async () => {
    vi.mocked(getRun).mockResolvedValue(slowRun());
    const out = body(await runPage(ctx(`/runs/${RUN}`, { params: { id: RUN } })));
    // 2ms against 12s is 0.017% of the track, which rounds to an invisible bar —
    // and an invisible bar reads as one that failed to render.
    const smallest = Math.min(...widths(out));
    expect(smallest).toBeGreaterThan(0);
    expect(smallest).toBeLessThan(1);
  });

  it('marks a failed step with the accent, and only the failed one', async () => {
    vi.mocked(getRun).mockResolvedValue(slowRun());
    const out = body(await runPage(ctx(`/runs/${RUN}`, { params: { id: RUN } })));
    expect(out.match(/class="bar is-seal"/g)).toHaveLength(1);
    expect(out.match(/class="failed"/g)).toHaveLength(1);
    expect(out).toContain('1 failed');
  });

  it('shows the arguments the model sent and the output the trace kept', async () => {
    vi.mocked(getRun).mockResolvedValue(slowRun());
    const out = body(await runPage(ctx(`/runs/${RUN}`, { params: { id: RUN } })));
    expect(out).toContain('args {&quot;name&quot;:&quot;Halden&quot;}');
    expect(out).toContain('Refused: which project?');
    // Both facts about what is being read, said once rather than per step.
    expect(out).toContain('before validation');
    expect(out).toContain('truncates it');
  });

  it('escapes tool arguments, which the model wrote outright', async () => {
    vi.mocked(getRun).mockResolvedValue(
      detail({
        trace: [
          {
            step: 1,
            kind: 'tool',
            toolName: '<script>x</script>',
            toolArgs: { name: '</pre><script>alert(1)</script>' },
            output: '<img src=x onerror=alert(1)>',
            ok: false,
            ms: 10,
          },
        ] as RunDetail['trace'],
      })
    );
    const out = body(await runPage(ctx(`/runs/${RUN}`, { params: { id: RUN } })));
    expect(out).not.toContain('<script>alert(1)');
    expect(out).not.toContain('<img src=x');
    expect(out).not.toContain('</pre><script>');
    expect(out).toContain('&lt;script&gt;');
  });

  it('survives a trace shaped like nothing this repository writes', async () => {
    // It is a JSONB column: `persistRun` writes the shape and nothing enforces it
    // at read time, and a renderer that throws takes down the page that is the
    // only way anybody would find out.
    for (const trace of [
      null,
      'not an array',
      [null, 42, { kind: 'tool' }, { kind: 'wat', ms: 'soon' }],
    ] as unknown[]) {
      vi.mocked(getRun).mockResolvedValue(detail({ trace: trace as RunDetail['trace'] }));
      const out = body(await runPage(ctx(`/runs/${RUN}`, { params: { id: RUN } })));
      expect(out).toContain('Trace');
    }
    // An empty trace says so rather than leaving the heading over nothing.
    vi.mocked(getRun).mockResolvedValue(detail({ trace: [] }));
    expect(body(await runPage(ctx(`/runs/${RUN}`, { params: { id: RUN } })))).toContain(
      'recorded no steps'
    );
  });

  it('says a model step reported no usage rather than printing 0 tokens', async () => {
    vi.mocked(getRun).mockResolvedValue(
      detail({ trace: [{ step: 1, kind: 'model', ms: 900 }] as RunDetail['trace'] })
    );
    const out = body(await runPage(ctx(`/runs/${RUN}`, { params: { id: RUN } })));
    // A provider that reports nothing is charged pessimistically by the budget, so
    // "0 tok" next to a run total of 6,506 would read as a step that was free.
    expect(out).toContain('usage not reported');
    expect(out).not.toContain('0 tok');
  });
});

describe('the verdict', () => {
  it('offers the form as a POST, with no button that acts on the business', async () => {
    vi.mocked(getRun).mockResolvedValue(detail());
    const out = body(await runPage(ctx(`/runs/${RUN}`, { params: { id: RUN } })));
    expect(out).toContain(`method="post" action="/runs/${RUN}/verdict"`);
    expect(out).toContain('value="good"');
    expect(out).toContain('value="wrong"');
    // .is-seal on a button means it changes the records. This writes a word onto
    // a run, so neither verdict button wears it.
    expect(out).not.toContain('btn is-seal');
    // And it says so, on the form.
    expect(out).toContain('changes nothing in the business');
    // Nothing to un-judge on a run with no verdict.
    expect(out).not.toContain('value="none"');
  });

  it('says why the verdict exists at all', async () => {
    vi.mocked(getRun).mockResolvedValue(detail());
    const out = body(await runPage(ctx(`/runs/${RUN}`, { params: { id: RUN } })));
    expect(out).toContain('the failures somebody imagined');
    expect(out).toContain('nobody could have invented');
    expect(out).toContain('Not judged');
  });

  it('shows an existing verdict and its note, and offers to take it off', async () => {
    vi.mocked(getRun).mockResolvedValue(
      detail({
        verdict: 'wrong',
        verdict_note: 'the total swallowed a void invoice',
        verdict_at: new Date('2026-08-11T09:00:00Z'),
      })
    );
    const out = body(await runPage(ctx(`/runs/${RUN}`, { params: { id: RUN } })));
    expect(out).toContain('badge is-seal">wrong');
    expect(out).toContain('the total swallowed a void invoice');
    expect(out).toContain('2026-08-11 09:00 UTC');
    expect(out).toContain('value="none"');
  });

  it('records good and wrong, then redirects so a reload cannot re-post it', async () => {
    for (const verdict of ['good', 'wrong'] as const) {
      const form = new URLSearchParams({ verdict, note: 'it invented a total' });
      const reply = await runVerdict(ctx(`/runs/${RUN}/verdict`, { form, params: { id: RUN } }));
      expect(vi.mocked(setVerdict)).toHaveBeenLastCalledWith({
        userId: USER,
        id: RUN,
        verdict,
        note: 'it invented a total',
      });
      expect(reply).toEqual({ kind: 'redirect', to: `/runs/${RUN}` });
    }
  });

  it('un-judges on a value that says so, rather than on a missing field', async () => {
    const form = new URLSearchParams({ verdict: 'none', note: 'left over' });
    await runVerdict(ctx(`/runs/${RUN}/verdict`, { form, params: { id: RUN } }));
    // null un-judges, and the statement clears the note with it.
    expect(vi.mocked(setVerdict)).toHaveBeenCalledWith(
      expect.objectContaining({ verdict: null })
    );
  });

  it('refuses a request with no verdict in it, and one with a word that is not one', async () => {
    const none = await runVerdict(ctx(`/runs/${RUN}/verdict`, { params: { id: RUN } }));
    expect(none.kind === 'html' && none.status).toBe(400);
    expect(body(none)).toContain('carried no verdict');

    const wrong = await runVerdict(
      ctx(`/runs/${RUN}/verdict`, {
        form: new URLSearchParams({ verdict: 'excellent' }),
        params: { id: RUN },
      })
    );
    expect(wrong.kind === 'html' && wrong.status).toBe(400);
    expect(body(wrong)).toContain('excellent');
    // Nothing was rounded to the nearest verdict.
    expect(vi.mocked(setVerdict)).not.toHaveBeenCalled();
    expect(body(wrong)).toContain('No verdict was written');
  });

  it('refuses an id that cannot name a run, without writing', async () => {
    const reply = await runVerdict(
      ctx('/runs/potato/verdict', {
        form: new URLSearchParams({ verdict: 'good' }),
        params: { id: 'potato' },
      })
    );
    expect(reply.kind === 'html' && reply.status).toBe(400);
    expect(vi.mocked(setVerdict)).not.toHaveBeenCalled();
    // A write that cannot name its target fails rather than reporting that it
    // changed nothing.
    expect(body(reply)).toContain('cannot be a run id');
  });

  it('reads a run that is not there as absent, and a refused value as a refusal', async () => {
    vi.mocked(setVerdict).mockRejectedValue(new Error('No such run.'));
    const missing = await runVerdict(
      ctx(`/runs/${RUN}/verdict`, {
        form: new URLSearchParams({ verdict: 'good' }),
        params: { id: RUN },
      })
    );
    expect(missing.kind === 'html' && missing.status).toBe(404);
    expect(body(missing)).toContain('No such run.');

    vi.mocked(setVerdict).mockRejectedValue(new Error('"ok" is not a verdict.'));
    const refused = await runVerdict(
      ctx(`/runs/${RUN}/verdict`, {
        form: new URLSearchParams({ verdict: 'good' }),
        params: { id: RUN },
      })
    );
    expect(refused.kind === 'html' && refused.status).toBe(400);
    expect(body(refused)).toContain('is not a verdict');
  });

  it('escapes a note on its way back into the form field', async () => {
    vi.mocked(getRun).mockResolvedValue(
      detail({ verdict: 'wrong', verdict_note: '"><script>alert(1)</script>' })
    );
    const out = body(await runPage(ctx(`/runs/${RUN}`, { params: { id: RUN } })));
    // An unescaped quote here closes the value attribute, which is the whole
    // reason `escapeHtml` covers both kinds of quote.
    expect(out).not.toContain('<script>alert(1)');
    expect(out).toContain('value="&quot;&gt;&lt;script&gt;');
  });
});
