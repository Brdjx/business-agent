/**
 * Reading the runs back.
 *
 * Every run since the first has written a trace, and nothing in this repository
 * has ever read one. `persistRun` inserts, `agent_runs.trace` fills up, and the
 * only way to see any of it is to open psql. A trace nobody can read is a log
 * file, not observability.
 *
 * That matters more here than it sounds. An agent is non-deterministic by
 * construction, so the only way to know whether a change made it better is to
 * look at what it actually did, repeatedly, on real questions — which tools it
 * reached for, which ones failed, how often it hit a wall, how long it took, what
 * it cost. All of that is already in the database.
 *
 * ── Why a verdict and not a score ──
 *
 * The suite in `evals/` tests the failures somebody imagined. The failures worth
 * testing are the ones that already happened, and those only exist here, in the
 * runs. A run marked wrong with one sentence saying why is the raw material for a
 * case that could not have been invented in advance.
 *
 * Two values and a note, deliberately. A five-point scale invites arguing with
 * yourself about whether something was a three or a four, and the result is that
 * nothing gets judged at all. Null is the honest majority, and an unjudged run is
 * never counted as a good one — `runHealth` reports `judged` and `wrong`
 * separately for exactly that reason.
 *
 * ── Eval runs are excluded from everything, unless asked for by name ──
 *
 * `agent_runs.kind` exists so that the suite's runs can be told apart from a
 * person's by a column rather than by matching text a caller chose. Seventeen
 * synthetic runs land per execution, which is already more than an operator
 * produces in a week: counted in, every figure below would quietly become a
 * statement about the test suite.
 *
 * So `listRuns` and `runHealth` exclude `kind = 'eval'`, and `only: 'eval'` is
 * the only way to see them — and it EXCLUDES the others. The first version of
 * that filter in the private system read `p_only = 'eval' OR kind <> 'eval'`,
 * which is "let eval rows through when they are asked for", so asking for eval
 * runs returned every run. Selecting a kind has to exclude the rest, not merely
 * permit the one. The `CASE` below is written that way on purpose, and the
 * COMMENT on `agent_runs.kind` in `db/002-agent.sql` says the same thing where
 * the column is defined.
 *
 * `getRun` deliberately does NOT exclude eval runs. Naming a row by its id is a
 * specific request, and the evals surface links straight to the trace of a case
 * that failed; a reader who followed that link and got "no such run" would
 * conclude the trace was pruned.
 *
 * ── Where the numbers come from ──
 *
 * Postgres, not here. The same rule the agent lives under applies to the agent's
 * own figures: a total is computed where the rows are. `trace` is also the
 * largest column in this schema, and the list needs three facts out of it, so the
 * derivation happens in SQL and the JSONB never leaves the database to render a
 * table.
 *
 * ── Notes from the port ──
 *
 * The private original called three plpgsql functions through Supabase RPC
 * (`agent_run_list`, `agent_health`, `agent_tool_stats`). These are the same
 * queries as plain SQL with `$1` placeholders, held here rather than added to
 * `db/`, because the files under `db/` are applied once on the first boot of an
 * empty volume: a function added there would be absent from every database that
 * already exists, and the failure would read as a broken UI rather than as an
 * unapplied migration. Queries in the file that uses them cannot go stale that
 * way.
 *
 * Three differences that are silent wrong answers rather than errors:
 *
 * TIMESTAMPTZ comes back as a `Date`, not an ISO string — `src/db.ts` overrides
 * the DATE parser only. The original typed `created_at` as `string` and sliced
 * it, which throws here.
 *
 * BIGINT and NUMERIC come back as STRINGS. `count(*)` is BIGINT, so every count
 * below is cast to `int` in the SELECT and the exported types are honestly
 * numbers. `sum(tokens)` is the one figure that is a sum of values rather than a
 * count of rows, so it stays BIGINT and is converted once, at the boundary, where
 * the conversion can be read.
 *
 * `.eq('user_id', …)` became a `WHERE` clause written by hand. There is no helper
 * that remembers the scope — see the note at the top of `src/db.ts` — so every
 * query here carries `user_id` explicitly, and `getRun` and `setVerdict` scope in
 * the query rather than checking afterwards: another operator's run has to read as
 * absent rather than as forbidden.
 */

import { one, sql } from '../db';
import type { Evidence } from './tools';
import type { TraceStep } from './loop';
import type { RunKind } from './trace';

export type Verdict = 'good' | 'wrong';

/**
 * The questions actually asked of a run history.
 *
 * The first three narrow within the runs a person and the watch produced. `eval`
 * is different in kind: it swaps which runs are in scope at all, because the
 * suite's runs are excluded from every other view.
 *
 * Exported as a list as well as a type so that the web layer can validate a query
 * string against it without keeping a second copy of the four words. A filter
 * arriving from a URL is an untrusted string, and an unrecognised one must be
 * refused rather than turned into an empty page — "no runs match" and "you
 * mistyped the filter" are different findings, and the first is a statement about
 * the business.
 */
export const RUN_FILTERS = ['walled', 'wrong', 'unjudged', 'eval'] as const;

export type RunFilter = (typeof RUN_FILTERS)[number];

export function isRunFilter(value: unknown): value is RunFilter {
  return typeof value === 'string' && (RUN_FILTERS as readonly string[]).includes(value);
}

/**
 * A row of the history, deliberately without the trace.
 *
 * Column names rather than camel case, and a `type` rather than an `interface`:
 * `sql<T>` constrains `T` to pg's `QueryResultRow`, which is an index signature,
 * and TypeScript gives an implicit index signature to object type aliases and not
 * to interfaces. Same reasoning as `Proposal` in `proposals.ts`, and the same
 * benefit — the SQL below is checkable against `db/002-agent.sql` by eye.
 */
export type RunSummary = {
  id: string;
  /** Who asked: `operator`, `watch`, or `eval`. Shown, because a list that
   * silently excludes one kind should be able to say what it is showing. */
  kind: RunKind;
  question: string;
  /** The first 280 characters of the answer. The whole thing is on the detail. */
  answer_preview: string;
  stop_reason: string;
  steps: number;
  tokens: number;
  duration_ms: number;
  writes_allowed: boolean;
  /** Tool names in call order, repeats kept: `find_client, find_client,
   * find_client` is a model going in circles, and collapsing it hides that. */
  tools: string[];
  tool_failures: number;
  evidence_count: number;
  /** How many steps the stored trace holds, so a list can say a run is worth
   * opening without shipping the trace to decide. */
  trace_steps: number;
  verdict: Verdict | null;
  verdict_note: string | null;
  created_at: Date;
};

/**
 * One run, with everything it recorded.
 *
 * `evidence` and `trace` arrive from JSONB columns, which means they are whatever
 * is in the row rather than whatever these types say. The columns are written by
 * `persistRun` and nothing else, so the shapes are right in practice — but a
 * renderer must still treat every string in them as untrusted text (the model
 * wrote the tool arguments, and a client name inside `evidence` came from the
 * business) and must not assume a field is present.
 */
export type RunDetail = {
  id: string;
  kind: RunKind;
  question: string;
  answer: string | null;
  stop_reason: string;
  steps: number;
  tokens: number;
  duration_ms: number;
  writes_allowed: boolean;
  evidence: Evidence[];
  trace: TraceStep[];
  verdict: Verdict | null;
  verdict_note: string | null;
  verdict_at: Date | null;
  created_at: Date;
};

/**
 * How the agent is doing over a window. One row, every figure a count or a
 * percentile over rows that already exist — nothing is sampled and nothing is
 * estimated, so a number that looks wrong is a bug in the agent rather than in
 * the measurement.
 */
export interface RunHealth {
  /** The window this describes, in days, echoed back. A figure without its
   * window is not a measurement. */
  days: number;
  runs: number;
  answered: number;
  /** A wall is a reported outcome and not an error. A rising share of them means
   * the questions are outgrowing the budget. */
  walled: number;
  /** Runs that were allowed to change something. Worth watching on its own: it
   * should be rare, and a climb means the read-only default is being worked
   * around rather than used. */
  with_writes: number;
  tool_calls: number;
  tool_failures: number;
  /** Null for an empty window. An empty window is still a window — "no runs in
   * the last 30 days" is a fact about the agent, not a missing measurement. */
  p50_ms: number | null;
  p95_ms: number | null;
  total_tokens: number;
  judged: number;
  wrong: number;
}

/**
 * Per tool: how often it is reached for, how often it fails, how slow it is.
 *
 * The view that says which tool the model cannot use properly — and a tool with a
 * high failure rate is usually a tool whose description is wrong, not a model
 * that is stupid.
 */
export type ToolStat = {
  tool_name: string;
  calls: number;
  failures: number;
  p50_ms: number | null;
  max_ms: number | null;
};

/** Any uuid version, as `src/cli.ts` and `proposals.ts` accept one. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether a string could name a run at all. Exported so a router can tell a
 * malformed path from a missing row before it queries. */
export const isRunId = (value: unknown): boolean =>
  typeof value === 'string' && UUID.test(value.trim());

/** A page of history, not a table dump. The cap is on the caller's side of the
 * query so a `?limit=100000` in a URL cannot ask Postgres for the whole table. */
const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;

/**
 * How much of the answer a list row carries. Enough to recognise the run, not
 * enough to read instead of opening it.
 *
 * Interpolated into the SQL below rather than bound, because it is a number
 * literal from this file and never a value from anywhere else — the same
 * distinction `cardColumns` in `proposals.ts` relies on.
 */
const PREVIEW = 280;

/**
 * The furthest a page may skip.
 *
 * Not defensive padding: `OFFSET` makes Postgres produce and discard every row
 * before the window, so `?offset=50000000` from a URL is a full scan of the table
 * to return nothing. A page beyond this is empty either way, and refusing to ask
 * for it costs nobody anything.
 */
const MAX_OFFSET = 100_000;

/** Windows, in days. A year is the widest thing worth asking for; 0 would report
 * an empty window, which is indistinguishable from an agent that has never run. */
const DEFAULT_DAYS = 30;
const MAX_DAYS = 365;

/**
 * A whole number in range, from something that may be anything.
 *
 * Written because these values now arrive from a query string rather than from
 * code. `Number('abc')` is NaN, `Math.min(NaN, 100)` is NaN, and NaN sent as a
 * bound parameter reaches Postgres as `NaN` and fails the LIMIT with a syntax
 * error — a 500 from a page for a typo in a URL. A non-number is treated as
 * absent instead, which is what the reader of `/runs?limit=` meant.
 */
function bounded(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), min), max);
}

/* ─── the list ─── */

/**
 * A page of runs, newest first.
 *
 * RAISES on a query failure rather than returning an empty array, and the absence
 * of a `catch` that swallows is the point — the same rule `listProposals` lives
 * under. An empty list reads as "the agent has not run", which is a statement
 * about the business that a broken query is not entitled to make. That exact bug
 * shipped in the private original on the approval desk: a join failed, the read
 * returned `data ?? []`, and the desk went blank.
 *
 * There is no total count. A caller that wants to know whether there is another
 * page compares `rows.length` to the limit it asked for and says so — a full page
 * is the signal, which is how `src/cli.ts` reports a truncated desk. A `count(*)`
 * over the same predicate would double the work of every page render to print a
 * number nobody acts on.
 */
export async function listRuns(
  userId: string,
  opts: { limit?: number; offset?: number; only?: RunFilter | null } = {}
): Promise<RunSummary[]> {
  const only = opts.only ?? null;
  if (only !== null && !isRunFilter(only)) {
    throw new Error(
      `"${String(only)}" is not a run filter. It is one of ${RUN_FILTERS.join(', ')}, or absent ` +
        'for everything a person and the watch produced. Refused rather than ignored: an ' +
        'unrecognised filter would match no rows, and an empty list reads as an agent that has ' +
        'never run.'
    );
  }

  const limit = bounded(opts.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
  const offset = bounded(opts.offset, 0, 0, MAX_OFFSET);

  try {
    return await sql<RunSummary>(
      `SELECT
         r.id,
         r.kind,
         r.question,
         left(coalesce(r.answer, ''), ${PREVIEW}) AS answer_preview,
         r.stop_reason,
         r.steps,
         r.tokens,
         r.duration_ms,
         r.writes_allowed,
         -- Derived from the trace inside Postgres. Selecting the whole column to
         -- count two things in JavaScript would move megabytes per page.
         --
         -- coalesce with an explicitly typed empty array: array_agg over a set
         -- that matched nothing returns NULL, not '{}', so a read-only run with
         -- no tool steps would otherwise arrive as null and every renderer would
         -- have to know that. The cast is needed because a bare '{}' has no type
         -- Postgres can infer here.
         coalesce(
           (SELECT array_agg(s.elem->>'toolName' ORDER BY s.ord)
              FROM jsonb_array_elements(r.trace) WITH ORDINALITY AS s(elem, ord)
             WHERE s.elem->>'kind' = 'tool'
               -- A tool step with no name would arrive as a null INSIDE a
               -- string[], and every caller would print it as "null". A step
               -- without a name is a fault in the trace, not a tool.
               AND s.elem->>'toolName' IS NOT NULL),
           '{}'::text[]
         ) AS tools,
         -- 'ok' is written on tool steps only, so a missing value is not a
         -- failure — it is a step that was never a tool call.
         (SELECT count(*)::int
            FROM jsonb_array_elements(r.trace) AS s(elem)
           WHERE s.elem->>'kind' = 'tool' AND s.elem->>'ok' = 'false') AS tool_failures,
         jsonb_array_length(r.evidence) AS evidence_count,
         jsonb_array_length(r.trace) AS trace_steps,
         r.verdict,
         r.verdict_note,
         r.created_at
       FROM agent_runs r
       WHERE r.user_id = $1
         -- Selecting a kind EXCLUDES the others. Written as a CASE rather than
         -- "$2 = 'eval' OR kind <> 'eval'", which was the first version of this
         -- in the private system and reads as "let eval rows through when asked
         -- for" — so asking for eval runs returned every run.
         AND (CASE WHEN $2::text = 'eval' THEN r.kind = 'eval' ELSE r.kind <> 'eval' END)
         AND (
           $2::text IS NULL
           -- 'eval' is a kind filter and is already applied above; there is no
           -- second condition for it, and saying so beats an empty branch.
           OR $2::text = 'eval'
           OR ($2::text = 'walled'   AND r.stop_reason <> 'answered')
           OR ($2::text = 'wrong'    AND r.verdict = 'wrong')
           OR ($2::text = 'unjudged' AND r.verdict IS NULL)
         )
       -- The tie-break is load-bearing under OFFSET. Two runs written inside the
       -- same millisecond have no defined order without it, so paging can show
       -- one of them twice and skip the other, and nothing in the output would
       -- say so.
       ORDER BY r.created_at DESC, r.id DESC
       LIMIT $3 OFFSET $4`,
      [userId, only, limit, offset]
    );
  } catch (err) {
    throw new Error(
      `Could not list the runs: ${messageOf(err)}. Reporting this rather than an empty history, ` +
        'because an empty history is a claim that the agent has never run.',
      { cause: err }
    );
  }
}

/* ─── one run ─── */

/**
 * One run with its full trace and evidence, or null.
 *
 * A value that cannot be a uuid returns null WITHOUT a query. Two reasons: a
 * malformed id sent to Postgres comes back as "invalid input syntax for type
 * uuid", which is a database error where the truth is that the caller named
 * something that cannot be a run; and a path segment from a URL is exactly where
 * that arrives from. Absent rather than an error, because `/runs/potato` and
 * `/runs/<a uuid nobody has>` are the same answer to the reader.
 */
export async function getRun(userId: string, id: string): Promise<RunDetail | null> {
  if (!isRunId(id)) return null;

  return one<RunDetail>(
    `SELECT id, kind, question, answer, stop_reason, steps, tokens, duration_ms,
            writes_allowed, evidence, trace, verdict, verdict_note, verdict_at, created_at
       FROM agent_runs
      -- Scoped in the query, not checked after it. Someone else's run has to read
      -- as absent rather than as forbidden: "not found" tells a stranger nothing,
      -- and "forbidden" confirms the row exists.
      WHERE id = $1 AND user_id = $2`,
    [id.trim(), userId]
  );
}

/* ─── the verdict ─── */

/** How much of a reason is worth keeping. Past this it is a bug report, and it
 * belongs in an eval case rather than in a column. */
const MAX_NOTE = 2_000;

/**
 * Mark a run, or take the mark off.
 *
 * Passing `null` un-judges it, which is not the same as marking it good: health
 * counts `judged` and `wrong` separately, and an unjudged run must never be
 * counted as one that passed. A misclick has to be undoable or the figures slowly
 * stop meaning anything.
 *
 * Throws for a run that is not there, and for an id that cannot be one. Unlike
 * `getRun`, a malformed id is NOT treated as absent here: a write that cannot
 * name its target must fail loudly rather than report that it changed nothing.
 *
 * An options object rather than four positional arguments, for the same reason
 * `decideProposal` takes one — `userId` and `id` are both uuids, and two uuids in
 * the wrong order is a call that typechecks, writes nothing, and reports "no such
 * run".
 */
export async function setVerdict(opts: {
  userId: string;
  id: string;
  verdict: Verdict | null;
  note?: string | null;
}): Promise<RunDetail> {
  if (opts.verdict !== null && opts.verdict !== 'good' && opts.verdict !== 'wrong') {
    throw new Error(
      `"${String(opts.verdict)}" is not a verdict. It is "good", "wrong", or null to un-judge ` +
        'the run. The column has a CHECK constraint saying the same thing; this refusal is a ' +
        'sentence rather than a Postgres error.'
    );
  }
  if (!isRunId(opts.id)) throw new Error(`"${opts.id}" is not a run id.`);

  const note = opts.note?.trim() ? opts.note.trim().slice(0, MAX_NOTE) : null;

  const row = await one<RunDetail>(
    `UPDATE agent_runs
        SET verdict = $3,
            -- Cleared along with the verdict. A note explaining why a run was
            -- wrong, left behind on a run no longer marked wrong, is a
            -- contradiction the next reader has to resolve — and they will
            -- resolve it by believing the note.
            verdict_note = CASE WHEN $3::text IS NULL THEN NULL ELSE $4 END,
            -- now(), not a timestamp from this process. created_at comes from the
            -- database's clock, and two stamps on one row that were read from two
            -- clocks can put the judgment before the run.
            verdict_at   = CASE WHEN $3::text IS NULL THEN NULL ELSE now() END
      WHERE id = $1 AND user_id = $2
      RETURNING id, kind, question, answer, stop_reason, steps, tokens, duration_ms,
                writes_allowed, evidence, trace, verdict, verdict_note, verdict_at, created_at`,
    [opts.id.trim(), opts.userId, opts.verdict, note]
  );

  if (!row) throw new Error('No such run.');
  return row;
}

/* ─── the aggregate ─── */

/**
 * The row as Postgres hands it back.
 *
 * Written out rather than derived from `RunHealth` with `Omit`, for two reasons.
 * `sql`/`one` constrain their row type to pg's `QueryResultRow`, which is an index
 * signature, and what TypeScript will give an implicit index signature to is
 * narrower than it looks — a type built out of an `interface` is exactly the case
 * that fails. And this list is meant to be read against the SELECT below it: a
 * column added there and not here should be a typecheck error rather than a
 * property that silently arrives as `undefined`.
 *
 * `total_tokens` is BIGINT, so it arrives as a string. Converted once, below,
 * where the conversion can be read.
 */
type HealthRow = {
  runs: number;
  answered: number;
  walled: number;
  with_writes: number;
  tool_calls: number;
  tool_failures: number;
  p50_ms: number | null;
  p95_ms: number | null;
  total_tokens: string;
  judged: number;
  wrong: number;
};

/**
 * Counts, percentiles and spend over a window, excluding eval runs.
 *
 * One round trip. The window is defined once, in a CTE, and every figure is a
 * scalar subquery over it — so `runs` and `answered` cannot describe different
 * sets of rows, which is what happens when the same predicate is written out
 * five times.
 */
export async function runHealth(userId: string, days = DEFAULT_DAYS): Promise<RunHealth> {
  const window = bounded(days, DEFAULT_DAYS, 1, MAX_DAYS);

  const row = await one<HealthRow>(
    `WITH window_runs AS (
       SELECT r.duration_ms, r.tokens, r.stop_reason, r.writes_allowed, r.verdict, r.trace
         FROM agent_runs r
        WHERE r.user_id = $1
          AND r.created_at >= now() - make_interval(days => $2::int)
          -- The suite is not evidence about the business. Seventeen synthetic
          -- runs per execution would swamp an operator's real ones, and every
          -- figure here would become a statement about the test suite. Its own
          -- history lives in agent_eval_suites, where comparing runs is the point.
          AND r.kind <> 'eval'
     ),
     tool_steps AS (
       SELECT s.elem
         FROM window_runs w
         CROSS JOIN LATERAL jsonb_array_elements(w.trace) AS s(elem)
        WHERE s.elem->>'kind' = 'tool'
     )
     SELECT
       (SELECT count(*)::int FROM window_runs)                                        AS runs,
       (SELECT count(*)::int FROM window_runs WHERE stop_reason = 'answered')          AS answered,
       (SELECT count(*)::int FROM window_runs WHERE stop_reason <> 'answered')         AS walled,
       (SELECT count(*)::int FROM window_runs WHERE writes_allowed)                    AS with_writes,
       (SELECT count(*)::int FROM tool_steps)                                          AS tool_calls,
       -- 'ok' is written on tool steps only, so a missing value is a step that
       -- was never a tool call rather than a failure.
       (SELECT count(*)::int FROM tool_steps WHERE elem->>'ok' = 'false')              AS tool_failures,
       -- Null for an empty window, and that is reported as null rather than as
       -- zero: "no runs yet" and "every run was instant" are different facts.
       (SELECT percentile_cont(0.5)  WITHIN GROUP (ORDER BY duration_ms)::int
          FROM window_runs)                                                            AS p50_ms,
       (SELECT percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms)::int
          FROM window_runs)                                                            AS p95_ms,
       -- The one figure that is a sum of values rather than a count of rows, so
       -- it stays BIGINT and arrives as a string. Converted below.
       (SELECT coalesce(sum(tokens), 0)::bigint FROM window_runs)                      AS total_tokens,
       (SELECT count(*)::int FROM window_runs WHERE verdict IS NOT NULL)               AS judged,
       (SELECT count(*)::int FROM window_runs WHERE verdict = 'wrong')                 AS wrong`,
    [userId, window]
  );

  // A scalar-subquery SELECT with no FROM always returns exactly one row, so the
  // fallback is unreachable in practice. It is written out rather than asserted
  // with `!` because an empty window is a legitimate state and a TypeError on a
  // health page would read as the agent being broken.
  if (!row) {
    return {
      days: window,
      runs: 0,
      answered: 0,
      walled: 0,
      with_writes: 0,
      tool_calls: 0,
      tool_failures: 0,
      p50_ms: null,
      p95_ms: null,
      total_tokens: 0,
      judged: 0,
      wrong: 0,
    };
  }

  const { total_tokens, ...counts } = row;
  return {
    days: window,
    ...counts,
    // BIGINT arrives as a string from this driver (see the note on money in
    // src/db.ts). Number() once, here, rather than an accidental coercion in
    // whatever renders it: a token total is a count of tokens and cannot come
    // near the precision limit of a double, so this conversion is exact.
    total_tokens: Number(total_tokens ?? 0),
  };
}

/**
 * Per-tool figures over the same window, most-used first.
 *
 * Most-used first because the tool called two hundred times is the one whose
 * failure rate is worth an afternoon; a tool called twice that failed once is a
 * 50% failure rate and almost never the thing to fix.
 */
export async function toolStats(userId: string, days = DEFAULT_DAYS): Promise<ToolStat[]> {
  const window = bounded(days, DEFAULT_DAYS, 1, MAX_DAYS);

  return sql<ToolStat>(
    `WITH steps AS (
       SELECT
         s.elem->>'toolName'               AS name,
         s.elem->>'ok'                     AS ok,
         coalesce((s.elem->>'ms')::int, 0) AS ms
       FROM agent_runs r
       CROSS JOIN LATERAL jsonb_array_elements(r.trace) AS s(elem)
       WHERE r.user_id = $1
         AND r.created_at >= now() - make_interval(days => $2::int)
         AND r.kind <> 'eval'
         AND s.elem->>'kind' = 'tool'
         AND s.elem->>'toolName' IS NOT NULL
     )
     SELECT
       steps.name                                                     AS tool_name,
       count(*)::int                                                  AS calls,
       count(*) FILTER (WHERE steps.ok = 'false')::int                AS failures,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY steps.ms)::int     AS p50_ms,
       max(steps.ms)::int                                             AS max_ms
     FROM steps
     GROUP BY steps.name
     ORDER BY count(*) DESC, steps.name`,
    [userId, window]
  );
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));
