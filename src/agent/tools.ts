/**
 * The tools, and the gate in front of them.
 *
 * The model proposes; the harness decides. A tool call arriving from the model
 * is an untrusted string until it has matched a registered name and its
 * arguments have passed that tool's own validator. Nothing else executes.
 *
 * This file is the contract only: the `Tool` shape, the registry that is the
 * allowlist, the validation helpers every tool shares, and `executeTool`. The
 * tools themselves live in `tools/`, and none of them is imported here — see
 * the note on the registry for the bug that arrangement exists to prevent.
 *
 * Every tool result carries evidence: the table and row id each fact came from.
 * That is not decoration. It is what lets a run be checked afterwards, and it is
 * what stops the model reporting something it cannot point at.
 */

import type { ToolSpec } from './providers/types';

/* ─── what a result is ─── */

/** A record a claim can be traced back to. */
export interface Evidence {
  /** The table it came from, as spelled in `db/`: `clients`, `invoices`, … */
  table: string;
  id: string;
  /** What a person would call it: a client name, an invoice number. */
  label: string;
}

/**
 * The row a card pinned, and what it asserted about that row.
 *
 * `table` and `id` freeze WHICH row the operator was shown, and that is not
 * something the stored call can do on its own. The arguments a tool validated
 * may still contain a project *name*, so approving re-resolves that name — and
 * in the hour a card sat on the desk a second project can have come to match it,
 * or the one that matched can have been renamed. The precondition is what makes
 * "yes" mean yes to a row.
 *
 * `expect` is what the card claimed about that row, re-read immediately before
 * the write. Two kinds of column belong in it, and the second is the one that
 * gets forgotten:
 *
 * - **What the summary said out loud.** A card reading `active -> inactive` is a
 *   claim about the present tense. If the status has moved since, applying the
 *   change would overwrite whatever happened in between.
 * - **What decides the consequence, even if the card never printed it.** A time
 *   entry pins its project's `rate_cents`. The card does not show the rate, but
 *   the rate is what the client is eventually billed, and a proposal read at one
 *   rate must not be applied at another.
 *
 * An empty `expect` means the card pinned nothing beyond the row's existence.
 * That is a per-tool judgment and it is deliberately not checked against the
 * summary: nothing verifies that a sentence and a precondition agree (see the
 * open edges in `docs/design.md`), so a tool that asserts a column in words and
 * pins nothing produces a card that reads more carefully than it is.
 */
export interface Precondition {
  /**
   * As spelled in `db/001-business.sql`.
   *
   * The approval path will only re-read business tables, and refuses a
   * precondition naming anything else rather than querying it: the value
   * arrives from a JSONB column, a column name cannot be a bound parameter, and
   * a check that cannot be made safely is not a check that passed.
   */
  table: string;
  id: string;
  /** column -> the value it had when the card was shown. */
  expect: Record<string, unknown>;
}

/**
 * A write that has not happened, in the form approving it later requires.
 *
 * With `allowWrites` false a write tool resolves its target, decides everything
 * it would decide, and returns one of these instead of writing. `recordProposals`
 * turns it into a row on `agent_proposals`, and approving that row re-runs THIS
 * call through `executeTool`.
 *
 * Which is why every field here is something that must not be re-derived at
 * approval time. The obvious way to act on a proposal — turn writes on and ask
 * the question again — grants permission to a session rather than to an action,
 * and re-resolves the request from scratch: the same words, an hour later, can
 * mean a different row, or the same row at a different rate. What the operator
 * agreed to was a sentence about a record, and asking again preserves neither.
 *
 * So there is deliberately nothing here that the desk would have to recompute or
 * reword. The model is not consulted a second time, and anything it would have
 * to decide again is a way for the applied thing to differ from the approved
 * thing.
 */
export interface ProposalDraft {
  /** The tool to re-run. A registered name: the approval path looks it up in
   * this same allowlist, through this same `executeTool`. */
  toolName: string;
  /**
   * The VALIDATED arguments, exactly as this tool's own `validate` returned
   * them — never the model's raw input.
   *
   * They are validated again on the way out, so a row edited by hand cannot
   * smuggle anything past the tool's checks. Storing the raw input would also
   * store whatever the validator refused to accept, and the card would then
   * describe something the tool never agreed to.
   */
  args: Record<string, unknown>;
  /** The sentence the operator reads before deciding. The card is the contract:
   * what gets applied has to be what this says. */
  summary: string;
  /**
   * Computed here, at propose time, from the RESOLVED ids — see `write-keys.ts`.
   *
   * Computing it at propose time is what lets the ledger recognise an approval
   * and a write-enabled run as one act rather than two, so approving something
   * that already happened replays the first result instead of doing it twice.
   */
  writeKey: string;
  /**
   * What the card is ABOUT, stable across revisions. Set it only where a
   * revision is a real possibility.
   *
   * The case that needs it is a tool producing revisable content: ask for a
   * draft, read it, ask for changes. The second draft is genuinely a different
   * act and gets a different `writeKey` — that is what stops the ledger
   * replaying draft one in place of draft two. But left alone the first card
   * stays on the desk, still pending, still approvable, and approving it applies
   * the draft that was rejected. A shared subject is what lets the new card
   * retire the old one without touching the ledger's notion of a distinct write.
   *
   * Both write tools in this repository — log a block of time, set a client's
   * status — have nothing revisable about them, so both leave this unset and the
   * supersession path never runs. A key invented for every write is a second
   * identity to keep consistent for no gain.
   */
  subjectKey?: string;
  /** The row this resolved to. The same shape as evidence because it IS
   * evidence: the record the card rests on, and the row a precondition pins. */
  target: Evidence;
  precondition: Precondition;
  /**
   * The records the card rests on, stored on the proposal row.
   *
   * Kept beside the result's own evidence rather than shared with it: the result
   * is what this run's model may cite, and this is what the desk shows about a
   * card nobody has decided yet. They are usually the same rows and they are not
   * the same claim.
   */
  evidence: Evidence[];
}

export interface ToolResult {
  /**
   * What the model sees. Prose, and kept small — a tool is a lookup, not a data
   * dump. A tool that returned half a table would spend the run's token budget
   * in one step, and the step limit cannot see that happen.
   */
  content: string;
  /**
   * What a person can check the answer against, and what an eval can assert on
   * mechanically. "This answer rests on a row from `invoices`" is checkable;
   * "this answer is good" is not.
   *
   * A tool that found nothing returns none, which is the point: there is then
   * nothing to point at, and the prompt rule that a number must come from a
   * tool has something concrete behind it.
   */
  evidence: Evidence[];
  /**
   * What this call WOULD have done, when it was not allowed to do it.
   *
   * Present only on a write tool's propose path — `allowWrites` false — and
   * absent on every read, and absent again when the same tool actually performs
   * the write. A run collects these and hands them to `recordProposals`; nothing
   * in `executeTool` reads it, because whether a card is kept is the caller's
   * decision and not the tool's.
   *
   * `content` still has to say plainly that nothing happened. The proposal is
   * for the operator; the sentence is what stops the model reporting a write it
   * did not perform.
   */
  proposal?: ProposalDraft;
}

/**
 * Thrown by a tool's `validate`, with a message written for the MODEL — it is
 * the thing that will read it and retry. `executeTool` turns it into a tool
 * result rather than letting it escape.
 */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolError';
  }
}

/* ─── what a tool is ─── */

/**
 * Validates raw arguments from the model and returns the accepted ones.
 *
 * Returns a *new* object rather than the input: the returned record is what
 * runs, and later what a proposal stores, so anything the validator did not
 * explicitly accept must not be carried along inside it.
 *
 * Throws `ToolError` with a sentence the model can act on.
 */
export type Validator = (raw: unknown) => Record<string, unknown>;

/**
 * Everything a tool is allowed to know about the run it belongs to.
 *
 * Passed explicitly, never read from module state. A module-level flag works
 * right up until two runs share a process, at which point a write tool reads
 * another run's permission — and that is not a bug worth shipping in code other
 * people will copy.
 */
export interface ToolContext {
  /**
   * The operator. Passed in, never taken from the model.
   *
   * Note what it does and does not scope in this schema: the `agent_*` tables
   * carry a `user_id` column and the business tables do not, so this is the
   * scope for traces, proposals, the write-key ledger and notes. A read of
   * `clients` is not filtered by it because there is no column to filter on.
   */
  userId: string;
  /**
   * False means a write tool describes what it WOULD do and does nothing.
   *
   * There is no write tool in this phase, and the flag is here anyway. Two
   * reasons. A read path that cannot see the flag cannot report honestly on the
   * mode it is in — "I can look that up but I cannot change it" is a true
   * sentence only if something knows. And a flag added later is a flag every
   * existing tool was written without: the absence of exactly this field is
   * what let a whole phase go by before anyone noticed which layer the decision
   * belonged in.
   */
  allowWrites: boolean;
  /**
   * The run this call belongs to, when there is one.
   *
   * Written onto the idempotency ledger and onto a proposal, so a write and the
   * reasoning that led to it stay joined: "which run logged these four hours" is
   * then a query rather than a guess from timestamps. Both columns are
   * `ON DELETE SET NULL`, so pruning a trace loses the provenance and keeps the
   * ledger entry that prevents a double write.
   *
   * Optional, and legitimately absent twice over. A run that failed to persist
   * has no id to give, and the approval path passes the id of the run that
   * *proposed* the card — there is no run for the approval itself, because
   * approving is a person pressing a button and not the agent taking a turn.
   */
  runId?: string;
  /**
   * Charge tokens a tool spent on a model call of its own.
   *
   * A tool that drafts prose makes a second model call the loop never sees, and
   * uncounted it makes an expensive run report as a cheap one. Optional so a
   * tool need not know whether anyone is keeping accounts — but the loop always
   * passes it, and it charges tokens without charging a step (see
   * `Budget.recordToolTokens`).
   */
  spend?: (tokens: number) => void;
}

export interface Tool {
  /** The name the model calls, and the key in the allowlist. */
  name: string;
  /** When to use it, written for the model. This is the routing decision being
   * delegated, so it says what question the tool answers rather than what it
   * does internally. */
  description: string;
  /** JSON Schema for the arguments, sent to the provider as-is. A hint the
   * model usually follows; `validate` is what decides. */
  inputSchema: Record<string, unknown>;
  validate: Validator;
  run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;
}

/** What `executeTool` returns: whether the call worked, and what to hand back
 * to the model either way. */
export interface ToolExecution {
  ok: boolean;
  result: ToolResult;
}

/* ─── validation helpers ─── */

/**
 * Shared, and exported, because the messages are read by the model.
 *
 * Each tool owns its own rules — what a valid `hours` is, whether a date may be
 * in the future — but the phrasing of "that field is required" should not have
 * one spelling per file. Three variants of the same refusal is three chances for
 * one of them to be the unhelpful one, and the model's next attempt is decided
 * by whichever it happened to get.
 *
 * Two judgments run through all of them, and they are the interesting part:
 *
 * - **Clamp what is merely greedy.** A `limit` of 500 is clamped to the cap
 *   rather than refused. It is not worth a round trip — and it is also not a
 *   reason to read the whole table.
 * - **Refuse what is a misunderstanding.** A value that could only be a mistake
 *   is rejected outright, in a sentence, so the model gets something to act on
 *   instead of a Postgres constraint error to explain to a person.
 */

/** The argument object itself. An array is not an object here: a model that
 * sends positional arguments must be told, not silently indexed. */
export function asObject(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ToolError('Arguments must be a JSON object.');
  }
  return raw as Record<string, unknown>;
}

export function requireString(
  o: Record<string, unknown>,
  key: string,
  opts: { max?: number } = {}
): string {
  const v = o[key];
  if (typeof v !== 'string' || v.trim() === '') {
    throw new ToolError(`"${key}" is required and must be a non-empty string.`);
  }
  const s = v.trim();
  if (opts.max && s.length > opts.max) {
    throw new ToolError(`"${key}" must be ${opts.max} characters or fewer.`);
  }
  return s;
}

/**
 * Absent and empty are the same thing.
 *
 * A model filling in `client_name: ""` means "no filter", not "the client whose
 * name is the empty string", and the second reading turns an ILIKE '%%' into a
 * scan that matches everything — an unfiltered answer to a filtered question,
 * which is worse than an error because it looks like data.
 */
export function optionalString(
  o: Record<string, unknown>,
  key: string,
  opts: { max?: number } = {}
): string | undefined {
  const v = o[key];
  if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) {
    return undefined;
  }
  return requireString(o, key, opts);
}

/** A row cap. Clamped to `max`, never refused for being too large; refused for
 * not being a positive whole number, because a `limit` of -1 or 2.5 is a
 * misunderstanding rather than an appetite. */
export function optionalInt(
  o: Record<string, unknown>,
  key: string,
  opts: { default: number; max: number }
): number {
  const v = o[key];
  if (v === undefined || v === null) return opts.default;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) {
    throw new ToolError(`"${key}" must be a positive whole number.`);
  }
  return Math.min(n, opts.max);
}

/**
 * One of a fixed set.
 *
 * The refusal lists the values, because the model is about to guess again and
 * the list is the only thing that makes the second attempt better than the
 * first. Worth being exact where this schema is easy to get wrong: `clients.
 * status` is active | inactive | prospect and there is no 'lead';
 * `engagement_kind` is client | passed | own_venture | artifact and does not
 * contain 'prospect'. A tool that accepts a value the column cannot hold
 * returns nothing, and nothing reads as "you have no such clients".
 */
export function optionalEnum<T extends string>(
  o: Record<string, unknown>,
  key: string,
  allowed: readonly T[]
): T | undefined {
  const v = optionalString(o, key);
  if (v === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(v)) {
    throw new ToolError(`"${key}" must be one of: ${allowed.join(', ')}.`);
  }
  return v as T;
}

/**
 * A calendar date as 'YYYY-MM-DD', kept as a string.
 *
 * The DATE columns come back from the driver as strings for a reason (see
 * `src/db.ts`), the questions are asked in days, and a `Date` object drags a
 * time zone into a comparison that has no time in it. So the string is the type
 * all the way through.
 *
 * Validated as a real date, not just a shape: `2026-02-31` matches the pattern
 * and is not a day. Postgres would reject it, but as an error string the model
 * then has to explain to a person.
 *
 * Deliberately no bound on how far out or back it may be. "Not next March" is a
 * rule about logging time and not about reading a date range, so the tool that
 * needs it owns it.
 */
export function optionalDate(o: Record<string, unknown>, key: string): string | undefined {
  const v = optionalString(o, key);
  if (v === undefined) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    throw new ToolError(`"${key}" must be a date in YYYY-MM-DD form, e.g. 2026-08-04.`);
  }
  const parsed = new Date(`${v}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== v) {
    throw new ToolError(`"${key}" is not a real date: ${v}.`);
  }
  return v;
}

/* ─── the registry: the allowlist ─── */

/**
 * The registry is the allowlist. A name that is not in it cannot run, whatever
 * the model asks for.
 *
 * This is not defence against a hostile model so much as against an ordinary
 * one: a model that half-remembers a tool name from its training data, or that
 * invents the tool it wishes you had, is a normal Tuesday.
 *
 * ── Empty until something registers ──
 *
 * This file defines no tools. In the private original it defined two, and that
 * is exactly what made its worst bug unreadable: registration was a side effect
 * of importing the loop, so the approval endpoint — which has no reason to
 * import the loop — ran with a registry holding only those two, and every
 * approval of a write came back `There is no tool called draft_upwork_proposal.
 * Available tools: find_client, invoice_totals.` It ran that way for weeks,
 * because a short, plausible list reads like an allowlist working rather than
 * like a wiring fault.
 *
 * So the registry starts empty, and the caller that forgot to register is told
 * that nothing at all is registered — a sentence with only one possible cause.
 * Registration belongs in an explicit, idempotent call that every entry point
 * makes (the loop, and later the approval path), not in an import side effect:
 * an import whose only purpose is to run code is also the first thing a bundler
 * is entitled to drop.
 *
 * A Map rather than a plain object, because the key comes from the model. On an
 * object, a call to a tool named `constructor` or `__proto__` finds something
 * truthy on `Object.prototype` and the allowlist hands back a value that is not
 * a tool.
 */
const REGISTRY = new Map<string, Tool>();

/**
 * Make tools callable. Safe to call repeatedly.
 *
 * Registering is what makes a tool executable at all; the per-run `allowWrites`
 * flag is what decides whether it acts or only describes what it would do. The
 * two are separate gates and neither substitutes for the other.
 *
 * A repeated name replaces the earlier tool rather than throwing, so that two
 * entry points can both call the registration helper without the second one
 * failing. The cost is that two tools claiming one name is a silent collision;
 * the names are literals in this repo's own source, so the trade is worth it.
 */
export function registerTools(tools: Tool[]): void {
  for (const tool of tools) REGISTRY.set(tool.name, tool);
}

/**
 * Look a tool up without running it.
 *
 * A lookup, not a gate. Anything that intends to *execute* goes through
 * `executeTool`, which is where validation is; reaching in here and calling
 * `run` directly skips the tool's own checks on arguments that came from a
 * model, and later from a stored row.
 */
export function getTool(name: string): Tool | undefined {
  return REGISTRY.get(name);
}

export function allTools(): Tool[] {
  return [...REGISTRY.values()];
}

/**
 * The tools as the provider needs to see them.
 *
 * Built here rather than in the loop or the adapter, so that "which tools exist"
 * has one answer and the vendor mapping stays on the far side of the provider
 * boundary.
 */
export function toolSpecs(): ToolSpec[] {
  return allTools().map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }));
}

/**
 * Execute one proposed call, or explain why it will not be executed.
 *
 * Refusals come back as tool RESULTS with `ok: false`, not as thrown errors, so
 * the model reads what went wrong and can correct itself on the next step. A
 * harness that crashes on a bad tool call teaches the model nothing and loses a
 * run that was otherwise fine. The loop counts the `false` against the
 * consecutive-tool-error limit, which is what stops a model retrying a broken
 * dependency forever.
 *
 * ── Why this is a separate function, and not part of the loop ──
 *
 * Because approving a write re-runs *the stored call*, not the question that
 * produced it. A proposal holds the validated arguments and the tool name; the
 * approval path hands them back through here, so the same allowlist and the same
 * validator apply. Two things follow. A row edited by hand cannot smuggle
 * anything past a tool's own checks, since validation runs again on the way in.
 * And the approval path does not import the loop — which is a requirement, not
 * an accident of layering: it is what stops "may the agent change things" and
 * "may it do this one thing" from sharing a code path.
 */
export async function executeTool(
  name: string,
  rawArgs: unknown,
  ctx: ToolContext
): Promise<ToolExecution> {
  const tool = REGISTRY.get(name);
  if (!tool) {
    const available = allTools().map((t) => t.name);
    return {
      ok: false,
      result: {
        content: available.length
          ? `There is no tool called "${name}". Available tools: ${available.join(', ')}. ` +
            'Use one of those, or answer from what you already have.'
          : // Distinguished from the ordinary unknown-name case on purpose. An
            // empty allowlist is a wiring fault in the harness, and the model
            // cannot recover from it by picking a different name — so it is told
            // to stop rather than to try again.
            `No tools are registered in this process, so "${name}" could not be called and ` +
            'neither could anything else. This is a fault in the harness, not something to ' +
            'work around: say that you cannot look anything up right now.',
        evidence: [],
      },
    };
  }

  let args: Record<string, unknown>;
  try {
    args = tool.validate(rawArgs);
  } catch (err) {
    return {
      ok: false,
      result: {
        content: `Invalid arguments for ${name}: ${
          err instanceof Error ? err.message : String(err)
        }`,
        evidence: [],
      },
    };
  }

  try {
    return { ok: true, result: await tool.run(args, ctx) };
  } catch (err) {
    // A tool that throws is a tool that failed, not a run that failed. The
    // message goes to the model as an error result; whether it is worth
    // retrying is the model's next decision, and whether the run continues at
    // all is the budget's.
    return {
      ok: false,
      result: {
        content: `${name} failed: ${err instanceof Error ? err.message : String(err)}`,
        evidence: [],
      },
    };
  }
}
