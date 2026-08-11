/**
 * What the history PRINTS, and what it refuses to claim.
 *
 * This file exists because the output is the whole product: `history.ts` computes
 * almost nothing, and every judgment it makes is a sentence on a terminal. A
 * regression here does not throw — it prints a calm report that reads as though
 * nothing is wrong. Three of the cases below are about exactly that:
 *
 *   * one suite must NOT be reported as stability. "Every case gave the same verdict
 *     every time" from a single sample is the unfounded reassurance the whole eval
 *     suite exists to stop being made;
 *   * a failed stability query must not leave a report that looks complete;
 *   * a case with both a pass and a failure must say so in the word the design uses,
 *     because that line is the reason the tables exist.
 *
 * The database is a set of canned replies keyed by a fragment of each statement, so
 * nothing here needs Postgres — which is also the limit of what it proves. No SQL is
 * executed anywhere in this repository's suite, so a wrong column name or a
 * statement Postgres would reject passes everything below. What is checked is the
 * reading of rows and the words chosen for them.
 *
 * `history.ts` is a script: it runs on import and sets `process.exitCode`. So each
 * case sets `process.argv`, resets the module registry, imports it, and reads back
 * the two streams — the same harness as `src/cli.test.ts`, for the same reason.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CASES } from './cases';

/** `vi.hoisted`, because `vi.mock`'s factory is lifted above the imports. */
const h = vi.hoisted(() => ({
  /** Every statement sent, flattened, with its parameters. */
  calls: [] as Array<{ text: string; params: unknown[] }>,
  /**
   * Canned replies, matched on a fragment of the statement rather than queued in
   * order. A queue would make every case depend on how many reads the file happens
   * to make, and the reads are an implementation detail — which table was asked is
   * not.
   */
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

/* ─── the statements, by the fragment that identifies each one ─── */

/** The window of suites. Distinguished from the prefix lookup, which also selects
 * from `agent_eval_suites` for one operator. */
const SUITES = 'user_id = $1 ORDER BY started_at';
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
    // 64 seconds, so the duration column has both halves to format.
    finished_at: new Date('2026-08-10T22:12:04Z'),
    model_id: 'bedrock/us.anthropic.claude-sonnet-4-5-20250929-v1:0',
    git_sha: 'fa58912',
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
    git_sha: 'fa58912',
    ...over,
  };
}

/* ─── driving it ─── */

interface Output {
  out: string;
  err: string;
  code: number | undefined;
}

async function history(...argv: string[]): Promise<Output> {
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    outChunks.push(String(chunk));
    return true;
  });
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    errChunks.push(String(chunk));
    return true;
  });

  const argvWas = process.argv;
  process.argv = ['node', 'history.ts', ...argv];
  process.exitCode = undefined;
  vi.resetModules();

  let code: number | undefined;
  try {
    await import('./history');
  } finally {
    code = process.exitCode as number | undefined;
    process.argv = argvWas;
    // Restored, so a case that exercises exit 2 does not hand the worker a non-zero
    // code and fail the whole file on its way out.
    process.exitCode = undefined;
    stdout.mockRestore();
    stderr.mockRestore();
  }

  return { out: outChunks.join(''), err: errChunks.join(''), code };
}

const reply = (...rs: Array<{ when: string; rows?: unknown[]; throws?: unknown }>) =>
  h.replies.push(...rs);

const envWas = { url: process.env.DATABASE_URL, user: process.env.USER_ID };

beforeEach(() => {
  h.calls.length = 0;
  h.replies.length = 0;
  process.env.DATABASE_URL = 'postgres://business_agent@localhost:5432/business_agent';
  process.env.USER_ID = USER;
});

afterEach(() => {
  process.env.DATABASE_URL = envWas.url;
  process.env.USER_ID = envWas.user;
});

/* ─── the default view ─── */

describe('the default view', () => {
  it('lists each suite with its commit, model and duration', async () => {
    reply({ when: SUITES, rows: [suiteRow()] }, { when: FLAKY, rows: [flakyRow()] });

    const { out, code } = await history();

    expect(code).toBe(0);
    expect(out).toContain('2026-08-10 22:11Z');
    expect(out).toContain('a1b2c3d4'); // the suite id, short, so --suite= is reachable
    expect(out).toContain('fa58912');
    // The affixes are trimmed and the provider is kept.
    expect(out).toContain('bedrock/claude-sonnet-4-5');
    expect(out).toContain('1m04s');
    expect(out).toContain('1 skipped');
  });

  it('leaves an unfamiliar model id whole rather than matching part of it', async () => {
    reply(
      { when: SUITES, rows: [suiteRow({ model_id: 'someone-elses-model-v9' })] },
      { when: FLAKY, rows: [flakyRow()] }
    );

    const { out } = await history();

    expect(out).toContain('someone-elses-model-v9');
  });

  it('says a suite did not finish rather than reporting its zeros as a result', async () => {
    reply(
      {
        when: SUITES,
        rows: [suiteRow({ finished_at: null, total: 17, passed: 0, failed: 0, skipped: 0 })],
      },
      { when: FLAKY, rows: [flakyRow()] }
    );

    const { out } = await history();

    expect(out).toContain('did not finish');
    expect(out).toContain('17 of 17');
    expect(out).toContain('unfinished');
  });

  it('names a case that produced both verdicts as unstable', async () => {
    reply(
      { when: SUITES, rows: [suiteRow(), suiteRow({ id: SUITE_B, started_at: AT_2220 })] },
      {
        when: FLAKY,
        rows: [flakyRow({ runs: 2, passes: 1, failures: 1, flaky_since: AT_2211 })],
      }
    );

    const { out } = await history();

    expect(out).toContain('UNSTABLE');
    expect(out).toContain('1 pass  1 fail');
    // Not "unstable since": the window is the only evidence there is.
    expect(out).toContain('earliest outcome still in the window');
  });

  it('refuses to call one suite stable', async () => {
    reply({ when: SUITES, rows: [suiteRow()] }, { when: FLAKY, rows: [flakyRow()] });

    const { out } = await history();

    expect(out).toContain('at least two runs');
    expect(out).not.toContain('same verdict every time');
  });

  it('reports stability once there are two suites to compare', async () => {
    reply(
      { when: SUITES, rows: [suiteRow(), suiteRow({ id: SUITE_B, started_at: AT_2220 })] },
      { when: FLAKY, rows: [flakyRow()] }
    );

    const { out } = await history();

    expect(out).toContain('same verdict every time');
    expect(out).not.toContain('at least two runs');
  });

  it('exits non-zero when stability could not be read, and says the section is missing', async () => {
    reply(
      { when: SUITES, rows: [suiteRow()] },
      { when: FLAKY, throws: new Error('function agent_eval_flaky(uuid, integer) does not exist') }
    );

    const { out, err, code } = await history();

    // The suites that were read are still worth printing.
    expect(out).toContain('a1b2c3d4');
    expect(err).toContain('Could not read stability');
    expect(err).toContain('agent_eval_flaky');
    expect(err).toContain('everything is stable');
    expect(code).toBe(1);
  });

  it('separates a case that only ever skipped from a case that failed', async () => {
    reply(
      { when: SUITES, rows: [suiteRow(), suiteRow({ id: SUITE_B, started_at: AT_2220 })] },
      {
        when: FLAKY,
        rows: [
          flakyRow({ case_id: 'unknown-client', runs: 2, passes: 0, failures: 0, skips: 2 }),
        ],
      }
    );

    const { out } = await history();

    expect(out).toContain('Never ran in this window');
    expect(out).toContain('unknown-client');
    expect(out).toContain('db:check');
    // A skip is not a failure, and nothing above may have called it one.
    expect(out).toContain('same verdict every time');
  });

  it('names the cases in the file that this window has no outcome for', async () => {
    reply(
      { when: SUITES, rows: [suiteRow(), suiteRow({ id: SUITE_B, started_at: AT_2220 })] },
      { when: FLAKY, rows: [flakyRow({ case_id: 'client-lookup' })] }
    );

    const { out } = await history();

    expect(out).toContain('absent from this window');
    expect(out).toContain(`${CASES.length - 1} of ${CASES.length}`);
    expect(out).toContain('budget-is-reported');
  });

  it('names an id in the history that the cases file no longer has', async () => {
    reply(
      { when: SUITES, rows: [suiteRow(), suiteRow({ id: SUITE_B, started_at: AT_2220 })] },
      { when: FLAKY, rows: [flakyRow({ case_id: 'outstanding-money' })] }
    );

    const { out } = await history();

    expect(out).toContain('no longer in the cases file');
    expect(out).toContain('outstanding-money');
  });

  it('says which operator it read as when there is nothing recorded', async () => {
    reply({ when: SUITES, rows: [] });

    const { out, code } = await history();

    expect(out).toContain('No eval history for this operator yet');
    expect(out).toContain(`USER_ID=${USER}`);
    expect(out).toContain('run.ts');
    expect(code).toBe(0);
  });
});

/* ─── one case over time ─── */

describe('one case over time', () => {
  it('prints the question as asked, the failed assertions, and the trace', async () => {
    reply(
      { when: CASE_RUNS, rows: [caseRow()] },
      { when: FLAKY, rows: [flakyRow({ runs: 2, passes: 1, failures: 1, flaky_since: AT_2211 })] }
    );

    const { out, code } = await history('--case=client-lookup');

    expect(out).toContain('asked: What is the status of Halden Freight');
    expect(out).toContain('✗ expectContains — none of: active, halden freight');
    expect(out).toContain(`trace: agent_runs/${TRACE}`);
    expect(out).toContain('FAIL');
    // The summary uses the same word the default view uses, from the same function.
    expect(out).toContain('UNSTABLE');
    expect(code).toBe(0);
  });

  it('still prints the runs when the verdict summary cannot be read, and says so', async () => {
    reply(
      { when: CASE_RUNS, rows: [caseRow()] },
      { when: FLAKY, throws: new Error('canceling statement due to statement timeout') }
    );

    const { out, err, code } = await history('--case=client-lookup');

    expect(out).toContain('asked: What is the status of Halden Freight');
    expect(err).toContain('Could not read the stability summary');
    // The summary is the one line here that applies the counting rule, so a reader
    // cannot reconstruct it by eye and the code says the report is short of it.
    expect(code).toBe(1);
  });

  it('tolerates failures stored in a shape it does not know', async () => {
    reply({ when: CASE_RUNS, rows: [caseRow({ failures: { check: 'not an array' } })] });

    const { out, code } = await history('--case=client-lookup');

    expect(out).toContain('unfamiliar shape');
    expect(code).toBe(0);
  });

  it('says a case id it does not recognise is probably a typo', async () => {
    reply({ when: CASE_RUNS, rows: [] });

    const { out } = await history('--case=money');

    expect(out).toContain('probably a typo');
    expect(out).toContain('money-outstanding');
    expect(out).toContain('money-for-one-client');
  });

  it('distinguishes a known case that has not run in the window', async () => {
    reply({ when: CASE_RUNS, rows: [] });

    const { out } = await history('--case=client-lookup');

    expect(out).toContain('has not run inside this window');
    expect(out).not.toContain('typo');
  });
});

/* ─── one suite in full ─── */

describe('one suite in full', () => {
  it('prints the binding it ran against, including the figures', async () => {
    reply(
      { when: SUITE_BY_PREFIX, rows: [suiteRow()] },
      { when: SUITE_CASES, rows: [caseRow()] }
    );

    const { out, code } = await history('--suite=a1b2c3d4');

    expect(out).toContain(`Suite ${SUITE_A}`);
    // The model in full here: a trimmed id is not something you can put in a report.
    expect(out).toContain('bedrock/us.anthropic.claude-sonnet-4-5-20250929-v1:0');
    expect(out).toContain('Halden Freight');
    // The private version rendered this half of the binding as [object Object].
    expect(out).toContain('outstandingCents=3330000');
    expect(out).toContain('naiveOutstandingCents=4080000');
    expect(code).toBe(0);
  });

  it('does not claim to know why a role is absent from a stored binding', async () => {
    reply({ when: SUITE_BY_PREFIX, rows: [suiteRow()] }, { when: SUITE_CASES, rows: [] });

    const { out } = await history('--suite=a1b2c3d4');

    expect(out).toContain('not in the stored binding');
    expect(out).toContain('passed_lead');
    expect(out).toContain('did not bind or were not recorded');
  });

  it('refuses an ambiguous prefix and shows the matches', async () => {
    reply({
      when: SUITE_BY_PREFIX,
      rows: [suiteRow(), suiteRow({ id: SUITE_B, started_at: AT_2220 })],
    });

    const { out, err, code } = await history('--suite=a1b2');

    expect(err).toContain('matches 2 suites');
    expect(err).toContain('Refusing to pick one');
    // Nothing about either suite may have been printed as though it were the answer.
    expect(out).toBe('');
    expect(code).toBe(2);
  });

  it('says when the case rows and the suite totals disagree', async () => {
    reply(
      { when: SUITE_BY_PREFIX, rows: [suiteRow({ total: 2, passed: 1, failed: 1, skipped: 0 })] },
      { when: SUITE_CASES, rows: [caseRow()] }
    );

    const { out } = await history('--suite=a1b2c3d4');

    expect(out).toContain('did not land');
  });
});

/* ─── refusals ─── */

describe('refusals', () => {
  it('refuses a window that is not a number, without reading anything', async () => {
    const { err, code } = await history('--suites=lots');

    expect(err).toContain('--suites=lots');
    expect(code).toBe(2);
    expect(h.calls).toHaveLength(0);
  });

  it('refuses a window of zero', async () => {
    const { code, err } = await history('--suites=0');

    expect(err).toContain('out of range');
    expect(code).toBe(2);
  });

  it('refuses to answer one of two questions when both were asked', async () => {
    const { err, code } = await history('--case=client-lookup', '--suite=a1b2c3d4');

    expect(err).toContain('two different views');
    expect(code).toBe(2);
    expect(h.calls).toHaveLength(0);
  });

  it('refuses --suites beside --suite rather than ignoring it', async () => {
    const { err, code } = await history('--suite=a1b2c3d4', '--suites=50');

    expect(err).toContain('Nothing would be widened');
    expect(code).toBe(2);
  });

  it('reads a bare argument as a mistake, not as the default view', async () => {
    reply({ when: SUITES, rows: [suiteRow()] });

    const { err, code } = await history('client-lookup');

    expect(err).toContain('--case=client-lookup');
    expect(code).toBe(2);
    expect(h.calls).toHaveLength(0);
  });

  it('refuses a suite ref that could not be an id', async () => {
    const { err, code } = await history('--suite=%');

    expect(err).toContain('not a uuid or a prefix of one');
    expect(code).toBe(2);
    expect(h.calls).toHaveLength(0);
  });

  it('refuses an unknown flag instead of silently printing the default view', async () => {
    const { err, code } = await history('--suits=5');

    expect(err).toContain('Unrecognised flag');
    expect(code).toBe(2);
  });

  it('names the missing variable when the environment is not set', async () => {
    delete process.env.USER_ID;

    const { err, code } = await history();

    expect(err).toContain('USER_ID is not set');
    expect(code).toBe(2);
    expect(h.calls).toHaveLength(0);
  });

  it('refuses a USER_ID that is not a uuid rather than sending it to Postgres', async () => {
    process.env.USER_ID = 'bradley';

    const { err, code } = await history();

    expect(err).toContain('not a uuid');
    expect(code).toBe(2);
    expect(h.calls).toHaveLength(0);
  });

  it('prints help with no environment at all', async () => {
    delete process.env.DATABASE_URL;
    delete process.env.USER_ID;

    const { out, code } = await history('--help');

    expect(out).toContain('usage:');
    expect(out).toContain('--case=<case-id>');
    expect(code).toBe(0);
  });
});
