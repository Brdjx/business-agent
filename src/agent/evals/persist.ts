/**
 * The suite records itself.
 *
 * ── Why ──
 *
 * A green suite used to leave nothing behind. Seventeen assertions were checked
 * against a live model, printed to a terminal, and lost. That has already cost
 * something concrete: one case passed at 22:11 and failed at 22:20 on identical
 * code, and the only reason anyone noticed was that the suite happened to be run
 * twice in one evening by hand. A suite whose only output is scrollback can tell
 * you that today is fine. It cannot tell you that something CHANGED, which is
 * the question you actually want answered.
 *
 * The tables are `db/003-eval-history.sql` and predate this file. Nothing here
 * invents a column: `agent_eval_suites` is one row per execution of the whole
 * suite, `agent_eval_runs` is one row per case, and `agent_eval_flaky()` is the
 * query that reads them back — which case has both passed AND failed inside the
 * window, counting a skip as neither.
 *
 * ── The rule this file inherits from `trace.ts` ──
 *
 * Recording must never break the thing it records. A suite that failed because
 * it could not write its own bookkeeping would have turned observability into an
 * outage — and worse here than in production, because the failure would look
 * exactly like the agent regressing. So every write is swallowed and logged, and
 * a suite whose opening insert failed degrades to precisely what the suite did
 * before this file existed: it runs, it prints, it exits with the right code.
 *
 * That is what the null id in `SuiteHandle` is for. It is not a missing value for
 * each call site to defend against; it is the off switch, checked once per
 * function here so that the runner never has to ask whether recording is on.
 *
 * The swallow has a cost worth stating plainly: a bug in this file — a wrong
 * column name, a `userId` that is not a uuid — shows up only as a line on
 * stderr, per suite for the opening insert and per case for the rest. That is
 * the trade. A loud log and a working suite, rather than a stack trace and
 * seventeen results nobody can read back.
 */

import { one, sql } from '../../db';
import type { Bound } from './roles';

/**
 * The suite being recorded, or the fact that it is not being recorded.
 *
 * A null id means either `--no-record` or an opening insert that failed, and
 * every later call is a no-op. The two are deliberately indistinguishable from
 * here: the runner has already said which it was, and neither changes what this
 * file does.
 */
export interface SuiteHandle {
  id: string | null;
}

/**
 * Recording is off.
 *
 * Frozen because it is a shared singleton: two callers hold the same object, and
 * one of them assigning an id to it would silently switch recording on for
 * everybody else holding the off switch. Nothing does that today — freezing is
 * what keeps it that way.
 */
export const NOT_RECORDING: SuiteHandle = Object.freeze<SuiteHandle>({ id: null });

export interface SuiteOpen {
  /**
   * Which model answered. A prompt regression and a model regression are
   * different investigations, and without this they are indistinguishable a
   * month later.
   */
  modelId: string;
  /**
   * Which adapter carried it — `anthropic`, `bedrock`.
   *
   * Stored in the same column as the model, as `provider/model`. The schema has
   * one column and this is the whole answer to "what answered": the ids are not
   * interchangeable between adapters, so the model alone is technically
   * sufficient, but the composed spelling is what `summarizeTrace` already
   * prints, and one fact should not read two ways in two places.
   */
  provider?: string;
  /** The commit the suite ran against, when the runner can determine it. */
  gitSha?: string;
  /**
   * What the roles bound to, verbatim, plus the money and hours figures the
   * assertions were built from.
   *
   * The cases name shapes rather than records, so the same case asks about
   * different rows on different days. Without this a failure says a case broke
   * and not which records it was asked about, and "expected the outstanding
   * total" stops being a debuggable sentence.
   */
  roles: Bound;
  /** Cases about to be attempted, INCLUDING the ones that will skip. `total <>
   * passed + failed + skipped` is then the same signal as a null `finished_at`:
   * the suite did not finish. */
  total: number;
}

export async function openSuite(userId: string, s: SuiteOpen): Promise<SuiteHandle> {
  try {
    const row = await one<{ id: string }>(
      // `roles` is stringified by hand and cast, like every JSONB parameter in
      // this repo. node-postgres serialises a JS ARRAY as a Postgres array
      // literal — `{...}` — which a jsonb column rejects with "invalid input
      // syntax for type json"; it happens to do the right thing for a plain
      // object, and relying on which JS type the driver guesses correctly is how
      // the `failures` insert below would have shipped broken. See the same note
      // in `src/agent/trace.ts`.
      `INSERT INTO agent_eval_suites (user_id, model_id, git_sha, roles, total)
       VALUES ($1, $2, $3, $4::jsonb, $5)
       RETURNING id`,
      [
        userId,
        s.provider ? `${s.provider}/${s.modelId}` : s.modelId,
        s.gitSha ?? null,
        JSON.stringify(s.roles),
        int(s.total),
      ]
    );

    if (!row) {
      // RETURNING on a successful single-row INSERT always yields a row, so this
      // is unreachable in practice. It is written out rather than asserted with
      // `!` because a TypeError inside a function whose entire job is not to
      // throw would be an odd way to fail.
      console.error('\n  (not recording this run: the suite was inserted but no id came back)');
      return NOT_RECORDING;
    }
    return { id: row.id };
  } catch (err) {
    console.error(`\n  (not recording this run: ${messageOf(err)})`);
    return NOT_RECORDING;
  }
}

export interface CaseResult {
  caseId: string;
  /**
   * As actually asked, after the roles were substituted. The template lives in
   * code and code changes; this is what the model saw.
   */
  question?: string;
  passed: boolean;
  skipped?: boolean;
  /**
   * Why it skipped, or the error that stopped it before any assertion ran.
   *
   * A skip is not a failure and the column that says so is `skipped`; this is the
   * sentence that makes it actionable — "no row has engagement_kind=passed" is a
   * fixture to add, and a case that has been saying it for six weeks is a
   * coverage gap nobody is being told about.
   */
  note?: string;
  /** The assertions that did not hold, in the runner's own words. A count says
   * something regressed; this says what. */
  failures?: Array<{ check: string; detail: string }>;
  durationMs?: number;
  /** The `agent_runs` row holding the trace, when the run got far enough to have
   * one. Null keeps the case result rather than losing it with the trace. */
  agentRunId?: string | null;
}

export async function recordCase(suite: SuiteHandle, r: CaseResult): Promise<void> {
  if (!suite.id) return;
  try {
    await sql(
      // The truncations match the columns' own reasons for existing rather than
      // any limit in Postgres: `question` is cut where `agent_runs.question` is
      // cut (4,000) so the two records of one run agree, and `note` is a sentence
      // rather than a document.
      `INSERT INTO agent_eval_runs (
         suite_id, agent_run_id, case_id, question, passed, skipped, note, failures, duration_ms
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)`,
      [
        suite.id,
        r.agentRunId ?? null,
        r.caseId,
        r.question?.slice(0, 4_000) ?? null,
        r.passed,
        r.skipped ?? false,
        r.note?.slice(0, 2_000) ?? null,
        // Inside the try, because this is the parameter that has to be a string:
        // an array handed to the driver becomes a Postgres array literal and the
        // insert fails.
        JSON.stringify(r.failures ?? []),
        r.durationMs === undefined ? null : int(r.durationMs),
      ]
    );
  } catch (err) {
    // Reported once per case rather than swallowed silently. If the history is
    // not being written, whoever is watching the terminal should find out now
    // rather than when they go looking for the row next week. Recording is NOT
    // switched off after the first failure: a transient error must not cost the
    // twelve cases that come after it.
    console.error(`      (case not recorded: ${messageOf(err)})`);
  }
}

/**
 * Stamp the totals and the finish time.
 *
 * A separate write at the end rather than something computed when the suite
 * opened, because a suite with no `finished_at` is one that crashed or was
 * killed partway — and that is worth being able to see. The opening insert
 * leaves the three counts at their defaults of zero, so a suite that died
 * halfway reads as "0 passed" with no finish time, which is the truth about what
 * is known rather than a claim that nothing passed.
 */
export async function closeSuite(
  suite: SuiteHandle,
  totals: { passed: number; failed: number; skipped: number }
): Promise<void> {
  if (!suite.id) return;
  try {
    await sql(
      `UPDATE agent_eval_suites
          SET finished_at = now(), passed = $2, failed = $3, skipped = $4
        WHERE id = $1`,
      [suite.id, int(totals.passed), int(totals.failed), int(totals.skipped)]
    );
  } catch (err) {
    console.error(`  (suite totals not recorded: ${messageOf(err)})`);
  }
}

/** INT columns reject a float, and NOT NULL rejects a NaN. Both would lose the
 * row over an arithmetic detail. */
function int(n: number): number {
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));
