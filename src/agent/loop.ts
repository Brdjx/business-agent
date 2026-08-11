/**
 * The loop. This is the whole thing an agent is.
 *
 *   send (conversation + tools) to the model
 *   text back      -> done
 *   tool call back -> execute it, append the result, continue
 *   over budget    -> stop and say why
 *
 * Everything else in this directory is engineering quality around those four
 * lines: a budget checked before spending, an allowlist in front of the tools,
 * argument validation, evidence on every result, and a trace of every step. The
 * loop is small on purpose — the interesting parts are the guards. If this file
 * grows, it is usually a guard that has been written in the wrong place.
 *
 * ── Writes leave the run as cards, and are not written here ──
 *
 * A write tool that is not permitted to act resolves its target, decides
 * everything it would decide, and returns a `proposal` on its result instead of
 * writing. This loop collects those the way it collects evidence, keyed by write
 * key — so a model that proposes the same act twice in one run produces one card
 * rather than two of the same — and hands them out on `AgentRun.proposals` in the
 * order they were proposed.
 *
 * What it deliberately does NOT do is persist them. `agent_proposals.run_id` is a
 * foreign key into `agent_runs`, and this run has no id until `persistRun` has
 * written the row: the record has to be written first and the cards after. Both
 * belong to whoever is recording — `persistRunAndProposals` in `trace.ts` — and a
 * loop that inserted its own cards would have to either invent an id or drop the
 * provenance that makes a card explainable.
 *
 * ── What this phase still does NOT have, and where it will go ──
 *
 * The private original loads conversation history and durable notes before the
 * first model call. Neither is here, and neither is stubbed: there is no thread
 * id and no note block. A field that is always empty is a field every caller
 * learns to ignore, and then the day it is populated nobody reads it.
 *
 * When memory lands, notes are loaded before the first call and rendered into a
 * second system block, AFTER the cache breakpoint — which is why `system` is
 * already a list here rather than a string. Conversation history arrives as
 * leading `messages`.
 */

import { Budget, type BudgetLimits, type StopReason } from './budget';
import {
  executeTool,
  toolSpecs,
  type Evidence,
  type ProposalDraft,
  type ToolContext,
  type ToolResult,
} from './tools';
import type { ContentBlock, Message, Provider, SystemBlock } from './providers/types';

/**
 * There is deliberately no default model in this file.
 *
 * `model` is a required argument, and `src/agent/providers/index.ts` is the one
 * place that reads it from the environment (`MODEL`), alongside which adapter to
 * build. Two reasons, and the first is the one that matters: which model
 * answered has to be recorded per run — a regression after a model change and a
 * regression after a prompt change are different investigations — and a default
 * sitting in the loop is how a run becomes unattributable. The second is that
 * the ids are not interchangeable between providers (`claude-opus-5` versus
 * `us.anthropic.claude-...`), so the layer that picks the adapter is the only
 * one that can pick the id.
 *
 * The caller therefore does `const { provider, model } = providerFromEnv()` and
 * hands both in. What answered comes back on `AgentRun`.
 *
 * ── Tools are not registered here either ──
 *
 * `runAgent` imports `executeTool` and `toolSpecs` and no tool. Registration is
 * `ensureToolsRegistered()` in `registry.ts`, called by whatever entry point is
 * about to reach `executeTool` — and NOT called from here on purpose. "Everything
 * that imports the loop works" is exactly how incident 1 stayed invisible for
 * weeks: the registry was full in every process anybody tested, and empty in the
 * one bundle nobody did. A run whose caller forgot is not silent — `toolSpecs()`
 * is empty and `executeTool` says in words that this is a fault in the harness.
 */

/**
 * The per-call output ceiling. Not the budget: the budget's token limit bounds
 * the whole run, this bounds one response, and the two catch different things.
 *
 * Raised from the original's 2048 for headroom — an answer that quotes three
 * invoices and their dates is longer than a status lookup — and left well below
 * anything a model would refuse. Worth knowing what shares this ceiling: on the
 * current Anthropic models thinking is on unless asked off, and thinking tokens
 * count against it. The Anthropic adapter here does ask it off (see
 * THINKS_BY_DEFAULT in `providers/anthropic.ts` — a thinking block cannot
 * round-trip through the block types the boundary has), so today this is
 * response text only. A provider that leaves thinking on would spend the same
 * budget twice over, and the failure shows up as a named wall rather than a
 * silent cut — see the `max_tokens` branch below.
 */
const MAX_OUTPUT_TOKENS = Number(process.env.AGENT_MAX_OUTPUT_TOKENS || 4_096);

/**
 * One tool must not be able to spend the whole run's wall clock.
 *
 * Kept ABOVE the database's `statement_timeout` (10s, see `src/db.ts`) so the
 * ordinary outcome of a slow query is Postgres cancelling it and the tool
 * returning an error the model can act on, rather than this timer abandoning a
 * promise while the query keeps running and the pool stays one client smaller.
 */
const TOOL_TIMEOUT_MS = Number(process.env.AGENT_TOOL_TIMEOUT_MS || 15_000);

/** The blocks the loop actually branches on, named so the narrowing is readable. */
type ToolUseBlock = Extract<ContentBlock, { type: 'tool_use' }>;

export interface TraceStep {
  step: number;
  /** What the model decided to do. */
  kind: 'model' | 'tool';
  toolName?: string;
  /** Verbatim, as the model sent them — before validation, so a refusal can be
   * read next to what caused it. */
  toolArgs?: unknown;
  /** Truncated — a trace is for debugging, not a second copy of the data. */
  output?: string;
  ok?: boolean;
  ms: number;
  inputTokens?: number;
  outputTokens?: number;
  /**
   * Tokens this step spent, for a tool that called a model of its own. Absent
   * on tools that only read the database, which is all of them in this phase.
   */
  tokens?: number;
  /**
   * The provider's own word for why the turn ended, on a model step. Useful
   * precisely when the normalised reason is `other` and nobody can otherwise
   * guess what happened — a content filter and a stop sequence arrive here
   * identically.
   */
  stop?: string;
  /** Milliseconds from the start of the run, so overlapping calls are visible. */
  offsetMs?: number;
}

/**
 * What the run announces while it is happening.
 *
 * The loop answers once, at the end, after N round trips, so a caller that only
 * awaits it sees nothing for twenty seconds. These are emitted as they occur so
 * a caller that wants to can show the work in progress — which tool, how long,
 * what came back — rather than a spinner that means both "thinking" and
 * "broken".
 *
 * Deliberately a callback on the one loop rather than a second streaming loop.
 * Two implementations of this diverge, and the last time something in this
 * directory existed in two forms, one of them ran for weeks with the wrong
 * tools registered and nothing could see it (incidents.md, entry 1).
 */
export type RunEvent =
  | { kind: 'thinking'; step: number }
  | { kind: 'thought'; step: number; ms: number; tokens: number; text: string }
  | { kind: 'tool'; step: number; name: string; args: unknown }
  | {
      kind: 'tool_done';
      step: number;
      name: string;
      ok: boolean;
      ms: number;
      tokens: number;
      preview: string;
    }
  | { kind: 'wall'; reason: StopReason; detail: string };

export interface AgentRun {
  answer: string;
  /**
   * Whether this run was permitted to change anything.
   *
   * The mode the run was ASKED for, and never a claim that something changed. A
   * read-only run can still leave cards; a write-enabled one can still write
   * nothing, because a tool that finds the value already set has nothing to do.
   */
  writesAllowed: boolean;
  stopReason: StopReason;
  /** Plain-language reason, safe to show a person. */
  stopDetail: string;
  steps: number;
  tokens: number;
  ms: number;
  /** Every record the answer was allowed to rest on. */
  evidence: Evidence[];
  /**
   * Writes this run described and did not perform, each approvable on its own,
   * in the order they were proposed.
   *
   * Populated only when a write tool was not permitted to act — with writes on it
   * wrote instead of proposing, and there is no card. Two drafts with one write
   * key collapse to one entry: asking twice is not consenting twice.
   *
   * Returned rather than recorded here. Nothing has been written to
   * `agent_proposals` by the time a caller reads this, so a run that is not
   * persisted has proposed nothing anybody can act on later — see
   * `persistRunAndProposals` in `trace.ts`.
   */
  proposals: ProposalDraft[];
  trace: TraceStep[];
  /**
   * Which model answered, and through which adapter.
   *
   * `agent_runs` has no column for it, so this is the per-run answer and
   * `agent_eval_suites.model_id` is where a suite persists it. Returned rather
   * than left to the caller to remember, because the alternative is reading an
   * environment variable after the fact and calling that a record of what ran.
   */
  model: string;
  provider: string;
}

/**
 * The instructions, and the one thing they are all in service of: an answer
 * that rests on records rather than on fluency.
 *
 * Two things this prompt deliberately does not do.
 *
 * It names no tools. Which tools exist is sent with the request (`toolSpecs()`),
 * so a tool named here would be a second, silently stale list — and the first
 * bug of that shape cost weeks (incidents.md, entry 1). It describes the shape
 * of the business instead, and lets the tool descriptions do the routing.
 *
 * It does not shout. Current models follow a system prompt closely, and a
 * prompt where five rules are CRITICAL has no way to say which one is. Each
 * rule below carries the reason it exists, because the reason is what makes it
 * generalise to the case nobody wrote down.
 *
 * ── The write rules, and the sentence that is the whole reason for them ──
 *
 * The block about writes is not general caution. The private agent once answered
 * "I've recorded your decision" having called no tool at all — a completed act
 * reported in the past tense, indistinguishable from the truth until somebody
 * looked. So the rule is not "be careful about writes", it is: a write is
 * something a TOOL RESULT in this conversation says happened, and nothing else
 * counts as having happened, including a sentence the model itself wrote earlier.
 *
 * The prompt says what a proposal is rather than naming the tools that make one,
 * for the same reason it names no read tool: which tools exist is sent with the
 * request. It also does not say which mode this run is in. That is deliberate —
 * everything above the cache breakpoint is identical on every run, and the tool
 * result is what knows whether the act was performed or left on the desk. A
 * cached sentence asserting the mode would be a second source of truth about it,
 * and the wrong one on exactly the run where it mattered.
 *
 * Two lines near the end are not about the business at all, and they are here
 * because the adapter asks thinking OFF (a thinking block cannot round-trip
 * through the block types at the provider boundary, so the alternative is the
 * second step of every multi-tool run being rejected — see THINKS_BY_DEFAULT in
 * `providers/anthropic.ts`). With thinking off these models occasionally write a
 * tool call into their visible text, where it silently never runs, and
 * occasionally leak internal tags into the answer. Allowing a sentence before a
 * call is what stops the first; a generic instruction about tags is what
 * mitigates the second. Note what is deliberately NOT here: any instruction not
 * to reason. That makes the leak worse rather than better.
 */
const SYSTEM = `You are the agent inside business-agent, an assistant over the records of a
one-person consulting studio: its clients, the people at them, the projects,
the invoices, and the hours logged against them.

You answer questions by CALLING TOOLS. The tools read the live database and are
the only way you can see it. If a tool returns nothing, say so — do not
substitute an estimate, and do not call the same tool again hoping for a
different answer.

Rules that matter more than being helpful:

- Never state a number you did not get from a tool. If you need a total, ask a
  tool for the total; do not add up rows yourself. Fifteen amounts added in your
  head are wrong often enough to matter, and a wrong total looks exactly like a
  right one.
- Money is held as whole cents and every total is summed in the database. Report
  what a tool gives you, in the units it gives it.
- What a client row IS and where it STANDS are two different columns, and both
  have to be read.
    engagement_kind 'client' with status active or inactive — someone the studio
      has actually worked with.
    engagement_kind 'passed' — took a call and never became a client. Never
      count one as a client and never as revenue.
    engagement_kind 'own_venture' — the studio's own product. Never billable,
      never revenue, and not a client however it sorts in a list.
    engagement_kind 'artifact' — built for another reason entirely, such as an
      interview take-home. A record of work, not an engagement.
    status 'prospect' — a relationship that has not started. An intro call is
      not someone the studio has worked for.
  So "who have we worked with" is both columns at once. Either one alone gives a
  confident wrong answer.
- Overdue is not a status; it is an open invoice whose due date has passed. It is
  narrower than outstanding — an open invoice that is not due yet is outstanding
  and not late. Say which of the two you are answering.
- A void invoice was cancelled and a draft was never sent. Neither is money:
  neither was collected and neither is owed.
- Cite the records. Name the client, quote the invoice number, give the date. An
  answer nobody can check is a claim rather than a statement about records.
- If you cannot answer from the tools, say what you would need. An honest "I
  don't have that" is worth more than a confident guess. If a name matches more
  than one record, say which you followed, or ask which was meant.

What is not in these records, so that you do not reason as though it were: there
is no email, no calendar, no accounting ledger beyond the invoices, no staff, no
documents, and no lead pipeline. Each question is answered on its own — you
cannot see earlier conversations, so do not refer to one.

Some tools change records, and you are not the one who decides whether a change
happens:

- When a write is not permitted, the tool tells you what it WOULD do and leaves a
  card the operator can approve or decline. Say what would change and that
  nothing has: a proposal is a question you are asking them, not an action you
  have deferred.
- Never say you have logged, created, updated, saved or sent something unless a
  tool result in THIS conversation said it happened. Reporting a proposal as done
  is the failure to avoid above all others — it is a false statement about
  someone's records, and it reads exactly like the truth until they check. An
  earlier message of your own is not evidence: it records you saying something,
  not the thing happening.
- Do not offer to do it later or to check back. You cannot act again on your own,
  and a promise you cannot keep is worse than a plain refusal.
- If a card is approved, the exact call you described is what runs. So describe
  the call — which record, which day, which figure — and not the intention
  behind it.
- Never choose on the operator's behalf when a write would cost someone money. If
  they name a client and that client has several projects, ask which one; do not
  pick the newest, the likeliest, or the only active one. Narrowing an ambiguous
  instruction yourself is how the wrong project gets billed, and the person who
  finds out is the client.

A short sentence saying what you are about to look up is welcome before a tool
call. Do not describe a call instead of making one — a tool call is the only
thing that reads the database, and text describing one looks the same to the
reader and does nothing.

Do not include internal or system XML tags in your answer.

Be brief. Answer the question that was asked.`;

export interface RunOptions {
  question: string;
  /**
   * The operator. Passed to every tool so a tool can scope its reads; never
   * taken from the model.
   */
  userId: string;
  /**
   * Where to send the request.
   *
   * Injected rather than imported, and that is the load-bearing difference from
   * the original, which constructed its client at module scope. A module-level
   * client means every test of this loop mocks a vendor SDK to get at the
   * control flow — and a mock of an SDK tests the mock. Passing the provider in
   * makes the fake in `loop.test.ts` an ordinary object implementing an
   * interface, and makes "which model answered" a fact about the call rather
   * than about the process.
   */
  provider: Provider;
  /**
   * The provider's own id for the model. Required, and not defaulted anywhere in
   * this file — see the note at the top. `providerFromEnv()` returns it next to
   * the provider it belongs to.
   */
  model: string;
  limits?: Partial<BudgetLimits>;
  /**
   * Off by default, and there is no caller in this repository that turns it on.
   *
   * With it off a write tool describes what it would do and returns a card;
   * `decideProposal` is what sets it true, for one stored call, after a person has
   * read that card. So the ordinary run proposes and only the approval path acts —
   * which is the point of per-action consent, and why nothing here offers a
   * "writes on" switch that would grant a whole run the permission.
   *
   * Passed to every tool either way, so a read can report honestly on the mode it
   * is in rather than guessing.
   */
  allowWrites?: boolean;
  /** Overrides the per-tool timeout. Exists so the timeout can be exercised by
   * a test in milliseconds instead of fifteen seconds — a guard nobody can
   * afford to test is a guard nobody knows works. */
  toolTimeoutMs?: number;
  /**
   * Cancellation from outside — a closed HTTP connection, a Ctrl-C. Checked
   * before each model call and passed to the provider, so a request already in
   * flight is abandoned rather than awaited. Cancelling produces the `aborted`
   * stop reason, which is an outcome like any other wall.
   */
  signal?: AbortSignal;
  /**
   * Told what is happening, as it happens. Optional: a caller that ignores it
   * behaves exactly as before.
   */
  onEvent?: (event: RunEvent) => void;
}

/**
 * Run the agent until it answers or hits a wall.
 *
 * Never rejects for a reason the run could have named: every limit, every
 * refusal and every tool failure comes back as a `stopReason`. It DOES reject if
 * the provider does — an endpoint that is down is not something the model can
 * correct itself out of, and converting it into a tool result would teach the
 * model to retry a network fault.
 */
export async function runAgent(opts: RunOptions): Promise<AgentRun> {
  const budget = new Budget(opts.limits);
  // The origin every trace offset is measured from, so a waterfall can be drawn
  // and two tools that overlapped do not read as twice the work.
  const runStartedAt = Date.now();

  const toolTimeoutMs = opts.toolTimeoutMs ?? TOOL_TIMEOUT_MS;

  /**
   * Announcing must never break the run.
   *
   * A caller whose stream has closed, or whose handler throws, has a broken
   * connection — not a broken agent. The work continues and the answer is still
   * returned; only the narration is lost.
   */
  const say = (event: RunEvent): void => {
    try {
      opts.onEvent?.(event);
    } catch {
      /* a listener that fails does not get to fail the run */
    }
  };

  const trace: TraceStep[] = [];
  const evidence: Evidence[] = [];
  /**
   * Keyed by write key, so a model that proposes the same act twice in one run
   * leaves one card rather than two of the same. A Map rather than an array
   * because insertion order is preserved and the first draft wins nothing over
   * the second: two drafts with one key describe one act, so which object
   * survives cannot matter.
   */
  const proposals = new Map<string, ProposalDraft>();

  const ctx: ToolContext = {
    userId: opts.userId,
    allowWrites: opts.allowWrites === true,
    // `runId` is deliberately NOT set here, and its absence is a fact about this
    // repository rather than an omission. The run's row is written after the run
    // ends (`agent_runs.answer` and `stop_reason` are NOT NULL, so there is
    // nothing to insert up front), and both `agent_write_keys.run_id` and
    // `agent_proposals.run_id` are foreign keys into it. Handing a tool an id for
    // a row that does not exist yet would not merely lose provenance: the
    // ledger's claim would fail the foreign key, `claim` would report that it
    // could not reserve the write, and the write would never happen. The approval
    // path passes the id of the run that PROPOSED the card, which is a row that
    // exists — see `decideProposal`.
    // A tool that writes prose calls a model of its own, and the loop never
    // sees that request. Charged here so the run's token figure is the whole
    // cost rather than the part that happened to go through this file. No tool
    // in this phase spends anything; the closure is passed anyway, because the
    // day one does, the accounting must already be correct.
    spend: (tokens) => budget.recordToolTokens(tokens),
  };

  // The instructions and the tool schemas are identical on every step of every
  // run, so everything up to the breakpoint is cached and re-read rather than
  // re-billed. What goes AFTER it is whatever differs per run: today's date
  // now, and the operator's notes when memory lands. Putting either before the
  // breakpoint invalidates the prefix every time and re-bills the instructions
  // along with it.
  const system: SystemBlock[] = [
    { text: SYSTEM, cacheBreakpoint: true },
    // The date is for reading the question — "this month", "last year" — and
    // never for computing an answer: every date filter is CURRENT_DATE in SQL,
    // evaluated by Postgres in its own time zone. A UTC day is used here
    // because that is the spelling every DATE column in this repo arrives as.
    { text: `Today is ${new Date().toISOString().slice(0, 10)}.` },
  ];

  const messages: Message[] = [
    { role: 'user', content: [{ type: 'text', text: opts.question }] },
  ];

  let answer = '';
  let stopReason: StopReason = 'answered';
  // Set only where the budget's own sentence would be wrong — a turn cut off at
  // the per-call ceiling is not the run's token limit, and neither is a model
  // that returned nothing. The budget owns the vocabulary; the loop owns the
  // sentence when it knows more than the budget does.
  let stopDetail: string | undefined;

  for (;;) {
    // Cancellation is checked here rather than in the budget, because the
    // budget counts and this is somebody else's decision.
    if (opts.signal?.aborted) {
      stopReason = 'aborted';
      break;
    }

    // Checked BEFORE the call that would spend, never after. A limit noticed
    // afterwards has already been exceeded, and for the wall clock it is worse
    // than accounting: at 95 seconds against a 90-second limit the caller may
    // already be gone, and then neither the answer nor the trace is written.
    const wall = budget.check();
    if (wall) {
      stopReason = wall;
      break;
    }

    say({ kind: 'thinking', step: budget.steps + 1 });

    const startedAt = Date.now();
    // The request gets the run's remaining wall clock as a deadline. Without
    // it the time limit is only enforced BETWEEN steps, so one hung request is
    // bounded by nothing and the run dies without reporting anything.
    const deadline = startDeadline(budget.limits.maxMs - budget.elapsedMs(), opts.signal);

    let completion;
    try {
      completion = await opts.provider.complete({
        model: opts.model,
        system,
        // A copy, not the live array. The loop keeps appending to `messages`,
        // and handing the same reference to every request makes each recorded
        // request a description of the final state instead of what was sent.
        messages: [...messages],
        tools: toolSpecs(),
        maxTokens: MAX_OUTPUT_TOKENS,
        // Asked for, and not conditioned on the model. Comparable runs are worth
        // something to an eval suite, and which models still accept the field is
        // a vendor fact that changes with every release — the current ones reject
        // it with a 400 naming it, and the adapter holds the allowlist and drops
        // it for those. A list of model ids in this file would be the same
        // knowledge in a second place, kept current by whoever remembers.
        // Temperature 0 never guaranteed identical output anyway, which is why
        // the eval suite asserts on behaviour rather than on wording.
        temperature: 0,
        signal: deadline.signal,
      });
    } catch (err) {
      // Distinguishing "we abandoned it" from "it failed" matters: the first is
      // an outcome the caller is owed a name for, the second is a fault.
      if (deadline.expired || opts.signal?.aborted) {
        stopReason = deadline.expired ? 'time_limit' : 'aborted';
        // The step is recorded even though it produced nothing. Without this
        // line the trace of a run that stopped on the clock shows nothing about
        // the step that spent it, which is the one thing worth knowing. It is
        // numbered ahead of the completed steps because the budget never
        // charged it: nothing here can know what the provider had already
        // spent when the request was abandoned, and inventing a figure would be
        // worse than the gap.
        trace.push({
          step: budget.steps + 1,
          kind: 'model',
          ms: Date.now() - startedAt,
          output: `abandoned in flight: the run ${
            deadline.expired ? 'reached its wall-clock limit' : 'was cancelled'
          }. Any tokens this request had already spent are not counted.`,
          offsetMs: startedAt - runStartedAt,
        });
        break;
      }
      throw err;
    } finally {
      // An armed 90-second timer keeps the event loop alive, so a CLI that
      // answered in two seconds would sit there for another eighty-eight.
      deadline.dispose();
    }

    const elapsed = Date.now() - startedAt;
    // 0 means UNKNOWN at the provider boundary, and the budget charges unknown
    // pessimistically rather than as free. Reporting nothing is not evidence
    // that nothing was spent.
    const used = completion.usage.input + completion.usage.output;
    budget.recordStep(used);

    const blocks = completion.content;
    const text = blocks
      .flatMap((b) => (b.type === 'text' ? [b.text] : []))
      .join('')
      .trim();
    const toolUses = blocks.filter((b): b is ToolUseBlock => b.type === 'tool_use');

    trace.push({
      step: budget.steps,
      kind: 'model',
      output: text.slice(0, 500),
      ms: elapsed,
      inputTokens: completion.usage.input,
      outputTokens: completion.usage.output,
      stop: completion.rawStopReason ?? completion.stopReason,
      offsetMs: startedAt - runStartedAt,
    });

    say({
      kind: 'thought',
      step: budget.steps,
      ms: elapsed,
      tokens: used,
      text: text.slice(0, 400),
    });

    // The model's turn goes back verbatim. Reconstructing it loses the tool-use
    // ids, and the next request is then rejected for referring to a call the
    // provider cannot find.
    messages.push({ role: 'assistant', content: blocks });

    // A turn that was CUT OFF is not an answer, and it is the one failure that
    // looks identical to success from the outside. `token_limit` rather than
    // `answered`, with a sentence saying what happened: the vocabulary belongs
    // to the budget, so the nearest true wall is used rather than a sixth value
    // that nothing reading `agent_runs.stop_reason` would recognise.
    if (completion.stopReason === 'max_tokens') {
      answer = text;
      stopReason = 'token_limit';
      stopDetail =
        `The model's turn was cut off at the ${MAX_OUTPUT_TOKENS.toLocaleString()}-token ` +
        'per-call ceiling, so this answer is incomplete rather than finished.';
      break;
    }

    if (toolUses.length === 0) {
      // No tool calls, so this turn is the answer — whatever the provider
      // called it. `end_turn` and `other` (a stop sequence, a content filter, a
      // refusal) are handled together on purpose: the loop has nothing
      // different to do about them, and the provider's own word is in the
      // trace for whoever investigates.
      //
      // The `tool_use`-with-no-tool_use-block case lands here too. That is an
      // adapter fault, and the alternative — pushing a user turn with no
      // tool_result blocks in it — is rejected by the API and loses a run that
      // may have had text in it.
      if (text) {
        answer = text;
        stopReason = 'answered';
      } else {
        // A turn with neither text nor a tool call is not an answer, and must
        // not be reported as one: an eval asserting `answered` would pass on an
        // empty non-answer. None of the budget's walls describes this, so the
        // least wrong of its names is used and the sentence carries the truth.
        stopReason = 'aborted';
        stopDetail =
          'The model ended its turn without text and without calling a tool ' +
          `(the provider said: ${completion.rawStopReason ?? completion.stopReason}), ` +
          'so there is no answer to report.';
      }
      break;
    }

    // The budget is consulted again before spending on tools. The model step
    // just charged may have crossed the token limit, and the clock may have
    // run out while it was in flight; either way the tools must not run.
    //
    // The check is before the BATCH rather than before each call, because the
    // calls in one turn are dispatched together — a check inside the batch
    // would be evaluated at the same instant for all of them. A batch already
    // in flight is not interrupted; the per-tool timeout is what bounds that.
    const toolWall = budget.check();
    if (toolWall) {
      stopReason = toolWall;
      break;
    }

    // Independent calls run together. The model routinely asks for two lookups
    // at once, and doing them in series spends the wall-clock budget on
    // waiting.
    const settled = await Promise.all(
      toolUses.map(async (call) => {
        say({ kind: 'tool', step: budget.steps, name: call.name, args: call.input });

        const toolStart = Date.now();
        // Tokens a tool spends on a model call of its own are charged to the
        // budget either way, and attributed to THIS call as well so the trace
        // can say which step cost what. Without it, a tool that drafts prose
        // shows as twenty seconds of unexplained silence.
        let tokens = 0;
        const callCtx: ToolContext = {
          ...ctx,
          spend: (t) => {
            tokens += t;
            budget.recordToolTokens(t);
          },
        };

        const { ok, result } = await withTimeout(
          () => executeTool(call.name, call.input, callCtx),
          toolTimeoutMs,
          call.name
        );
        const ms = Date.now() - toolStart;

        say({
          kind: 'tool_done',
          step: budget.steps,
          name: call.name,
          ok,
          ms,
          tokens,
          preview: result.content.slice(0, 200),
        });

        return {
          call,
          ok,
          result,
          ms,
          tokens,
          // Where this call began, relative to the run. These execute in
          // parallel and a list of durations cannot show that — two tools each
          // taking 3s read as 6s of work unless you know they overlapped.
          offsetMs: toolStart - runStartedAt,
        };
      })
    );

    // Reassembled in the order the model asked for them, because it refers to
    // them positionally as well as by id.
    const resultBlocks: ContentBlock[] = [];
    for (const { call, ok, result, ms, tokens, offsetMs } of settled) {
      budget.recordToolResult(ok);
      // Only a successful call contributes evidence. A refusal has no rows
      // behind it, and evidence is the thing that stops the model pointing at
      // something that was never returned.
      //
      // A card is collected on the same condition, and for a sharper reason: a
      // call that failed decided nothing, so a proposal from one would be a
      // question about an act nobody worked out. Approving it would re-run a call
      // that had already refused itself once.
      if (ok) {
        evidence.push(...result.evidence);
        if (result.proposal) proposals.set(result.proposal.writeKey, result.proposal);
      }

      trace.push({
        step: budget.steps,
        kind: 'tool',
        toolName: call.name,
        toolArgs: call.input,
        output: result.content.slice(0, 500),
        ok,
        ms,
        ...(tokens > 0 ? { tokens } : {}),
        offsetMs,
      });

      resultBlocks.push({
        type: 'tool_result',
        toolUseId: call.id,
        // An empty tool result is rejected by the provider, which would end a
        // run over a tool that returned nothing at all — a fault in the tool,
        // not in the conversation. Say that instead, and let the model decide.
        content:
          result.content.trim() ||
          `${call.name} returned no content at all, which is a fault in the tool rather than an answer.`,
        // A refusal is reported to the model as an error result so it can
        // correct itself, rather than being thrown and losing the run.
        isError: !ok,
      });
    }

    messages.push({ role: 'user', content: resultBlocks });
  }

  const detail = stopDetail ?? budget.describe(stopReason);
  if (stopReason !== 'answered') {
    say({ kind: 'wall', reason: stopReason, detail });
    // A run that hit a wall still owes the caller an explanation and whatever
    // it managed to establish. Silent truncation is the thing being avoided: an
    // answer that stopped mid-thought and a complete one look identical, and
    // only one of them should be believed.
    answer = answer || detail;
  }

  return {
    answer,
    writesAllowed: opts.allowWrites === true,
    stopReason,
    stopDetail: detail,
    steps: budget.steps,
    tokens: budget.tokens,
    ms: budget.elapsedMs(),
    evidence: dedupe(evidence),
    // Returned even when the run walled. A card the model got as far as
    // describing is a decision the operator can still make, and dropping it
    // because a later step ran out of steps would throw away the useful half of a
    // run that stopped.
    proposals: [...proposals.values()],
    trace,
    model: opts.model,
    provider: opts.provider.id,
  };
}

/**
 * A deadline for one request, folded together with the caller's own signal.
 *
 * `expired` is what lets the loop tell its own timeout apart from a provider
 * failure — an AbortError and a 500 arrive at the same `catch`, and reporting a
 * dead endpoint as `time_limit` would send somebody to look at the wrong thing.
 */
interface Deadline {
  signal: AbortSignal;
  readonly expired: boolean;
  dispose(): void;
}

function startDeadline(ms: number, caller?: AbortSignal): Deadline {
  const controller = new AbortController();
  const state = { expired: false };

  const timer = setTimeout(
    () => {
      state.expired = true;
      controller.abort(new Error('the run reached its wall-clock limit'));
    },
    // Never negative. `budget.check()` has already returned `time_limit` if
    // there was no time left, so this is belt and braces rather than a path.
    Math.max(ms, 0)
  );

  const relay = () => controller.abort();
  caller?.addEventListener('abort', relay, { once: true });

  return {
    signal: controller.signal,
    get expired() {
      return state.expired;
    },
    dispose() {
      clearTimeout(timer);
      caller?.removeEventListener('abort', relay);
    },
  };
}

async function withTimeout(
  fn: () => Promise<{ ok: boolean; result: ToolResult }>,
  ms: number,
  toolName: string
): Promise<{ ok: boolean; result: ToolResult }> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<{ ok: boolean; result: ToolResult }>((resolve) => {
    timer = setTimeout(
      () =>
        resolve({
          ok: false,
          // Reported to the model as a failed result, so it can try something
          // narrower rather than the run dying on a slow query. Note what this
          // does NOT do: the work carries on. Postgres keeps executing and the
          // pool stays one client smaller until `statement_timeout` fires,
          // which is why that timeout is set below this one.
          result: {
            content: `${toolName} took longer than ${ms}ms and was abandoned. Try a narrower request.`,
            evidence: [],
          },
        }),
      ms
    );
  });

  try {
    return await Promise.race([
      // `executeTool` already converts a thrown tool into a failed result, so
      // this catch is the second line rather than the first. It exists because
      // the loop cannot tell "the tool failed" from "the harness failed", and
      // the run should survive either well enough to report.
      fn().catch((err: unknown) => ({
        ok: false,
        result: {
          content: `${toolName} failed before it could return: ${
            err instanceof Error ? err.message : String(err)
          }`,
          evidence: [],
        },
      })),
      timeout,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Evidence is deduplicated by `table:id`, so two tools that both returned the
 * same client do not make the answer look twice as well supported. */
function dedupe(items: Evidence[]): Evidence[] {
  const seen = new Set<string>();
  return items.filter((e) => {
    const k = `${e.table}:${e.id}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
