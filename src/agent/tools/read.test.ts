/**
 * The read tools, with Postgres replaced by a queue of rows.
 *
 * These assertions are about the SQL and about the words, not about the shape of
 * a returned object, and that is the point. A test that only checks the envelope
 * — evidence is an array, content is a string — passes while the query behind it
 * counts a void invoice as money someone owes. So the mock records every
 * statement it was given, and the tests read those statements: that outstanding
 * is summed with a filter naming `'open'` rather than negating `'paid'`, that
 * "worked with" constrains both columns, that overdue is a status plus a date
 * compared in the database.
 *
 * The tests go through `executeTool` rather than calling `run` directly, because
 * validation is part of the tool: a refusal the model reads is one of the
 * behaviours being asserted, and reaching past the gate would skip it.
 *
 * This file calls `registerTools` itself and deliberately does NOT call
 * `ensureToolsRegistered`. There is no entry point yet for the registry to be
 * wired into, so a test here that called it would prove only that the helper
 * works — which is incident 2 in `docs/incidents.md`, a test that passed with the
 * fix reverted. When the run path exists, the test that covers registration is
 * one that never registers anything itself.
 *
 * What is NOT covered here: none of this SQL has been executed. The mock returns
 * whatever it was queued, so a syntax error, a wrong column name, or a `FILTER`
 * clause Postgres rejects would pass every assertion below. Only the compose
 * database can catch that, and nothing in this repository runs against it yet.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * `vi.hoisted`, because `vi.mock` is lifted above the imports and its factory
 * would otherwise close over bindings that are still in their temporal dead zone
 * when `read.ts` is first imported.
 */
const h = vi.hoisted(() => ({
  calls: [] as Array<{ text: string; params: unknown[] }>,
  queue: [] as unknown[][],
}));

vi.mock('../../db', () => ({
  sql: async (text: string, params: unknown[] = []) => {
    h.calls.push({ text, params });
    return h.queue.shift() ?? [];
  },
  one: async (text: string, params: unknown[] = []) => {
    h.calls.push({ text, params });
    return (h.queue.shift() ?? [])[0] ?? null;
  },
  close: async () => {},
}));

import { registerTools, executeTool, type ToolContext } from '../tools';
import { READ_TOOLS } from './read';

registerTools(READ_TOOLS);

const CTX: ToolContext = { userId: '00000000-0000-4000-8000-000000000000', allowWrites: false };

/** Whitespace is formatting; the predicates are what is being asserted. */
const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
const stmt = (i: number) => norm(h.calls[i].text);
const args = (i: number) => h.calls[i].params;
const every = () => h.calls.map((c) => norm(c.text));
const queue = (...batches: unknown[][]) => h.queue.push(...batches);

beforeEach(() => {
  h.calls.length = 0;
  h.queue.length = 0;
});

/* ─── row factories, shaped like the columns in db/ ─── */

const clientRow = (over: Record<string, unknown> = {}) => ({
  id: 'c1',
  name: 'Halden Freight',
  status: 'active',
  engagement_kind: 'client',
  disposition: 'ongoing',
  website: 'https://haldenfreight.example',
  city: 'Portland',
  country: 'US',
  default_rate_cents: 18500,
  notes: null,
  worked_with: true,
  ...over,
});

const projectRow = (over: Record<string, unknown> = {}) => ({
  id: 'p1',
  name: 'Dispatch Rewrite',
  status: 'active',
  rate_cents: 18500,
  budget_hours: '120.00',
  start_date: '2025-06-11',
  end_date: null,
  client_id: 'c1',
  client_name: 'Halden Freight',
  engagement_kind: 'client',
  client_status: 'active',
  ...over,
});

/**
 * The seed's own money block, as written in `db/900-seed.sql`: $110,500
 * collected, $33,300 outstanding, $24,300 of it overdue, and $3,000 void plus
 * $4,500 draft excluded from both.
 */
const totalsRow = (over: Record<string, unknown> = {}) => ({
  invoices: 11,
  currencies: 1,
  open_count: 3,
  paid_count: 6,
  void_count: 1,
  draft_count: 1,
  overdue_count: 2,
  not_due_count: 1,
  outstanding_cents: '3330000',
  overdue_cents: '2430000',
  not_due_cents: '900000',
  collected_cents: '11050000',
  void_cents: '300000',
  draft_cents: '450000',
  first_paid_at: '2024-06-14',
  last_paid_at: '2026-05-11',
  ...over,
});

const invoiceRow = (over: Record<string, unknown> = {}) => ({
  id: 'i1',
  number: 'INV-1008',
  status: 'open',
  amount_cents: '1650000',
  currency: 'USD',
  description: 'Dispatch rewrite - phase 2',
  issued_at: '2026-06-02',
  due_date: '2026-07-02',
  paid_at: null,
  client_id: 'c1',
  client_name: 'Halden Freight',
  is_overdue: true,
  days_overdue: 40,
  ...over,
});

const timeTotalsRow = (over: Record<string, unknown> = {}) => ({
  entries: 10,
  projects: 1,
  total_hours: '62.00',
  billable_hours: '59.50',
  nonbillable_hours: '2.50',
  first_entry: '2026-06-14',
  last_entry: '2026-08-08',
  ...over,
});

/* ═══ the two-column predicate ═══ */

describe('"worked with" constrains engagement_kind AND status', () => {
  it('list_clients defaults to both columns, in the query', async () => {
    queue([clientRow()], [{ engagement_kind: 'client', status: 'active', n: 1 }]);

    const { ok } = await executeTool('list_clients', {}, CTX);
    expect(ok).toBe(true);

    // Both halves, in the WHERE clause rather than applied to the rows
    // afterwards. engagement_kind alone would list the prospect whose
    // relationship has never started; status alone would list a lead that was
    // passed on as a client that went quiet.
    expect(stmt(0)).toContain('engagement_kind = $1');
    expect(args(0)[0]).toBe('client');
    expect(stmt(0)).toContain("status IN ('active', 'inactive')");
  });

  it('find_client computes the verdict in SQL from the same predicate', async () => {
    queue([clientRow()], []);
    await executeTool('find_client', { name: 'Halden' }, CTX);

    expect(stmt(0)).toContain(
      "(engagement_kind = 'client' AND status IN ('active', 'inactive')) AS worked_with"
    );
  });

  it('says a passed lead was never a client, and why', async () => {
    queue(
      [
        clientRow({
          id: 'c4',
          name: 'Quillon Robotics',
          status: 'inactive',
          engagement_kind: 'passed',
          disposition: 'declined_by_us',
          default_rate_cents: null,
          worked_with: false,
        }),
      ],
      []
    );

    const { result } = await executeTool('find_client', { name: 'Quillon' }, CTX);
    expect(result.content).toContain('worked with: NO');
    expect(result.content).toContain('never became a client');
    expect(result.content).toContain('never count one as a client or as revenue');
  });

  it('says a prospect has not started rather than that it is not a client', async () => {
    queue(
      [
        clientRow({
          id: 'c8',
          name: 'Ashgrove Dental Group',
          status: 'prospect',
          engagement_kind: 'client',
          disposition: null,
          worked_with: false,
        }),
      ],
      []
    );

    const { result } = await executeTool('find_client', { name: 'Ashgrove' }, CTX);
    expect(result.content).toContain('worked with: NO');
    expect(result.content).toContain('it has not started');
  });

  it('counts the excluded prospect from the database, and names it', async () => {
    queue(
      [clientRow(), clientRow({ id: 'c2', name: 'Calderwood Diagnostics' })],
      [
        { engagement_kind: 'client', status: 'active', n: 2 },
        { engagement_kind: 'client', status: 'inactive', n: 1 },
        { engagement_kind: 'client', status: 'prospect', n: 1 },
        { engagement_kind: 'passed', status: 'inactive', n: 2 },
        { engagement_kind: 'own_venture', status: 'active', n: 1 },
        { engagement_kind: 'artifact', status: 'inactive', n: 1 },
      ]
    );

    const { result } = await executeTool('list_clients', {}, CTX);

    // Three match, two were itemized: the count is the database's and survives
    // the page.
    expect(result.content).toContain('3 client record(s) match');
    expect(result.content).toContain('itemized (2 of 3)');
    expect(result.content).toContain('status "prospect"');
    expect(result.content).toContain('2 passed, 1 own_venture, 1 artifact');
  });

  it('refuses "prospect" as an engagement kind, because it is a status here', async () => {
    const { ok, result } = await executeTool('list_clients', { engagement_kind: 'prospect' }, CTX);
    expect(ok).toBe(false);
    expect(result.content).toContain('client, passed, own_venture, artifact');
    expect(h.calls).toHaveLength(0);
  });

  it('refuses "lead" as a status, because this schema has no such value', async () => {
    const { ok, result } = await executeTool('list_clients', { status: 'lead' }, CTX);
    expect(ok).toBe(false);
    expect(result.content).toContain('active, inactive, prospect');
  });
});

/* ═══ money ═══ */

describe('invoice totals exclude void and draft', () => {
  it('sums each figure by naming its status, never by negating paid', async () => {
    queue([totalsRow()], [invoiceRow()]);
    const { ok } = await executeTool('invoice_summary', {}, CTX);
    expect(ok).toBe(true);

    const totals = stmt(0);

    // Outstanding is open. Collected is paid. Both positive filters.
    expect(totals).toContain(
      "coalesce(sum(i.amount_cents) FILTER (WHERE i.status = 'open'), 0) AS outstanding_cents"
    );
    expect(totals).toContain("FILTER (WHERE i.status = 'paid' ), 0) AS collected_cents");

    // The spelling that would count the seed's void reissue and its unsent draft
    // as money someone owes. It must not appear in any statement.
    for (const text of every()) {
      expect(text).not.toMatch(/status\s*(<>|!=)\s*'paid'/);
      expect(text).not.toMatch(/status\s+NOT\s+IN/i);
    }
  });

  it('reports void and draft as excluded, with their amounts', async () => {
    queue([totalsRow()], [invoiceRow()]);
    const { result } = await executeTool('invoice_summary', {}, CTX);

    expect(result.content).toContain('excluded from every figure above');
    expect(result.content).toContain('1 void ($3,000.00)');
    expect(result.content).toContain('1 draft ($4,500.00)');
    expect(result.content).toContain("status <> 'paid'");
  });

  it('gives the model a formatted figure and the cents behind it', async () => {
    queue([totalsRow()], [invoiceRow()]);
    const { result } = await executeTool('invoice_summary', {}, CTX);

    // Formatted, because dividing 3330000 by 100 is arithmetic the model is bad
    // at; the cent count too, because that is what makes the answer checkable
    // against invoices.amount_cents.
    expect(result.content).toContain('outstanding (status open): $33,300.00 (3330000 cents)');
    expect(result.content).toContain('$110,500.00 (11050000 cents)');
    expect(result.content).toContain('$24,300.00 (2430000 cents)');
  });

  it('refuses to read a NULL total as zero', async () => {
    queue([totalsRow({ outstanding_cents: null })]);
    const { ok, result } = await executeTool('invoice_summary', {}, CTX);

    expect(ok).toBe(false);
    expect(result.content).toContain('not the same as zero');
    // No figure was reported at all. Asserting the absence of the literal
    // "$0.00" would fail on the refusal's own wording, which is the mistake the
    // eval notes call scoring phrasing instead of behaviour.
    expect(result.content).not.toContain('outstanding (status open)');
    expect(result.evidence).toEqual([]);
  });

  it('will not report a total across two currencies', async () => {
    queue([totalsRow({ currencies: 2 })], [invoiceRow()]);
    const { result } = await executeTool('invoice_summary', {}, CTX);
    expect(result.content).toContain('are not meaningful');
  });
});

describe('overdue is derived, never stored', () => {
  it('compares the due date against CURRENT_DATE in the database', async () => {
    queue([totalsRow()], [invoiceRow()]);
    await executeTool('invoice_summary', {}, CTX);

    const derived = "i.status = 'open' AND i.due_date IS NOT NULL AND i.due_date < CURRENT_DATE";
    expect(stmt(0)).toContain(derived);
    // Also in the itemization, so the flag on a line and the figure in the total
    // cannot disagree.
    expect(stmt(1)).toContain(derived);

    // No stored status, and no date computed from the process clock — the two
    // clocks can differ by a day and "overdue" has to be one answer.
    for (const text of every()) {
      expect(text).not.toContain("'overdue'");
    }
    for (const call of h.calls) {
      for (const p of call.params) {
        expect(p).not.toBe(new Date().toISOString().slice(0, 10));
      }
    }
  });

  it('itemizes the open invoices with how late each one is', async () => {
    queue([totalsRow()], [invoiceRow(), invoiceRow({ id: 'i3', number: 'INV-1010', amount_cents: '900000', due_date: '2026-08-29', is_overdue: false, days_overdue: null })]);
    const { result } = await executeTool('invoice_summary', {}, CTX);

    expect(result.content).toContain('INV-1008 — Halden Freight — $16,500.00 — open — due 2026-07-02, 40 days overdue');
    expect(result.content).toContain('INV-1010');
    expect(result.content).toContain('due 2026-08-29');
    expect(result.content).not.toContain('INV-1010 — Halden Freight — $9,000.00 — open — due 2026-08-29, null days overdue');
  });

  it('windows collected on paid_at and says outstanding is not windowed', async () => {
    queue([totalsRow()], []);
    const { ok } = await executeTool(
      'invoice_summary',
      { paid_from: '2026-01-01', paid_to: '2026-12-31' },
      CTX
    );
    expect(ok).toBe(true);

    expect(stmt(0)).toContain("FILTER (WHERE i.status = 'paid' AND i.paid_at >= $1 AND i.paid_at <= $2)");
    expect(args(0).slice(0, 2)).toEqual(['2026-01-01', '2026-12-31']);
  });

  it('refuses a window that cannot contain anything', async () => {
    const { ok, result } = await executeTool(
      'invoice_summary',
      { paid_from: '2026-12-31', paid_to: '2026-01-01' },
      CTX
    );
    expect(ok).toBe(false);
    expect(result.content).toContain('the window is empty');
    expect(h.calls).toHaveLength(0);
  });
});

/* ═══ nothing found, said as data ═══ */

describe('a miss is data, not an empty success', () => {
  it('names the absent client and what is on file', async () => {
    queue(
      [],
      [
        { id: 'c1', name: 'Halden Freight', total: 8 },
        { id: 'c2', name: 'Ledgerlight', total: 8 },
      ]
    );

    const { ok, result } = await executeTool('find_client', { name: 'Initech' }, CTX);

    // Not an error: "there is no such client" is an answer.
    expect(ok).toBe(true);
    expect(result.content).toContain('No client matches "Initech"');
    expect(result.content).toContain('8 client records are on file');
    expect(result.content).toContain('Halden Freight');
    expect(result.content).toMatch(/do not guess/i);

    /**
     * The names it listed are cited.
     *
     * This assertion used to require the opposite — no evidence at all — on the
     * reasoning that the answer is an ABSENCE and an absence has no row. That
     * reads well and is wrong in practice: the message also hands over every
     * client name on file, and the model repeats those to the operator as fact.
     * Running it live made it obvious. The CLI printed "nothing above rests on a
     * record; treat it as a claim" directly beneath eight true names read
     * straight out of the table.
     *
     * Citing them is what makes a name the model invented into that list
     * detectable, which is the whole reason evidence exists.
     */
    expect(result.evidence).toEqual([
      { table: 'clients', id: 'c1', label: 'Halden Freight' },
      { table: 'clients', id: 'c2', label: 'Ledgerlight' },
    ]);
  });

  it('distinguishes an empty table from a name that matched nothing', async () => {
    queue([], []);
    const { result } = await executeTool('find_client', { name: 'Initech' }, CTX);
    expect(result.content).toContain('no client records on file at all');
  });

  it('says a filter came up empty without saying the business has no clients', async () => {
    queue(
      [],
      [
        { engagement_kind: 'client', status: 'active', n: 2 },
        { engagement_kind: 'passed', status: 'inactive', n: 2 },
      ]
    );

    const { ok, result } = await executeTool('list_clients', { engagement_kind: 'artifact' }, CTX);
    expect(ok).toBe(true);
    expect(result.content).toContain('No client record matches engagement_kind "artifact"');
    expect(result.content).toContain('On file there are: 2 client, 2 passed');
    expect(result.content).toContain('not the same as');
  });

  it('says a client has no invoices rather than reporting a summed zero', async () => {
    queue(
      [clientRow({ id: 'c4', name: 'Quillon Robotics', engagement_kind: 'passed', worked_with: false })],
      [totalsRow({ invoices: 0 })]
    );

    const { ok, result } = await executeTool('client_invoices', { client_name: 'Quillon' }, CTX);
    expect(ok).toBe(true);
    expect(result.content).toContain('has no invoices on file at all');
    expect(result.content).toContain('engagement_kind passed');
    expect(result.content).not.toContain('$0.00');
  });

  it('says which of "no time" and "an empty window" it found', async () => {
    queue(
      [projectRow()],
      [timeTotalsRow({ entries: 0, projects: 0, total_hours: '0.00' })],
      [timeTotalsRow({ entries: 10, total_hours: '62.00', first_entry: '2026-06-14', last_entry: '2026-08-08' })]
    );

    const { result } = await executeTool(
      'time_summary',
      { project_name: 'Dispatch', from: '2020-01-01', to: '2020-12-31' },
      CTX
    );

    expect(result.content).toContain('No time entries match');
    expect(result.content).toContain('62.00h exist outside that window');
    expect(result.content).toContain('The WINDOW is empty, not the record');

    // The re-ask drops the dates and their parameters together: three values in
    // the windowed query, one without.
    expect(args(1)).toHaveLength(3);
    expect(args(2)).toHaveLength(1);
  });
});

/* ═══ ambiguity ═══ */

describe('a figure is refused when the name is ambiguous', () => {
  it('client_invoices computes nothing for two matching clients', async () => {
    queue([clientRow(), clientRow({ id: 'c9', name: 'Halden Freight Holdings' })]);

    const { ok, result } = await executeTool('client_invoices', { client_name: 'Halden' }, CTX);
    expect(ok).toBe(true);
    expect(result.content).toContain('matches 2 clients');
    expect(result.content).toContain('Nothing was computed');

    // The refusal is the whole call: no totals query was issued.
    expect(h.calls).toHaveLength(1);
    expect(result.evidence.map((e) => e.id)).toEqual(['c1', 'c9']);
  });

  it('time_summary computes nothing for two matching projects', async () => {
    queue([projectRow(), projectRow({ id: 'p9', name: 'Dispatch Rewrite Phase 2' })]);

    const { result } = await executeTool('time_summary', { project_name: 'Dispatch' }, CTX);
    expect(result.content).toContain('matches 2 projects');
    expect(result.content).toContain('Dispatch Rewrite (Halden Freight)');
    expect(h.calls).toHaveLength(1);
  });

  it('find_client lists every match instead, because a list attributes nothing', async () => {
    queue([clientRow(), clientRow({ id: 'c9', name: 'Halden Freight Holdings' })], []);

    const { result } = await executeTool('find_client', { name: 'Halden' }, CTX);
    expect(result.content).toContain('2 clients match "Halden"');
    expect(result.content).toContain('do not assume the first is the one meant');
    expect(result.evidence).toHaveLength(2);
  });
});

/* ═══ evidence ═══ */

describe('evidence carries the table and the row id', () => {
  it('cites the client and each of its projects', async () => {
    queue([clientRow()], [projectRow(), projectRow({ id: 'p2', name: 'Driver Mobile App' })]);

    const { result } = await executeTool('find_client', { name: 'Halden' }, CTX);

    expect(result.evidence).toEqual([
      { table: 'clients', id: 'c1', label: 'Halden Freight' },
      { table: 'projects', id: 'p1', label: 'Dispatch Rewrite' },
      { table: 'projects', id: 'p2', label: 'Driver Mobile App' },
    ]);
  });

  it('cites the invoices a money answer rests on', async () => {
    queue([totalsRow()], [invoiceRow()]);
    const { result } = await executeTool('invoice_summary', {}, CTX);

    expect(result.evidence).toContainEqual({ table: 'invoices', id: 'i1', label: 'INV-1008' });
  });

  it('cites time entries as well as their project', async () => {
    queue(
      [projectRow()],
      [timeTotalsRow()],
      [
        {
          project_id: 'p1',
          project_name: 'Dispatch Rewrite',
          project_status: 'active',
          budget_hours: '120.00',
          client_id: 'c1',
          client_name: 'Halden Freight',
          engagement_kind: 'client',
          entries: 10,
          total_hours: '62.00',
          billable_hours: '59.50',
          budget_pct: '51.7',
        },
      ],
      [
        {
          id: 't1',
          entry_date: '2026-08-08',
          hours: '4.50',
          billable: true,
          note: 'Watching the first terminal.',
          project_name: 'Dispatch Rewrite',
        },
      ]
    );

    const { result } = await executeTool('time_summary', { project_name: 'Dispatch' }, CTX);
    const tables = result.evidence.map((e) => e.table);
    expect(tables).toContain('projects');
    expect(tables).toContain('time_entries');
    expect(result.evidence.find((e) => e.table === 'time_entries')?.id).toBe('t1');
  });
});

/* ═══ hours ═══ */

describe('hours are summed in the database', () => {
  it('reports the database total, not the sum of the rows it itemized', async () => {
    queue(
      [projectRow()],
      [timeTotalsRow()],
      [
        {
          project_id: 'p1',
          project_name: 'Dispatch Rewrite',
          project_status: 'active',
          budget_hours: '120.00',
          client_id: 'c1',
          client_name: 'Halden Freight',
          engagement_kind: 'client',
          entries: 10,
          total_hours: '62.00',
          billable_hours: '59.50',
          budget_pct: '51.7',
        },
      ],
      // One entry of 4.50h. A tool that added up what it showed would say 4.50h.
      [
        {
          id: 't1',
          entry_date: '2026-08-08',
          hours: '4.50',
          billable: true,
          note: null,
          project_name: 'Dispatch Rewrite',
        },
      ]
    );

    const { result } = await executeTool('time_summary', { project_name: 'Dispatch' }, CTX);

    expect(stmt(1)).toContain('coalesce(sum(t.hours), 0) AS total_hours');
    expect(stmt(1)).toContain('FILTER (WHERE t.billable)');
    expect(result.content).toContain('total: 62.00h');
    expect(result.content).toContain('billable: 59.50h');
    expect(result.content).toContain('non-billable: 2.50h');
    expect(result.content).toContain('most recent entries (1 of 10)');
    expect(result.content).toContain('9 more not itemized');
  });

  it('separates no budget from a budget of zero', async () => {
    const project = {
      project_id: 'p3',
      project_name: 'Terminal Yard Sensors',
      project_status: 'paused',
      budget_hours: null as string | null,
      client_id: 'c1',
      client_name: 'Halden Freight',
      engagement_kind: 'client',
      entries: 2,
      total_hours: '7.50',
      billable_hours: '7.50',
      budget_pct: null as string | null,
    };

    queue([timeTotalsRow({ entries: 2, total_hours: '7.50', billable_hours: '7.50', nonbillable_hours: '0.00' })], [project], []);
    const first = await executeTool('time_summary', {}, CTX);
    expect(first.result.content).toContain('no budget agreed');

    h.calls.length = 0;
    queue(
      [timeTotalsRow({ entries: 2, total_hours: '7.50', billable_hours: '7.50', nonbillable_hours: '0.00' })],
      [{ ...project, budget_hours: '0.00' }],
      []
    );
    const second = await executeTool('time_summary', {}, CTX);
    expect(second.result.content).toContain('every hour logged is over it');
  });

  it('reports over budget with the overrun, from the database percentage', async () => {
    queue(
      [timeTotalsRow({ entries: 10, total_hours: '67.50', billable_hours: '63.50', nonbillable_hours: '4.00' })],
      [
        {
          project_id: 'p2',
          project_name: 'Driver Mobile App',
          project_status: 'completed',
          budget_hours: '60.00',
          client_id: 'c1',
          client_name: 'Halden Freight',
          engagement_kind: 'client',
          entries: 10,
          total_hours: '67.50',
          billable_hours: '63.50',
          budget_pct: '112.5',
        },
      ],
      []
    );

    const { result } = await executeTool('time_summary', {}, CTX);
    expect(result.content).toContain('112.5% used, OVER BUDGET by 7.50h');
  });

  it('flags hours that can never be billed to anyone', async () => {
    queue(
      [timeTotalsRow({ entries: 4, total_hours: '14.50', billable_hours: '0.00', nonbillable_hours: '14.50' })],
      [
        {
          project_id: 'p7',
          project_name: 'Ledgerlight Internal Tooling',
          project_status: 'active',
          budget_hours: null,
          client_id: 'c6',
          client_name: 'Ledgerlight',
          engagement_kind: 'own_venture',
          entries: 4,
          total_hours: '14.50',
          billable_hours: '0.00',
          budget_pct: null,
        },
      ],
      []
    );

    const { result } = await executeTool('time_summary', {}, CTX);
    expect(result.content).toContain('never billable, never revenue');
    expect(result.content).toContain('none of this can be billed to anyone');
  });

  it('never turns hours into money', async () => {
    queue(
      [timeTotalsRow()],
      [
        {
          project_id: 'p1',
          project_name: 'Dispatch Rewrite',
          project_status: 'active',
          budget_hours: '120.00',
          client_id: 'c1',
          client_name: 'Halden Freight',
          engagement_kind: 'client',
          entries: 10,
          total_hours: '62.00',
          billable_hours: '59.50',
          budget_pct: '51.7',
        },
      ],
      []
    );

    const { result } = await executeTool('time_summary', {}, CTX);
    // Billable hours times a rate is not money anyone owes, and a figure that
    // looks like revenue but appears on no invoice is the kind that gets quoted.
    expect(result.content).not.toContain('$');
    for (const text of every()) expect(text).not.toContain('rate_cents');
  });
});

/* ═══ arguments ═══ */

describe('arguments the model got wrong', () => {
  it('clamps a greedy limit instead of reading the table', async () => {
    queue([totalsRow()], []);
    const { ok } = await executeTool('invoice_summary', { limit: 999_999 }, CTX);
    expect(ok).toBe(true);
    // The itemization query's last parameter is its LIMIT.
    expect(args(1).at(-1)).toBe(50);
  });

  it('refuses a limit that is a misunderstanding rather than an appetite', async () => {
    const { ok, result } = await executeTool('list_projects', { limit: -3 }, CTX);
    expect(ok).toBe(false);
    expect(result.content).toContain('positive whole number');
  });

  it('treats an empty string filter as no filter', async () => {
    queue([totalsRow()], []);
    const { ok } = await executeTool('invoice_summary', { client_name: '   ' }, CTX);
    expect(ok).toBe(true);
    // No client was resolved, so the first statement is the totals aggregate.
    expect(stmt(0)).toContain('AS outstanding_cents');
  });

  it('passes the search text as a parameter and escapes LIKE wildcards', async () => {
    queue([], []);
    await executeTool('find_client', { name: 'a_b%' }, CTX);

    expect(stmt(0)).toContain('WHERE name ILIKE $1');
    // An unescaped _ matches any character, which silently widens a lookup and
    // the extra match reads like a hit.
    expect(args(0)[0]).toBe('%a\\_b\\%%');
  });

  it('reports an unknown tool as a result the model can act on', async () => {
    const { ok, result } = await executeTool('invoice_totals', {}, CTX);
    expect(ok).toBe(false);
    expect(result.content).toContain('There is no tool called "invoice_totals"');
    expect(result.content).toContain('invoice_summary');
  });
});

/* ═══ projects ═══ */

describe('list_projects', () => {
  it('reads start_date, not created_at, and says a budget was never agreed', async () => {
    queue([{ ...projectRow({ budget_hours: null, status: 'paused' }), total: 1 }]);

    const { ok, result } = await executeTool('list_projects', {}, CTX);
    expect(ok).toBe(true);

    expect(stmt(0)).toContain('p.start_date');
    expect(stmt(0)).not.toContain('created_at');
    expect(result.content).toContain('2025-06-11 to open');
    expect(result.content).toContain('not a budget of 0.00h');
  });

  it('takes the match count from the database, not from the page', async () => {
    queue([
      { ...projectRow(), total: 9 },
      { ...projectRow({ id: 'p2', name: 'Driver Mobile App' }), total: 9 },
    ]);

    const { result } = await executeTool('list_projects', { limit: 2 }, CTX);
    expect(stmt(0)).toContain('(count(*) OVER ())::int AS total');
    expect(result.content).toContain('9 project(s)');
    expect(result.content).toContain('itemized (2 of 9)');
    expect(result.content).toContain('7 more not itemized');
  });

  it('separates "no such client" from "that client has no projects"', async () => {
    queue([], [{ name: 'Halden Freight', total: 8 }]);
    const absent = await executeTool('list_projects', { client_name: 'Initech' }, CTX);
    expect(absent.result.content).toContain('No client matches "Initech"');

    h.calls.length = 0;
    queue([clientRow({ id: 'c8', name: 'Ashgrove Dental Group', status: 'prospect', worked_with: false })], [], [{ name: 'Dispatch Rewrite', total: 9 }]);
    const empty = await executeTool('list_projects', { client_name: 'Ashgrove' }, CTX);
    expect(empty.result.content).toContain('No project is on file for Ashgrove Dental Group');
    expect(empty.result.content).toContain('9 project(s) are on file overall');
  });
});

/* ═══ one client's invoices ═══ */

describe('client_invoices', () => {
  it('itemizes the rows and keeps the totals over every invoice', async () => {
    queue([clientRow()], [totalsRow({ invoices: 5 })], [invoiceRow(), invoiceRow({ id: 'i2', number: 'INV-1004', status: 'paid', amount_cents: '2400000', paid_at: '2025-12-11', is_overdue: false, days_overdue: null })]);

    const { ok, result } = await executeTool(
      'client_invoices',
      { client_name: 'Halden', status: 'open' },
      CTX
    );
    expect(ok).toBe(true);

    expect(stmt(2)).toContain('i.client_id = $1');
    expect(args(2)[0]).toBe('c1');
    expect(args(2)[1]).toBe('open');

    expect(result.content).toContain('INV-1004 — Halden Freight — $24,000.00 — paid — paid 2025-12-11');
    expect(result.content).toContain('the totals above cover ALL 5 invoice(s)');
  });

  it('says a status filter matched nothing without denying the invoices exist', async () => {
    queue([clientRow()], [totalsRow({ invoices: 5 })], []);

    const { result } = await executeTool(
      'client_invoices',
      { client_name: 'Halden', status: 'void' },
      CTX
    );
    expect(result.content).toContain('No invoice for Halden Freight has status "void"');
    expect(result.content).toContain('The totals above still stand');
  });
});
