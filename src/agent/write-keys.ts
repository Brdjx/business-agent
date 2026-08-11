/**
 * The idempotency ledger: one key per act, claimed before the write.
 *
 * A read done twice is waste. "Log four hours against Halden Freight" done twice
 * is a second billable line against someone real, and a model can call the same
 * tool twice in one turn while a retried step replays a call that already
 * succeeded. So every write derives a key from its own content, claims that key,
 * and a repeat returns the first result instead of writing again.
 *
 * Three things here, and the order of two of them is the whole mechanism:
 *
 *   writeKey(tool, user, parts)  a stable name for the act
 *   claim(key, …)                INSERT FIRST, before the write
 *   record(key, result)          what a later attempt will be handed back
 *
 * **Claim-before-write, not write-then-record.** The ledger row goes in first, so
 * two concurrent attempts race on a primary key rather than on the write itself
 * and the loser reads the winner's result. Recording afterwards leaves the window
 * that matters wide open: both writes land, and the ledger learns about it after
 * the fact.
 *
 * A unique violation on the claim is therefore the normal, expected path and not
 * an error. It is detected by the driver's error CODE — `23505` — and never by
 * matching the message text, which is localised, versioned, and different for
 * every constraint.
 *
 * What this is not: a transaction. It makes a repeat safe; it does not make a
 * multi-row write atomic. Every write tool in this repository touches exactly one
 * row for that reason, and a write spanning two tables needs the claim inside the
 * same transaction as the write (see the open edges in `docs/design.md`).
 */

import { createHash } from 'node:crypto';
import { one, sql } from '../db';
import { ToolError, type Evidence, type ToolContext, type ToolResult } from './tools';

/**
 * 128 bits of a SHA-256, hex. Enough that a collision is not a thing that
 * happens, short enough that the key is readable in a `select` and pasteable
 * into a `where`.
 */
const KEY_LENGTH = 32;

/**
 * A deterministic name for one act.
 *
 * Same intent, same key, however many times the model proposes it and however a
 * retry replays it. What goes in decides what counts as "the same act", so the
 * choice of parts is the design and not the plumbing.
 *
 * **The tool name.** Two tools doing different things to one row are two acts.
 *
 * **The operator.** The ledger's primary key is the key alone — see the comment
 * on `agent_write_keys.key` — so the user has to be inside the hash or two
 * operators would share one ledger row and the second would be told their write
 * had already happened.
 *
 * **Resolved ids, never the operator's words.** `"Dispatch Rewrite"`,
 * `"dispatch rewrite"` and `"dispatch"` all resolve to one `projects.id`, and
 * they are one act. Keying on the input string makes three acts out of one, and
 * the ledger then prevents nothing.
 *
 * **Anything that changes the consequence.** `billable` is in the key, because
 * the same hours logged billable and non-billable are two different entries and
 * must not collide — the first would silently stand in for the second. This is
 * also why the flag has to be *decided* before the key is derived: it is part of
 * the identity of the write, not a detail of how it is performed.
 *
 * The two write tools this repository extracts, spelled out, because getting a
 * part list wrong is invisible until a repeat is either allowed or refused
 * wrongly:
 *
 *   log_time           { project_id, entry_date, hours, note, billable }
 *   set_client_status  { client_id, status }
 *
 * `note` is in the first because two blocks of work on one day described
 * differently are two entries. `reason` is deliberately NOT in the second: a
 * reason annotates the act, and setting the same client to the same status is one
 * act whatever is written beside it.
 *
 * Renaming a part changes every key derived from it. That is a durable-data
 * decision, not a refactor: a card proposed before the rename computes one key
 * and, if it were re-derived after, another — so the ledger would no longer
 * recognise the act it already holds.
 */
export function writeKey(toolName: string, userId: string, parts: Record<string, unknown>): string {
  return (
    createHash('sha256')
      // NUL as the separator, because it cannot occur in a tool name, a uuid, or
      // the canonical JSON below. Joining on a space would make ("a b", "c") and
      // ("a", "b c") the same input.
      .update([toolName, userId, canonical(parts)].join('\u0000'))
      .digest('hex')
      .slice(0, KEY_LENGTH)
  );
}

/**
 * JSON with every object's keys sorted, recursively.
 *
 * The obvious one-liner for this is `JSON.stringify(parts, Object.keys(parts).sort())`
 * — a replacer array does canonicalise the order — and it is a trap: the same key
 * list is applied at every depth, so `{ a: { b: 1 } }` serialises as `{"a":{}}`
 * and two acts differing only inside a nested object get one key. These parts are
 * flat today; the trap is silent, and this is four lines.
 *
 * `undefined` is dropped, matching JSON, so an absent part and a part explicitly
 * set to `undefined` are one key. `null` is kept and is NOT the same as absent: a
 * tool that decided "no rate" and a tool that never considered the rate are
 * different, and the ledger should say so.
 *
 * Anything else — a bigint, a Date, a function — throws rather than being coerced.
 * A key nobody can reproduce is worse than a loud failure, and a Date silently
 * carrying a time zone into the identity of a write is exactly the sort of thing
 * that would be found months later.
 */
function canonical(value: unknown): string {
  if (value === null) return 'null';

  switch (typeof value) {
    case 'string':
    case 'boolean':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) {
        throw new Error(`A write key part is ${String(value)}, which cannot identify anything.`);
      }
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
      // A plain object, or nothing. A Date, a Map, a class instance and a Buffer
      // all reach here as `typeof 'object'`, and `Object.entries` of most of them
      // is `[]` — so without this check they would every one of them hash as `{}`
      // and every act carrying one would share a key with every other.
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        throw new Error(
          `A write key part of type ${value.constructor?.name ?? 'object'} cannot be hashed. ` +
            'Convert it to a string, a number or a boolean deliberately — money as a decimal ' +
            'string, a date as YYYY-MM-DD.'
        );
      }
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        // Code-unit order, not locale order: the key is durable data and must not
        // depend on where the process is running.
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
    }
    default:
      throw new Error(
        `A write key part of type ${typeof value} cannot be hashed. Convert it to a string, a ` +
          'number or a boolean deliberately — money as a decimal string, a date as YYYY-MM-DD.'
      );
  }
}

/* ─── the ledger ─── */

/** Postgres unique violation. The code, never the message. */
export const UNIQUE_VIOLATION = '23505';

/**
 * Whether an error is a unique violation.
 *
 * Exported because the proposals desk needs the same judgment for the partial
 * unique index on pending cards, and one spelling of "23505" is one place to be
 * wrong. Message matching is what this exists to prevent: the driver's text
 * differs per constraint and per server version, and a rule that reads
 * `includes('duplicate key')` fails silently on a localised server by taking the
 * error path for the normal case.
 */
export function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === UNIQUE_VIOLATION
  );
}

/** What the ledger stored for an act that has already been claimed. */
export type StoredResult = {
  /** Empty when the claim exists but no result was ever recorded against it. */
  content: string;
  evidence: Evidence[];
};

export type ClaimOutcome =
  | { claimed: true }
  | {
      /** Somebody else holds this key. Nothing has been written by this call. */
      claimed: false;
      previous: StoredResult;
    };

/**
 * Reserve a key before performing the write it names.
 *
 * Returns `{ claimed: true }` when this call owns the act and must now perform
 * it, or `{ claimed: false, previous }` when the act is already in the ledger —
 * in which case `previous` is what the first attempt recorded and the caller must
 * report that nothing was done a second time.
 *
 * Throws only for a failure that is not a conflict. A ledger that cannot be
 * written to must stop the write: proceeding would be performing an act with no
 * record that it happened, which is the state this table exists to prevent.
 */
export async function claim(
  key: string,
  userId: string,
  toolName: string,
  runId?: string | null
): Promise<ClaimOutcome> {
  return attemptClaim(key, userId, toolName, runId ?? null, 1);
}

/**
 * `attempt` exists for one narrow race, and it is bounded at two on purpose.
 *
 * A failed write releases its claim (see `once`). So a second caller can take a
 * unique violation and then, a moment later, find no row: the winner's write
 * failed and it deleted the row between the two statements. Reporting that as
 * "already performed" would be a false statement about the business, so the claim
 * is simply attempted again — the act is genuinely unclaimed now.
 */
async function attemptClaim(
  key: string,
  userId: string,
  toolName: string,
  runId: string | null,
  attempt: number
): Promise<ClaimOutcome> {
  try {
    await sql(
      // The result column is NOT NULL and is filled in by `record` once the
      // write has succeeded, so a row is a reservation first and a receipt
      // second.
      `INSERT INTO agent_write_keys (key, user_id, tool_name, run_id, result)
       VALUES ($1, $2, $3, $4, '{}'::jsonb)`,
      [key, userId, toolName, runId]
    );
    return { claimed: true };
  } catch (err) {
    if (!isUniqueViolation(err)) {
      throw new ToolError(
        `Could not reserve the write, so nothing was attempted: ${messageOf(err)}`
      );
    }

    const previous = await storedResult(key);
    if (previous) return { claimed: false, previous };

    if (attempt < 2) return attemptClaim(key, userId, toolName, runId, attempt + 1);

    // Two conflicts and no readable row. Something is holding the key that this
    // process cannot see; the honest report is that nothing was done, not that
    // the act succeeded.
    return { claimed: false, previous: { content: '', evidence: [] } };
  }
}

/**
 * Store what a later attempt will be handed back.
 *
 * Only `content` and `evidence`: a `proposal` on the result would be a card
 * replayed out of its own past, and the write path never produces one anyway.
 */
export async function record(key: string, result: ToolResult): Promise<void> {
  await sql(`UPDATE agent_write_keys SET result = $2::jsonb WHERE key = $1`, [
    key,
    JSON.stringify({ content: result.content, evidence: result.evidence }),
  ]);
}

/**
 * Give up a claim.
 *
 * A failed write MUST release, or one transient database error becomes a
 * permanent refusal to ever perform that act again and the only way out is a
 * manual delete from a table nobody remembers exists.
 */
export async function release(key: string): Promise<void> {
  await sql(`DELETE FROM agent_write_keys WHERE key = $1`, [key]);
}

/**
 * Perform a write once, ever, for a given key.
 *
 * The composition of the three above, in the one order that is safe. A write tool
 * should reach for this rather than assembling the parts itself — the ordering is
 * the guarantee, and it is not visible in a call site that has it wrong.
 *
 * `perform` is only called when this process owns the claim. It must do the write
 * and return the result to be recorded; if it throws, the claim is released and
 * the error propagates to `executeTool`, which turns it into a failed tool result.
 */
export async function once(
  key: string,
  ctx: ToolContext,
  toolName: string,
  perform: () => Promise<ToolResult>
): Promise<ToolResult> {
  const outcome = await claim(key, ctx.userId, toolName, ctx.runId);
  if (!outcome.claimed) return replay(outcome.previous);

  let result: ToolResult;
  try {
    result = await perform();
  } catch (err) {
    // Released before rethrowing, and the release's own failure is swallowed:
    // the caller is owed the reason the WRITE failed, not the reason the cleanup
    // did. A stuck claim is recoverable by hand; a masked error is not
    // recoverable at all.
    await release(key).catch((cleanupErr: unknown) => {
      console.error(
        `agent: ${toolName} failed and its write key could not be released (${key}) —`,
        messageOf(cleanupErr)
      );
    });
    throw err;
  }

  // Recorded after the write, and its failure is LOGGED rather than thrown. The
  // write has already happened: letting this throw would run the release above
  // and leave the act unclaimed, so a retry would perform it a second time —
  // exactly the outcome the ledger exists to prevent. The cost of the swallow is
  // a row whose result is '{}', which a later attempt reports as unknown rather
  // than as done.
  await record(key, result).catch((err: unknown) => {
    console.error(
      `agent: ${toolName} wrote successfully but its result could not be recorded (${key}) —`,
      messageOf(err)
    );
  });

  return result;
}

/**
 * What a second attempt is told.
 *
 * The empty case is the hole named in `db/002-agent.sql`: a process killed
 * between the claim and the update leaves a row asserting a write nobody can
 * confirm. Reporting that as "already performed" would be inventing a fact about
 * the business, so it says what is actually known — nothing was done here, and
 * the record needs looking at.
 */
function replay(previous: StoredResult): ToolResult {
  if (previous.content.trim() === '') {
    return {
      content:
        'This exact write was already claimed by an earlier attempt, and that attempt never ' +
        'recorded a result — so whether it completed cannot be told from here. NOTHING was ' +
        'done a second time by this call. Say that the record needs checking rather than ' +
        'reporting it as done.',
      evidence: previous.evidence,
    };
  }
  return {
    content: `${previous.content}\n\nThis exact write was already performed. Nothing was done a second time.`,
    evidence: previous.evidence,
  };
}

async function storedResult(key: string): Promise<StoredResult | null> {
  const row = await one<{ result: unknown }>(
    `SELECT result FROM agent_write_keys WHERE key = $1`,
    [key]
  );
  if (!row) return null;

  // jsonb arrives parsed. The string branch is for a value that went in as text
  // through some other path; a shape this does not recognise reads as "nothing
  // recorded", which `replay` reports honestly rather than as a success.
  const value = typeof row.result === 'string' ? parse(row.result) : row.result;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { content: '', evidence: [] };
  }
  const stored = value as { content?: unknown; evidence?: unknown };
  return {
    content: typeof stored.content === 'string' ? stored.content : '',
    evidence: Array.isArray(stored.evidence) ? (stored.evidence as Evidence[]) : [],
  };
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));
