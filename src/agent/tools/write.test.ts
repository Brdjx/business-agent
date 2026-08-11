/**
 * The write tools, with Postgres replaced by a queue of rows.
 *
 * What is being asserted here is what each tool DID and DID NOT do, statement by
 * statement, because that is where a write tool goes wrong. A test that only checked
 * the returned envelope — a proposal came back, the content mentions the project —
 * would pass while the propose path inserted a time entry, while an ambiguous name
 * silently picked the first match, or while the ledger row went in after the write it
 * was supposed to guard. So the mock records every statement it was given and the
 * tests read those statements: that nothing touched `time_entries` with writes off,
 * that the claim on `agent_write_keys` precedes the insert, that the UPDATE on
 * `clients` names one column and it is not `notes`.
 *
 * Everything goes through `executeTool` rather than calling `run` directly, because
 * validation is part of the tool: a refusal the model reads is one of the behaviours
 * under test, and reaching past the gate would skip it.
 *
 * ── Why this file registers, where `proposals.test.ts` must not ──
 *
 * It calls `registerTools(WRITE_TOOLS)` itself, exactly as `read.test.ts` does. That
 * is not incident 2. The subject here is what the tools do once they are callable;
 * the subject THERE is whether the approval path remembers to make them callable at
 * all, and a test of that which registers anything itself is measuring itself. The
 * two files need opposite things and it is worth being explicit about which is which.
 *
 * ── What is NOT covered ──
 *
 * None of this SQL has been executed. The mock returns whatever it was queued, so a
 * wrong column name, a rejected cast, or an `INSERT ... RETURNING` list Postgres
 * dislikes would pass every assertion below. Only the compose database catches that,
 * and nothing in this repository runs against it yet. Nor is the concurrency the
 * ledger exists for reproducible here: two attempts racing on a primary key needs a
 * real Postgres. What is covered is that the code takes the conflict path on 23505,
 * and the ORDER of the statements around it.
 *
 * Dates are computed from the clock rather than written as literals. A test whose
 * validity depends on the wall clock starts failing on a date nobody chose, and these
 * tools refuse a date in the future on purpose.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

/** `vi.hoisted`, because `vi.mock`'s factory is lifted above the imports. */
const h = vi.hoisted(() => ({
  calls: [] as Array<{ text: string; params: unknown[] }>,
  queue: [] as Array<unknown[] | { throws: unknown }>,
}));

vi.mock('../../db', () => {
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

import { executeTool, registerTools } from '../tools';
import { writeKey } from '../write-keys';
import { WRITE_TOOLS } from './write';

registerTools(WRITE_TOOLS);

/* ─── ids, as the columns hold them ─── */

const USER = '00000000-0000-4000-8000-000000000001';
const RUN = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const CLIENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PROJECT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const INVOICE = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const ENTRY = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Always in the past, whatever day this suite is run on. */
const YESTERDAY = iso(Date.now() - DAY);
const TWO_MONTHS_AGO = iso(Date.now() - 60 * DAY);
const THREE_MONTHS_AGO = iso(Date.now() - 90 * DAY);
/** Always in the future, and therefore always refused. */
const NEXT_MONTH = iso(Date.now() + 30 * DAY);

const NOTE = 'dispatch rewrite, phase 2';

/* ─── reading what the mock saw ─── */

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
const stmts = () => h.calls.map((c) => norm(c.text));
const at = (i: number) => stmts()[i] ?? '';
const withText = (fragment: string) => h.calls.filter((c) => norm(c.text).includes(fragment));
const counted = (fragment: string) => withText(fragment).length;
const indexOfText = (fragment: string) => stmts().findIndex((s) => s.includes(fragment));
const queue = (...replies: Array<unknown[] | { throws: unknown }>) => h.queue.push(...replies);

/** A driver error, identified the way the code identifies it: by `code`. */
const duplicate = () =>
  Object.assign(new Error('duplicate key value violates unique constraint "agent_write_keys_pkey"'), {
    code: '23505',
  });

beforeEach(() => {
  h.calls.length = 0;
  h.queue.length = 0;
});

/* ─── rows, shaped like the columns in db/001-business.sql ─── */

const projectRow = (over: Record<string, unknown> = {}) => ({
  id: PROJECT,
  name: 'Dispatch Rewrite',
  // INTEGER, so the driver hands back a number. Unlike amount_cents below.
  rate_cents: 18500,
  client_id: CLIENT,
  client_name: 'Halden Freight',
  engagement_kind: 'client',
  client_status: 'active',
  ...over,
});

const clientRow = (over: Record<string, unknown> = {}) => ({
  id: CLIENT,
  name: 'Halden Freight',
  status: 'active',
  engagement_kind: 'client',
  ...over,
});

const invoiceRow = (over: Record<string, unknown> = {}) => ({
  id: INVOICE,
  number: 'INV-1008',
  status: 'open',
  // BIGINT: a STRING from the driver, and it stays one everywhere but the printer.
  amount_cents: '1650000',
  currency: 'USD',
  issued_at: TWO_MONTHS_AGO,
  due_date: YESTERDAY,
  paid_at: null,
  exact: true,
  client_id: CLIENT,
  client_name: 'Halden Freight',
  ...over,
});

/* ─── calling a tool ─── */

const run = (name: string, args: Record<string, unknown>, allowWrites = false) =>
  executeTool(name, args, { userId: USER, allowWrites, runId: RUN });

const logTime = (args: Record<string, unknown> = {}, allowWrites = false) =>
  run(
    'log_time',
    { project_name: 'Dispatch', date: YESTERDAY, hours: 3, note: NOTE, ...args },
    allowWrites
  );

const setStatus = (args: Record<string, unknown> = {}, allowWrites = false) =>
  run('set_client_status', { client_name: 'Halden', status: 'inactive', ...args }, allowWrites);

const markPaid = (args: Record<string, unknown> = {}, allowWrites = false) =>
  run(
    'mark_invoice_paid',
    { invoice_number: 'INV-1008', paid_date: YESTERDAY, ...args },
    allowWrites
  );

/* ═══ the gate ═══ */

describe('with writes off, a write tool proposes and does not write', () => {
  it('returns a proposal for the time it would log, and touches nothing', async () => {
    queue([projectRow()]);

    const { ok, result } = await logTime();

    expect(ok).toBe(true);
    expect(result.content).toContain('WRITES ARE DISABLED');
    expect(result.content).toContain('nothing was logged');
    expect(result.content).toContain(`Log 3.00h on ${YESTERDAY} against Dispatch Rewrite`);
    expect(result.proposal).toBeDefined();
    // One statement: the lookup that resolved the project. No claim, no insert.
    expect(h.calls).toHaveLength(1);
    expect(counted('INSERT INTO time_entries')).toBe(0);
    expect(counted('agent_write_keys')).toBe(0);
  });

  it('does not claim a write key for a proposal', async () => {
    // The key belongs to the ACT, and the act has not happened. Claiming it here
    // would make the operator's approval replay a result nobody produced.
    queue([clientRow()]);
    await setStatus();
    queue([invoiceRow()]);
    await markPaid();

    expect(counted('agent_write_keys')).toBe(0);
    expect(counted('UPDATE clients')).toBe(0);
    expect(counted('UPDATE invoices')).toBe(0);
  });

  it('carries the exact key the write will claim', async () => {
    queue([projectRow()]);

    const { result } = await logTime();

    // Derived at propose time from the resolved project id, so the ledger recognises
    // an approval and a write-enabled run as ONE act. Derived at apply time, they
    // would be two, and approving something already done would do it again.
    expect(result.proposal?.writeKey).toBe(
      writeKey('log_time', USER, {
        project_id: PROJECT,
        entry_date: YESTERDAY,
        hours: '3.00',
        note: NOTE,
        billable: true,
      })
    );
  });

  it('stores the validated arguments, not the model’s raw input', async () => {
    queue([projectRow()]);

    const { result } = await logTime({ hours: '3', project_name: '  Dispatch  ' });

    // Approving re-runs THIS call, so what is stored has to be what the tool
    // accepted: the trimmed name, and hours as the canonical two-decimal string the
    // NUMERIC(5,2) column holds.
    expect(result.proposal?.args).toEqual({
      project_name: 'Dispatch',
      date: YESTERDAY,
      hours: '3.00',
      note: NOTE,
    });
    // Absent, deliberately. Whether the hours are billable is decided from the
    // client at apply time, not frozen here from a client that may be reclassified
    // in between.
    expect(result.proposal?.args.billable).toBeUndefined();
  });

  it('pins the row it resolved, its rate and whose project it is', async () => {
    queue([projectRow()]);

    const { result } = await logTime();

    expect(result.proposal?.target).toEqual({
      table: 'projects',
      id: PROJECT,
      label: 'Dispatch Rewrite',
    });
    // The name, because the stored argument is still a name and a rename would
    // resolve it elsewhere. The rate, because it is what the client is eventually
    // billed and the card never prints it. The client, because whose project this is
    // decides whether the hours can be billed at all.
    expect(result.proposal?.precondition).toEqual({
      table: 'projects',
      id: PROJECT,
      expect: { name: 'Dispatch Rewrite', rate_cents: 18500, client_id: CLIENT },
    });
  });

  it('cites the client as well as the project, because the billable decision rests on it', async () => {
    queue([projectRow()]);

    const { result } = await logTime();

    expect(result.evidence).toEqual([
      { table: 'projects', id: PROJECT, label: 'Dispatch Rewrite' },
      { table: 'clients', id: CLIENT, label: 'Halden Freight' },
    ]);
  });

  it('sets no subject key, because a block of time has no revisions', async () => {
    queue([projectRow()]);

    const { result } = await logTime();

    // subject_key exists for a tool producing revisable content. A key invented for
    // every write is a second identity to keep consistent for no gain.
    expect(result.proposal?.subjectKey).toBeUndefined();
  });
});

/* ═══ ambiguity ═══ */

describe('an ambiguous name is refused, never resolved', () => {
  it('lists the candidates and logs nothing', async () => {
    queue([projectRow(), projectRow({ id: 'p2', name: 'Dispatch Rewrite Phase 2' })]);

    const { ok, result } = await logTime();

    expect(ok).toBe(true);
    expect(result.content).toContain('matches 2 projects');
    expect(result.content).toContain('Dispatch Rewrite (Halden Freight)');
    expect(result.content).toContain('Dispatch Rewrite Phase 2 (Halden Freight)');
    expect(result.content).toContain('Nothing was logged');
    // No card. The operator would be approving hours against whichever row the tool
    // happened to order second.
    expect(result.proposal).toBeUndefined();
  });

  it('refuses just as hard with writes ON', async () => {
    queue([projectRow(), projectRow({ id: 'p2', name: 'Dispatch Rewrite Phase 2' })]);

    const { result } = await logTime({}, true);

    // The gate is not what protects this. Ambiguity about a billable write is raised
    // whether or not the run is allowed to act.
    expect(result.content).toContain('Nothing was logged');
    expect(counted('INSERT INTO time_entries')).toBe(0);
    expect(counted('agent_write_keys')).toBe(0);
  });

  it('says what is on file when the name matches nothing', async () => {
    queue([], [{ id: PROJECT, name: 'Dispatch Rewrite', total: 3 }]);

    const { result } = await logTime({ project_name: 'Dispach' });

    expect(result.content).toContain('No project matches "Dispach"');
    expect(result.content).toContain('Dispatch Rewrite');
    // The message hands the model a real name out of the table, so the answer rests
    // on that row and has to cite it.
    expect(result.evidence).toEqual([
      { table: 'projects', id: PROJECT, label: 'Dispatch Rewrite' },
    ]);
    expect(result.proposal).toBeUndefined();
  });

  it('says the table is empty rather than listing nothing', async () => {
    queue([], []);

    const { result } = await logTime({ project_name: 'anything' });

    expect(result.content).toContain('no project records on file at all');
    expect(result.content).toContain('do not guess');
  });

  it('escapes LIKE wildcards in the name it was given', async () => {
    queue([projectRow()]);

    await logTime({ project_name: 'Dispatch_Rewrite' });

    // An unescaped `_` matches any single character. That does not fail — it widens
    // the lookup, and the extra match then makes the tool refuse a write it should
    // have performed.
    expect(h.calls[0].params[0]).toBe('%Dispatch\\_Rewrite%');
  });
});

/* ═══ what may be billed ═══ */

describe('billable is decided after the client is resolved', () => {
  const ownVenture = (over: Record<string, unknown> = {}) =>
    projectRow({
      name: 'Cadence',
      client_name: 'Cadence Labs',
      engagement_kind: 'own_venture',
      rate_cents: null,
      ...over,
    });

  it('bills a real client by default', async () => {
    queue([projectRow()]);

    const { result } = await logTime();

    expect(result.content).not.toContain('[not billable]');
  });

  it("never bills the studio's own venture", async () => {
    queue([ownVenture()]);

    const { result } = await logTime({ project_name: 'Cadence' });

    // The first write this agent ever performed was thirty minutes against an own
    // venture, marked billable, because the default was decided in `validate` —
    // before the project name had been resolved to a project and a client at all
    // (incident 7). Harmless there, and the same default would be wrong in a way
    // that mattered on a project with a rate.
    expect(result.content).toContain('[not billable]');
  });

  it('overrides an explicit billable:true on an own venture, and says so', async () => {
    queue([ownVenture()]);

    const { result } = await logTime({ project_name: 'Cadence', billable: true });

    // Asking twice does not make it billable, and a silently flipped flag would make
    // the rest of the report suspect.
    expect(result.content).toContain('requested as billable');
    expect(result.content).toContain('own_venture');
    expect(result.content).toContain('[not billable]');

    /**
     * And it says so as a FACT, not as an instruction.
     *
     * This text is not only read by the model. It goes into the proposal summary
     * and the applied result, both of which the CLI prints verbatim to the
     * operator — so the first version's closing "Say that." reached a person as a
     * stray order. Tool content aimed at the model is fine elsewhere; anything
     * that lands on the approval desk has to read as a statement.
     */
    expect(result.content).not.toMatch(/\bSay that\b/);
    expect(result.proposal?.writeKey).toBe(
      writeKey('log_time', USER, {
        project_id: PROJECT,
        entry_date: YESTERDAY,
        hours: '3.00',
        note: NOTE,
        // false, not the true that was asked for.
        billable: false,
      })
    );
  });

  it('never bills an artifact either', async () => {
    queue([ownVenture({ engagement_kind: 'artifact' })]);

    const { result } = await logTime({ project_name: 'Cadence', billable: true });

    // A take-home built for an interview was never work anyone bought.
    expect(result.content).toContain('[not billable]');
    expect(result.content).toContain('artifact');
  });

  it('honours an explicit non-billable on a real client, without claiming an override', async () => {
    queue([projectRow()]);

    const { result } = await logTime({ billable: false });

    expect(result.content).toContain('[not billable]');
    // Deciding not to charge for something is the operator's business. Reporting it
    // as an override would be describing a correction that did not happen.
    expect(result.content).not.toContain('You asked for this to be billable');
  });

  it('gives billable and non-billable hours different keys', async () => {
    queue([projectRow()]);
    const yes = await logTime({ billable: true });
    queue([projectRow()]);
    const no = await logTime({ billable: false });

    // The same hours logged billable and non-billable are two different entries.
    // Sharing a key would let the first silently stand in for the second.
    expect(yes.result.proposal?.writeKey).not.toBe(no.result.proposal?.writeKey);
  });

  it('names a passed lead on the card without changing the flag', async () => {
    queue([projectRow({ engagement_kind: 'passed' })]);

    const { result } = await logTime();

    // 'passed' is not in the never-billable set: the schema names own_venture and
    // artifact, and inventing a third rule here would be policy this extraction has
    // no mandate for. What the card does instead is say what kind of record it is,
    // so the operator approving it can see what they are billing.
    expect(result.content).toContain('passed');
    expect(result.content).not.toContain('[not billable]');
  });
});

/* ═══ validating a write's arguments ═══ */

describe('arguments that could only be a misunderstanding', () => {
  const refused = async (args: Record<string, unknown>) => {
    const { ok, result } = await logTime(args);
    expect(ok).toBe(false);
    // Refusals are tool RESULTS, not exceptions, so the model reads them and retries.
    expect(h.calls).toHaveLength(0);
    return result.content;
  };

  it('refuses no hours, negative hours and more than a day', async () => {
    expect(await refused({ hours: 0 })).toContain('must be more than 0');
    expect(await refused({ hours: -2 })).toContain('positive number of hours');
    expect(await refused({ hours: 25 })).toContain('cannot exceed 24');
    // A 40 in this field is a week typed into a day, and it lands in a billable
    // total nobody re-checks.
    expect(await refused({ hours: 40 })).toContain('a week typed into a day');
    expect(await refused({ hours: 'four' })).toContain('positive number of hours');
    expect(await refused({ hours: '1e3' })).toContain('positive number of hours');
  });

  it('rounds hours to the two places the column holds, and prints what it will write', async () => {
    queue([projectRow()]);

    // 80 minutes is an ordinary thing to log, and refusing 1.333 would spend a round
    // trip on something NUMERIC(5,2) simply cannot hold. It is rounded and the
    // recorded value is printed, so the change is visible rather than silent.
    const { result } = await logTime({ hours: 1.333 });

    expect(result.content).toContain('Log 1.33h');
    expect(result.proposal?.args.hours).toBe('1.33');
  });

  it('refuses a date that is not one, and a date that has not happened', async () => {
    expect(await refused({ date: 'August 8' })).toContain('YYYY-MM-DD');
    expect(await refused({ date: '2026-02-31' })).toContain('not a real date');
    // db/001-business.sql deliberately has no CHECK against CURRENT_DATE — it is not
    // immutable, so a dump taken today could fail to restore tomorrow — and says a
    // write tool refusing a date next March is the same guard with a better message.
    expect(await refused({ date: NEXT_MONTH })).toContain('in the future');
    expect(await refused({ date: '1926-08-04' })).toContain('mistyped year');
  });

  it('refuses a missing date rather than assuming today', async () => {
    const { ok, result } = await run('log_time', {
      project_name: 'Dispatch',
      hours: 3,
      note: NOTE,
    });

    expect(ok).toBe(false);
    expect(result.content).toContain('"date" is required');
    expect(result.content).toContain('not assumed to be today');
  });

  it('requires a note, because the ledger cannot tell two blocks of work apart without one', async () => {
    const { ok, result } = await run('log_time', {
      project_name: 'Dispatch',
      date: YESTERDAY,
      hours: 3,
    });

    expect(ok).toBe(false);
    expect(result.content).toContain('"note" is required');
  });

  it('refuses a boolean that arrived as a string', async () => {
    // `Boolean('false')` is true, which is how a model asking NOT to bill somebody
    // would have had them billed — silently, in the direction that costs money.
    expect(await refused({ billable: 'false' })).toContain('must be true or false');
  });
});

/* ═══ performing the write ═══ */

describe('with writes on, the ledger is claimed before the row is written', () => {
  it('inserts one time entry, in this schema’s columns, and records the result', async () => {
    queue([projectRow()], [], [{ id: ENTRY }], []);

    const { ok, result } = await logTime({}, true);

    expect(ok).toBe(true);
    expect(result.content).toContain('Logged 3.00h');
    // Nothing to approve: it happened.
    expect(result.proposal).toBeUndefined();

    // Claim FIRST. Two concurrent attempts then race on a primary key rather than on
    // the write itself, and the loser reads the winner's result. Write-then-record
    // leaves the window that matters wide open.
    //
    // The count is asserted before the order, and not as belt and braces: a tool that
    // never claimed at all has `indexOfText` of -1, and -1 is less than everything, so
    // the ordering assertion on its own would pass for a write with no ledger entry.
    expect(counted('INSERT INTO agent_write_keys')).toBe(1);
    expect(counted('INSERT INTO time_entries')).toBe(1);
    expect(indexOfText('INSERT INTO agent_write_keys')).toBeLessThan(
      indexOfText('INSERT INTO time_entries')
    );
    expect(indexOfText('INSERT INTO time_entries')).toBeLessThan(
      indexOfText('UPDATE agent_write_keys')
    );

    const insert = withText('INSERT INTO time_entries')[0];
    expect(norm(insert.text)).toContain(
      'INSERT INTO time_entries (project_id, entry_date, hours, note, billable)'
    );
    // No user_id: time_entries has no such column here, and inserting one would
    // fail outright. No start_time/end_time/duration_minutes either — the private
    // original stored a pair plus minutes and divided by 60 at four call sites.
    expect(norm(insert.text)).not.toContain('user_id');
    expect(norm(insert.text)).not.toContain('start_time');
    expect(norm(insert.text)).not.toContain('duration_minutes');
    // updated_at is the trigger's: touch_updated_at() owns it.
    expect(norm(insert.text)).not.toContain('updated_at');
    // The exact decimal string, cast, so Postgres parses the value rather than JS
    // formatting a float into it.
    expect(norm(insert.text)).toContain('$3::numeric');
    expect(insert.params).toEqual([PROJECT, YESTERDAY, '3.00', NOTE, true]);
  });

  it('cites the row it created', async () => {
    queue([projectRow()], [], [{ id: ENTRY }], []);

    const { result } = await logTime({}, true);

    expect(result.evidence[0]).toEqual({
      table: 'time_entries',
      id: ENTRY,
      label: `${YESTERDAY} — 3.00h — Dispatch Rewrite`,
    });
  });

  it('replays the first result instead of writing a second entry', async () => {
    queue(
      [projectRow()],
      // The claim loses the race: this exact act is already in the ledger.
      { throws: duplicate() },
      [{ result: { content: `Logged 3.00h on ${YESTERDAY}`, evidence: [] } }]
    );

    const { ok, result } = await logTime({}, true);

    expect(ok).toBe(true);
    expect(result.content).toContain('already performed');
    expect(result.content).toContain('Nothing was done a second time');
    // The whole point of the mechanism: no second row.
    expect(counted('INSERT INTO time_entries')).toBe(0);
  });

  it('gives the claim back when the write fails', async () => {
    queue(
      [projectRow()],
      [],
      // The insert returns no row, so whether it landed cannot be told from here.
      []
    );

    const { ok, result } = await logTime({}, true);

    expect(ok).toBe(false);
    expect(result.content).toContain('needs checking');
    // Otherwise one transient error becomes a permanent refusal to ever perform that
    // act again, recoverable only by deleting from a table nobody remembers.
    expect(counted('DELETE FROM agent_write_keys')).toBe(1);
  });
});

/* ═══ set_client_status ═══ */

describe('a status change that changes nothing', () => {
  it('proposes nothing and says the value is already set', async () => {
    queue([clientRow({ status: 'inactive' })]);

    const { ok, result } = await setStatus();

    expect(ok).toBe(true);
    // A card asking someone to approve a no-op is noise. The private eval suite had
    // a case asserting a proposal here and that case was wrong (incident 6).
    expect(result.proposal).toBeUndefined();
    expect(result.content).toContain('already inactive');
    expect(result.content).toContain('Nothing was changed');
    expect(result.content).toContain('nothing to approve');
  });

  it('changes nothing and claims nothing with writes ON either', async () => {
    queue([clientRow({ status: 'inactive' })]);

    const { result } = await setStatus({}, true);

    // "Marked inactive" when it was already inactive is a small lie, and one is
    // enough to make everything else the agent reports unverifiable by feel.
    expect(result.content).toContain('already inactive');
    expect(counted('UPDATE clients')).toBe(0);
    expect(counted('agent_write_keys')).toBe(0);
  });
});

describe('proposing a status change', () => {
  it('reads as a diff and pins what the card asserted', async () => {
    queue([clientRow()]);

    const { result } = await setStatus({ reason: 'work finished in June' });

    expect(result.content).toContain('from active to inactive');
    expect(result.content).toContain('work finished in June');
    expect(result.proposal?.summary).toBe(
      'Set Halden Freight from active to inactive — work finished in June'
    );
    // "active -> inactive" is a claim about the present tense; engagement_kind is
    // printed on the card and decides what the new status even means.
    expect(result.proposal?.precondition).toEqual({
      table: 'clients',
      id: CLIENT,
      expect: { status: 'active', engagement_kind: 'client' },
    });
  });

  it('leaves the reason out of the write key', async () => {
    queue([clientRow()]);
    const withReason = await setStatus({ reason: 'work finished in June' });
    queue([clientRow()]);
    const without = await setStatus();

    // A reason annotates the act. Setting the same client to the same status is one
    // act whatever is written beside it — and since the reason changes no record,
    // including it would split one act into two.
    expect(withReason.result.proposal?.writeKey).toBe(without.result.proposal?.writeKey);
    expect(withReason.result.proposal?.writeKey).toBe(
      writeKey('set_client_status', USER, { client_id: CLIENT, status: 'inactive' })
    );
  });

  it('refuses a status this schema cannot hold', async () => {
    const { ok, result } = await setStatus({ status: 'lead' });

    expect(ok).toBe(false);
    // `clients.status` is active | inactive | prospect. A tool that accepted 'lead'
    // would match no row and report a change, and nothing reads as an empty result.
    expect(result.content).toContain('active, inactive, prospect');
    expect(result.content).toContain('There is no "lead"');
    expect(h.calls).toHaveLength(0);
  });

  it('asks which client rather than picking one', async () => {
    queue([clientRow(), clientRow({ id: 'c2', name: 'Halden Logistics', status: 'prospect' })]);

    const { result } = await setStatus();

    expect(result.content).toContain('matches 2 clients');
    expect(result.content).toContain('Halden Logistics (prospect, client)');
    expect(result.content).toContain('Nothing was changed');
    expect(result.proposal).toBeUndefined();
  });
});

describe('performing a status change', () => {
  it('updates one column, guarded on the value the card was read at', async () => {
    queue([clientRow()], [], [{ id: CLIENT, name: 'Halden Freight' }], []);

    const { ok, result } = await setStatus({ reason: 'work finished in June' }, true);

    expect(ok).toBe(true);
    expect(result.content).toContain('Halden Freight: active -> inactive.');

    const update = withText('UPDATE clients')[0];
    // A compare-and-swap on the previous status. The approval path re-reads the row
    // and THEN runs the tool, so there is a window between the two; this closes it in
    // the database rather than in this process.
    expect(norm(update.text)).toContain('AND status = $3');
    expect(update.params).toEqual([CLIENT, 'inactive', 'active']);
    // The private original wrote `reason` into clients.notes, overwriting whatever a
    // person had typed there. The reason lives on the proposal and in this answer.
    expect(norm(update.text)).not.toContain('notes');
    expect(norm(update.text)).not.toContain('engagement_kind');
    expect(norm(update.text)).not.toContain('updated_at');
    // Counted before ordered: -1 is less than every index, so a write that never
    // claimed would satisfy the comparison on its own.
    expect(counted('INSERT INTO agent_write_keys')).toBe(1);
    expect(indexOfText('INSERT INTO agent_write_keys')).toBeLessThan(indexOfText('UPDATE clients'));
  });

  it('reports that nothing changed when the row moved inside the window', async () => {
    // The claim succeeds, and the guarded update matches no row: somebody else moved
    // the status between the precondition check and the write.
    queue([clientRow()], [], []);

    const { ok, result } = await setStatus({}, true);

    expect(ok).toBe(false);
    expect(result.content).toContain('no longer active');
    expect(result.content).toContain('nothing was changed');
    // The claim is released, so this act is not recorded as having happened.
    expect(counted('DELETE FROM agent_write_keys')).toBe(1);
  });
});

/* ═══ mark_invoice_paid ═══ */

describe('an invoice that cannot be paid', () => {
  it('refuses a void invoice and says it is void', async () => {
    queue([invoiceRow({ status: 'void' })]);

    const { ok, result } = await markPaid();

    expect(ok).toBe(true);
    expect(result.content).toContain('INV-1008');
    expect(result.content).toContain('is void');
    expect(result.content).toContain('never owed');
    expect(result.content).toContain('Nothing was changed');
    // No card, and no claim. A void invoice is not money anybody can pay.
    expect(result.proposal).toBeUndefined();
    expect(counted('agent_write_keys')).toBe(0);
    expect(counted('UPDATE invoices')).toBe(0);
  });

  it('refuses a void invoice with writes ON as well', async () => {
    queue([invoiceRow({ status: 'void' })]);

    const { result } = await markPaid({}, true);

    expect(result.content).toContain('is void');
    expect(counted('UPDATE invoices')).toBe(0);
    expect(counted('agent_write_keys')).toBe(0);
  });

  it('refuses a draft, and says it was never sent', async () => {
    queue([invoiceRow({ status: 'draft', issued_at: null, due_date: null })]);

    const { result } = await markPaid();

    // Which of the two it is tells the operator what to do next: a draft has to be
    // issued, where a void one was reissued and it is the reissue that gets paid.
    expect(result.content).toContain('is draft');
    expect(result.content).toContain('never sent');
    expect(result.proposal).toBeUndefined();
  });

  it('reports an invoice already paid as already paid, with the date', async () => {
    queue([invoiceRow({ status: 'paid', paid_at: TWO_MONTHS_AGO })]);

    const { result } = await markPaid();

    expect(result.content).toContain('already marked paid');
    expect(result.content).toContain(TWO_MONTHS_AGO);
    expect(result.proposal).toBeUndefined();
  });

  it('refuses a payment dated before the invoice was issued', async () => {
    queue([invoiceRow()]);

    const { result } = await markPaid({ paid_date: THREE_MONTHS_AGO });

    // CHECK (paid_at IS NULL OR issued_at IS NULL OR paid_at >= issued_at) would
    // reject this. Refused here so the model gets a sentence rather than a constraint
    // violation to explain to a person.
    expect(result.content).toContain(`issued on ${TWO_MONTHS_AGO}`);
    expect(result.content).toContain(`cannot have been paid on ${THREE_MONTHS_AGO}`);
    expect(result.proposal).toBeUndefined();
  });

  it('requires the date the money arrived rather than assuming today', async () => {
    const { ok, result } = await run('mark_invoice_paid', { invoice_number: 'INV-1008' });

    expect(ok).toBe(false);
    // The private system had no paid_at and fell back on updated_at, so marking six
    // historical retainers paid in one sitting put every one of those dollars into
    // the current month.
    expect(result.content).toContain('"paid_date" is required');
    expect(h.calls).toHaveLength(0);
  });

  it('does not offer a nearby invoice number when nothing matches', async () => {
    queue([]);

    const { result } = await markPaid({ invoice_number: 'INV-9999' });

    // Unlike the project and client misses, no list of other numbers. An invoice
    // number is read off a document, and a payment recorded against the wrong
    // invoice is money that looks collected and is still owed.
    expect(result.content).toContain('No invoice matches "INV-9999"');
    expect(result.content).toContain('do not pick a nearby number');
    expect(result.evidence).toEqual([]);
  });

  it('asks which invoice when a fragment matches several', async () => {
    queue([
      invoiceRow({ exact: false, number: 'INV-1001' }),
      invoiceRow({ exact: false, id: 'i2', number: 'INV-1002', status: 'open' }),
    ]);

    const { result } = await markPaid({ invoice_number: '100' });

    expect(result.content).toContain('matches 2 invoices');
    expect(result.content).toContain('INV-1001 (Halden Freight, $16,500.00, open)');
    expect(result.proposal).toBeUndefined();
  });

  it('prefers an exact number over a fragment that matches more', async () => {
    queue([
      invoiceRow({ number: 'INV-100', exact: true }),
      invoiceRow({ id: 'i2', number: 'INV-1001', exact: false }),
    ]);

    const { result } = await markPaid({ invoice_number: 'INV-100' });

    // A substring search for "INV-100" matches INV-1001 through INV-1009, and
    // refusing a number that identifies exactly one row would be refusing the only
    // identifier a person has.
    expect(result.proposal?.target).toEqual({
      table: 'invoices',
      id: INVOICE,
      label: 'INV-100',
    });
  });
});

describe('proposing and performing a payment', () => {
  it('pins the status and the amount the card printed', async () => {
    queue([invoiceRow()]);

    const { result } = await markPaid();

    expect(result.proposal?.summary).toContain('Mark INV-1008 (Halden Freight, $16,500.00 USD)');
    expect(result.proposal?.summary).toContain(`paid on ${YESTERDAY}`);
    // Approving "$16,500 paid" is not approving whatever the row says an hour later,
    // and a voided invoice is not one anybody agreed to pay. The amount is pinned as
    // the STRING the driver returned: amount_cents is BIGINT, and two different
    // sixteen-digit amounts can round to one double.
    expect(result.proposal?.precondition).toEqual({
      table: 'invoices',
      id: INVOICE,
      expect: { status: 'open', amount_cents: '1650000' },
    });
    expect(typeof result.proposal?.precondition.expect.amount_cents).toBe('string');
  });

  it('sets status and date together, guarded on the invoice still being open', async () => {
    queue([invoiceRow()], [], [{ id: INVOICE, number: 'INV-1008' }], []);

    const { ok, result } = await markPaid({}, true);

    expect(ok).toBe(true);
    expect(result.content).toContain(`is now paid, dated ${YESTERDAY}`);

    const update = withText('UPDATE invoices')[0];
    // The schema holds the two together: CHECK ((status = 'paid' AND paid_at IS NOT
    // NULL) OR (status <> 'paid' AND paid_at IS NULL)). A row marked paid with no
    // date is invisible to every question about when money arrived.
    expect(norm(update.text)).toContain("SET status = 'paid', paid_at = $2");
    expect(norm(update.text)).toContain("AND status = 'open'");
    // Marking a payment is not restating what was billed.
    expect(norm(update.text)).not.toContain('amount_cents');
    expect(update.params).toEqual([INVOICE, YESTERDAY]);
    expect(counted('INSERT INTO agent_write_keys')).toBe(1);
    expect(indexOfText('INSERT INTO agent_write_keys')).toBeLessThan(indexOfText('UPDATE invoices'));
  });

  it('reports that nothing changed when the invoice moved inside the window', async () => {
    queue([invoiceRow()], [], []);

    const { ok, result } = await markPaid({}, true);

    expect(ok).toBe(false);
    expect(result.content).toContain('no longer open');
    expect(counted('DELETE FROM agent_write_keys')).toBe(1);
  });
});

/* ═══ the three tools together ═══ */

describe('what the write tools are', () => {
  it('registers three, each keyed on its own act', () => {
    expect(WRITE_TOOLS.map((t) => t.name)).toEqual([
      'log_time',
      'set_client_status',
      'mark_invoice_paid',
    ]);
  });

  it('never shares a key between two different acts on the same row', () => {
    // The tool name is part of every key, so two tools doing different things to one
    // row cannot collide.
    const a = writeKey('set_client_status', USER, { client_id: CLIENT, status: 'inactive' });
    const b = writeKey('mark_invoice_paid', USER, { invoice_id: CLIENT, paid_at: YESTERDAY });
    expect(a).not.toBe(b);
  });
});
