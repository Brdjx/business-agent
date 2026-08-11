/**
 * The budget's guards, which are the part of the loop worth testing.
 *
 * The loop itself is four lines and needs a model to exercise. These are the
 * rules that decide whether a bad run is a cheap one, and they hold with no
 * database, no key and no network — which is why they run on every commit
 * rather than before a release.
 *
 * Three properties are asserted over and over below, because each one has a
 * plausible-looking implementation that gets it wrong:
 *
 *   1. A limit is enforced BEFORE the spend that would breach it. Checked
 *      afterwards it is not a limit, it is an observation: the step has already
 *      been paid for.
 *   2. A stop is a named outcome, never a throw. `check()` returns the name of
 *      the wall and the run reports it; a budget that threw would turn the
 *      answer and the trace into a stack trace.
 *   3. It fails closed. An unreported token count is charged, not forgiven.
 *
 * No fake timers anywhere. `Budget` takes `now` in the constructor and in
 * `check()` precisely so that the wall-clock rule can be tested as arithmetic;
 * mocking the clock to test a class that already accepts one would be testing
 * vitest.
 */

import { describe, it, expect } from 'vitest';
import { Budget, DEFAULT_LIMITS, type StopReason } from './budget';

describe('Budget', () => {
  it('permits a step when nothing has been spent', () => {
    expect(new Budget().check()).toBeNull();
  });

  it('keeps the limits a caller did not override', () => {
    // The eval suite passes maxSteps and nothing else — a merge that replaced
    // the whole object would silently run the suite with maxTokens 0, and every
    // case would wall on token_limit before its first call. Partial means
    // partial.
    const b = new Budget({ maxSteps: 6 });
    expect(b.limits.maxSteps).toBe(6);
    expect(b.limits.maxTokens).toBe(DEFAULT_LIMITS.maxTokens);
    expect(b.limits.maxMs).toBe(DEFAULT_LIMITS.maxMs);
    expect(b.limits.maxConsecutiveToolErrors).toBe(DEFAULT_LIMITS.maxConsecutiveToolErrors);
  });

  it('stops at the step limit rather than one step past it', () => {
    const b = new Budget({ maxSteps: 2 });
    b.recordStep(10);
    expect(b.check()).toBeNull();
    b.recordStep(10);
    // The check runs before the call that would spend, so the third step never
    // happens — the limit is a ceiling, not a target to overshoot. The run has
    // paid for exactly the two steps it was entitled to.
    expect(b.check()).toBe('step_limit');
    expect(b.steps).toBe(2);
  });

  it('stops on tokens', () => {
    const b = new Budget({ maxTokens: 1_000 });
    b.recordStep(999);
    expect(b.check()).toBeNull();
    b.recordStep(2);
    expect(b.check()).toBe('token_limit');
  });

  it('charges an unreported token count pessimistically, never as zero', () => {
    const b = new Budget();
    b.recordStep(0);
    // A model that reports no usage is not evidence that nothing was spent.
    // Charging zero here is how an unbounded run stays invisible: every step
    // costs nothing, the token limit is never reached, and the only thing left
    // to stop the run is the step count.
    expect(b.tokens).toBeGreaterThan(0);

    const afterZero = b.tokens;
    b.recordStep(Number.NaN);
    expect(b.tokens).toBeGreaterThan(afterZero);

    // Negative and infinite are the same class of broken as NaN, and both have
    // a worse failure than undercounting: a negative usage figure subtracted
    // from the total would buy the run extra steps, and an infinite one makes
    // `tokens` unprintable in the trace and in `describe()`.
    const afterNaN = b.tokens;
    b.recordStep(-500);
    expect(b.tokens).toBeGreaterThan(afterNaN);
    b.recordStep(Number.POSITIVE_INFINITY);
    expect(Number.isFinite(b.tokens)).toBe(true);
  });

  it('stops on wall clock', () => {
    const start = 1_000_000;
    const b = new Budget({ maxMs: 5_000 }, start);
    expect(b.check(start + 4_999)).toBeNull();
    expect(b.check(start + 5_000)).toBe('time_limit');
    // Reported from the same origin the check uses, so a trace and a wall
    // cannot disagree about how long the run took.
    expect(b.elapsedMs(start + 5_000)).toBe(5_000);
  });

  it('charges a tool that called a model of its own, without charging a step', () => {
    // A tool that drafts prose makes a second model call the loop never sees.
    // Uncounted, an expensive run reports as a cheap one. It costs tokens but
    // NOT a step: the step count is what bounds the loop, and inflating it here
    // would stop the run early for the wrong reason — a two-step run that hit
    // the step limit is a bug report nobody can make sense of.
    const b = new Budget({ maxSteps: 4, maxTokens: 10_000 });
    b.recordStep(100);
    b.recordToolTokens(2_000);
    expect(b.steps).toBe(1);
    expect(b.tokens).toBe(2_100);
    expect(b.check()).toBeNull();

    // And it counts towards the wall, so one expensive tool can end a run that
    // the step count would have let continue.
    b.recordToolTokens(9_000);
    expect(b.check()).toBe('token_limit');
  });

  it('gives up after consecutive tool failures, and forgives a success', () => {
    const b = new Budget({ maxConsecutiveToolErrors: 3 });
    b.recordToolResult(false);
    b.recordToolResult(false);
    expect(b.check()).toBeNull();
    // A success means progress is being made again, so the count resets rather
    // than accumulating across an otherwise healthy run. Two failures early and
    // one an hour later is a run that worked; three in a row is a dependency
    // that is down, and only the second is worth stopping for.
    b.recordToolResult(true);
    b.recordToolResult(false);
    b.recordToolResult(false);
    expect(b.check()).toBeNull();
    b.recordToolResult(false);
    expect(b.check()).toBe('tool_error_limit');
    expect(b.consecutiveToolErrors).toBe(3);
  });

  it('reports a wall rather than throwing, and keeps reporting it', () => {
    const b = new Budget({ maxTokens: 100 });
    // Recording is not policed. The budget's job is to answer the question the
    // loop asks before it spends, not to interrupt a step already in flight —
    // a throw from inside `recordStep` would lose the model turn that had just
    // been paid for, along with the trace of everything before it.
    expect(() => b.recordStep(1_000_000)).not.toThrow();

    const first = b.check();
    expect(first).toBe('token_limit');
    // `check()` is a question, not a transition. The loop calls it once per
    // round and the CLI calls it again when it reports; two answers to the same
    // question would make "how often does it wall, and on what" unanswerable.
    expect(b.check()).toBe(first);
    expect(b.steps).toBe(1);
  });

  it('names one wall when several are breached, in a fixed order', () => {
    // Over on everything at once. Which name comes back has to be stable
    // rather than incidental: `stop_reason` is a column, and a run that reports
    // whichever limit the branches happened to reach first makes the histogram
    // it feeds meaningless.
    const start = 1_000_000;
    const b = new Budget({ maxSteps: 1, maxTokens: 100, maxMs: 10 }, start);
    b.recordStep(9_999);
    b.recordToolResult(false);
    b.recordToolResult(false);
    b.recordToolResult(false);
    expect(b.check(start + 1_000)).toBe('step_limit');
  });

  it('explains every stop in words a person can act on', () => {
    const b = new Budget({ maxSteps: 1 });
    b.recordStep(100);
    const reason = b.check();
    expect(reason).toBe('step_limit');
    const text = b.describe(reason!);
    expect(text).toContain('1 steps');
    // Never a bare enum. An answer that stopped mid-thought and an answer that
    // is complete look identical to whoever reads them, and only one of them
    // should be believed — so the sentence says which wall, and where it can,
    // what to do about it.
    expect(text.length).toBeGreaterThan(20);
  });

  it('has a sentence for every reason in the vocabulary', () => {
    // Listed explicitly rather than iterated off the type, because the point is
    // to fail when a new wall is added: `stop_reason` has no CHECK constraint,
    // so an unhandled reason would be written to the database as `undefined`
    // and nothing would object. The switch in `describe` is exhaustive today
    // and this is what keeps it that way.
    const reasons: StopReason[] = [
      'answered',
      'step_limit',
      'token_limit',
      'time_limit',
      'tool_error_limit',
      'aborted',
    ];
    const b = new Budget();
    for (const reason of reasons) {
      const text = b.describe(reason);
      expect(text, reason).toBeTruthy();
      expect(text, reason).not.toContain('undefined');
    }
    // Distinct sentences, so two different walls do not read as the same event
    // in a list of runs.
    expect(new Set(reasons.map((r) => b.describe(r))).size).toBe(reasons.length);
  });
});
