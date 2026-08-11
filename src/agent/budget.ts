/**
 * The budget, checked before every model call.
 *
 * An agent is a loop that decides when to stop, which means the failure mode is
 * that it doesn't. Every guard here is checked BEFORE the call that would
 * spend, not after — a limit you notice afterwards has already been exceeded —
 * and every one of them fails closed. If the budget cannot be evaluated, the
 * run stops. An agent that keeps going when its accounting is broken is the
 * expensive kind of bug.
 *
 * Hitting a limit is a reported outcome, never a silent truncation. The caller
 * gets a `stop_reason` naming the wall it hit, and the trace shows what it had
 * done by then.
 *
 * Four limits rather than one, because each catches something the others cannot
 * see. A step limit does not notice a single step that costs 90k tokens. A token
 * limit does not notice a run spending thirty seconds per call. An error limit
 * is the only one that tells "working slowly" apart from "not working".
 */

/**
 * Written to `agent_runs.stop_reason`, which has no CHECK constraint for
 * exactly this reason: the vocabulary belongs to the budget, so adding a wall is
 * a code change and must not also be a migration — or the new wall gets recorded
 * as one of the old ones to avoid the ceremony.
 */
export type StopReason =
  | 'answered'
  | 'step_limit'
  | 'token_limit'
  | 'time_limit'
  | 'tool_error_limit'
  | 'aborted';

export interface BudgetLimits {
  /** Model calls, not tool calls. Each step is one round trip. */
  maxSteps: number;
  /** Input + output across the whole run. */
  maxTokens: number;
  /** Wall clock. */
  maxMs: number;
  /** Consecutive tool failures before we give up on making progress. */
  maxConsecutiveToolErrors: number;
}

export const DEFAULT_LIMITS: BudgetLimits = {
  maxSteps: 8,
  maxTokens: 120_000,
  // Long enough for several tool round trips, short enough that whoever is
  // waiting gets either an answer or a named wall. Nothing here runs inside a
  // platform that will kill it — the original ran in a Lambda with a 120s
  // ceiling, and this does not — but the reason for stopping early is the same
  // either way: the limit has to be evaluated while there is still time to
  // write the answer and the trace.
  maxMs: 90_000,
  maxConsecutiveToolErrors: 3,
};

/**
 * What an unreported token count is charged.
 *
 * Named rather than written twice, because the two places it is used have to
 * agree: a provider that reports nothing must cost the same whether the call
 * came from the loop or from inside a tool.
 */
const UNKNOWN_TOKENS = 4_000;

export class Budget {
  readonly limits: BudgetLimits;
  private readonly startedAt: number;
  steps = 0;
  tokens = 0;
  consecutiveToolErrors = 0;

  constructor(limits: Partial<BudgetLimits> = {}, now = Date.now()) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    this.startedAt = now;
  }

  /**
   * May the run make another model call? Returns null to proceed, or the reason
   * it must stop. Call this before the request, never after.
   *
   * A limit enforced after the fact is not a limit, it is an observation: you
   * have already paid for the step that broke it, and you are left deciding
   * whether to use a result you were not entitled to buy. For the wall clock it
   * is worse than accounting — noticing at 95 seconds that you passed 90 means
   * the caller may already be gone, and then the answer and the trace are never
   * written at all.
   */
  check(now = Date.now()): StopReason | null {
    if (this.steps >= this.limits.maxSteps) return 'step_limit';
    if (this.tokens >= this.limits.maxTokens) return 'token_limit';
    if (now - this.startedAt >= this.limits.maxMs) return 'time_limit';
    if (this.consecutiveToolErrors >= this.limits.maxConsecutiveToolErrors) {
      return 'tool_error_limit';
    }
    return null;
  }

  recordStep(tokensUsed: number): void {
    this.steps += 1;
    // A model that reports no usage is not evidence that nothing was spent, so
    // an unknown count is charged at a deliberately pessimistic estimate rather
    // than at zero. Charging zero turns a broken usage field into an unbounded
    // run — and the provider boundary reports 0 for "unknown" precisely because
    // this is where that is handled.
    this.tokens += Number.isFinite(tokensUsed) && tokensUsed > 0 ? tokensUsed : UNKNOWN_TOKENS;
  }

  /**
   * Tokens spent by a tool that called a model of its own.
   *
   * A tool that generates text is a second model call the loop never sees, and
   * left uncounted the budget would report a cheap run that cost twice what it
   * says. It charges tokens without charging a step, because no round trip of
   * the loop happened — the step count is what bounds the loop, and inflating it
   * here would stop a run early for the wrong reason.
   */
  recordToolTokens(tokensUsed: number): void {
    this.tokens += Number.isFinite(tokensUsed) && tokensUsed > 0 ? tokensUsed : UNKNOWN_TOKENS;
  }

  /**
   * A success resets the count rather than decrementing it. Consecutive is the
   * word that matters: three failures spread across a run that is otherwise
   * making progress is a run making progress, and three in a row is a
   * dependency that is down.
   */
  recordToolResult(ok: boolean): void {
    this.consecutiveToolErrors = ok ? 0 : this.consecutiveToolErrors + 1;
  }

  elapsedMs(now = Date.now()): number {
    return now - this.startedAt;
  }

  /**
   * What the caller is told when a wall is hit. Plain, and specific.
   *
   * Never a bare enum. An answer that stopped mid-thought and an answer that is
   * complete look identical to whoever reads them, and only one should be
   * believed — so the sentence says which wall, and where it can, what to do
   * about it.
   */
  describe(reason: StopReason): string {
    switch (reason) {
      case 'step_limit':
        return `Stopped after ${this.steps} steps without reaching an answer. The question may need to be narrower.`;
      case 'token_limit':
        return `Stopped after using ${this.tokens.toLocaleString()} tokens.`;
      case 'time_limit':
        return `Stopped after ${Math.round(this.elapsedMs() / 1000)} seconds.`;
      case 'tool_error_limit':
        return `Stopped after ${this.consecutiveToolErrors} tool calls in a row failed. Something it depends on is broken.`;
      case 'aborted':
        return 'The run was cancelled.';
      case 'answered':
        return 'Answered.';
    }
  }
}
