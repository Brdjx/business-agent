/**
 * The recorded eval history, read back: the five queries, and the two rules for
 * reading what was STORED in a JSONB column.
 *
 * ── Why this is not inside `history.ts` ──
 *
 * `history.ts` is a script. It parses `process.argv` at module scope, prints, and
 * closes the pool on the way out, so importing it to borrow a query would run a
 * report and shut the connection pool down underneath the caller. The web UI's
 * evals surface needs exactly the same five reads, and there are only two ways to
 * give it them: move them here, or write them a second time.
 *
 * A second time is not acceptable, and the reason is specific rather than tidy.
 * Three of the things below are not queries so much as decisions:
 *
 * **The window** is "the most recent N suites for this operator, by `started_at
 * DESC, id DESC`". It is already defined twice — here and inside
 * `agent_eval_flaky` in `db/003-eval-history.sql` — and those two have to agree or
 * the per-case list and the stability line describe different sets of runs. A
 * third copy in a page module would be a copy nobody thinks to change.
 *
 * **The counting rule** — a skip is NEVER a failure — belongs to
 * `agent_eval_flaky` and to nothing else. Both surfaces call it rather than
 * counting rows they already have in hand, including the per-case view, which has
 * the rows right there. Two copies of a counting rule is one that will eventually
 * disagree with the schema, and neither copy would error while doing it.
 *
 * **Reading `failures` and `roles`** is defensive, because they are JSONB and a
 * renderer that throws on one malformed row hides every row after it — and the
 * rows after it are the history. Two independent defensive readers would be two
 * different opinions about what a malformed row means.
 *
 * So this file holds the reads and the two stored-column readers, and the surfaces
 * hold their own words. That split is deliberate: a sentence phrased differently
 * on a terminal and in a page is visible to anybody reading both, whereas a
 * counting rule that differs is not.
 *
 * ── Notes carried over from the port ──
 *
 * These were Supabase calls (`.from().select()`, `.rpc()`) and are now plain pg
 * with `$1` placeholders. Two consequences, both of which are a silent wrong
 * answer rather than an error:
 *
 * TIMESTAMPTZ comes back as a `Date`, not an ISO string (`src/db.ts` overrides the
 * DATE parser only). The original sliced these as strings, which throws here.
 *
 * The BIGINT counts from `agent_eval_flaky` come back as STRINGS, so `skips ===
 * runs` compares text and `failures > 0` coerces. They are cast to `int` in the
 * SELECT, so every comparison a caller makes is arithmetic. A count of eval rows
 * cannot come near an int's range.
 *
 * Nothing here writes, and nothing here catches. A failed read is reported by the
 * caller in the words its medium wants — the CLI names the missing section on
 * stderr and exits 1; the page renders a notice saying the section is absent and
 * that nothing on screen may be read as stability.
 */

import { sql } from '../../db';
import { ROLES } from './roles';

/* ─── the window ─── */

/** Bigger than any history worth reading, and small enough to be a valid `int`. */
export const MAX_WINDOW = 1_000;
export const DEFAULT_WINDOW = 20;

/**
 * Four, like `approve` in the CLI: `--suite=a1b` is short enough to be a typo of
 * something else, and resolving a typo to a real suite is worse than refusing.
 */
export const MIN_REF = 4;

/**
 * How many matches a prefix lookup returns before it stops caring.
 *
 * Six rather than two, so an ambiguous prefix can show what it is ambiguous
 * between. "Matches 6 suites" from a `LIMIT 6` is honest about being a floor
 * because the sentence that prints it says "at least" where it matters.
 */
const MAX_MATCHES = 6;

/* ─── the rows, as the columns hold them ─── */

/**
 * `type` rather than `interface`, and that is load-bearing: `sql<T>` constrains `T`
 * to pg's `QueryResultRow`, which is an index signature, and TypeScript gives an
 * implicit index signature to object type aliases and not to interfaces. Same
 * reasoning as `Proposal` in `src/agent/proposals.ts`, and the same choice of
 * column names over camel case, so the SQL below is checkable against
 * `db/003-eval-history.sql` by eye.
 */
export type SuiteRow = {
  id: string;
  started_at: Date;
  finished_at: Date | null;
  model_id: string | null;
  git_sha: string | null;
  /** Written when the suite OPENED, counting every case attempted. */
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  /** The binding, verbatim, as the runner stored it. Shape not assumed — see
   * `readBinding`. */
  roles: unknown;
};

export type CaseRow = {
  case_id: string;
  question: string | null;
  passed: boolean;
  skipped: boolean;
  note: string | null;
  /** `[{ check, detail }]`, per the schema. Read defensively all the same. */
  failures: unknown;
  duration_ms: number | null;
  created_at: Date;
  agent_run_id: string | null;
  suite_id: string;
};

/** A case row joined to the suite it belongs to, for the per-case view. */
export type CaseWithSuite = CaseRow & { git_sha: string | null };

export type FlakyRow = {
  case_id: string;
  runs: number;
  passes: number;
  failures: number;
  skips: number;
  last_seen: Date;
  /** Non-null means the same case produced both verdicts inside the window. */
  flaky_since: Date | null;
};

/* ─── the reads ─── */

/**
 * The window: most recent N suites for this operator.
 *
 * `started_at DESC, id DESC` — the tie-break matters. Two suites started inside the
 * same millisecond (a suite that failed to open and was rerun immediately) would
 * otherwise be ordered by whatever the heap returned, so the same window could drop
 * a different one of the pair on two reads. `agent_eval_flaky` has the same
 * exposure and takes the same rows either way, because it only needs the set.
 */
export async function recentSuites(userId: string, limit: number): Promise<SuiteRow[]> {
  return sql<SuiteRow>(
    `SELECT id, started_at, finished_at, model_id, git_sha,
            total, passed, failed, skipped, roles
       FROM agent_eval_suites
      WHERE user_id = $1
      ORDER BY started_at DESC, id DESC
      LIMIT $2`,
    [userId, limit]
  );
}

/**
 * Stability, from the function that owns the counting rule.
 *
 * The counts are BIGINT and would arrive as strings, which is how `skips === runs`
 * becomes a string comparison and `failures > 0` becomes a coercion. Cast here, at
 * the boundary, rather than parsed at each use.
 *
 * No `ORDER BY` of its own, deliberately. The function orders unstable first, then
 * most-failing, and re-sorting here would mean copying the predicate it owns into
 * this file — the one duplication the schema comment specifically warns about. Every
 * caller renders the rows in the order they arrive, for the same reason.
 */
export async function flakiness(userId: string, window: number): Promise<FlakyRow[]> {
  return sql<FlakyRow>(
    `SELECT case_id,
            runs::int     AS runs,
            passes::int   AS passes,
            failures::int AS failures,
            skips::int    AS skips,
            last_seen,
            flaky_since
       FROM agent_eval_flaky($1, $2)`,
    [userId, window]
  );
}

/**
 * Every outcome of one case inside the window, newest first.
 *
 * One query, joined against the same window `agent_eval_flaky` uses — the private
 * version read the suites, collected their ids and sent them back as an `.in()`
 * list, which is two round trips and a window defined in JavaScript.
 *
 * `created_at DESC, id DESC`: without the tie-break, two rows written in the same
 * millisecond change places between reads, and "newest first" that reorders is not
 * a history anybody can quote from.
 */
export async function caseOutcomes(
  userId: string,
  caseId: string,
  window: number
): Promise<CaseWithSuite[]> {
  return sql<CaseWithSuite>(
    `WITH recent AS (
       SELECT id, git_sha
         FROM agent_eval_suites
        WHERE user_id = $1
        ORDER BY started_at DESC, id DESC
        LIMIT $2
     )
     SELECT e.case_id, e.question, e.passed, e.skipped, e.note, e.failures,
            e.duration_ms, e.created_at, e.agent_run_id, e.suite_id,
            s.git_sha
       FROM agent_eval_runs e
       JOIN recent s ON s.id = e.suite_id
      WHERE e.case_id = $3
      ORDER BY e.created_at DESC, e.id DESC`,
    [userId, window, caseId]
  );
}

/**
 * The suites whose id starts with `ref` — none, one, or an ambiguity to refuse.
 *
 * Resolving is left to the caller because the two surfaces refuse differently: the
 * CLI prints the matches and exits 2, the page renders them as links. What is
 * shared is the rule that a prefix is never resolved by picking one, which is the
 * same rule `approve` in the CLI lives under.
 *
 * `id::text` is canonical lowercase with dashes. The caller must have restricted
 * `ref` to hex and dashes (`looksLikeRef`) before this point, so the LIKE pattern
 * cannot carry a `%` or `_` that would widen it — the one thing about this query
 * that is a security property rather than a convenience.
 */
export async function suitesByRef(userId: string, ref: string): Promise<SuiteRow[]> {
  return sql<SuiteRow>(
    `SELECT id, started_at, finished_at, model_id, git_sha,
            total, passed, failed, skipped, roles
       FROM agent_eval_suites
      WHERE user_id = $1
        AND id::text LIKE $2
      ORDER BY started_at DESC, id DESC
      LIMIT ${MAX_MATCHES}`,
    [userId, `${ref}%`]
  );
}

/**
 * Every case row of one suite, in the order the suite ran them.
 *
 * Not scoped by operator, and that is not an oversight: the only way to have a
 * suite id here is to have resolved it through `suitesByRef`, which is scoped. A
 * second `user_id` on this query would need a join and would suggest that a
 * caller is allowed to arrive with an id it did not resolve.
 */
export async function suiteCases(suiteId: string): Promise<CaseRow[]> {
  return sql<CaseRow>(
    `SELECT case_id, question, passed, skipped, note, failures,
            duration_ms, created_at, agent_run_id, suite_id
       FROM agent_eval_runs
      WHERE suite_id = $1
      ORDER BY created_at ASC, id ASC`,
    [suiteId]
  );
}

/* ─── what could be an id at all ─── */

/** Hex and dashes, and long enough not to be a typo of something else. Checked
 * before a read, because a ref that cannot be a uuid prefix reaches Postgres as a
 * pattern rather than as a mistake, and matches whatever it happens to match. */
export const looksLikeRef = (ref: string): boolean =>
  ref.length >= MIN_REF && /^[0-9a-f-]+$/i.test(ref);

/* ─── a window that arrived from outside ─── */

/**
 * A whole number of suites, in range.
 *
 * For a caller whose window comes from a query string, where `?suites=abc` is a
 * typo rather than a request: `Number('abc')` is NaN, and NaN bound to a `LIMIT`
 * reaches Postgres as `NaN` and fails the statement — a 500 from a page because
 * somebody fat-fingered a URL. The CLI does NOT use this; it refuses an
 * unparseable `--suites=` with a sentence, because a flag is typed deliberately
 * and silently correcting one is how a reader concludes the flag was honoured.
 */
export function boundedWindow(value: unknown): number {
  // Absent and empty are handled before the coercion, because `Number(null)` is 0 and
  // `Number('')` is 0 — so `?suites=` and a missing parameter would both clamp to a
  // window of ONE suite, which is the width at which stability cannot be judged at
  // all. The default has to survive both spellings of "not given".
  if (value === null || value === undefined || value === '') return DEFAULT_WINDOW;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return DEFAULT_WINDOW;
  return Math.min(Math.max(Math.trunc(n), 1), MAX_WINDOW);
}

/* ─── a model id, short enough for a column ─── */

/**
 * `bedrock/us.anthropic.claude-sonnet-4-5-20250929-v1:0` reads as
 * `bedrock/claude-sonnet-4-5`.
 *
 * Known affixes are TRIMMED rather than a name being extracted with one pattern, so
 * an unfamiliar model id degrades to its full self — long, but true. A single greedy
 * pattern would match part of an id it did not recognise and print something that
 * reads as a model nobody ran, which is worse than a wide column.
 *
 * The region prefixes are listed rather than matched as `^[a-z]{2}\.` (which the
 * private version used): a two-letter prefix rule quietly eats the first segment of
 * any dotted id, including one from a vendor this list has never heard of.
 *
 * The `provider/` prefix is KEPT. `persist.ts` writes `model_id` as
 * `${provider}/${modelId}`, and the same weights reached through two providers are
 * two things worth telling apart in a history — that is half the reason the column
 * carries the provider at all.
 *
 * Shared rather than copied because it is a list of affixes, and a list that exists
 * twice acquires a new entry in one place. Both surfaces shorten this column in a
 * list and print the id in FULL on a suite's own view, where a trimmed id is not
 * something you can put in a bug report.
 */
const BEDROCK_REGIONS = /^(us|eu|apac|ap|ca|sa|il|mx)\./;
const VENDOR = /^anthropic\./;
/** A release date, optionally with a Bedrock version suffix. */
const RELEASE = /-\d{8}(-v\d+(:\d+)?)?$/;

export function shortModel(model: string | null | undefined): string {
  const full = model?.trim();
  if (!full) return 'unknown';

  // Split at the FIRST slash only: the provider is one segment, and everything after
  // it is the id the affix rules apply to.
  const slash = full.indexOf('/');
  const prefix = slash === -1 ? '' : full.slice(0, slash + 1);
  const id = slash === -1 ? full : full.slice(slash + 1);

  const short = id.replace(BEDROCK_REGIONS, '').replace(VENDOR, '').replace(RELEASE, '');
  // An id that is entirely affix would otherwise print as an empty column, which
  // reads as a suite that recorded no model at all.
  return short.length > 0 ? `${prefix}${short}` : full;
}

/* ─── reading the two JSONB columns ─── */

/** One failed assertion, in the runner's own words. */
export interface StoredFailure {
  check: string;
  detail: string;
}

/**
 * The failed assertions of one case row.
 *
 * Read defensively, though the column is `NOT NULL DEFAULT '[]'::jsonb` and the
 * runner writes `[{ check, detail }]`. A reader that throws on one malformed row
 * hides every row after it, and the rows after it are the history — so an
 * unrecognised shape comes back as itself, in `unfamiliar`, for the caller to label
 * as such rather than to render as an assertion.
 *
 * `detail` is never dropped: an entry whose detail is not a string is JSON-encoded,
 * because the runner's exact words are the whole value of this column and a
 * `[object Object]` where an expectation should be is worse than a long line.
 */
export function readFailures(raw: unknown): {
  failures: StoredFailure[];
  unfamiliar: string | null;
} {
  if (raw === null || raw === undefined) return { failures: [], unfamiliar: null };
  if (!Array.isArray(raw)) return { failures: [], unfamiliar: json(raw) };

  return {
    failures: raw.map((entry) => {
      const f = (entry ?? {}) as { check?: unknown; detail?: unknown };
      return {
        check: typeof f.check === 'string' ? f.check : '(unnamed check)',
        detail: typeof f.detail === 'string' ? f.detail : json(f.detail ?? entry ?? null),
      };
    }),
    unfamiliar: null,
  };
}

/** One role and what it bound to, flattened to a line. */
export interface BindingRow {
  role: string;
  value: string;
}

/**
 * The binding a suite stored, in the order `describeBinding` prints it.
 *
 * Four outcomes rather than one, because "no binding was recorded", "the binding
 * was recorded as empty", "what is stored is not an object" and "here is the
 * binding" are four different findings and collapsing any of them into an empty
 * list would make a suite that recorded nothing look like a suite that bound
 * nothing.
 *
 * jsonb does not keep insertion order — it sorts keys by length and then bytewise —
 * so reading `Object.entries` straight out puts the roles in an order nobody chose.
 * The nine known roles come first, in their documented order, then anything else the
 * runner stored (`money`, `hours`, or a role added since).
 *
 * `absent` claims nothing about WHY a role is missing. The runner stores what
 * bound, so an absent role either did not bind or was not recorded, and this cannot
 * tell which — which is why the sentence saying so is a constant both surfaces use
 * rather than a claim each one invents.
 */
export type StoredBinding =
  | { kind: 'rows'; rows: BindingRow[]; absent: string[] }
  /** The column was null, which the schema's default should make impossible. */
  | { kind: 'none' }
  /** `{}` — the runner recorded a binding and it had nothing in it. */
  | { kind: 'empty' }
  /** Not an object: an array, a number, a string. Carried as JSON to be shown. */
  | { kind: 'unfamiliar'; json: string };

/** The one thing an absent role does NOT tell you, in the words both surfaces
 * use. Exported so the CLI and the page cannot drift into two explanations of the
 * same silence. */
export const ABSENT_ROLE_MEANS =
  'the runner stores what bound, so these either did not bind or were not recorded';

export function readBinding(roles: unknown): StoredBinding {
  if (roles === null || roles === undefined) return { kind: 'none' };
  if (typeof roles !== 'object' || Array.isArray(roles)) {
    return { kind: 'unfamiliar', json: json(roles) };
  }

  const stored = roles as Record<string, unknown>;
  const keys = Object.keys(stored);
  if (keys.length === 0) return { kind: 'empty' };

  const known = ROLES as readonly string[];
  const ordered = [
    ...known.filter((r) => keys.includes(r)),
    ...keys.filter((k) => !known.includes(k)),
  ];

  return {
    kind: 'rows',
    rows: ordered.map((role) => ({ role, value: renderValue(stored[role]) })),
    absent: known.filter((r) => !keys.includes(r)),
  };
}

/** A stored value as one line: a name as itself, a facts object as `key=value`
 * pairs. The private version printed `${role} ${name}` and rendered the money and
 * hours facts as `[object Object]`, which is the half of the binding the
 * figure-based assertions were built from. */
function renderValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'object' && !Array.isArray(value)) {
    return Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => `${k}=${v === null || typeof v === 'object' ? json(v) : String(v)}`)
      .join('  ');
  }
  return json(value);
}

/**
 * `JSON.stringify` that always returns a string.
 *
 * It returns `undefined` for `undefined`, a function or a symbol, and a template
 * literal would then print the word "undefined" as though it were the stored
 * value. It also THROWS on a circular structure — which cannot come out of a JSONB
 * column, but this function is one of the two places a malformed row is being
 * tolerated on purpose, and taking the page down inside the tolerant branch would
 * be a poor joke.
 */
function json(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return '(a value that could not be encoded as JSON)';
  }
}
