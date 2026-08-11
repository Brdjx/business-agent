/**
 * The ask surface, with the model and the database replaced.
 *
 * Three kinds of assertion, and they are here for three different reasons.
 *
 * **The sentences.** "nothing above rests on a record", "nothing has been
 * changed", the wall being named rather than truncated silently — these are what
 * the surface exists for rather than decoration on it, and they are exactly the
 * lines somebody removes while tidying up a layout. A page that shows an answer
 * and no evidence is the wrong page, so the test says so.
 *
 * **The escaping.** A proposal summary and an answer were written by a language
 * model that had just read a database somebody else fills in, and the trace's tool
 * arguments are strings the model invented outright. So a client called
 * `<script>…</script>` is asserted against on the paths where it can actually
 * arrive, which is all of them.
 *
 * **The stream.** The frames, the abort on a closed response, and the one property
 * of a narration line that is not obvious from reading it: it must contain no
 * newline, because a blank line is what separates two SSE frames and `.stream` is
 * `white-space: pre-wrap`, so a newline in the markup prints as a gap even when the
 * framing survives.
 *
 * What is NOT covered: the browser half. `SCRIPT` is asserted to exist and to be
 * reachable, and whether `TextDecoderStream` behaves is a question for a browser.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

import type { AgentRun, RunEvent } from '../../agent/loop';
import type { Proposal } from '../../agent/proposals';
import type { ProposalDraft } from '../../agent/tools';
import type { RecordedRun } from '../../agent/trace';
import type { Ctx } from '../server';

/* ─── the model, the database, and the provider ─── */

const h = vi.hoisted(() => ({
  /** What `runAgent` will emit, then return. */
  events: [] as RunEvent[],
  run: null as AgentRun | null,
  /** Set by the fake, so a test can assert what the loop was asked for. */
  asked: null as Record<string, unknown> | null,
  /** Thrown by `runAgent` when set: a provider that is down. */
  fails: null as Error | null,
  recorded: { runId: null, proposals: [] } as RecordedRun,
  persisted: [] as Array<{ userId: string; question: string; kind: unknown }>,
  providerFails: null as Error | null,
}));

vi.mock('../../agent/loop', () => ({
  runAgent: async (opts: Record<string, unknown>) => {
    h.asked = opts;
    const say = opts.onEvent as ((event: RunEvent) => void) | undefined;
    for (const event of h.events) say?.(event);
    if (h.fails) throw h.fails;
    return h.run;
  },
}));

vi.mock('../../agent/trace', () => ({
  persistRunAndProposals: async (userId: string, question: string, _run: unknown, opts: { kind?: string }) => {
    h.persisted.push({ userId, question, kind: opts?.kind });
    return h.recorded;
  },
}));

vi.mock('../../agent/providers', () => ({
  providerFromEnv: () => {
    if (h.providerFails) throw h.providerFails;
    return { provider: { id: 'fake' }, model: 'fake-model' };
  },
}));

// The registry and the tool allowlist are NOT mocked. `ensureToolsRegistered` is
// the call this module has to make itself — the server deliberately does not make
// it — so the test drives the real one and asks the real registry afterwards.
import { allTools } from '../../agent/tools';
import { askPage, askRun, narrationLine, runReport } from './ask';

/* ─── the request ─── */

const USER = '00000000-0000-4000-8000-000000000001';
const RUN_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

/** A response that records what was written to it and can be closed by hand. */
function fakeRes() {
  const chunks: string[] = [];
  const listeners = new Map<string, Array<() => void>>();
  return {
    statusCode: 0,
    headers: {} as Record<string, string>,
    writableEnded: false,
    destroyed: false,
    writeHead(status: number, headers: Record<string, string>) {
      this.statusCode = status;
      Object.assign(this.headers, headers);
      return this;
    },
    write(text: string) {
      chunks.push(text);
      return true;
    },
    end() {
      this.writableEnded = true;
    },
    on(event: string, fn: () => void) {
      const kept = listeners.get(event) ?? [];
      kept.push(fn);
      listeners.set(event, kept);
      return this;
    },
    /** What the client would have seen. */
    body: () => chunks.join(''),
    /** The client going away mid-run. */
    close() {
      for (const fn of listeners.get('close') ?? []) fn();
    },
  };
}

type Res = ReturnType<typeof fakeRes>;

function ctx(over: { form?: Record<string, string>; accept?: string; query?: string; res?: Res } = {}): Ctx {
  const form = new URLSearchParams(over.form ?? {});
  return {
    req: { method: 'POST', headers: over.accept ? { accept: over.accept } : {} },
    res: over.res ?? fakeRes(),
    url: new URL(`http://localhost/${over.query ?? ''}`),
    userId: USER,
    params: {},
    form,
  } as unknown as Ctx;
}

const bodyOf = async (reply: unknown): Promise<string> => {
  const r = reply as { kind: string; body?: string };
  return r.kind === 'html' ? (r.body ?? '') : '';
};

const statusOf = (reply: unknown): number | undefined => (reply as { status?: number }).status;

/** The frames a client would have parsed out of the stream. */
function frames(res: Res): Array<Record<string, string>> {
  return res
    .body()
    .split('\n\n')
    .flatMap((block) => block.split('\n'))
    .filter((line) => line.startsWith('data:'))
    .map((line) => JSON.parse(line.slice(5)) as Record<string, string>);
}

/* ─── the run that comes back ─── */

const EVIDENCE = [
  { table: 'invoices', id: 'de9bcc24-a04f-456f-8a18-791097d91193', label: 'INV-1008' },
];

function agentRun(over: Partial<AgentRun> = {}): AgentRun {
  return {
    answer: 'Outstanding: $33,300.00 across 3 open invoices.',
    writesAllowed: false,
    stopReason: 'answered',
    stopDetail: 'Answered.',
    steps: 2,
    tokens: 6_506,
    ms: 6_558,
    evidence: EVIDENCE,
    proposals: [],
    trace: [
      {
        step: 1,
        kind: 'model',
        output: 'Let me look at the invoices.',
        ms: 2_800,
        inputTokens: 3_100,
        outputTokens: 84,
        stop: 'tool_use',
        offsetMs: 0,
      },
      {
        step: 1,
        kind: 'tool',
        toolName: 'invoice_summary',
        toolArgs: { status: 'open' },
        output: '11 invoice(s) on file.',
        ok: true,
        ms: 284,
        offsetMs: 2_800,
      },
    ],
    model: 'fake-model',
    provider: 'fake',
    ...over,
  };
}

function draft(over: Partial<ProposalDraft> = {}): ProposalDraft {
  return {
    toolName: 'log_time',
    args: { hours: 3 },
    summary: 'Log 3.00h on 2026-08-11 against Ledgerlight Internal Tooling',
    writeKey: 'wk-1',
    target: { table: 'projects', id: '71c2bda4-0000-4000-8000-000000000001', label: 'Ledgerlight Internal Tooling' },
    precondition: {
      table: 'projects',
      id: '71c2bda4-0000-4000-8000-000000000001',
      expect: { name: 'Ledgerlight Internal Tooling', rate_cents: null },
    },
    evidence: [],
    ...over,
  };
}

function card(over: Partial<Proposal> = {}): Proposal {
  return {
    id: 'a64900db-0000-4000-8000-000000000001',
    tool_name: 'log_time',
    summary: 'Log 3.00h on 2026-08-11 against Ledgerlight Internal Tooling',
    target_table: 'projects',
    target_id: '71c2bda4-0000-4000-8000-000000000001',
    target_label: 'Ledgerlight Internal Tooling',
    status: 'pending',
    result: null,
    created_at: new Date('2026-08-11T07:06:00Z'),
    decided_at: null,
    expires_at: new Date('2026-08-12T07:06:00Z'),
    run_id: RUN_ID,
    subject_key: null,
    ...over,
  };
}

beforeEach(() => {
  h.events = [];
  h.run = agentRun();
  h.asked = null;
  h.fails = null;
  h.providerFails = null;
  h.recorded = { runId: RUN_ID, proposals: [] };
  h.persisted = [];
});

/* ─── the box ─── */

describe('the question box', () => {
  it('renders a form that works without any of the script', async () => {
    const out = await bodyOf(await askPage(ctx()));
    // method="post" is the whole of the no-JS path: the browser submits it, the
    // server runs the agent, the finished run comes back as a page.
    expect(out).toContain('<form id="ask" method="post" action="/ask">');
    expect(out).toContain('name="q"');
    expect(out).toContain(`maxlength="4000"`);
    // And the noscript block says what is lost rather than leaving the reader to
    // wonder whether the page is broken.
    expect(out).toContain('<noscript>');
    expect(out).toContain('the whole result arrives at once');
  });

  it('says what a run will show before anything has been asked', async () => {
    const out = await bodyOf(await askPage(ctx()));
    expect(out).toContain('nothing has been asked yet');
    // An empty state has to say what would put something here, and on this surface
    // that sentence is also where a first-time reader is told what they will get.
    expect(out).toContain('the rows the answer rests on with their ids');
    expect(out).toContain('class="next"');
  });

  it('never asks the model on a GET, and never touches the database', async () => {
    // A GET that ran the agent would spend tokens and insert proposal rows the
    // first time anything prefetched it.
    await askPage(ctx({ query: '?q=how much is outstanding' }));
    expect(h.asked).toBe(null);
    expect(h.persisted).toHaveLength(0);
  });

  it('prefills from ?q= so a run can be asked again with a word changed', async () => {
    const out = await bodyOf(await askPage(ctx({ query: '?q=what is overdue' })));
    expect(out).toContain('>what is overdue</textarea>');
  });

  it('escapes a question that came out of a query string', async () => {
    const out = await bodyOf(await askPage(ctx({ query: `?q=${encodeURIComponent('"><script>alert(1)</script>')}` })));
    expect(out).not.toContain('<script>alert(1)');
    expect(out).toContain('&lt;script&gt;alert(1)');
  });
});

/* ─── refusing before anything is spent ─── */

describe('what is refused before a model is called', () => {
  it('refuses an empty question with the reason, and spends nothing', async () => {
    const reply = await askRun(ctx({ form: { q: '   ' } }));
    expect(statusOf(reply)).toBe(400);
    expect(await bodyOf(reply)).toContain('nothing was asked');
    expect(h.asked).toBe(null);
  });

  it('refuses a question longer than the record keeps, and reports its real length', async () => {
    const reply = await askRun(ctx({ form: { q: 'x'.repeat(9_000) } }));
    expect(statusOf(reply)).toBe(400);
    const out = await bodyOf(reply);
    // The true length, not the length after any clipping this file did on the way
    // in: a question the record would keep as something shorter than what was
    // asked is a run nobody can reproduce.
    expect(out).toContain('9,000 characters');
    expect(out).toContain('4,000');
    expect(h.asked).toBe(null);
  });

  it('hands back what was typed, so a long question does not have to be retyped', async () => {
    const reply = await askRun(ctx({ form: { q: `${'x'.repeat(4_100)}END` } }));
    expect(await bodyOf(reply)).toContain('xxxEND</textarea>');
  });

  it('passes the provider layer’s own sentence through, and calls it a 500', async () => {
    h.providerFails = new Error('ANTHROPIC_API_KEY is not set.');
    const reply = await askRun(ctx({ form: { q: 'anything' } }));
    expect(statusOf(reply)).toBe(500);
    // Verbatim. A second vocabulary for the same fault would eventually be the
    // stale one.
    expect(await bodyOf(reply)).toContain('ANTHROPIC_API_KEY is not set.');
    expect(h.asked).toBe(null);
  });

  it('registers the tools itself, because the server deliberately does not', async () => {
    // Incident 1: a registry filled by whoever happened to import something. If
    // this module stops calling ensureToolsRegistered(), the model is sent no tools
    // and the run looks like a fast cheap success.
    expect(allTools()).toHaveLength(0);
    await askRun(ctx({ form: { q: 'how much is outstanding' } }));
    expect(allTools().length).toBeGreaterThan(0);
  });
});

/* ─── the finished run, rendered on the server ─── */

describe('the run without any JavaScript', () => {
  const ask = async (over: Partial<AgentRun> = {}, recorded?: RecordedRun): Promise<string> => {
    h.run = agentRun(over);
    if (recorded) h.recorded = recorded;
    return bodyOf(await askRun(ctx({ form: { q: 'how much is outstanding' } })));
  };

  it('shows the answer, the evidence with its id, the cost and the stop reason', async () => {
    const out = await ask();
    expect(out).toContain('Outstanding: $33,300.00 across 3 open invoices.');
    // The id is what makes the answer checkable: with it, disagreeing with the
    // agent is a query rather than an argument.
    expect(out).toContain('invoices/INV-1008');
    expect(out).toContain('de9bcc24-a04f-456f-8a18-791097d91193');
    expect(out).toContain('6,506');
    expect(out).toContain('6.6s');
    expect(out).toContain('read-only');
    // Always, including when it is the dull one.
    expect(out).toContain('answered');
  });

  it('says out loud when nothing rests on a record', async () => {
    const out = await ask({ evidence: [] });
    // The CLI's sentence, verbatim through evidenceList. An answer with no
    // evidence is the one a reader most needs warning about.
    expect(out).toContain('nothing above rests on a record');
    expect(out).toContain('Treat it as a claim');
  });

  it('names the wall rather than letting a cut-off answer read as a finished one', async () => {
    const out = await ask({
      stopReason: 'step_limit',
      stopDetail: 'Stopped after 8 steps without reaching an answer.',
      answer: 'Stopped after 8 steps without reaching an answer.',
    });
    expect(out).toContain('stopped — step_limit');
    expect(out).toContain('Stopped after 8 steps without reaching an answer.');
    // The seal is the one accent, and a wall is what it is for.
    expect(out).toContain('notice is-seal');
    expect(out).toContain('badge is-seal');
  });

  it('shows every step with its tool, its arguments, its duration and its failure', async () => {
    const out = await ask({
      trace: [
        {
          step: 1,
          kind: 'tool',
          toolName: 'find_client',
          toolArgs: { name: 'Initech' },
          output: 'No client matches "Initech".',
          ok: false,
          ms: 91,
          offsetMs: 2_800,
        },
      ],
    });
    expect(out).toContain('find_client');
    expect(out).toContain('{&quot;name&quot;:&quot;Initech&quot;}');
    expect(out).toContain('91ms');
    expect(out).toContain('class="failed"');
    // The overlap is text because the stylesheet draws a length, not a waterfall.
    expect(out).toContain('at +2.8s');
    // The bar is clamped by the page: a width over 100% pushes the row off its
    // own column.
    expect(out).toMatch(/--w:\d{1,3}%/);
  });

  it('distinguishes a step whose usage was not reported from a free one', async () => {
    const out = await ask({
      trace: [{ step: 1, kind: 'model', ms: 900, offsetMs: 0 }],
    });
    // "0 tokens" beside a run total of 6,506 would let a reader conclude the step
    // was free, when the budget in fact charged it pessimistically.
    expect(out).toContain('usage not reported');
  });

  it('links the run’s record, and prints the query that checks it', async () => {
    const out = await ask({}, { runId: RUN_ID, proposals: [] });
    expect(out).toContain(`href="/runs/${RUN_ID}"`);
    expect(out).toContain(`where id = '${RUN_ID}'`);
  });

  it('says the trace was lost without suggesting the answer was', async () => {
    const out = await ask({}, { runId: null, proposals: [] });
    expect(out).toContain('not recorded');
    expect(out).toContain('the answer stands');
  });

  it('records the run as an operator run, under the operator from the environment', async () => {
    await ask();
    // Never from the request: a UI with no authentication must not also let the
    // request choose whose records it reads.
    expect(h.persisted).toEqual([{ userId: USER, question: 'how much is outstanding', kind: 'operator' }]);
  });

  it('never turns writes on', async () => {
    await ask();
    // There is no field, no checkbox and no query parameter that could. Consent
    // belongs to an action, not to a session.
    expect(h.asked?.allowWrites).toBe(undefined);
  });

  it('reports a provider that is down as the page, keeping the question', async () => {
    h.fails = new Error('the provider returned 503');
    const reply = await askRun(ctx({ form: { q: 'how much is outstanding' } }));
    expect(statusOf(reply)).toBe(500);
    const out = await bodyOf(reply);
    expect(out).toContain('the provider returned 503');
    expect(out).toContain('Nothing was changed by this');
    expect(out).toContain('how much is outstanding</textarea>');
  });

  it('escapes an answer and a tool argument the model wrote', async () => {
    const out = await ask({
      answer: '<script>alert(1)</script>',
      evidence: [{ table: 'clients', id: 'x', label: '<img src=x onerror=alert(1)>' }],
      trace: [
        { step: 1, kind: 'tool', toolName: 'find_client', toolArgs: { name: '</script><b>' }, ok: true, ms: 1 },
      ],
    });
    expect(out).not.toContain('<script>alert(1)');
    expect(out).not.toContain('<img src=x');
    expect(out).not.toContain('</script><b>');
    expect(out).toContain('&lt;script&gt;alert(1)');
  });
});

/* ─── the cards a run left ─── */

describe('a run that proposed a write', () => {
  const withCards = (drafts: ProposalDraft[], cards: Proposal[]): string =>
    String(runReport(agentRun({ proposals: drafts }), { runId: RUN_ID, proposals: cards }));

  it('says nothing has been changed before any of the detail', async () => {
    const out = withCards([draft()], [card()]);
    const heading = out.indexOf('nothing has been changed');
    expect(heading).toBeGreaterThan(-1);
    // Before the summary, which on its own reads exactly like a receipt.
    expect(heading).toBeLessThan(out.indexOf('Log 3.00h'));
    expect(out).toContain('One change is waiting');
    // Not the whole sentence: the markup wraps, and a contiguous match would be
    // asserting where the line breaks in ask.ts rather than what it says.
    expect(out).toContain('did not do it');
  });

  it('shows the row, the facts the card asserts, and when it ages out', async () => {
    const out = withCards([draft()], [card()]);
    expect(out).toContain('projects/Ledgerlight Internal Tooling');
    // The asserts line is the part of a card that matters most, and it is the one
    // thing `Proposal` does not carry — so it comes off the draft.
    expect(out).toContain('name = Ledgerlight Internal Tooling; rate_cents = unset');
    expect(out).toContain('2026-08-12 07:06 UTC');
    expect(out).toContain('re-read immediately before anything is written');
  });

  it('links the desk and applies nothing itself', async () => {
    const out = withCards([draft()], [card()]);
    expect(out).toContain('href="/approvals"');
    // No second page that can apply a write, which would be a second page that has
    // to get stale, expired and already-decided right.
    expect(out).not.toContain('/approve');
    expect(out).not.toContain('method="post"');
    // The seal on a button means the button acts on the business, and a link to
    // the desk does not.
    expect(out).not.toContain('btn is-seal');
  });

  it('reports a card that could not be written rather than counting it as waiting', async () => {
    const out = withCards([draft(), draft({ writeKey: 'wk-2', summary: 'Log 1.00h' })], [card()]);
    expect(out).toContain('1 proposal(s) could not be written');
  });

  it('does not pretend two drafts of one act are two cards', async () => {
    // Asking twice is not consenting twice: the loop keys by write key, so two
    // identical drafts collapse. Reporting that as a lost proposal would teach the
    // reader to distrust a working desk.
    const out = withCards([draft(), draft()], [card()]);
    expect(out).not.toContain('could not be written');
  });

  it('keeps the heading true when every card failed to record', async () => {
    const out = withCards([draft()], []);
    expect(out).toContain('nothing has been changed');
    // "0 changes are waiting for your approval" has no useful reading, and it would
    // be the last thing anybody read before moving on.
    expect(out).not.toContain('0 changes are waiting');
    expect(out).toContain('no card could be written');
  });

  it('renders without the asserts line rather than pairing the wrong draft', async () => {
    const out = withCards([draft({ summary: 'something else entirely' })], [card()]);
    expect(out).toContain('could not be matched to the draft');
  });

  it('escapes a summary a language model wrote about a client somebody named', async () => {
    const nasty = '<script>fetch("/approvals/x/approve",{method:"POST"})</script>';
    const out = withCards([draft({ summary: nasty })], [card({ summary: nasty })]);
    expect(out).not.toContain('<script>fetch');
    expect(out).toContain('&lt;script&gt;fetch');
  });
});

/* ─── the stream ─── */

describe('the run as it happens', () => {
  const events: RunEvent[] = [
    { kind: 'thinking', step: 1 },
    { kind: 'thought', step: 1, ms: 2_800, tokens: 3_184, text: 'Let me look at the invoices.' },
    { kind: 'tool', step: 1, name: 'invoice_summary', args: { status: 'open' } },
    { kind: 'tool_done', step: 1, name: 'invoice_summary', ok: true, ms: 284, tokens: 0, preview: '11 invoice(s) on file.' },
  ];

  const stream = async (over: { form?: Record<string, string> } = {}): Promise<Res> => {
    const res = fakeRes();
    const reply = await askRun(
      ctx({ res, accept: 'text/event-stream', form: over.form ?? { q: 'how much is outstanding' } })
    );
    expect((reply as { kind: string }).kind).toBe('handled');
    return res;
  };

  it('answers the same POST with an event stream when that is what was asked for', async () => {
    h.events = events;
    const res = await stream();
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/event-stream; charset=utf-8');
    expect(res.headers['cache-control']).toBe('no-store');
    // Opened immediately, so the browser hands the body to the reader rather than
    // waiting for enough bytes to be worth delivering.
    expect(res.body().startsWith(': the run has started\n\n')).toBe(true);
    expect(res.writableEnded).toBe(true);
  });

  it('sends one line per event, then the report once', async () => {
    h.events = events;
    const sent = frames(await stream());
    const lines = sent.filter((f) => f.line);
    const reports = sent.filter((f) => f.report);
    expect(lines).toHaveLength(4);
    expect(reports).toHaveLength(1);
    // The tool, its arguments and its duration, as they happened.
    expect(lines[2]?.line).toContain('invoice_summary');
    expect(lines[2]?.line).toContain('{&quot;status&quot;:&quot;open&quot;}');
    expect(lines[3]?.line).toContain('284ms');
    // And the whole report, rendered by the same function the no-JS path uses.
    expect(reports[0]?.report).toContain('Outstanding: $33,300.00');
    expect(reports[0]?.report).toContain('de9bcc24-a04f-456f-8a18-791097d91193');
  });

  it('carries markup and not data, so there is only one renderer', async () => {
    h.events = [events[0] as RunEvent];
    const sent = frames(await stream());
    // If this ever becomes `{kind:'tool',name:…}`, the browser has started
    // rendering, and the no-JS path and the streamed path can then disagree about
    // what a run showed.
    expect(sent[0]?.line).toContain('<div>');
    expect(Object.keys(sent[0] ?? {})).toEqual(['line']);
  });

  it('cancels the run when the reader goes away', async () => {
    // The loop turns a signal into the `aborted` stop reason, so an abandoned run
    // still records what it established instead of spending the rest of its budget
    // for nobody.
    const res = fakeRes();
    h.events = [];
    const running = askRun(ctx({ res, accept: 'text/event-stream', form: { q: 'anything' } }));
    res.close();
    await running;
    const signal = h.asked?.signal as AbortSignal;
    expect(signal.aborted).toBe(true);
  });

  it('does not cancel a run that has simply finished', async () => {
    h.events = events;
    const res = await stream();
    // res.end() emits 'close' too, and a listener that did not check would report
    // every completed run as cancelled.
    res.close();
    expect((h.asked?.signal as AbortSignal).aborted).toBe(false);
  });

  it('reports a refusal as a frame rather than as a page nobody can read', async () => {
    h.providerFails = new Error('MODEL is not set.');
    const sent = frames(await stream());
    expect(sent).toHaveLength(1);
    expect(sent[0]?.report).toContain('MODEL is not set.');
    expect(sent[0]?.report).toContain('notice is-seal');
    expect(h.asked).toBe(null);
  });

  it('reports a provider that failed mid-run in the stream it opened', async () => {
    h.events = events;
    h.fails = new Error('the provider returned 503');
    const res = await stream();
    const sent = frames(res);
    expect(sent.filter((f) => f.line)).toHaveLength(4);
    expect(sent[sent.length - 1]?.report).toContain('the provider returned 503');
    expect(res.writableEnded).toBe(true);
  });

  it('survives a reader that has already gone', async () => {
    // The run continues, the trace is still written, and only the narration is
    // lost — the same rule the CLI applies to a closed stdout.
    const res = fakeRes();
    res.write = () => {
      throw new Error('EPIPE');
    };
    h.events = events;
    const reply = await askRun(ctx({ res, accept: 'text/event-stream', form: { q: 'anything' } }));
    expect((reply as { kind: string }).kind).toBe('handled');
    expect(h.persisted).toHaveLength(1);
  });

  it('renders a page, not a stream, for a browser that asked for one', async () => {
    const reply = await askRun(ctx({ accept: 'text/html,application/xhtml+xml', form: { q: 'anything' } }));
    expect((reply as { kind: string }).kind).toBe('html');
  });
});

/* ─── one line of narration ─── */

describe('a narration line', () => {
  const now = Date.now();

  it('is one line, because a newline in it is a gap in the box', async () => {
    // `.stream` is white-space: pre-wrap, and a blank line is also what separates
    // two SSE frames.
    const all: RunEvent[] = [
      { kind: 'thinking', step: 1 },
      { kind: 'thought', step: 1, ms: 10, tokens: 5, text: 'a\nb\nc' },
      { kind: 'tool', step: 1, name: 't', args: { a: 'x\ny' } },
      { kind: 'tool_done', step: 1, name: 't', ok: false, ms: 1, tokens: 0, preview: 'one\ntwo' },
      { kind: 'wall', reason: 'time_limit', detail: 'Stopped after 90 seconds.' },
    ];
    for (const event of all) {
      expect(String(narrationLine(event, now))).not.toContain('\n');
    }
  });

  it('marks a failed step and a wall with the accent, and nothing else', async () => {
    expect(String(narrationLine({ kind: 'tool_done', step: 1, name: 't', ok: false, ms: 1, tokens: 0, preview: 'no' }, now))).toContain(
      'class="seal"'
    );
    expect(String(narrationLine({ kind: 'wall', reason: 'aborted', detail: 'The run was cancelled.' }, now))).toContain(
      'class="seal"'
    );
    // There is deliberately no success colour: a mark beside every answered step
    // trains the eye to skip it.
    expect(String(narrationLine({ kind: 'tool_done', step: 1, name: 't', ok: true, ms: 1, tokens: 0, preview: 'ok' }, now))).not.toContain(
      'seal'
    );
  });

  it('reports what a silent model step cost instead of saying nothing', async () => {
    // A departure from the CLI's narrator, on purpose: here the stream is the
    // record of the run as it happened, and a step that spent 1,900 tokens and
    // said nothing is exactly the step worth seeing.
    const out = String(narrationLine({ kind: 'thought', step: 2, ms: 3_100, tokens: 1_900, text: '' }, now));
    expect(out).toContain('1,900 tokens');
    expect(out).toContain('3.1s');
  });

  it('escapes an argument the model invented', async () => {
    const out = String(narrationLine({ kind: 'tool', step: 1, name: '<b>x</b>', args: { q: '<script>' } }, now));
    expect(out).not.toContain('<script>');
    expect(out).not.toContain('<b>x</b>');
    expect(out).toContain('&lt;script&gt;');
  });

  it('still says something about an event kind it has not been taught', async () => {
    // The loop owns this vocabulary and may grow it. Silence during a step that is
    // happening is the exact thing the narration exists to prevent.
    const out = String(narrationLine({ kind: 'compacting' } as unknown as RunEvent, now));
    expect(out).toContain('compacting');
  });
});
