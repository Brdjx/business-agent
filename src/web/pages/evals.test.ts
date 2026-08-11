/**
 * What the evals surface SHOWS, and what it refuses to claim.
 *
 * This file is shaped like `src/agent/evals/history.test.ts` on purpose: the two
 * surfaces read the same rows through the same queries, and the interesting failures
 * are not exceptions but calm pages that read as though nothing were wrong. The cases
 * that matter most here are the three that were worth writing down for the CLI:
 *
 *   * one suite must NOT be reported as stability — "every case gave the same verdict
 *     every time" from a single sample is the unfounded reassurance the whole eval
 *     suite exists to prevent, and a page is more persuasive than a terminal;
 *   * a failed stability query must not leave a page that looks complete;
 *   * a skip must never be rendered as a failure, in the accent or in a count.
 *
 * And one that only exists here: every value on these pages goes through the escaper.
 * A case's `question` is built from a role binding, so it carries client names out of
 * the business tables, and `failures[].detail` is a string the runner assembled out of
 * the model's answer.
 *
 * The database is a set of canned replies keyed by a fragment of each statement, so
 * nothing here needs Postgres — which is also the limit of what it proves. No SQL is
 * executed anywhere in this repository's suite, so a wrong column name or a statement
 * Postgres would reject passes everything below. What is checked is the reading of
 * rows, the words chosen for them, and which statement was sent.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CASES } from '../../agent/evals/cases';

/** `vi.hoisted`, because `vi.mock`'s factory is lifted above the imports. */
const h = vi.hoisted(() => ({
  /** Every statement sent, flattened, with its parameters. */
  calls: [] as Array<{ text: string; params: unknown[] }>,
  /** Canned replies, matched on a fragment of the statement rather than queued in
   * order: a queue would make every case depend on how many reads a page happens to
   * make, and that is an implementation detail. Which table was asked is not. */
  replies: [] as Array<{ when: string; rows?: unknown[]; throws?: unknown }>,
}));

vi.mock('../../db', () => {
  const run = (text: string, params: unknown[]): unknown[] => {
    const flat = text.replace(/\s+/g, ' ').trim();
    h.calls.push({ text: flat, params });
    const reply = h.replies.find((r) => flat.includes(r.when));
    if (reply?.throws) throw reply.throws;
    return reply?.rows ?? [];
  };
  return {
    sql: async (text: string, params: unknown[] = []) => run(text, params),
    one: async (text: string, params: unknown[] = []) => run(text, params)[0] ?? null,
    close: async () => {},
  };
});

import { evalCasePage, evalSuitePage, evalsPage } from './evals';
import type { Ctx } from '../server';

/* ─── the statements, by the fragment that identifies each one ─── */

/** The window of suites. Distinguished from the prefix lookup, which selects the same
 * columns for the same operator and then narrows by id. */
const SUITES = 'roles FROM agent_eval_suites WHERE user_id = $1 ORDER BY';
const SUITE_BY_PREFIX = 'id::text LIKE $2';
const CASE_RUNS = 'JOIN recent s ON s.id = e.suite_id';
const SUITE_CASES = 'FROM agent_eval_runs WHERE suite_id = $1';
const FLAKY = 'agent_eval_flaky';

/* ─── rows, as the columns hold them ─── */

const USER = '00000000-0000-4000-8000-000000000001';
const SUITE_A = 'a1b2c3d4-1111-4111-8111-111111111111';
const SUITE_B = 'b9c8d7e6-2222-4222-8222-222222222222';
const TRACE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

/** Nine minutes apart, which is the interval the design document is about. */
const AT_2211 = new Date('2026-08-10T22:11:00Z');
const AT_2220 = new Date('2026-08-10T22:20:00Z');

function suiteRow(over: Record<string, unknown> = {}) {
  return {
    id: SUITE_A,
    started_at: AT_2211,
    // 64 seconds, so the duration has both halves to format.
    finished_at: new Date('2026-08-10T22:12:04Z'),
    model_id: 'bedrock/us.anthropic.claude-sonnet-4-5-20250929-v1:0',
    git_sha: 'fa589121a2b3',
    total: 2,
    passed: 1,
    failed: 0,
    skipped: 1,
    roles: {
      client_with_project: 'Halden Freight',
      money: { outstandingCents: '3330000', naiveOutstandingCents: '4080000' },
    },
    ...over,
  };
}

function flakyRow(over: Record<string, unknown> = {}) {
  return {
    case_id: 'client-lookup',
    runs: 2,
    passes: 2,
    failures: 0,
    skips: 0,
    last_seen: AT_2220,
    flaky_since: null,
    ...over,
  };
}

function caseRow(over: Record<string, unknown> = {}) {
  return {
    case_id: 'client-lookup',
    question: 'What is the status of Halden Freight, and what are we doing for them?',
    passed: false,
    skipped: false,
    note: null,
    failures: [{ check: 'expectContains', detail: 'none of: active, halden freight' }],
    duration_ms: 4210,
    created_at: AT_2220,
    agent_run_id: TRACE,
    suite_id: SUITE_A,
    git_sha: 'fa589121a2b3',
    ...over,
  };
}

/* ─── driving a handler ─── */

/**
 * A `Ctx` with only the fields a page on this surface reads.
 *
 * `req` and `res` are absent rather than faked. None of these three handlers touches
 * either — they return a `Reply` and let the server write it — and a stub
 * `IncomingMessage` would be a claim that one of them might.
 */
const ctx = (path: string, params: Record<string, string> = {}): Ctx =>
  ({
    url: new URL(path, 'http://localhost'),
    userId: USER,
    params,
    form: new URLSearchParams(),
  }) as unknown as Ctx;

type Handler = (c: Ctx) => Promise<{ kind: string; body?: string; status?: number }>;

/**
 * Render a page, and hand back something an assertion can be written against.
 *
 * `body` is the document with two transformations, and both of them are the
 * difference between a test that checks the page and a test that checks how the
 * source happens to be indented:
 *
 * The inlined stylesheet is REMOVED. `style.ts` names every class in the design
 * system, including `.badge.is-seal`, so `expect(body).not.toContain('is-seal')` —
 * the assertion that says a skip was not given the accent — passes on no page at all
 * while the stylesheet is still in the string.
 *
 * Whitespace is collapsed. A sentence that wraps across two lines in a template
 * literal is still one sentence on screen, because HTML collapses runs of whitespace
 * exactly this way. Asserting against the unflattened string would mean every
 * sentence in this file had to be re-wrapped whenever the markup was reformatted.
 *
 * `raw` is the untouched document for the rare assertion that wants it.
 */
async function page(
  handler: Handler,
  path: string,
  params: Record<string, string> = {}
): Promise<{ body: string; raw: string; status: number }> {
  const reply = await handler(ctx(path, params));
  if (reply.kind !== 'html' || typeof reply.body !== 'string') {
    throw new Error(`expected an html reply, got ${JSON.stringify(reply)}`);
  }
  const raw = reply.body;
  const body = raw.replace(/<style>[\s\S]*?<\/style>/, '').replace(/\s+/g, ' ');
  return { body, raw, status: reply.status ?? 200 };
}

const reply = (...rs: Array<{ when: string; rows?: unknown[]; throws?: unknown }>) =>
  h.replies.push(...rs);

/** The parameters the page sent with one statement, by its fragment. */
const paramsFor = (fragment: string): unknown[] =>
  h.calls.find((c) => c.text.includes(fragment))?.params ?? [];

beforeEach(() => {
  h.calls.length = 0;
  h.replies.length = 0;
});

/* ─── the overview ─── */

describe('the overview', () => {
  it('lists each suite with its commit, its model and how long it took', async () => {
    reply({ when: SUITES, rows: [suiteRow()] }, { when: FLAKY, rows: [flakyRow()] });

    const { body, status } = await page(evalsPage, '/evals');

    expect(status).toBe(200);
    expect(body).toContain('2026-08-10 22:11 UTC');
    // The suite is reachable: the short id is a link to its own view.
    expect(body).toContain(`/evals/suite/${SUITE_A}`);
    expect(body).toContain('a1b2c3d4');
    expect(body).toContain('fa58912');
    // The affixes are trimmed and the provider is kept.
    expect(body).toContain('bedrock/claude-sonnet-4-5');
    expect(body).toContain('1m04s');
  });

  it('leaves an unfamiliar model id whole rather than matching part of it', async () => {
    reply(
      { when: SUITES, rows: [suiteRow({ model_id: 'someone-elses-model-v9' })] },
      { when: FLAKY, rows: [flakyRow()] }
    );

    const { body } = await page(evalsPage, '/evals');

    expect(body).toContain('someone-elses-model-v9');
  });

  it('says a suite did not finish rather than showing its zeros as a result', async () => {
    reply(
      {
        when: SUITES,
        rows: [suiteRow({ finished_at: null, total: 17, passed: 0, failed: 0, skipped: 0 })],
      },
      { when: FLAKY, rows: [flakyRow()] }
    );

    const { body } = await page(evalsPage, '/evals');

    expect(body).toContain('did not finish');
    expect(body).toContain('17 of 17');
    expect(body).toContain('unfinished');
    expect(body).toContain('not the whole suite');
  });

  it('refuses to call one suite stable', async () => {
    reply({ when: SUITES, rows: [suiteRow()] }, { when: FLAKY, rows: [flakyRow()] });

    const { body } = await page(evalsPage, '/evals');

    expect(body).toContain('at least two runs');
    expect(body).not.toContain('same verdict every time');
  });

  it('reports stability once there are two suites to compare', async () => {
    reply(
      { when: SUITES, rows: [suiteRow(), suiteRow({ id: SUITE_B, started_at: AT_2220 })] },
      { when: FLAKY, rows: [flakyRow()] }
    );

    const { body } = await page(evalsPage, '/evals');

    expect(body).toContain('same verdict every time');
    expect(body).not.toContain('at least two runs');
  });

  it('gives the accent to a case that produced both verdicts, and dates it honestly', async () => {
    reply(
      { when: SUITES, rows: [suiteRow(), suiteRow({ id: SUITE_B, started_at: AT_2220 })] },
      { when: FLAKY, rows: [flakyRow({ runs: 2, passes: 1, failures: 1, flaky_since: AT_2211 })] }
    );

    const { body } = await page(evalsPage, '/evals');

    expect(body).toContain('badge is-seal">unstable');
    expect(body).toContain('Earliest outcome still in the window: 2026-08-10 22:11 UTC');
    // Not "unstable since": the window is the only evidence there is.
    expect(body).toContain('not the moment the flake began');
  });

  it('never renders a skip as a failure, in a count or in the accent', async () => {
    reply(
      { when: SUITES, rows: [suiteRow(), suiteRow({ id: SUITE_B, started_at: AT_2220 })] },
      {
        when: FLAKY,
        rows: [flakyRow({ case_id: 'unknown-client', runs: 2, passes: 0, failures: 0, skips: 2 })],
      }
    );

    const { body } = await page(evalsPage, '/evals');

    expect(body).toContain('never ran');
    expect(body).toContain('db:check');
    expect(body).toContain('gap in coverage rather than a failure');
    // Two suites and nothing that failed: the page says so, and nothing anywhere on it
    // is wearing the accent for a skip.
    expect(body).toContain('same verdict every time');
    expect(body).not.toContain('is-seal');
  });

  it('keeps the suite list and names the section it could not read', async () => {
    reply(
      { when: SUITES, rows: [suiteRow()] },
      { when: FLAKY, throws: new Error('function agent_eval_flaky(uuid, integer) does not exist') }
    );

    const { body, status } = await page(evalsPage, '/evals');

    // The suites that were read are still worth showing.
    expect(body).toContain('a1b2c3d4');
    expect(body).toContain('could not be read');
    expect(body).toContain('agent_eval_flaky(uuid, integer) does not exist');
    expect(body).toContain('everything is stable');
    // 200: a status that said the server failed would throw away the half that worked.
    // The sentence on the page is the signal.
    expect(status).toBe(200);
  });

  it('names the cases in the file that this window has no outcome for', async () => {
    reply(
      { when: SUITES, rows: [suiteRow(), suiteRow({ id: SUITE_B, started_at: AT_2220 })] },
      { when: FLAKY, rows: [flakyRow({ case_id: 'client-lookup' })] }
    );

    const { body } = await page(evalsPage, '/evals');

    expect(body).toContain('absent from this window');
    expect(body).toContain(`${CASES.length - 1} of ${CASES.length}`);
    expect(body).toContain('budget-is-reported');
  });

  it('names an id in the history that the cases file no longer has', async () => {
    reply(
      { when: SUITES, rows: [suiteRow(), suiteRow({ id: SUITE_B, started_at: AT_2220 })] },
      { when: FLAKY, rows: [flakyRow({ case_id: 'outstanding-money' })] }
    );

    const { body } = await page(evalsPage, '/evals');

    expect(body).toContain('no longer in the cases file');
    expect(body).toContain('outstanding-money');
    expect(body).toContain('will not grow');
  });

  it('says how to produce a suite, and which operator it read as', async () => {
    reply({ when: SUITES, rows: [] });

    const { body, status } = await page(evalsPage, '/evals');

    expect(status).toBe(200);
    expect(body).toContain('npm run eval');
    expect(body).toContain(USER);
    // The scoping trap, said out loud: a suite under another USER_ID is
    // indistinguishable from no history, and the two have different fixes.
    expect(body).toContain('reads exactly like no history at all');
  });
});

/* ─── the window, which arrives from a URL ─── */

describe('the window', () => {
  it('does not send a typo to Postgres as a broken LIMIT', async () => {
    reply({ when: SUITES, rows: [suiteRow()] }, { when: FLAKY, rows: [flakyRow()] });

    await page(evalsPage, '/evals?suites=abc');

    expect(paramsFor(SUITES)[1]).toBe(20);
  });

  it('falls back to the default for an empty parameter rather than a window of one', async () => {
    reply({ when: SUITES, rows: [suiteRow()] }, { when: FLAKY, rows: [flakyRow()] });

    // Number('') is 0, which would clamp to 1 — the width at which stability cannot be
    // judged at all.
    await page(evalsPage, '/evals?suites=');

    expect(paramsFor(SUITES)[1]).toBe(20);
  });

  it('widens when asked, and says what the window holds', async () => {
    reply({ when: SUITES, rows: [suiteRow()] }, { when: FLAKY, rows: [flakyRow()] });

    const { body } = await page(evalsPage, '/evals?suites=50');

    expect(paramsFor(SUITES)[1]).toBe(50);
    expect(paramsFor(FLAKY)[1]).toBe(50);
    expect(body).toContain('last 50');
    // Widening is offered upward only; there is no link back to a narrower history.
    expect(body).toContain('suites=100');
    expect(body).not.toContain('suites=20');
  });

  it('carries a widened window across a case link, and only when it is not the default', async () => {
    reply({ when: SUITES, rows: [suiteRow()] }, { when: FLAKY, rows: [flakyRow()] });

    const wide = await page(evalsPage, '/evals?suites=100');
    expect(wide.body).toContain('/evals/case/client-lookup?suites=100');

    h.calls.length = 0;
    const plain = await page(evalsPage, '/evals');
    // An ordinary link stays an ordinary path rather than carrying a query string
    // nobody chose.
    expect(plain.body).toContain('"/evals/case/client-lookup"');
  });
});

/* ─── escaping, which is the only defence on this surface ─── */

describe('escaping', () => {
  it('escapes model ids, case ids and assertion details out of the database', async () => {
    reply(
      { when: SUITES, rows: [suiteRow({ model_id: `<script>alert('m')</script>` })] },
      { when: FLAKY, rows: [flakyRow({ case_id: `<img src=x onerror=alert('c')>` })] }
    );

    const { body } = await page(evalsPage, '/evals');

    expect(body).not.toContain('<script>alert');
    expect(body).not.toContain('<img src=x');
    expect(body).toContain('&lt;script&gt;');
    expect(body).toContain('&lt;img src=x onerror=alert(&#39;c&#39;)&gt;');
    // And the id is percent-encoded into the href rather than escaped into it: a
    // quote in a path is not made safe by being a &quot;.
    expect(body).toContain('/evals/case/%3Cimg%20src%3Dx');
  });

  it('escapes a question and an assertion the model had a hand in writing', async () => {
    reply({
      when: CASE_RUNS,
      rows: [
        caseRow({
          question: `What is the status of <script>alert('q')</script>?`,
          failures: [{ check: '<b>expectContains</b>', detail: `none of: <script>alert('d')</script>` }],
        }),
      ],
    });

    const { body } = await page(evalCasePage, '/evals/case/client-lookup', {
      caseId: 'client-lookup',
    });

    expect(body).not.toContain('<script>alert');
    expect(body).not.toContain('<b>expectContains');
    expect(body).toContain('&lt;script&gt;');
  });
});

/* ─── one case over time ─── */

describe('one case over time', () => {
  it('shows the question as asked, the failed assertions and the trace', async () => {
    reply(
      { when: CASE_RUNS, rows: [caseRow()] },
      { when: FLAKY, rows: [flakyRow({ runs: 2, passes: 1, failures: 1, flaky_since: AT_2211 })] }
    );

    const { body } = await page(evalCasePage, '/evals/case/client-lookup', {
      caseId: 'client-lookup',
    });

    expect(body).toContain('What is the status of Halden Freight');
    expect(body).toContain('expectContains');
    expect(body).toContain('none of: active, halden freight');
    expect(body).toContain(`/runs/${TRACE}`);
    expect(body).toContain('badge is-seal">failed');
    expect(body).toContain('4.2s');
    // The summary uses the same word the overview uses, from the same function.
    expect(body).toContain('unstable');
  });

  it('shows the question of every run, because the roles bind to different records', async () => {
    reply({
      when: CASE_RUNS,
      rows: [
        caseRow({ question: 'What is the status of Halden Freight?' }),
        caseRow({
          question: 'What is the status of Ridgeline Dairy?',
          created_at: AT_2211,
          passed: true,
          failures: [],
        }),
      ],
    });

    const { body } = await page(evalCasePage, '/evals/case/client-lookup', {
      caseId: 'client-lookup',
    });

    expect(body).toContain('Halden Freight');
    expect(body).toContain('Ridgeline Dairy');
    expect(body).toContain('differs between runs');
  });

  it('asks the counting function for the summary rather than counting the rows it has', async () => {
    reply(
      { when: CASE_RUNS, rows: [caseRow(), caseRow({ passed: true, failures: [] })] },
      { when: FLAKY, rows: [flakyRow({ runs: 2, passes: 1, failures: 1, flaky_since: AT_2211 })] }
    );

    await page(evalCasePage, '/evals/case/client-lookup', { caseId: 'client-lookup' });

    expect(h.calls.some((c) => c.text.includes(FLAKY))).toBe(true);
  });

  it('still shows the outcomes when the summary cannot be read, and says what is missing', async () => {
    reply(
      { when: CASE_RUNS, rows: [caseRow()] },
      { when: FLAKY, throws: new Error('canceling statement due to statement timeout') }
    );

    const { body, status } = await page(evalCasePage, '/evals/case/client-lookup', {
      caseId: 'client-lookup',
    });

    expect(status).toBe(200);
    expect(body).toContain('What is the status of Halden Freight');
    expect(body).toContain('summary could not be read');
    expect(body).toContain('cannot be reconstructed');
  });

  it('reads a case id it does not recognise as a typo, with a 404', async () => {
    reply({ when: CASE_RUNS, rows: [] });

    const { body, status } = await page(evalCasePage, '/evals/case/money', { caseId: 'money' });

    expect(status).toBe(404);
    expect(body).toContain('probably a typo');
    expect(body).toContain('money-outstanding');
    expect(body).toContain('money-for-one-client');
  });

  it('distinguishes a known case that has not run in the window', async () => {
    reply({ when: CASE_RUNS, rows: [] });

    const { body, status } = await page(evalCasePage, '/evals/case/client-lookup', {
      caseId: 'client-lookup',
    });

    // Not a 404: the case exists, and the page is waiting on a suite.
    expect(status).toBe(200);
    expect(body).toContain('has not run inside the last');
    expect(body).toContain('npm run eval');
    expect(body).not.toContain('typo');
  });

  it('says a retired case id has a history that will not grow', async () => {
    reply({ when: CASE_RUNS, rows: [caseRow({ case_id: 'outstanding-money' })] });

    const { body } = await page(evalCasePage, '/evals/case/outstanding-money', {
      caseId: 'outstanding-money',
    });

    expect(body).toContain('not in the cases file');
    expect(body).toContain('will not grow');
  });

  it('labels failures stored in a shape it does not know instead of reading them as assertions', async () => {
    reply({ when: CASE_RUNS, rows: [caseRow({ failures: { check: 'not an array' } })] });

    const { body } = await page(evalCasePage, '/evals/case/client-lookup', {
      caseId: 'client-lookup',
    });

    expect(body).toContain('unfamiliar shape');
    expect(body).toContain('written by something else');
  });

  it('says a trace is absent rather than showing a dead link', async () => {
    reply({ when: CASE_RUNS, rows: [caseRow({ agent_run_id: null })] });

    const { body } = await page(evalCasePage, '/evals/case/client-lookup', {
      caseId: 'client-lookup',
    });

    expect(body).toContain('No trace');
    expect(body).toContain('ON DELETE SET NULL');
  });
});

/* ─── one suite in full ─── */

describe('one suite in full', () => {
  it('shows the binding it ran against, including the figures', async () => {
    reply(
      { when: SUITE_BY_PREFIX, rows: [suiteRow()] },
      { when: SUITE_CASES, rows: [caseRow(), caseRow({ passed: true, skipped: true })] }
    );

    const { body } = await page(evalSuitePage, '/evals/suite/a1b2c3d4', { ref: 'a1b2c3d4' });

    expect(body).toContain('Halden Freight');
    // The private version rendered this half of the binding as [object Object].
    expect(body).toContain('outstandingCents=3330000');
    expect(body).toContain('naiveOutstandingCents=4080000');
    expect(body).toContain('does not say what it passed against');
    // The model in FULL here: a trimmed id is not something you can put in a report.
    expect(body).toContain('bedrock/us.anthropic.claude-sonnet-4-5-20250929-v1:0');
    // And the commit in full, for the same reason.
    expect(body).toContain('fa589121a2b3');
  });

  it('does not claim to know why a role is absent from a stored binding', async () => {
    reply({ when: SUITE_BY_PREFIX, rows: [suiteRow()] }, { when: SUITE_CASES, rows: [] });

    const { body } = await page(evalSuitePage, '/evals/suite/a1b2c3d4', { ref: 'a1b2c3d4' });

    expect(body).toContain('not in the stored binding');
    expect(body).toContain('passed_lead');
    expect(body).toContain('did not bind or were not recorded');
  });

  it('refuses an ambiguous prefix and shows what it is ambiguous between', async () => {
    reply({
      when: SUITE_BY_PREFIX,
      rows: [suiteRow(), suiteRow({ id: SUITE_B, started_at: AT_2220 })],
    });

    const { body, status } = await page(evalSuitePage, '/evals/suite/a1b2', { ref: 'a1b2' });

    // 300 Multiple Choices, which is what this is, and no Location: choosing one is
    // the thing being refused.
    expect(status).toBe(300);
    expect(body).toContain('Refusing to pick one');
    expect(body).toContain(SUITE_A);
    expect(body).toContain(SUITE_B);
    // Nothing about either suite has been rendered as though it were the answer.
    expect(body).not.toContain('Roles it was asked about');
  });

  it('does not query for a ref that could not be an id', async () => {
    const { body, status } = await page(evalSuitePage, '/evals/suite/%25', { ref: '%' });

    expect(status).toBe(404);
    expect(body).toContain('not a suite id or a prefix of one');
    expect(h.calls).toHaveLength(0);
  });

  it('says which operator it read as when no suite matches', async () => {
    reply({ when: SUITE_BY_PREFIX, rows: [] });

    const { body, status } = await page(evalSuitePage, '/evals/suite/deadbeef', {
      ref: 'deadbeef',
    });

    expect(status).toBe(404);
    expect(body).toContain('deadbeef');
    expect(body).toContain(USER);
  });

  it('says when the suite totals and the stored case rows disagree', async () => {
    reply(
      { when: SUITE_BY_PREFIX, rows: [suiteRow({ total: 2, passed: 1, failed: 1, skipped: 0 })] },
      { when: SUITE_CASES, rows: [caseRow()] }
    );

    const { body } = await page(evalSuitePage, '/evals/suite/a1b2c3d4', { ref: 'a1b2c3d4' });

    expect(body).toContain('did not land');
    expect(body).toContain('does not add up');
  });

  it('says a suite that wrote no case rows opened and recorded nothing', async () => {
    reply({ when: SUITE_BY_PREFIX, rows: [suiteRow()] }, { when: SUITE_CASES, rows: [] });

    const { body } = await page(evalSuitePage, '/evals/suite/a1b2c3d4', { ref: 'a1b2c3d4' });

    expect(body).toContain('none recorded');
    expect(body).toContain('recording must never break the thing it records');
  });

  it('links each case to its own history and each failure to its trace', async () => {
    reply(
      { when: SUITE_BY_PREFIX, rows: [suiteRow()] },
      { when: SUITE_CASES, rows: [caseRow(), caseRow({ case_id: 'money-outstanding', passed: true, failures: [] })] }
    );

    const { body } = await page(evalSuitePage, '/evals/suite/a1b2c3d4', { ref: 'a1b2c3d4' });

    expect(body).toContain('/evals/case/client-lookup');
    expect(body).toContain('/evals/case/money-outstanding');
    // One trace link, on the failure. A column of them under passing cases buries the
    // row somebody came here to read.
    expect(body.split(`/runs/${TRACE}`)).toHaveLength(2);
  });
});
