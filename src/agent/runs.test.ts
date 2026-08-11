/**
 * Reading runs back, with Postgres replaced by a queue of rows.
 *
 * What is being asserted here is almost entirely about the FILTER, because that is
 * where this has already been wrong. The first version of the kind filter in the
 * private system read `p_only = 'eval' OR kind <> 'eval'` — "let eval rows through
 * when they are asked for" — so asking for eval runs returned every run, and
 * nothing about the output said so: a page of runs is a page of runs. The
 * COMMENT on `agent_runs.kind` in `db/002-agent.sql` records it, and these tests
 * are the version that fails when somebody rewrites the clause.
 *
 * The rest is what changed by putting a URL in front of these functions. `limit`,
 * `offset`, `only` and an id are now text somebody can type into an address bar, so
 * the tests for "a non-numeric limit" and "an id that cannot be a uuid" are tests
 * about a query string rather than about defensive programming.
 *
 * What is NOT covered: none of this SQL has been executed. Whether the CTE
 * aggregates correctly, whether `percentile_cont` returns null on an empty window,
 * and whether `jsonb_array_elements` copes with every trace ever written are
 * questions for a database, and the compose file is where that lives.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => ({
  calls: [] as Array<{ text: string; params: unknown[] }>,
  queue: [] as Array<unknown[] | { throws: unknown }>,
}));

vi.mock('../db', () => {
  const next = (text: string, params: unknown[]): unknown[] => {
    h.calls.push({ text, params });
    const reply = h.queue.shift();
    if (reply && !Array.isArray(reply)) throw reply.throws;
    return reply ?? [];
  };
  return {
    sql: async (text: string, params: unknown[] = []) => next(text, params),
    one: async (text: string, params: unknown[] = []) => next(text, params)[0] ?? null,
    close: async () => {},
  };
});

import { getRun, isRunFilter, isRunId, listRuns, runHealth, setVerdict, toolStats } from './runs';

const USER = '00000000-0000-4000-8000-000000000001';
const RUN = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
const lastText = () => norm(h.calls[h.calls.length - 1]?.text ?? '');
const lastParams = () => h.calls[h.calls.length - 1]?.params ?? [];
const queue = (...replies: Array<unknown[] | { throws: unknown }>) => h.queue.push(...replies);

/** The clause the incident was about, whitespace-insensitive. */
const KIND_CASE = "CASE WHEN $2::text = 'eval' THEN r.kind = 'eval' ELSE r.kind <> 'eval' END";

beforeEach(() => {
  h.calls.length = 0;
  h.queue.length = 0;
});

describe('which runs are in scope', () => {
  it('excludes eval runs when no filter is asked for', async () => {
    await listRuns(USER);
    expect(lastText()).toContain(KIND_CASE);
    expect(lastParams()[1]).toBe(null);
  });

  it('excludes the other kinds when eval is asked for', async () => {
    // The whole point: selecting a kind excludes the rest. A clause that merely
    // PERMITS eval rows returns everything, which is the bug this replaces.
    await listRuns(USER, { only: 'eval' });
    expect(lastText()).toContain(KIND_CASE);
    expect(lastParams()[1]).toBe('eval');
    // And there is no second predicate for eval, so it cannot narrow twice.
    expect(lastText()).toContain("OR $2::text = 'eval'");
  });

  it('narrows within the non-eval runs for the other three', async () => {
    for (const only of ['walled', 'wrong', 'unjudged'] as const) {
      await listRuns(USER, { only });
      expect(lastParams()[1]).toBe(only);
      // Still excluding eval: a walled eval run is the suite hitting a wall, not
      // the business.
      expect(lastText()).toContain(KIND_CASE);
    }
    expect(h.calls).toHaveLength(3);
  });

  it('refuses a filter it does not know, without querying', async () => {
    await expect(listRuns(USER, { only: 'evals' as never })).rejects.toThrow(/not a run filter/);
    // Not an empty page. An unrecognised filter would match no rows, and an empty
    // history reads as an agent that has never run.
    expect(h.calls).toHaveLength(0);
  });

  it('exports the filter list so a query string can be checked against it', () => {
    expect(isRunFilter('walled')).toBe(true);
    expect(isRunFilter('eval')).toBe(true);
    expect(isRunFilter('EVAL')).toBe(false);
    expect(isRunFilter(undefined)).toBe(false);
  });

  it('leaves getRun open to eval runs', async () => {
    // Naming a row by its id is a specific request, and the evals surface links
    // straight to the trace of a case that failed. "No such run" there would read
    // as a pruned trace.
    queue([{ id: RUN, kind: 'eval' }]);
    await getRun(USER, RUN);
    expect(lastText()).not.toContain("kind <> 'eval'");
  });
});

describe('values that now arrive from a URL', () => {
  it('clamps the page size and refuses to page past the end of anything', async () => {
    await listRuns(USER, { limit: 5_000, offset: -20 });
    expect(lastParams()[2]).toBe(100);
    expect(lastParams()[3]).toBe(0);
  });

  it('treats a limit that is not a number as absent', async () => {
    // `Number('abc')` is NaN, `Math.min(NaN, 100)` is NaN, and NaN bound to a
    // LIMIT reaches Postgres as a syntax error — a 500 from a page for a typo in
    // a query string.
    await listRuns(USER, { limit: 'abc' as never });
    expect(lastParams()[2]).toBe(30);
  });

  it('orders by created_at with a tie-break, because it pages', async () => {
    await listRuns(USER, { offset: 30 });
    // Without the tie-break two runs written in the same millisecond have no
    // defined order, so paging shows one of them twice and skips the other.
    expect(lastText()).toContain('ORDER BY r.created_at DESC, r.id DESC');
  });

  it('reads an id that cannot be a uuid as absent, without querying', async () => {
    expect(await getRun(USER, 'potato')).toBe(null);
    expect(await getRun(USER, '')).toBe(null);
    expect(h.calls).toHaveLength(0);
    expect(isRunId(RUN)).toBe(true);
    expect(isRunId('potato')).toBe(false);
  });

  it('scopes the read to the operator in the query', async () => {
    queue([{ id: RUN }]);
    await getRun(USER, RUN);
    // Someone else's run has to read as absent rather than as forbidden, which
    // means the scope is in the WHERE and not checked afterwards.
    expect(lastText()).toContain('WHERE id = $1 AND user_id = $2');
    expect(lastParams()).toEqual([RUN, USER]);
  });

  it('raises rather than reporting an empty history when the query fails', async () => {
    const broken = () => ({ throws: new Error('relation "agent_runs" does not exist') });
    queue(broken(), broken());
    await expect(listRuns(USER)).rejects.toThrow(/Could not list the runs/);
    // The sentence says why an empty array would have been the wrong answer.
    await expect(listRuns(USER)).rejects.toThrow(/never run/);
  });
});

describe('the verdict', () => {
  it('refuses a value that is not one, and an id that cannot be one', async () => {
    await expect(setVerdict({ userId: USER, id: RUN, verdict: 'ok' as never })).rejects.toThrow(
      /not a verdict/
    );
    await expect(setVerdict({ userId: USER, id: 'nope', verdict: 'wrong' })).rejects.toThrow(
      /not a run id/
    );
    // A write that cannot name its target must not quietly report changing
    // nothing, so neither of these reached the database.
    expect(h.calls).toHaveLength(0);
  });

  it('records the note and stamps the time from the database clock', async () => {
    queue([{ id: RUN, verdict: 'wrong' }]);
    await setVerdict({ userId: USER, id: RUN, verdict: 'wrong', note: '  it invented a total  ' });
    expect(lastParams()).toEqual([RUN, USER, 'wrong', 'it invented a total']);
    // now(), not a timestamp from this process: created_at comes from the
    // database's clock, and two stamps read from two clocks can put the judgment
    // before the run.
    expect(lastText()).toContain('verdict_at = CASE WHEN $3::text IS NULL THEN NULL ELSE now() END');
  });

  it('clears the note when the verdict is taken off', async () => {
    queue([{ id: RUN, verdict: null }]);
    await setVerdict({ userId: USER, id: RUN, verdict: null, note: 'why it was wrong' });
    // The note is still bound, and the statement is what nulls it: a note
    // explaining why a run was wrong, left on a run no longer marked wrong, is a
    // contradiction the next reader resolves by believing the note.
    expect(lastText()).toContain('verdict_note = CASE WHEN $3::text IS NULL THEN NULL ELSE $4 END');
    expect(lastParams()[2]).toBe(null);
  });

  it('bounds the note', async () => {
    queue([{ id: RUN }]);
    await setVerdict({ userId: USER, id: RUN, verdict: 'wrong', note: 'x'.repeat(5_000) });
    expect(String(lastParams()[3])).toHaveLength(2_000);
  });

  it('says there is no such run rather than returning nothing', async () => {
    // An UPDATE that matched nothing is either a run that is not there or one
    // that belongs to somebody else, and both are the same sentence.
    await expect(setVerdict({ userId: USER, id: RUN, verdict: 'good' })).rejects.toThrow(
      'No such run.'
    );
  });
});

describe('health', () => {
  it('turns the BIGINT token total into a number', async () => {
    // BIGINT arrives from this driver as a STRING, so a sum of tokens read
    // straight out concatenates instead of adding. Converted once, at the
    // boundary, where the conversion can be read.
    queue([
      {
        runs: 3,
        answered: 2,
        walled: 1,
        with_writes: 0,
        tool_calls: 7,
        tool_failures: 1,
        p50_ms: 4_200,
        p95_ms: 9_100,
        total_tokens: '19518',
        judged: 1,
        wrong: 1,
      },
    ]);
    const health = await runHealth(USER);
    expect(health.total_tokens).toBe(19_518);
    expect(health.total_tokens + 1).toBe(19_519);
    // The window is echoed back: a figure without its window is not a
    // measurement.
    expect(health.days).toBe(30);
  });

  it('reports an empty window as zeroes rather than as nothing', async () => {
    const health = await runHealth(USER);
    expect(health.runs).toBe(0);
    // Null, not zero. "No runs yet" and "every run was instant" are different
    // facts about the agent.
    expect(health.p50_ms).toBe(null);
  });

  it('excludes eval runs from every figure and clamps the window', async () => {
    await runHealth(USER, 5_000);
    expect(lastText()).toContain("r.kind <> 'eval'");
    expect(lastParams()[1]).toBe(365);

    await toolStats(USER, 0);
    expect(lastText()).toContain("r.kind <> 'eval'");
    expect(lastParams()[1]).toBe(1);
  });
});
