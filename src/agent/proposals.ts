/**
 * Proposals — consent to the action, not to the session.
 *
 * The write gate answers "may the agent change things?" With writes off a tool
 * describes what it would do and does nothing, which is most of the way there.
 * What the gate cannot answer is the question that actually comes up: *may it do
 * THIS?*
 *
 * The obvious way to act on a proposal is to turn writes on and ask again. It has
 * two defects and the second is the interesting one. It grants permission to a
 * whole run rather than to an action — what was read was a sentence, what was
 * authorised is everything the model decides next. And it re-resolves the request
 * from scratch: "log 3 hours against Dispatch" resolved to one project when the
 * card was written, and an hour later *Dispatch Rewrite Phase 2* exists, or the
 * project was renamed, or its rate moved. Same words, different row, or the same
 * row with a different consequence.
 *
 * So the proposal is kept as a row. It holds the validated arguments, the row they
 * resolved to, the key the write will claim, and the facts that were true when it
 * was shown. Approving re-runs THAT CALL through the same `executeTool` — same
 * allowlist, same validation, same idempotency ledger — and refuses if the record
 * moved underneath it.
 *
 * Three properties follow, and each is a way this goes wrong if it is left out:
 *
 * **The approved thing is the applied thing.** Arguments are stored, not
 * re-derived, so the model cannot change its mind between the card and the write.
 *
 * **Approval is not a second chance to write.** The key was computed at propose
 * time, so approving something that already happened — from here, from a
 * write-enabled run, or from a retry of either — replays the first result.
 *
 * **A stale proposal is refused, not applied.** The world is allowed to move while
 * a card sits on the desk. When it does, the honest answer names what changed and
 * asks again, because the operator agreed to a diff that no longer describes
 * anything.
 *
 * ── What a stored call preserves, and what it does not ──
 *
 * Worth being exact, because a careless reading leaves a hole open. The stored
 * arguments are the ones the *tool* validated, and for a tool that takes a project
 * by name one of them is still a name. So the tool does resolve that name again on
 * approval: storing the call does not by itself freeze which row it lands on.
 *
 * What freezes the row is the precondition, which pins the resolved id and the
 * columns the card depended on. The order below is: is this mine, is it still
 * pending, has it aged out, and does the pinned row still say what the card said —
 * and only past all four does the stored call run.
 */

import { one, sql } from '../db';
import { ensureToolsRegistered } from './registry';
import { executeTool, type Evidence, type Precondition, type ProposalDraft } from './tools';
import { isUniqueViolation } from './write-keys';

/* ─── the shape of a card ─── */

export type ProposalStatus =
  | 'pending'
  | 'applied'
  | 'declined'
  | 'stale'
  | 'expired'
  | 'failed'
  // What happened to a card nobody decided about, kept distinct from 'declined'
  // on purpose. Declining is a decision somebody made; reporting the second as
  // the first tells the operator they rejected something they never saw again,
  // which is a false statement about their own actions.
  | 'superseded';

export type Decision = 'approve' | 'decline';

/**
 * A card, as the desk reads it.
 *
 * Column names, not camel case, because these rows come straight back from
 * Postgres and renaming them here would mean two vocabularies for one table — and
 * the SQL in this file is meant to be checkable against `db/002-agent.sql` by
 * eye.
 *
 * A `type` rather than an `interface`, and that is load-bearing rather than
 * stylistic: `sql<T>` constrains `T` to pg's `QueryResultRow`, which is an index
 * signature, and TypeScript gives an implicit index signature to object type
 * aliases and not to interfaces.
 */
export type Proposal = {
  id: string;
  tool_name: string;
  summary: string;
  target_table: string | null;
  target_id: string | null;
  target_label: string | null;
  status: ProposalStatus;
  /** What happened, in the words the tool used. Kept for the applied and the
   * refused alike: "the client is no longer active" is the useful half of a
   * proposal that went stale. */
  result: string | null;
  created_at: Date;
  decided_at: Date | null;
  expires_at: Date;
  run_id: string | null;
  subject_key: string | null;
  /**
   * The question whose run produced this card, when there was one.
   *
   * So the desk can say where a card came from: one the operator asked for and
   * one the scheduled run left while nobody was watching are different things to
   * find waiting, and only the second needs explaining. Absent rather than null
   * on a row that was just inserted — that path knows the run id and not the
   * question.
   */
  origin?: string | null;
};

/**
 * The desk: what is waiting, and what was recently decided.
 *
 * The decided half is not decoration. A desk showing only open cards cannot
 * answer "did I approve that?", and that question is the reason the record
 * exists.
 */
export type ProposalDesk = {
  pending: Proposal[];
  recent: Proposal[];
};

export interface DecisionOutcome {
  status: ProposalStatus;
  /** What happened, in words the operator reads. */
  message: string;
  evidence: Evidence[];
}

/**
 * One column list, used with and without a table alias.
 *
 * The desk's reads join `agent_runs`, and both tables have `id` and `created_at`,
 * so those reads must qualify every column; `INSERT ... RETURNING` has no alias to
 * qualify with. Two hand-written lists would drift — a column added to one and
 * not the other is a bug that only shows on whichever path the tests do not take
 * — so there is one array and a prefix. These are literals from this file, never
 * values from anywhere else.
 */
const CARD_FIELDS = [
  'id',
  'tool_name',
  'summary',
  'target_table',
  'target_id',
  'target_label',
  'status',
  'result',
  'created_at',
  'decided_at',
  'expires_at',
  'run_id',
  'subject_key',
] as const;

const cardColumns = (prefix = ''): string => CARD_FIELDS.map((f) => `${prefix}${f}`).join(', ');

/** `agent_proposals.result` is TEXT with no length limit; a tool that returned a
 * wall of prose should not make the row that records the decision unreadable. */
const MAX_RESULT = 4_000;

/** A desk is a page of things to act on, not a table dump. */
const PENDING_LIMIT = 25;
const RECENT_LIMIT = 10;

/* ─── recording what a run proposed ─── */

/**
 * Persist what a run proposed, and return the cards that are now on the desk.
 *
 * Never throws. A proposal that could not be written is a proposal the operator
 * does not see, which is the same outcome as the agent not having suggested it —
 * inconvenient, and strictly better than losing the answer that came with it.
 *
 * Returns one card per draft that made it, in order, and fewer than it was given
 * if one could not be written. Identical drafts collapse: two drafts with one
 * write key produce one card, because asking twice is not consenting twice.
 */
export async function recordProposals(
  userId: string,
  runId: string | null,
  drafts: ProposalDraft[]
): Promise<Proposal[]> {
  if (drafts.length === 0) return [];

  // Before anything is written. A card past its expiry is still marked pending
  // and still holds the write key a fresh card would need, so left alone, asking
  // again tomorrow keeps returning the one card the operator is not allowed to
  // act on. Swept for the whole operator rather than only for the keys about to
  // be inserted: an expired card that nothing re-proposes is exactly the one
  // nobody would otherwise retire, and it would sit on the desk looking
  // approvable.
  await expirePending(userId);

  const out: Proposal[] = [];

  for (const draft of drafts) {
    try {
      // A revision retires what it replaces, BEFORE anything new is written. Ask
      // for a draft, read it, ask for changes: without this the earlier card
      // stays on the desk and approving it applies the version that was
      // rejected.
      await retireSuperseded(userId, draft);

      const first = await insertProposal(userId, runId, draft);
      if (first !== 'conflict') {
        out.push(first);
        continue;
      }

      // The partial unique index on (user_id, write_key) WHERE status='pending'
      // fired: this exact act is already on the desk. That is not an error and
      // must not become two separately approvable cards.
      const existing = await pendingByWriteKey(userId, draft.writeKey);

      if (!existing) {
        // Conflicted and yet nothing pending holds the key — it was decided
        // between the two statements. The act is proposable again.
        const retry = await insertProposal(userId, runId, draft);
        if (retry !== 'conflict') out.push(retry);
        continue;
      }

      if (msSince(existing.expires_at) >= 0) {
        // Belt and braces after the sweep above, which uses the database's clock
        // where this uses the process's. A card that aged out in between is
        // retired here rather than returned, because returning it hands the
        // operator something they cannot approve.
        await settle(existing.id, 'expired', EXPIRED_UNDECIDED, []);
        const retry = await insertProposal(userId, runId, draft);
        if (retry !== 'conflict') out.push(retry);
        continue;
      }

      out.push(existing);
    } catch (err) {
      console.error('agent: could not record proposal —', messageOf(err));
    }
  }

  return out;
}

const EXPIRED_UNDECIDED = 'Aged out without a decision. Nothing was changed.';

/** Retire every pending card of this operator's that is past its expiry. */
async function expirePending(userId: string): Promise<void> {
  try {
    const rows = await sql<{ id: string }>(
      `UPDATE agent_proposals
          SET status = 'expired', result = $2, decided_at = now()
        WHERE user_id = $1
          AND status = 'pending'
          AND expires_at <= now()
        RETURNING id`,
      [userId, EXPIRED_UNDECIDED]
    );
    if (rows.length > 0) {
      console.log(`agent: retired ${rows.length} expired proposal(s) before proposing`);
    }
  } catch (err) {
    // Logged, not thrown. Failing to tidy up must not cost the operator the card
    // the run actually wanted to leave them.
    console.error('agent: could not retire expired proposals —', messageOf(err));
  }
}

/**
 * Retire any pending card about the same thing.
 *
 * Keyed on the SUBJECT, not the write key. The write key deliberately differs
 * between revisions — that is what makes a revision a distinct act and stops the
 * ledger replaying the first version in place of the second — so it cannot also be
 * what recognises them as versions of one another.
 *
 * Marked `superseded`, never `declined`.
 */
async function retireSuperseded(userId: string, draft: ProposalDraft): Promise<void> {
  if (!draft.subjectKey) return;

  const rows = await sql<{ id: string }>(
    `UPDATE agent_proposals
        SET status = 'superseded', result = $3, decided_at = now()
      WHERE user_id = $1
        AND subject_key = $2
        AND status = 'pending'
      RETURNING id`,
    [userId, draft.subjectKey, 'Replaced by a newer version of the same proposal.']
  );

  if (rows.length > 0) {
    console.log(`agent: superseded ${rows.length} earlier proposal(s) for the same subject`);
  }
}

/**
 * Insert one card, or report that the desk already holds this act.
 *
 * The JSONB parameters are stringified BY HAND. node-postgres serialises a JS
 * array as a Postgres ARRAY literal, which a jsonb column rejects — and `evidence`
 * is an array. The Supabase client this was ported from took objects directly, so
 * this is exactly the kind of difference that typechecks and then fails on the
 * first real insert.
 */
async function insertProposal(
  userId: string,
  runId: string | null,
  draft: ProposalDraft
): Promise<Proposal | 'conflict'> {
  try {
    const row = await one<Proposal>(
      `INSERT INTO agent_proposals (
         user_id, run_id, tool_name, args, write_key, subject_key,
         summary, target_table, target_id, target_label, precondition, evidence
       ) VALUES (
         $1, $2, $3, $4::jsonb, $5, $6,
         $7, $8, $9, $10, $11::jsonb, $12::jsonb
       )
       RETURNING ${cardColumns()}`,
      [
        userId,
        runId,
        draft.toolName,
        JSON.stringify(draft.args),
        draft.writeKey,
        draft.subjectKey ?? null,
        draft.summary,
        draft.target.table,
        draft.target.id,
        draft.target.label,
        JSON.stringify(draft.precondition),
        JSON.stringify(draft.evidence),
      ]
    );
    if (!row) {
      // RETURNING on a successful single-row insert always yields a row, so this
      // is unreachable in practice. It is here rather than as a `!` because the
      // alternative is a TypeError inside a function that promises not to throw.
      throw new Error('the proposal was inserted but no row came back');
    }
    return row;
  } catch (err) {
    if (isUniqueViolation(err)) return 'conflict';
    throw err;
  }
}

async function pendingByWriteKey(userId: string, writeKey: string): Promise<Proposal | null> {
  return one<Proposal>(
    `SELECT ${cardColumns()}
       FROM agent_proposals
      WHERE user_id = $1 AND write_key = $2 AND status = 'pending'
      LIMIT 1`,
    [userId, writeKey]
  );
}

/* ─── reading the desk ─── */

/**
 * What is waiting, and what was recently decided.
 *
 * RAISES on a query failure, and the absence of a `catch` here is the point. An
 * empty array reads as "nothing is waiting on you", which is a statement about the
 * business that a broken query is not entitled to make. That exact bug shipped in
 * the original: a join failed, the read returned `data ?? []`, and the desk went
 * blank — and a proposal nobody sees is a proposal nobody approves.
 */
export async function listProposals(
  userId: string,
  limits: { pending?: number; recent?: number } = {}
): Promise<ProposalDesk> {
  const pendingLimit = limits.pending ?? PENDING_LIMIT;
  const recentLimit = limits.recent ?? RECENT_LIMIT;

  try {
    const [pending, recent] = await Promise.all([
      sql<Proposal>(
        // LEFT JOIN, not JOIN. `run_id` is nullable and ON DELETE SET NULL, so an
        // inner join would silently drop exactly the cards whose run was pruned
        // or never persisted — the ones with the least context, hidden by the
        // query that exists to give them context.
        `SELECT ${cardColumns('p.')}, r.question AS origin
           FROM agent_proposals p
           LEFT JOIN agent_runs r ON r.id = p.run_id
          WHERE p.user_id = $1 AND p.status = 'pending'
          ORDER BY p.created_at DESC
          LIMIT $2`,
        [userId, pendingLimit]
      ),
      sql<Proposal>(
        `SELECT ${cardColumns('p.')}, r.question AS origin
           FROM agent_proposals p
           LEFT JOIN agent_runs r ON r.id = p.run_id
          WHERE p.user_id = $1 AND p.status <> 'pending'
          ORDER BY p.decided_at DESC NULLS LAST
          LIMIT $2`,
        [userId, recentLimit]
      ),
    ]);

    return { pending, recent };
  } catch (err) {
    throw new Error(
      `Could not read the proposals: ${messageOf(err)}. Reporting this rather than an empty ` +
        'desk, because an empty desk is a claim that nothing is waiting.',
      { cause: err }
    );
  }
}

/* ─── deciding ─── */

/**
 * Approve or decline one card.
 *
 * Everything that can refuse, refuses before the write: the wrong owner, a card
 * already decided, one that has aged out, one whose record has moved. Only past
 * all four does the stored call run, and it runs through `executeTool` rather than
 * around it — so the arguments are validated a second time and a row edited by
 * hand cannot smuggle anything past the tool's own checks.
 *
 * Throws only for "there is no such card". Every other outcome is a
 * `DecisionOutcome` with a status and a sentence, because a refusal is a result
 * the operator is owed and not an exception.
 */
export async function decideProposal(opts: {
  userId: string;
  id: string;
  decision: Decision;
  /** For the expiry comparison. Injectable so a test does not have to construct
   * a row and then wait a day. */
  now?: Date;
}): Promise<DecisionOutcome> {
  const now = opts.now ?? new Date();

  if (!UUID.test(opts.id)) {
    // Refused here rather than sent to Postgres, which answers a malformed uuid
    // with "invalid input syntax for type uuid" — a database error where the
    // truth is that the caller named something that cannot be a card.
    throw new Error(`"${opts.id}" is not a proposal id.`);
  }

  const row = await one<DecidableRow>(
    `SELECT ${cardColumns('p.')}, p.args, p.write_key, p.precondition
       FROM agent_proposals p
      WHERE p.id = $1
        -- Scoped to the caller, not checked afterwards. Somebody else's proposal
        -- has to read as absent rather than as forbidden: "not found" tells a
        -- stranger nothing, and "forbidden" confirms the card exists.
        AND p.user_id = $2`,
    [opts.id, opts.userId]
  );

  if (!row) throw new Error('No such proposal.');

  if (row.status !== 'pending') {
    // Already settled. Report which way rather than pretending this press did
    // something: a button pressed twice must not read as two approvals, and must
    // not reach the tool a second time to find out.
    const when = row.decided_at ? ` on ${formatWhen(row.decided_at)}` : '';
    return {
      status: row.status,
      message:
        `This was already ${row.status}${when}.` + (row.result ? ` ${row.result}` : ''),
      evidence: [],
    };
  }

  if (opts.decision === 'decline') {
    // Declining is always available, including after expiry and including for a
    // card whose record has moved. Clearing the desk is not an action on the
    // business, and an expired card nobody can dismiss is just clutter.
    await settle(row.id, 'declined', DECLINED, []);
    return { status: 'declined', message: DECLINED, evidence: [] };
  }

  if (msSince(row.expires_at, now) >= 0) {
    const message =
      'This proposal has aged out and was not applied. Ask again if it is still wanted — ' +
      'the records may have changed since it was written.';
    await settle(row.id, 'expired', message, []);
    return { status: 'expired', message, evidence: [] };
  }

  const moved = await changedSincePropose(row.precondition);
  if (moved) {
    const message = `Not applied: ${moved} Ask again so the proposal describes what is there now.`;
    await settle(row.id, 'stale', message, []);
    return { status: 'stale', message, evidence: [] };
  }

  // Without this the registry holds only whatever this bundle happened to import,
  // and approving a write reports the tool as nonexistent — which is exactly what
  // production did for weeks (incident 1). Deliberately a call and not an import
  // side effect. `proposals.test.ts` registers nothing itself and drives this
  // path, so it is the only test that would notice this line being deleted; read
  // it before removing this.
  ensureToolsRegistered();

  const { ok, result } = await executeTool(row.tool_name, row.args, {
    userId: opts.userId,
    allowWrites: true,
    // The run that PROPOSED it, so the write and the reasoning that led to it
    // stay joined in the ledger. There is no run for the approval itself: this is
    // a person pressing a button, not the agent taking a turn — which is also why
    // no `spend` is passed. A tool that calls a model of its own spends tokens
    // nothing here counts, and that is a real gap rather than a decision.
    runId: row.run_id ?? undefined,
  });

  // A known open edge, written down rather than papered over: this settles on
  // whether the tool RAN, not on whether it wrote. A write tool that declines at
  // apply time — the project name has become ambiguous since the card was written
  // — returns a normal result saying nothing was logged, and lands here as
  // 'applied'. Nothing was written, which is correct; the label is not. Closing
  // it needs the tool to report wrote-or-declined explicitly instead of having it
  // inferred from the absence of an exception.
  const status: ProposalStatus = ok ? 'applied' : 'failed';
  await settle(row.id, status, result.content, result.evidence);

  return { status, message: result.content, evidence: result.evidence };
}

const DECLINED = 'Declined. Nothing was changed.';

/** The card plus the parts only the decide path needs. */
type DecidableRow = Proposal & {
  args: Record<string, unknown>;
  write_key: string;
  /** `unknown` on purpose: it is JSONB, so it is whatever is in the row. */
  precondition: unknown;
};

/**
 * Write the decision onto the card.
 *
 * Logged, not thrown. By the time this runs the write may already have happened,
 * and failing the request now would tell the operator it did not — the worse of
 * the two lies.
 *
 * Deliberately not conditional on `status = 'pending'`. Two concurrent approvals
 * of one card are made safe by the write-key ledger, which lets exactly one of
 * them perform the act and hands the other the first one's result; making this
 * update the guard instead would put the check in the row and leave the write
 * unprotected.
 */
async function settle(
  id: string,
  status: ProposalStatus,
  result: string,
  evidence: Evidence[]
): Promise<void> {
  try {
    await sql(
      `UPDATE agent_proposals
          SET status = $2, result = $3, evidence = $4::jsonb, decided_at = now()
        WHERE id = $1`,
      [id, status, result.slice(0, MAX_RESULT), JSON.stringify(evidence)]
    );
  } catch (err) {
    console.error(`agent: could not settle proposal ${id} —`, messageOf(err));
  }
}

/* ─── has the record moved? ─── */

/**
 * The tables a precondition may name, and the noun a refusal calls each one.
 *
 * An allowlist because a table name cannot be a bound parameter and this value
 * arrives from a JSONB column. It is also the reason the nouns are spelled out
 * rather than derived: stripping a trailing "s" turns `time_entries` into a
 * "time_entrie", and a refusal that reads like a bug is a refusal the operator
 * stops reading.
 */
const PINNABLE: Record<string, string> = {
  clients: 'client',
  contacts: 'contact',
  projects: 'project',
  invoices: 'invoice',
  time_entries: 'time entry',
};

/** Column names this path will build SQL from. Everything else is refused. */
const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Whether the record has moved since the card was written.
 *
 * Returns a sentence naming what changed, or null if nothing did. The sentence is
 * the useful part: "status is now prospect, not active" tells the operator why the
 * answer was no and what to do next, where a bare "cannot apply" makes the system
 * look broken rather than careful.
 *
 * A check that cannot be MADE is not a check that passed. If the row is gone, if
 * the query fails, or if the precondition itself is not something this path can
 * safely read, the answer is no — this gate exists precisely for the case where
 * the record is not what it was.
 */
async function changedSincePropose(raw: unknown): Promise<string | null> {
  const pin = readPin(raw);
  if (pin.kind === 'none') return null;
  if (pin.kind === 'unusable') return pin.why;

  const { table, id, expect } = pin.pre;

  const noun = PINNABLE[table];
  if (!noun) {
    return (
      `the proposal pins a row in "${table}", which the approval path will not read, so the ` +
      'facts the card asserted could not be checked.'
    );
  }
  if (!UUID.test(id)) {
    return `the pinned ${noun} id is not a uuid ("${id}"), so the row could not be re-read.`;
  }

  const columns = Object.keys(expect);
  const bad = columns.find((c) => !IDENTIFIER.test(c));
  if (bad) {
    return (
      `the proposal pins a column the approval path will not read ("${bad}"), so the facts the ` +
      'card asserted could not be checked.'
    );
  }

  let row: Record<string, unknown> | null;
  try {
    // Identifiers are quoted, and they have already been matched against
    // IDENTIFIER and PINNABLE — the regex admits no quote character, so the
    // quoting is the second line of defence rather than the first. The id is a
    // bound parameter like every other value in this repository.
    //
    // With nothing pinned but the row itself, `id` is selected so that existence
    // is still checked: a card that named a row is a card that asserted the row
    // is there.
    const selected = (columns.length > 0 ? columns : ['id']).map((c) => `"${c}"`).join(', ');
    row = await one(`SELECT ${selected} FROM "${table}" WHERE id = $1`, [id]);
  } catch (err) {
    return `the ${noun} could not be re-read (${messageOf(err)}).`;
  }

  if (!row) return `the ${noun} no longer exists.`;

  const drifted = columns
    .filter((c) => !same(row[c], expect[c]))
    .map((c) => `${c} is now ${show(row[c])}, not ${show(expect[c])}`);

  if (drifted.length === 0) return null;
  return `the ${noun} changed after this was proposed — ${drifted.join('; ')}.`;
}

type Pin =
  | { kind: 'none' }
  | { kind: 'pinned'; pre: Precondition }
  | { kind: 'unusable'; why: string };

/**
 * What the stored precondition is.
 *
 * Three answers, and the difference between the first and the third is rule 5 of
 * this file. `{}` — the column default — means the card pinned nothing, and there
 * is nothing to compare; that is a per-tool judgment and it proceeds. A
 * precondition that names *part* of a row is not a card that asserted nothing, it
 * is a card whose assertion cannot be evaluated, and it is refused.
 */
function readPin(raw: unknown): Pin {
  if (raw === null || raw === undefined) return { kind: 'none' };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      kind: 'unusable',
      why: 'the stored precondition is not an object, so the facts the card asserted could not be checked.',
    };
  }

  const p = raw as { table?: unknown; id?: unknown; expect?: unknown };
  const expect =
    p.expect && typeof p.expect === 'object' && !Array.isArray(p.expect)
      ? (p.expect as Record<string, unknown>)
      : {};

  const said =
    p.table !== undefined || p.id !== undefined || Object.keys(expect).length > 0;
  if (!said) return { kind: 'none' };

  if (typeof p.table !== 'string' || p.table === '' || typeof p.id !== 'string' || p.id === '') {
    return {
      kind: 'unusable',
      why:
        'the stored precondition asserts something without naming the row it is about, so it ' +
        'could not be checked.',
    };
  }

  return { kind: 'pinned', pre: { table: p.table, id: p.id, expect } };
}

/**
 * Whether a column still holds the value the card asserted.
 *
 * Comparison tolerates representation rather than bytes. The pg driver returns
 * NUMERIC as a string and BIGINT as a string, so `3` and `"3.00"` are the same
 * number and a column arriving as text is not drift. A precondition that fired on
 * formatting would refuse every approval and teach the operator to stop reading
 * the reason.
 *
 * The numeric comparison is done on normalised DECIMAL STRINGS, not through
 * `Number`. `amount_cents` is BIGINT: two different sixteen-digit cent amounts can
 * round to one double, and a precondition that reports no drift because two
 * amounts are equal as floats is a check that passed by losing information.
 */
function same(actual: unknown, expected: unknown): boolean {
  if (actual === expected) return true;
  if (actual === null || actual === undefined) return expected === null || expected === undefined;
  if (expected === null || expected === undefined) return false;

  // TIMESTAMPTZ comes back as a Date and a pinned value is JSON, so it is a
  // string. Compared as instants, because two spellings of one moment are not a
  // change.
  if (actual instanceof Date || expected instanceof Date) {
    const a = new Date(actual as string).getTime();
    const b = new Date(expected as string).getTime();
    if (Number.isFinite(a) && Number.isFinite(b)) return a === b;
  }

  const a = decimal(actual);
  const b = decimal(expected);
  if (a !== null && b !== null) return a === b;

  return String(actual) === String(expected);
}

/**
 * A decimal number as a canonical string, or null if it is not one.
 *
 * `'18500'`, `18500` and `'18500.00'` all become `'18500'`. Exponential notation
 * is deliberately not accepted: it only arises from a JS number large or small
 * enough that its decimal form is not what is in the column, and a string
 * comparison is the honest fallback there.
 */
function decimal(value: unknown): string | null {
  const raw =
    typeof value === 'number'
      ? Number.isFinite(value)
        ? String(value)
        : null
      : typeof value === 'string'
        ? value.trim()
        : null;
  if (raw === null || !/^[+-]?\d+(\.\d+)?$/.test(raw)) return null;

  const negative = raw.startsWith('-');
  const [whole = '', fraction = ''] = raw.replace(/^[+-]/, '').split('.');
  const digits = whole.replace(/^0+(?=\d)/, '');
  const trimmed = fraction.replace(/0+$/, '');
  const body = trimmed === '' ? digits : `${digits}.${trimmed}`;
  return negative && Number(body) !== 0 ? `-${body}` : body;
}

/** A value as the refusal should read it. NULL is "unset" and not "null", because
 * a person reading the sentence is not reading SQL. */
function show(value: unknown): string {
  if (value === null || value === undefined) return 'unset';
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

/* ─── small shared helpers ─── */

/**
 * How long ago an instant was, in milliseconds. Positive means past.
 *
 * TIMESTAMPTZ arrives as a Date from the driver; a string is accepted because a
 * row that came through JSON — a fixture, a serialised response — is still a row
 * this has to compare.
 */
function msSince(at: Date | string | null | undefined, now: Date = new Date()): number {
  if (at === null || at === undefined) return Number.NEGATIVE_INFINITY;
  const t = new Date(at).getTime();
  // An unparseable timestamp must not read as "not yet expired". Treated as past,
  // so the card is retired rather than applied on the strength of a value nobody
  // can read.
  if (Number.isNaN(t)) return Number.POSITIVE_INFINITY;
  return now.getTime() - t;
}

/** "2026-08-09 14:30" — minutes, because a decision is not a stopwatch. */
function formatWhen(at: Date | string): string {
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? String(at) : d.toISOString().slice(0, 16).replace('T', ' ');
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));
