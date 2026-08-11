/**
 * Persisting the run.
 *
 * Without a trace you cannot debug an agent. The model made six calls, one of
 * them was wrong, and by the time you read the answer every intermediate step
 * has been garbage collected. You are left guessing at a system that is
 * non-deterministic by construction.
 *
 * With a trace, every question about a run has an answer: what it was asked,
 * which tools it chose, what arguments it passed, what came back, how long each
 * step took, what it cost, and which wall it hit if it stopped early.
 *
 * ── Recording must never break the run ──
 *
 * Every failure in this file is swallowed and logged, and `persistRun` returns
 * null. An agent that answered correctly and then failed because it could not
 * record itself has turned an observability problem into an outage. The caller
 * is expected to treat a null id as "no trace was written", not as "the run
 * failed" — the answer is already in hand by the time this is called.
 *
 * The swallow has a cost worth stating: a bug in this file (a bad column name,
 * a userId that is not a uuid) shows up only as a line on stderr. That is the
 * trade — a loud log and a working agent, rather than a stack trace and a lost
 * answer.
 */

import { one } from '../db';
import type { AgentRun } from './loop';

/**
 * Bound the stored trace.
 *
 * A runaway run is exactly the one worth recording, and also the one that would
 * otherwise write the largest row. Keep the HEAD, which is where the mistake
 * started; the tail of a loop is fifty copies of the same wrong call.
 *
 * Two other bounds are already in place by the time a trace arrives here: the
 * loop truncates every step's `output` to 500 characters, and `question` and
 * `answer` are cut below. What is deliberately NOT bounded is `toolArgs`: those
 * are the arguments a model invented, they are kept verbatim so an eval can
 * assert on them, and a tool's own validator is what caps the strings inside
 * them. A single pathological argument can therefore still make one large row.
 * If that ever matters, the fix belongs here rather than in the loop, which
 * needs the real arguments to hand to the tool.
 */
const MAX_TRACE_STEPS = 60;
const MAX_STEP_OUTPUT = 500;
const MAX_QUESTION = 4_000;
const MAX_ANSWER = 20_000;

/**
 * Who asked.
 *
 * Recorded as a column rather than inferred, because it was previously
 * inferred: the scheduled run's rows were identifiable only by their question
 * beginning with "watch:", and deciding what a row IS by matching text a caller
 * chose is a guess that holds until someone types that prefix. It also keeps
 * the eval suite's runs — synthetic, and several times more numerous than the
 * real ones — out of every health figure by default. See the COMMENT on
 * `agent_runs.kind` in `db/002-agent.sql`.
 */
export type RunKind = 'operator' | 'watch' | 'eval';

export interface PersistOptions {
  /** Defaults to 'operator', matching the column default. A person asking is
   * the ordinary case, and an unlabelled row would have to be excluded from
   * every query that filters on kind. */
  kind?: RunKind;
  /** A pre-allocated id, for a caller that had to name the run before it
   * finished — the eval runner records a case against a run id, and the write
   * phase's ledger points at one. */
  runId?: string;
}

/**
 * Write the run to `agent_runs`, and return its id — or null, if it could not
 * be written.
 *
 * `userId` must be a uuid, because the column is one. A value that is not gets
 * a Postgres error, which is swallowed and logged like any other failure here.
 */
export async function persistRun(
  userId: string,
  question: string,
  run: AgentRun,
  opts: PersistOptions = {}
): Promise<string | null> {
  try {
    const trace = run.trace.slice(0, MAX_TRACE_STEPS).map((step) => ({
      ...step,
      // The loop already truncates this. Done again because the loop is not the
      // only thing that builds an AgentRun — the eval runner will — and a bound
      // that only one caller applies is a bound that one caller can forget.
      ...(step.output === undefined ? {} : { output: step.output.slice(0, MAX_STEP_OUTPUT) }),
    }));

    const row = await one<{ id: string }>(
      // One statement for both the given-id and the generated-id case.
      // `coalesce($1::uuid, gen_random_uuid())` rather than two SQL strings,
      // because two strings drift: a column added to one and not the other is
      // a bug that only appears on whichever path the tests do not take.
      //
      // The JSONB parameters are stringified BY HAND, and that is not
      // decoration. node-postgres serialises a JS array as a Postgres ARRAY
      // literal — `{...}` — which a jsonb column rejects with "invalid input
      // syntax for type json". The Supabase client this was ported from took
      // objects directly, so this is exactly the kind of difference that
      // typechecks and then fails on the first real insert.
      `INSERT INTO agent_runs (
         id, user_id, kind, question, answer, stop_reason,
         steps, tokens, duration_ms, writes_allowed, evidence, trace
       ) VALUES (
         coalesce($1::uuid, gen_random_uuid()), $2, $3, $4, $5, $6,
         $7, $8, $9, $10, $11::jsonb, $12::jsonb
       )
       RETURNING id`,
      [
        opts.runId ?? null,
        userId,
        opts.kind ?? 'operator',
        question.slice(0, MAX_QUESTION),
        run.answer.slice(0, MAX_ANSWER),
        run.stopReason,
        // INTEGER columns. Date.now() differences are already whole numbers,
        // but a float here would fail the insert and lose the trace over a
        // rounding detail, which is not a trade worth taking.
        int(run.steps),
        int(run.tokens),
        int(run.ms),
        run.writesAllowed,
        JSON.stringify(run.evidence),
        JSON.stringify(trace),
      ]
    );

    if (!row) {
      // RETURNING on a successful single-row INSERT always yields a row, so
      // this is unreachable in practice and is here rather than as a `!`
      // because the alternative is a TypeError inside a function whose whole
      // job is not to throw.
      console.error('agent: the run was inserted but no id came back');
      return null;
    }
    return row.id;
  } catch (err) {
    console.error(
      'agent: could not persist run —',
      err instanceof Error ? err.message : String(err)
    );
    return null;
  }
}

/** INTEGER columns reject a float and NOT NULL rejects a NaN. */
function int(n: number): number {
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
}

/**
 * A one-line summary per step, for reading a run at a glance.
 *
 * The full trace is for a debugger; this is what a person scans to see where a
 * run went sideways before deciding whether to open it. The CLI prints this.
 *
 * The model and the provider are on the second line because which model
 * answered is part of reading a run: a regression after a model change and a
 * regression after a prompt change are different investigations, and the trace
 * is where that gets settled.
 */
export function summarizeTrace(run: AgentRun): string {
  const lines = run.trace.map((s) => {
    if (s.kind === 'model') {
      const reported = (s.inputTokens ?? 0) + (s.outputTokens ?? 0);
      // A provider that reports no usage is charged pessimistically by the
      // budget (see Budget.recordStep), so a step printing 0 tokens next to a
      // run total of 4,000 is not an inconsistency. Say which it is, rather
      // than printing "0tok" and letting a reader conclude the step was free.
      const tokens = reported > 0 ? ` ${reported}tok` : ' usage not reported';
      const stop = s.stop ? ` [${s.stop}]` : '';
      return `  ${s.step}. model ${s.ms}ms${tokens}${stop}` + (s.output ? ` — ${first(s.output)}` : '');
    }
    const mark = s.ok ? '' : ' FAILED';
    const tokens = s.tokens ? ` ${s.tokens}tok` : '';
    return `  ${s.step}. ${s.toolName}${mark} ${s.ms}ms${tokens} — ${first(s.output ?? '')}`;
  });

  return [
    `${run.stopReason}: ${run.stopDetail}`,
    `${run.steps} step(s), ${run.tokens.toLocaleString()} tokens, ${run.ms}ms` +
      (run.writesAllowed ? ', writes ALLOWED' : ', read-only') +
      ` — ${run.provider}/${run.model}`,
    ...lines,
    run.evidence.length > 0
      ? `  evidence: ${run.evidence.map((e) => `${e.table}/${e.label}`).join(', ')}`
      : '  evidence: none',
  ].join('\n');
}

const first = (s: string): string => {
  const line = (s.split('\n')[0] ?? '').trim();
  return line.length > 90 ? `${line.slice(0, 90)}…` : line;
};
