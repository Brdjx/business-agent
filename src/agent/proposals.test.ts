/**
 * The consent machinery, with Postgres replaced by a queue of rows.
 *
 * These assertions are about the ORDER of statements and the words of a refusal,
 * because that is where this mechanism lives. A test that only checked the shape
 * of the returned object would pass while a revision left two approvable cards on
 * the desk, or while an approval applied a card whose record had moved.
 *
 * ── This file registers nothing, on purpose ──
 *
 * It never calls `registerTools` or `ensureToolsRegistered`, and it never imports
 * the loop. That is what makes the registry block at the bottom worth anything.
 * In the private original every unit test registered what it needed at the top of
 * the file and the one end-to-end check imported the loop, so the registry was
 * full in every process anybody looked at and empty in the one bundle nobody did:
 * approving a write had never worked in production (incident 1). The test written
 * for that fix then called the registration helper itself and passed with the fix
 * reverted (incident 2).
 *
 * So: registration has to be reached through `decideProposal` or this file is
 * measuring itself. Delete the `ensureToolsRegistered()` call from `proposals.ts`
 * and the last two tests here must fail.
 *
 * What is NOT covered: none of this SQL has been executed. The mock returns
 * whatever it was queued, so a wrong column name or a statement Postgres rejects
 * would pass every assertion below. Only the compose database catches that, and
 * nothing in this repository runs against it yet.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

/** `vi.hoisted`, because `vi.mock`'s factory is lifted above the imports. */
const h = vi.hoisted(() => ({
  calls: [] as Array<{ text: string; params: unknown[] }>,
  queue: [] as Array<unknown[] | { throws: unknown }>,
}));

vi.mock('../db', () => {
  const next = (text: string, params: unknown[]) => {
    h.calls.push({ text, params });
    const reply = h.queue.shift();
    if (reply && !Array.isArray(reply)) throw reply.throws;
    return reply ?? [];
  };
  return {
    sql: async (text: string, params: unknown[] = []) => next(text, params),
    one: async (text: string, params: unknown[] = []) => next(text, params)[0] ?? null,
    close: async () => {},
  };
});

import { decideProposal, listProposals, recordProposals } from './proposals';
import { writeKey } from './write-keys';
import type { ProposalDraft } from './tools';

/* ─── ids, as the columns hold them ─── */

const USER = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-000000000002';
const CARD = '11111111-1111-4111-8111-111111111111';
const CARD_2 = '22222222-2222-4222-8222-222222222222';
const CLIENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PROJECT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const RUN = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const HOUR = 3_600_000;

/* ─── reading what the mock saw ─── */

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
const stmts = () => h.calls.map((c) => norm(c.text));
const at = (i: number) => stmts()[i] ?? '';
const withText = (fragment: string) => h.calls.filter((c) => norm(c.text).includes(fragment));
const counted = (fragment: string) => withText(fragment).length;
const indexOfText = (fragment: string) => stmts().findIndex((s) => s.includes(fragment));

/** The settle statement is the only UPDATE that parameterises its status. */
const SETTLE = 'UPDATE agent_proposals SET status = $2';
const settlements = () => withText(SETTLE).map((c) => String(c.params[1]));

const queue = (...replies: Array<unknown[] | { throws: unknown }>) => h.queue.push(...replies);

/** A driver error, identified the way the code identifies it: by `code`. */
const pgError = (code: string, message: string) => Object.assign(new Error(message), { code });
const duplicate = () =>
  pgError('23505', 'duplicate key value violates unique constraint "uniq_agent_proposals_pending"');

/**
 * Silenced for the whole file, and kept so the one test that asserts a failure was
 * LOGGED can say so. `recordProposals` swallows what it cannot write, and a
 * swallowed failure that is also silent is indistinguishable from nothing having
 * gone wrong.
 */
const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

beforeEach(() => {
  h.calls.length = 0;
  h.queue.length = 0;
  logs.mockClear();
  errors.mockClear();
});

/* ─── fixtures ─── */

/**
 * A pending card, as the propose path would have written it.
 *
 * `set_client_status` is named here because it is the write tool this card belongs
 * to. Every test using this name refuses before the tool is reached, so nothing
 * below depends on whether that tool is registered yet — the two that DO reach a
 * tool use a name the registry holds today, and say so.
 */
function card(over: Record<string, unknown> = {}) {
  return {
    id: CARD,
    tool_name: 'set_client_status',
    args: { client_name: 'Halden Freight', status: 'inactive' },
    write_key: writeKey('set_client_status', USER, { client_id: CLIENT, status: 'inactive' }),
    summary: 'Set Halden Freight from active to inactive',
    target_table: 'clients',
    target_id: CLIENT,
    target_label: 'Halden Freight',
    precondition: { table: 'clients', id: CLIENT, expect: { status: 'active' } },
    status: 'pending',
    result: null,
    created_at: new Date(Date.now() - HOUR),
    decided_at: null,
    expires_at: new Date(Date.now() + 23 * HOUR),
    run_id: RUN,
    subject_key: null,
    ...over,
  };
}

const draft = (over: Partial<ProposalDraft> = {}): ProposalDraft => ({
  toolName: 'set_client_status',
  args: { client_name: 'Halden Freight', status: 'inactive' },
  summary: 'Set Halden Freight from active to inactive',
  writeKey: writeKey('set_client_status', USER, { client_id: CLIENT, status: 'inactive' }),
  target: { table: 'clients', id: CLIENT, label: 'Halden Freight' },
  precondition: { table: 'clients', id: CLIENT, expect: { status: 'active' } },
  evidence: [{ table: 'clients', id: CLIENT, label: 'Halden Freight' }],
  ...over,
});

/* ═══ recording ═══ */

describe('recording what a run proposed', () => {
  it('carries the validated call, the target and the precondition onto the row', async () => {
    queue([], [card()]);

    const out = await recordProposals(USER, RUN, [draft()]);

    expect(out).toHaveLength(1);
    const insert = withText('INSERT INTO agent_proposals')[0];
    expect(insert.params).toContain(USER);
    expect(insert.params).toContain(RUN);
    // The JSONB columns are stringified by hand: node-postgres would send an
    // array as a Postgres ARRAY literal, which jsonb rejects.
    expect(insert.params).toContain(JSON.stringify({ table: 'clients', id: CLIENT, expect: { status: 'active' } }));
    expect(insert.params).toContain(
      JSON.stringify([{ table: 'clients', id: CLIENT, label: 'Halden Freight' }])
    );
    expect(norm(insert.text)).toContain('$11::jsonb, $12::jsonb');
  });

  it('retires cards that have aged out before writing a new one', async () => {
    queue([{ id: 'gone' }], [card()]);

    await recordProposals(USER, RUN, [draft()]);

    // An expired card is still marked pending, so it still holds the write key a
    // fresh card would need. Left alone, asking again tomorrow keeps returning
    // the one card the operator is not allowed to act on.
    expect(at(0)).toContain("SET status = 'expired'");
    expect(at(0)).toContain('expires_at <= now()');
    expect(indexOfText("SET status = 'expired'")).toBeLessThan(
      indexOfText('INSERT INTO agent_proposals')
    );
  });

  it('returns the card already on the desk instead of a second one', async () => {
    queue(
      // the expiry sweep
      [],
      // the insert loses the partial unique index on (user_id, write_key)
      { throws: duplicate() },
      // the card that was already there
      [card()]
    );

    const out = await recordProposals(USER, RUN, [draft()]);

    // Asking twice is not consenting twice. Two approvable cards for one write is
    // two chances to do it, and the operator consented once.
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe(CARD);
    expect(counted('INSERT INTO agent_proposals')).toBe(1);
  });

  it('retires an aged-out duplicate and proposes again in its place', async () => {
    queue(
      [],
      { throws: duplicate() },
      // pending by the process clock's reckoning, and past its expiry
      [card({ expires_at: new Date(Date.now() - HOUR) })],
      // the settle
      [],
      // the retry
      [card({ id: CARD_2 })]
    );

    const out = await recordProposals(USER, RUN, [draft()]);

    expect(out).toHaveLength(1);
    expect(out[0].id).toBe(CARD_2);
    expect(settlements()).toContain('expired');
    expect(counted('INSERT INTO agent_proposals')).toBe(2);
  });

  it('proposes again when the conflicting card was decided in between', async () => {
    queue(
      [],
      { throws: duplicate() },
      // nothing pending holds the key any more
      [],
      [card({ id: CARD_2 })]
    );

    const out = await recordProposals(USER, RUN, [draft()]);

    expect(out[0].id).toBe(CARD_2);
    expect(counted('INSERT INTO agent_proposals')).toBe(2);
  });

  it('never throws when the desk cannot be written to', async () => {
    queue([], { throws: new Error('disk full') });

    // A proposal that could not be recorded is a proposal the operator does not
    // see — the same outcome as the agent not suggesting it, and strictly better
    // than losing the answer that came with it.
    await expect(recordProposals(USER, RUN, [draft()])).resolves.toEqual([]);
    expect(errors).toHaveBeenCalled();
  });
});

/* ═══ supersession ═══ */

describe('a revision retires what it replaces', () => {
  // Differs per revision, which is what makes it a distinct act; the subject is
  // stable, which is what recognises the two as versions of one another.
  const revision = (version: string) =>
    draft({
      toolName: 'draft_letter',
      args: { about: 'the Halden renewal', version },
      writeKey: `write-key-${version}`,
      subjectKey: 'letter:halden-renewal',
      summary: `Draft the Halden renewal letter (${version})`,
    });

  it('marks the earlier pending card superseded, not declined', async () => {
    queue([], [{ id: 'older' }], [card({ id: CARD_2, subject_key: 'letter:halden-renewal' })]);

    const out = await recordProposals(USER, RUN, [revision('second')]);

    expect(at(1)).toContain("SET status = 'superseded'");
    // Declining is a decision somebody made. This is what happened to a card
    // nobody decided about, and reporting the second as the first tells the
    // operator they rejected something they never saw again.
    expect(stmts().some((s) => s.includes("'declined'"))).toBe(false);
    expect(out[0].id).toBe(CARD_2);
  });

  it('retires before inserting, so the desk never briefly shows both', async () => {
    queue([], [{ id: 'older' }], [card({ id: CARD_2 })]);

    await recordProposals(USER, RUN, [revision('second')]);

    expect(indexOfText("SET status = 'superseded'")).toBeLessThan(
      indexOfText('INSERT INTO agent_proposals')
    );
  });

  it('carries the subject onto the row so the next revision can find it', async () => {
    queue([], [], [card({ subject_key: 'letter:halden-renewal' })]);

    await recordProposals(USER, RUN, [revision('first')]);

    const insert = withText('INSERT INTO agent_proposals')[0];
    expect(insert.params).toContain('letter:halden-renewal');
  });

  it('leaves a proposal with no subject alone', async () => {
    queue([], [card()]);

    // A status change has no drafts, so nothing supersedes it and nothing should
    // be retired on its behalf. A key invented for every write would be a second
    // identity to keep consistent for no gain.
    await recordProposals(USER, RUN, [draft()]);

    expect(counted("SET status = 'superseded'")).toBe(0);
  });
});

/* ═══ reading the desk ═══ */

describe('reading the desk', () => {
  it('lists pending cards newest first, with the question that produced them', async () => {
    queue(
      [{ ...card(), origin: 'should we mark Halden inactive?' }],
      [{ ...card({ id: CARD_2, status: 'applied' }), origin: 'log yesterday' }]
    );

    const desk = await listProposals(USER);

    expect(desk.pending[0].origin).toBe('should we mark Halden inactive?');
    expect(at(0)).toContain('ORDER BY p.created_at DESC');
    // LEFT JOIN, because run_id is nullable and ON DELETE SET NULL: an inner join
    // would drop exactly the cards whose run was pruned or never persisted.
    expect(at(0)).toContain('LEFT JOIN agent_runs r ON r.id = p.run_id');
    // The decided half is not decoration: a desk showing only open cards cannot
    // answer "did I approve that?".
    expect(desk.recent[0].status).toBe('applied');
    expect(at(1)).toContain("p.status <> 'pending'");
  });

  it('raises rather than reporting an empty desk when the query fails', async () => {
    queue({ throws: new Error('relation "agent_runs" does not exist') }, []);

    // An empty array here reads as "nothing is waiting on you", which is a
    // statement about the business that a broken query is not entitled to make.
    // That bug shipped once: a join failed, the read coalesced it to [], and the
    // desk went blank.
    await expect(listProposals(USER)).rejects.toThrow('Could not read the proposals');
  });
});

/* ═══ deciding ═══ */

describe('a proposal the world moved underneath', () => {
  it('refuses when the record changed, and names what changed', async () => {
    // Somebody made them a prospect while the card sat on the desk. The operator
    // agreed to active -> inactive; that diff no longer describes anything.
    queue([card()], [{ status: 'prospect' }]);

    const outcome = await decideProposal({ userId: USER, id: CARD, decision: 'approve' });

    expect(outcome.status).toBe('stale');
    expect(outcome.message).toContain('the client changed after this was proposed');
    // The sentence is the useful part. A bare "cannot apply" makes the system look
    // broken; this says what to do next.
    expect(outcome.message).toContain('status is now prospect, not active');
    expect(settlements()).toEqual(['stale']);
    // Nothing was claimed and nothing was written.
    expect(counted('agent_write_keys')).toBe(0);
    expect(counted('UPDATE clients')).toBe(0);
  });

  it('refuses when the record is gone', async () => {
    queue([card()], []);

    const outcome = await decideProposal({ userId: USER, id: CARD, decision: 'approve' });

    expect(outcome.status).toBe('stale');
    expect(outcome.message).toContain('the client no longer exists');
  });

  it('refuses when the check itself could not be made', async () => {
    queue([card()], { throws: new Error('connection reset') });

    const outcome = await decideProposal({ userId: USER, id: CARD, decision: 'approve' });

    // A check that could not run is not a check that passed. This gate exists for
    // exactly the case where the record is not what it was.
    expect(outcome.status).toBe('stale');
    expect(outcome.message).toContain('could not be re-read');
    expect(outcome.message).toContain('connection reset');
  });

  it('refuses a precondition that asserts something without naming a row', async () => {
    queue([card({ precondition: { expect: { status: 'active' } } })]);

    const outcome = await decideProposal({ userId: USER, id: CARD, decision: 'approve' });

    expect(outcome.status).toBe('stale');
    expect(outcome.message).toContain('without naming the row');
    // Nothing was queried on the strength of a precondition that cannot be
    // evaluated.
    expect(h.calls).toHaveLength(2);
  });

  it('refuses a precondition pinning a table the approval path will not read', async () => {
    queue([card({ precondition: { table: 'agent_runs', id: RUN, expect: { question: 'x' } } })]);

    const outcome = await decideProposal({ userId: USER, id: CARD, decision: 'approve' });

    // A table name cannot be a bound parameter and this value came out of a JSONB
    // column, so the allowlist is what stands between the two.
    expect(outcome.status).toBe('stale');
    expect(outcome.message).toContain('will not read');
    expect(counted('agent_runs')).toBe(0);
  });

  it('does not treat a numeric column arriving as a string as drift', async () => {
    queue(
      [
        card({
          precondition: {
            table: 'projects',
            id: PROJECT,
            // What the card asserted: the project's identity and its rate. The
            // card never printed the rate, and the rate is what the client is
            // eventually billed.
            expect: { name: 'Dispatch Rewrite', rate_cents: 18500, budget_hours: '120.00' },
          },
          tool_name: 'find_client',
          args: { name: 'Halden' },
        }),
      ],
      // NUMERIC and BIGINT come back from the driver as strings. 18500 is
      // '18500', and '120.00' is 120: a precondition that fired on formatting
      // would refuse every approval and teach the operator to stop reading the
      // reason.
      [{ name: 'Dispatch Rewrite', rate_cents: '18500', budget_hours: 120 }]
    );

    const outcome = await decideProposal({ userId: USER, id: CARD, decision: 'approve' });

    expect(outcome.status).not.toBe('stale');
    expect(at(1)).toContain('SELECT "name", "rate_cents", "budget_hours" FROM "projects"');
  });
});

describe('a decision already made', () => {
  it('reports which way it went instead of doing it again', async () => {
    queue([
      card({
        status: 'applied',
        result: 'Halden Freight: active -> inactive.',
        decided_at: new Date('2026-08-09T14:30:00.000Z'),
      }),
    ]);

    const outcome = await decideProposal({ userId: USER, id: CARD, decision: 'approve' });

    expect(outcome.status).toBe('applied');
    expect(outcome.message).toContain('already applied on 2026-08-09 14:30');
    expect(outcome.message).toContain('Halden Freight: active -> inactive.');
    // A button pressed twice must not read as two approvals, and must not reach
    // the tool a second time to find out. One statement: the read.
    expect(h.calls).toHaveLength(1);
  });

  it('does not resurrect a declined proposal', async () => {
    queue([card({ status: 'declined', result: 'Declined. Nothing was changed.' })]);

    const outcome = await decideProposal({ userId: USER, id: CARD, decision: 'approve' });

    expect(outcome.status).toBe('declined');
    expect(h.calls).toHaveLength(1);
  });

  it('reports a superseded card as superseded', async () => {
    queue([card({ status: 'superseded', result: 'Replaced by a newer version.' })]);

    const outcome = await decideProposal({ userId: USER, id: CARD, decision: 'approve' });

    // Not "declined". The operator never decided about this one.
    expect(outcome.status).toBe('superseded');
    expect(outcome.message).toContain('already superseded');
  });
});

describe('age, ownership and declining', () => {
  it('will not apply a card that has aged out', async () => {
    queue([card({ expires_at: new Date(Date.now() - HOUR) })]);

    const outcome = await decideProposal({ userId: USER, id: CARD, decision: 'approve' });

    expect(outcome.status).toBe('expired');
    expect(outcome.message).toContain('aged out');
    expect(settlements()).toEqual(['expired']);
    // Refused before the precondition is even read: a proposal you no longer
    // remember reading is not one you can meaningfully approve.
    expect(counted('FROM "clients"')).toBe(0);
  });

  it('still lets an aged-out card be declined', async () => {
    queue([card({ expires_at: new Date(Date.now() - HOUR) })]);

    // Clearing the desk is not an action on the business, so declining is never
    // blocked — an expired card you cannot dismiss is just clutter.
    const outcome = await decideProposal({ userId: USER, id: CARD, decision: 'decline' });

    expect(outcome.status).toBe('declined');
    expect(settlements()).toEqual(['declined']);
  });

  it('declines without touching the record', async () => {
    queue([card()]);

    const outcome = await decideProposal({ userId: USER, id: CARD, decision: 'decline' });

    expect(outcome.message).toContain('Nothing was changed');
    expect(counted('FROM "clients"')).toBe(0);
    expect(counted('agent_write_keys')).toBe(0);
  });

  it('reads as absent when it belongs to someone else', async () => {
    // The query is scoped by user_id rather than checked afterwards, so another
    // operator's card is not found at all: "not found" tells a stranger nothing,
    // where "forbidden" confirms the card exists.
    queue([]);

    await expect(
      decideProposal({ userId: OTHER, id: CARD, decision: 'approve' })
    ).rejects.toThrow('No such proposal.');
    expect(at(0)).toContain('AND p.user_id = $2');
    expect(h.calls).toHaveLength(1);
  });

  it('refuses an id that could not be a card', async () => {
    await expect(
      decideProposal({ userId: USER, id: 'prop1', decision: 'approve' })
    ).rejects.toThrow('is not a proposal id');
    // Not sent to Postgres to be told "invalid input syntax for type uuid".
    expect(h.calls).toHaveLength(0);
  });
});

/* ═══ the registry ═══ */

/**
 * The bundle test.
 *
 * This is the one thing in this file that would notice `ensureToolsRegistered()`
 * being deleted from `decideProposal`. It works because this file imports what the
 * approval path imports and nothing else: no loop, no tool module, no registration
 * call of its own. If the decide path stops registering, the allowlist in this
 * process is empty and `executeTool` says so.
 *
 * The first case drives a READ tool, because the read tools were registered first
 * and it is the case that has always held. The second drives every WRITE tool
 * there is, and that is the one that matches the production failure: what came
 * back on 2026-08-10 was `There is no tool called draft_upwork_proposal`, and a
 * read has no approval path to break.
 *
 * Neither case asserts that the approval succeeded. Against a stubbed database it
 * may fail for its own reasons, and the only thing being held here is that the
 * registry never again claims the tool does not exist.
 */
describe('approving in a bundle that never imported the loop', () => {
  it('finds the tool registered', async () => {
    queue([card({ tool_name: 'find_client', args: { name: 'Halden' }, precondition: {} })]);

    const outcome = await decideProposal({ userId: USER, id: CARD, decision: 'approve' });

    // The words two real approvals came back with on 2026-08-10, when
    // registration was a side effect of importing the loop.
    expect(outcome.message).not.toContain('There is no tool called');
    expect(outcome.message).not.toContain('Available tools: find_client, invoice_totals');
    // And the empty-allowlist wording, which is what an unregistered bundle says
    // now that this repository's gate module defines no tools of its own.
    expect(outcome.message).not.toContain('No tools are registered in this process');
    // Positively: this sentence can only have come from inside the tool, so the
    // tool ran.
    expect(outcome.message).toContain('No client matches');
  });

  /**
   * Every write tool, by name, because the one that is missing is the one nobody
   * checked. A write registered in one place and forgotten in another is invisible
   * from here — `executeTool` names the tools that DO exist, and a list of three
   * plausible tools reads like an allowlist working rather than like a bundle that
   * was assembled by accident.
   *
   * The stored arguments are valid ones: `validate` runs again on the way in, and a
   * card refused for its arguments would never reach the registry lookup this is
   * about. The precondition is empty so nothing is re-read, which leaves the tool's
   * own body as the only thing that can produce the sentence each case expects.
   */
  const WRITES = [
    {
      tool: 'log_time',
      args: { project_name: 'Dispatch Rewrite', date: '2026-08-04', hours: 3, note: 'platform work' },
      says: 'No project matches',
      andNot: 'Nothing was logged',
    },
    {
      tool: 'set_client_status',
      args: { client_name: 'Halden Freight', status: 'inactive' },
      says: 'No client matches',
      andNot: 'Nothing was changed',
    },
    {
      tool: 'mark_invoice_paid',
      args: { invoice_number: 'INV-1008', paid_date: '2026-08-04' },
      says: 'No invoice matches',
      andNot: 'Nothing was changed',
    },
  ] as const;

  for (const write of WRITES) {
    it(`finds ${write.tool} registered`, async () => {
      queue([card({ tool_name: write.tool, args: write.args, precondition: {} })]);

      const outcome = await decideProposal({ userId: USER, id: CARD, decision: 'approve' });

      expect(outcome.message).not.toContain('There is no tool called');
      expect(outcome.message).not.toContain('No tools are registered in this process');
      // Positively: these sentences exist only inside that tool's own body, so the
      // stored call reached it. The stub database matches nothing, so the tool
      // refuses — which is the correct outcome and not the point of the test.
      expect(outcome.message).toContain(write.says);
      expect(outcome.message).toContain(write.andNot);
    });
  }

  it('runs the stored call, past the precondition, and settles on what came back', async () => {
    queue(
      [card({ tool_name: 'find_client', args: { name: 'Halden' } })],
      // the precondition re-read: unchanged
      [{ status: 'active' }]
    );

    const outcome = await decideProposal({ userId: USER, id: CARD, decision: 'approve' });

    expect(outcome.status).toBe('applied');
    // The order that matters: is the pinned row still what the card said, and only
    // then the stored call.
    expect(at(1)).toContain('SELECT "status" FROM "clients" WHERE id = $1');
    // 'Halden' exists nowhere but the stored arguments, so the call that ran is
    // the one the card described rather than anything re-derived.
    expect(at(2)).toContain('FROM clients WHERE name ILIKE $1');
    expect(h.calls[2].params[0]).toBe('%Halden%');
    expect(settlements()).toEqual(['applied']);
  });
});
