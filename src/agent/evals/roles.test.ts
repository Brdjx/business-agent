/**
 * The binder, with Postgres replaced by rows held in memory.
 *
 * ── Why the suite needs a suite ──
 *
 * `bindRoles` decides which cases run. A binder that silently returns nothing turns
 * seventeen cases into seventeen skips, prints a reason for each, and exits 0 — a
 * green run that measured the agent on nothing at all. A binder that binds the WRONG
 * row is worse: a passed lead bound as `client_with_project` makes every lookup case
 * ask about a company that was never a client, and the agent then fails cases it
 * answered correctly. Neither failure is visible in a pass count, so it is asserted
 * here.
 *
 * ── Two kinds of assertion, and the difference matters ──
 *
 * The fake below is not a SQL engine. It recognises each of the binder's queries and
 * answers it from crafted rows, and there are two ways it could do that:
 *
 * **Reading the clause out of the SQL.** Where a test's whole point is that a clause
 * is load-bearing — `engagement_kind = 'client'` on the project roles, `client_billed
 * DESC` in the contact pair's ORDER BY, which text columns the absent-name check
 * unions over — the fake probes the statement for that clause and only applies it if
 * it is there. So deleting the clause from `roles.ts` changes the row that binds, and
 * the test fails. Without that, a fake that hardcoded the filter would pass with the
 * filter removed, which is a test of the fake.
 *
 * **Implementing the documented semantics.** Everywhere else — the money and hours
 * aggregates — the fake sums the rows the way `roles.ts` documents, and a separate
 * block at the bottom asserts the SQL text says what the fake assumed (that
 * outstanding is filtered on `status = 'open'` and not on `status <> 'paid'`, that
 * the never-billable filter names both engagement kinds). Two halves of one check;
 * either alone would pass on the wrong query.
 *
 * ── What is NOT covered ──
 *
 * None of this SQL has been executed. A syntax error, a column that does not exist, a
 * FILTER clause Postgres rejects: every assertion below passes on all of them, because
 * the fake answers from JavaScript. `npm run db:check` and the compose database are the
 * only things that catch that, and they check the same predicates from the other side.
 *
 * Collation is not modelled either. The fake sorts by code point where the binder says
 * ORDER BY, and Postgres sorts by the database's collation; the names in these
 * datasets are ASCII and differ early, so the two agree. A test that turned on the
 * difference would be asserting something neither file promises.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

/* ─── the rows, shaped like the columns in db/001-business.sql ─── */

interface ClientRow {
  id: string;
  name: string;
  status: string;
  engagement_kind: string;
  notes?: string | null;
}

interface ProjectRow {
  id: string;
  name: string;
  client_id: string;
  description?: string | null;
}

interface ContactRow {
  id: string;
  /** Nullable in the schema: someone met at a conference has no client to attach to. */
  client_id: string | null;
  first_name: string | null;
  last_name?: string | null;
  is_primary?: boolean | null;
  notes?: string | null;
}

interface InvoiceRow {
  number: string;
  client_id: string;
  status: string;
  /** BIGINT, so a string here as well as everywhere else. */
  amount_cents: string;
  description?: string | null;
  notes?: string | null;
}

interface TimeRow {
  project_id: string;
  /** NUMERIC(5,2) — '40.50', never 40.5. */
  hours: string;
  billable: boolean;
  note?: string | null;
}

interface Dataset {
  clients: ClientRow[];
  projects: ProjectRow[];
  contacts: ContactRow[];
  invoices: InvoiceRow[];
  time_entries: TimeRow[];
}

type Row = Record<string, unknown>;

/**
 * `vi.hoisted`, because `vi.mock` is lifted above the imports and its factory would
 * otherwise close over bindings still in their temporal dead zone when `roles.ts` is
 * first imported.
 */
const h = vi.hoisted(() => ({
  calls: [] as Array<{ text: string; params: unknown[] }>,
  data: null as Dataset | null,
  /** A normalized fragment; a query containing it fails the way a dropped connection does. */
  throwOn: null as string | null,
  /** A normalized fragment; a query containing it returns no row at all. */
  emptyOn: null as string | null,
}));

vi.mock('../../db', () => {
  const rows = (text: string, params: unknown[]): Row[] => {
    h.calls.push({ text, params });
    return answer(text, params);
  };
  return {
    sql: async (text: string, params: unknown[] = []) => rows(text, params),
    one: async (text: string, params: unknown[] = []) => rows(text, params)[0] ?? null,
    close: async () => {},
  };
});

import {
  bindRoles,
  conflatedBillableSpellings,
  describeBinding,
  dollarSpellings,
  hourSpellings,
  ROLES,
  type Binding,
} from './roles';

/* ─── the fake ─── */

const norm = (s: string): string => s.replace(/\s+/g, ' ').trim();
/** Probes read a lowercased statement, so a capitalisation change is not a failure. */
const probe = (s: string): string => norm(s).toLowerCase();

const statements = (): string[] => h.calls.map((c) => norm(c.text));
const asked = (fragment: string): string[] =>
  statements().filter((s) => s.toLowerCase().includes(fragment.toLowerCase()));

/** Code-point order, not locale order. See the note about collation in the header. */
const byName = (a: { name: string }, b: { name: string }): number =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

const limited = (n: string, rows: Row[]): Row[] => {
  const m = /limit (\d+)/.exec(n);
  return m ? rows.slice(0, Number(m[1])) : rows;
};

const projectsOf = (d: Dataset, c: ClientRow): ProjectRow[] =>
  d.projects.filter((p) => p.client_id === c.id);
const invoicesOf = (d: Dataset, c: ClientRow): InvoiceRow[] =>
  d.invoices.filter((i) => i.client_id === c.id);

const cents = (rows: InvoiceRow[]): string =>
  String(rows.reduce((total, i) => total + Number(i.amount_cents), 0));
const hoursOf = (rows: TimeRow[]): string =>
  rows.reduce((total, t) => total + Number(t.hours), 0).toFixed(2);

/**
 * Which of a table's text columns a branch of the absent-name check actually reads.
 *
 * Word boundaries matter here rather than being tidiness: `\bname\b` must not match
 * inside `first_name`, or the fake would report the contacts branch as searching a
 * column it does not search.
 */
const TEXT_COLUMNS: Record<string, string[]> = {
  clients: ['name', 'notes'],
  projects: ['name', 'description'],
  contacts: ['first_name', 'last_name', 'notes'],
  invoices: ['number', 'description', 'notes'],
  time_entries: ['note'],
};

/**
 * Answer one of the binder's queries from the crafted rows.
 *
 * An unrecognised statement THROWS. It would otherwise return no rows, which
 * `bindRoles` reads as "this dataset has no such row" — so a query added to the binder
 * and not to this fake would turn every test below into a test of an unbound role, and
 * they would all still pass.
 */
function answer(text: string, params: readonly unknown[]): Row[] {
  const n = probe(text);

  if (h.throwOn && n.includes(h.throwOn)) {
    throw new Error('Connection terminated unexpectedly');
  }
  if (h.emptyOn && n.includes(h.emptyOn)) return [];

  const d = h.data;
  if (!d) throw new Error('No dataset was given to the fake. Call given(...) in the test.');

  /* ---------- the contact pair: one query, two roles ---------- */
  if (n.includes('from contacts ct')) {
    // The WHERE, applied only if it is there. The schema's CHECK on first_name makes
    // an empty name impossible in Postgres, so this filter is belt and braces — but
    // "never bound to an empty string" is the binder's promise rather than the
    // schema's, and it is asserted below.
    const requiresName = n.includes('btrim');
    const prefersBilled = /order by[^;]*client_billed desc/.test(n);
    const prefersPrimary = /is_primary[^,]*desc/.test(n) || /is_primary\) desc/.test(n);

    const joined = d.contacts
      .map((ct) => ({ ct, client: d.clients.find((c) => c.id === ct.client_id) }))
      .filter((x): x is { ct: ContactRow; client: ClientRow } => x.client !== undefined)
      .map(({ ct, client }) => ({
        contact: `${ct.first_name ?? ''} ${ct.last_name ?? ''}`.trim(),
        bare: `${ct.first_name ?? ''}${ct.last_name ?? ''}`.trim(),
        client: client.name,
        is_primary: ct.is_primary ?? false,
        client_billed: invoicesOf(d, client).length > 0,
      }))
      .filter((x) => !requiresName || x.bare !== '');

    joined.sort((a, b) => {
      if (prefersBilled && a.client_billed !== b.client_billed) return a.client_billed ? -1 : 1;
      if (prefersPrimary && a.is_primary !== b.is_primary) return a.is_primary ? -1 : 1;
      if (a.client !== b.client) return a.client < b.client ? -1 : 1;
      return a.contact < b.contact ? -1 : a.contact > b.contact ? 1 : 0;
    });

    return limited(
      n,
      joined.map((x) => ({
        contact: x.contact,
        client: x.client,
        client_billed: x.client_billed,
      }))
    );
  }

  /* ---------- which project names contain which ---------- */
  if (n.includes('string_agg')) {
    const pairs = new Set<string>();
    for (const a of d.projects) {
      for (const b of d.projects) {
        if (a.id === b.id) continue;
        if (b.name.toLowerCase().includes(a.name.toLowerCase())) {
          pairs.add(`${a.name} is inside ${b.name}`);
        }
      }
    }
    const sorted = [...pairs].sort();
    return [{ pairs: sorted.length > 0 ? sorted.join('; ') : null }];
  }

  /* ---------- single_project ---------- */
  if (n.includes('from projects q')) {
    const rows = d.projects
      .filter(
        (p) =>
          d.projects.filter((q) => q.name.toLowerCase().includes(p.name.toLowerCase())).length === 1
      )
      .sort(byName)
      .map((p) => ({ name: p.name }));
    return limited(n, rows);
  }

  /* ---------- absent_client ---------- */
  if (n.includes('union all')) {
    const needle = String(params[0] ?? '')
      .replace(/%/g, '')
      .toLowerCase();
    let hits = 0;
    for (const branch of n.split('union all')) {
      const table = Object.keys(TEXT_COLUMNS).find((t) => new RegExp(`from ${t}\\b`).test(branch));
      if (!table) continue;
      const columns = TEXT_COLUMNS[table].filter((col) => new RegExp(`\\b${col}\\b`).test(branch));
      for (const row of d[table as keyof Dataset] as unknown as Row[]) {
        // Joined with a space, which treats `a OR b` and `a || ' ' || b` alike. That is
        // exact for a needle containing no space, and 'Initech' contains none.
        const haystack = columns
          .map((col) => String(row[col] ?? ''))
          .join(' ')
          .toLowerCase();
        if (needle !== '' && haystack.includes(needle)) hits++;
      }
    }
    return [{ hits }];
  }

  /* ---------- the money ---------- */
  if (n.includes('as outstanding_cents')) {
    const byStatus = (status: string) => d.invoices.filter((i) => i.status === status);
    const notPaid = d.invoices.filter((i) => i.status !== 'paid');
    const first = (status: string) =>
      byStatus(status)
        .map((i) => i.number)
        .sort()[0] ?? null;
    return [
      {
        outstanding_cents: cents(byStatus('open')),
        naive_cents: cents(notPaid),
        collected_cents: cents(byStatus('paid')),
        void_count: byStatus('void').length,
        draft_count: byStatus('draft').length,
        void_invoice: first('void'),
        draft_invoice: first('draft'),
      },
    ];
  }

  /* ---------- the hours ---------- */
  if (n.includes('as total_hours')) {
    // INNER JOINs, so an entry whose project is gone, or whose project's client is
    // gone, is not counted.
    const joined = d.time_entries
      .map((t) => {
        const project = d.projects.find((p) => p.id === t.project_id);
        const client = project ? d.clients.find((c) => c.id === project.client_id) : undefined;
        return { t, client };
      })
      .filter((x): x is { t: TimeRow; client: ClientRow } => x.client !== undefined);

    return [
      {
        total_hours: hoursOf(joined.map((x) => x.t)),
        billable_hours: hoursOf(joined.filter((x) => x.t.billable).map((x) => x.t)),
        nonbillable_hours: hoursOf(joined.filter((x) => !x.t.billable).map((x) => x.t)),
        never_billable_hours: hoursOf(
          joined
            .filter((x) => ['own_venture', 'artifact'].includes(x.client.engagement_kind))
            .map((x) => x.t)
        ),
      },
    ];
  }

  /* ---------- passed_lead ---------- */
  if (/engagement_kind\s*=\s*'passed'/.test(n)) {
    const rows = d.clients
      .filter((c) => c.engagement_kind === 'passed')
      .sort(byName)
      .map((c) => ({ name: c.name }));
    return limited(n, rows);
  }

  /* ---------- client_with_invoices ---------- */
  if (n.includes('join invoices i')) {
    const rows = d.clients
      .filter((c) => invoicesOf(d, c).length > 0)
      .sort((a, b) => {
        const openA = invoicesOf(d, a).filter((i) => i.status === 'open').length;
        const openB = invoicesOf(d, b).filter((i) => i.status === 'open').length;
        if (openA !== openB) return openB - openA;
        const allA = invoicesOf(d, a).length;
        const allB = invoicesOf(d, b).length;
        if (allA !== allB) return allB - allA;
        return byName(a, b);
      })
      .map((c) => ({ name: c.name }));
    return limited(n, rows);
  }

  /* ---------- the three plain client lookups ---------- */
  if (n.includes('from clients')) {
    // Read out of the statement, not assumed. The seed holds a passed lead WITH
    // projects precisely so that a binder filtering on projects alone binds the wrong
    // row, and a fake that applied this filter unconditionally could not tell.
    const clientsOnly = /engagement_kind\s*=\s*'client'/.test(n);
    const inactiveOnly = /status\s*=\s*'inactive'/.test(n);
    const needsProjects = n.includes('from projects');
    const needsSeveral = n.includes('> 1');

    const rows = d.clients
      .filter((c) => !clientsOnly || c.engagement_kind === 'client')
      .filter((c) => !inactiveOnly || c.status === 'inactive')
      .filter((c) => {
        if (!needsProjects) return true;
        return projectsOf(d, c).length > (needsSeveral ? 1 : 0);
      })
      .sort(byName)
      .map((c) => ({ name: c.name }));
    return limited(n, rows);
  }

  throw new Error(
    'The fake database does not recognise this query, so bindRoles would have read null ' +
      'from it and reported a role as unbound while every assertion here still passed. ' +
      `Teach the fake:\n${norm(text)}`
  );
}

/* ─── datasets ─── */

const empty = (): Dataset => ({
  clients: [],
  projects: [],
  contacts: [],
  invoices: [],
  time_entries: [],
});

const given = (over: Partial<Dataset> = {}): void => {
  h.data = { ...empty(), ...over };
};

/**
 * The seeded business, thinned to one row per fact.
 *
 * The figures are the ones `db/900-seed.sql` publishes in its closing block —
 * $110,500 collected, $33,300 outstanding, $3,000 void and $4,500 draft excluded from
 * both, 257.50h logged of which 217.00h billable — so a reader can recognise the
 * dataset. Nothing here proves the seed still holds them: this is a hand copy, and
 * `npm run db:check` is what checks the real thing.
 */
function seedShaped(): Dataset {
  const clients: ClientRow[] = [
    { id: 'hf', name: 'Halden Freight', status: 'active', engagement_kind: 'client' },
    { id: 'cd', name: 'Calderwood Diagnostics', status: 'active', engagement_kind: 'client' },
    // status inactive AND engagement_kind client: the only row that is both, which is
    // why inactive_client needs two columns.
    { id: 'nc', name: 'Northaven Credit Union', status: 'inactive', engagement_kind: 'client' },
    { id: 'ad', name: 'Ashgrove Dental Group', status: 'prospect', engagement_kind: 'client' },
    // Took a call, never became a client. Also 'inactive', which is the confusion.
    { id: 'qr', name: 'Quillon Robotics', status: 'inactive', engagement_kind: 'passed' },
    { id: 'sv', name: 'Sable and Vane Interiors', status: 'inactive', engagement_kind: 'passed' },
    { id: 'll', name: 'Ledgerlight', status: 'active', engagement_kind: 'own_venture' },
    { id: 'sl', name: 'Statline', status: 'active', engagement_kind: 'artifact' },
  ];

  const projects: ProjectRow[] = [
    { id: 'p1', name: 'Dispatch Rewrite', client_id: 'hf' },
    { id: 'p2', name: 'Driver Mobile App', client_id: 'hf' },
    { id: 'p3', name: 'Terminal Yard Sensors', client_id: 'hf' },
    { id: 'p4', name: 'Lab Results Portal', client_id: 'cd' },
    { id: 'p5', name: 'HL7 Feed Cleanup', client_id: 'cd' },
    { id: 'p6', name: 'Loan Origination Audit', client_id: 'nc' },
    { id: 'p7', name: 'Ledgerlight Internal Tooling', client_id: 'll' },
    { id: 'p8', name: 'Statline Hockey Prototype', client_id: 'sl' },
    // The row the passed-lead tests turn on: a lead that was declined still carries
    // the project the scoping call was logged against.
    { id: 'p9', name: 'Warehouse Robotics Scoping', client_id: 'qr' },
  ];

  const contacts: ContactRow[] = [
    { id: 'ct1', client_id: 'hf', first_name: 'Dana', last_name: 'Ruiz', is_primary: true },
    { id: 'ct2', client_id: 'hf', first_name: 'Marcus', last_name: 'Alden' },
    // Contacts at clients that were never billed, which is what the pair's ORDER BY is
    // for.
    { id: 'ct3', client_id: 'ad', first_name: 'Priya', last_name: 'Nandra', is_primary: true },
    { id: 'ct4', client_id: 'qr', first_name: 'Owen', last_name: 'Falk', is_primary: true },
  ];

  const invoices: InvoiceRow[] = [
    { number: 'INV-1001', client_id: 'nc', status: 'paid', amount_cents: '1200000' },
    { number: 'INV-1002', client_id: 'nc', status: 'paid', amount_cents: '1850000' },
    { number: 'INV-1003', client_id: 'hf', status: 'paid', amount_cents: '2500000' },
    { number: 'INV-1004', client_id: 'hf', status: 'paid', amount_cents: '1750000' },
    { number: 'INV-1005', client_id: 'cd', status: 'paid', amount_cents: '2000000' },
    { number: 'INV-1006', client_id: 'cd', status: 'void', amount_cents: '300000' },
    { number: 'INV-1007', client_id: 'cd', status: 'paid', amount_cents: '1750000' },
    { number: 'INV-1008', client_id: 'hf', status: 'open', amount_cents: '1350000' },
    { number: 'INV-1009', client_id: 'cd', status: 'open', amount_cents: '1080000' },
    { number: 'INV-1010', client_id: 'hf', status: 'open', amount_cents: '900000' },
    { number: 'INV-1011', client_id: 'hf', status: 'draft', amount_cents: '450000' },
  ];

  const time_entries: TimeRow[] = [
    { project_id: 'p1', hours: '52.50', billable: true },
    // Non-billable work on a paying client's project: the reason the billable total is
    // not simply the total.
    { project_id: 'p1', hours: '9.50', billable: false },
    { project_id: 'p2', hours: '67.50', billable: true },
    { project_id: 'p3', hours: '7.50', billable: true },
    { project_id: 'p4', hours: '38.50', billable: true },
    { project_id: 'p5', hours: '21.50', billable: true },
    { project_id: 'p6', hours: '29.50', billable: true },
    // Nobody to charge: an own venture and an artifact.
    { project_id: 'p7', hours: '14.50', billable: false },
    { project_id: 'p8', hours: '15.00', billable: false },
    { project_id: 'p9', hours: '1.50', billable: false },
  ];

  return { clients, projects, contacts, invoices, time_entries };
}

/* ─── invariants asserted of every binding in this file ─── */

/**
 * The three promises the runner depends on, checked after every bind below rather than
 * in one test of one dataset.
 *
 * A role is bound to a non-empty string, or it is reported in `missing` with a reason —
 * never both, never neither, and never present as a key holding undefined, which would
 * read as bound to `'role' in roles` and print as `undefined` inside a question.
 */
function auditBinding(b: Binding): void {
  for (const role of ROLES) {
    const present = Object.prototype.hasOwnProperty.call(b.roles, role);
    const reported = b.missing.filter((m) => m.role === role);

    if (present) {
      expect(typeof b.roles[role], `${role} is present but not a string`).toBe('string');
      expect(b.roles[role], `${role} is bound to an empty string`).not.toBe('');
      expect(reported, `${role} is both bound and reported missing`).toEqual([]);
    } else {
      expect(reported.length, `${role} is neither bound nor reported as missing`).toBe(1);
      // A sentence, not a label. "not bound" tells the reader nothing they did not
      // already know from the role being absent.
      expect(reported[0].because.trim().length).toBeGreaterThan(20);
    }
  }

  // Both ends of one edge or neither. A case needing a contact AND their client cannot
  // have them chosen independently, so half a pair must never be offered.
  expect(
    Object.prototype.hasOwnProperty.call(b.roles, 'contact_at_client'),
    'the contact pair is half bound'
  ).toBe(Object.prototype.hasOwnProperty.call(b.roles, 'client_of_contact'));

  // The aggregates throw rather than degrade, so both facts exist on every binding.
  expect(b.roles.money).toBeDefined();
  expect(b.roles.hours).toBeDefined();

  // Nothing is reported missing twice, and nothing is reported that is not a role.
  const reportedRoles = b.missing.map((m) => m.role);
  expect(new Set(reportedRoles).size).toBe(reportedRoles.length);
  for (const role of reportedRoles) expect(ROLES).toContain(role);
}

const bound = async (): Promise<Binding> => {
  const b = await bindRoles();
  auditBinding(b);
  return b;
};

beforeEach(() => {
  h.calls.length = 0;
  h.data = null;
  h.throwOn = null;
  h.emptyOn = null;
});

/* ─── the tests ─── */

describe('ROLES', () => {
  it('lists nine roles, once each', () => {
    // The union and the list are guarded against each other at compile time in
    // roles.ts. What that guard cannot see is a name repeated, which would print a
    // role twice and hide the duplicate in a wall of nine lines.
    expect(ROLES).toHaveLength(9);
    expect(new Set(ROLES).size).toBe(9);
  });
});

describe('bindRoles against a dataset shaped like the seed', () => {
  it('binds all nine roles, and reports nothing missing', async () => {
    given(seedShaped());
    const b = await bound();

    expect(b.missing).toEqual([]);
    expect(b.roles).toMatchObject({
      // Alphabetical, because every query orders explicitly: Calderwood has two
      // projects and sorts before Halden's three. Which qualifying row binds is
      // irrelevant to the case — that it is the SAME row on the next run is not.
      client_multi_project: 'Calderwood Diagnostics',
      client_with_project: 'Calderwood Diagnostics',
      passed_lead: 'Quillon Robotics',
      inactive_client: 'Northaven Credit Union',
      // Not alphabetical: the binder prefers the client with the most OPEN invoices,
      // so the case that asks for itemized open rows has some.
      client_with_invoices: 'Halden Freight',
      contact_at_client: 'Dana Ruiz',
      client_of_contact: 'Halden Freight',
      single_project: 'Dispatch Rewrite',
      absent_client: 'Initech',
    });
  });

  it('warns about nothing, because every trap in the seed is armed', async () => {
    given(seedShaped());
    const b = await bound();
    expect(b.warnings).toEqual([]);
  });

  it('reads the money the way the seed publishes it, and arms the naive total', async () => {
    given(seedShaped());
    const b = await bound();

    expect(b.roles.money).toEqual({
      outstandingCents: '3330000',
      // status <> 'paid' swallows the $3,000 void and the $4,500 draft. Non-null means
      // the case that catches that mistake has a wrong figure to forbid.
      naiveOutstandingCents: '4080000',
      collectedCents: '11050000',
      voidCount: 1,
      draftCount: 1,
      voidInvoice: 'INV-1006',
      draftInvoice: 'INV-1011',
    });
  });

  it('gives the right total and the wrong one no spelling in common', async () => {
    given(seedShaped());
    const b = await bound();

    // `totals-exclude-void-and-draft` requires one figure and forbids the other. If any
    // spelling of the wrong total contained a spelling of the right one, no answer
    // could satisfy both and the case would fail every correct run. Checked here
    // because it is a property of the DATA, so it cannot be checked in cases.test.ts.
    const right = dollarSpellings(b.roles.money?.outstandingCents);
    const wrong = dollarSpellings(b.roles.money?.naiveOutstandingCents);
    expect(right.length).toBeGreaterThan(0);
    expect(wrong.length).toBeGreaterThan(0);
    for (const r of right) {
      for (const w of wrong) {
        expect(w.includes(r), `the forbidden ${w} contains the required ${r}`).toBe(false);
        expect(r.includes(w), `the required ${r} contains the forbidden ${w}`).toBe(false);
      }
    }
  });

  it('separates hours that are not billable from hours nobody can be billed for', async () => {
    given(seedShaped());
    const b = await bound();

    expect(b.roles.hours).toEqual({
      totalHours: '257.50',
      billableHours: '217.00',
      nonBillableHours: '40.50',
      // The own venture and the artifact. Not 40.50: 9.50h of non-billable work sits on
      // a paying client's project, and 1.50h on a lead that was passed on.
      neverBillableHours: '29.50',
    });
  });

  it('reads only, and orders every lookup it binds a role from', async () => {
    given(seedShaped());
    await bound();

    for (const statement of statements()) {
      // A suite that mutated the data it measures would measure what an earlier run
      // left behind.
      expect(statement).not.toMatch(/\b(insert|update|delete|truncate|drop|alter|create)\b/i);
    }

    // Heap order is not a promise Postgres makes. A case that behaved differently on
    // Tuesday is not debuggable if the binding may have moved too, so every query that
    // picks one row of several names its tie-break.
    const picksOneRow = statements().filter((s) => /limit 1/i.test(s));
    expect(picksOneRow.length).toBeGreaterThan(0);
    for (const statement of picksOneRow) {
      expect(statement.toLowerCase(), `no ORDER BY: ${statement}`).toContain('order by');
    }
  });
});

describe('a role that cannot bind', () => {
  it('is reported with a reason and is absent from roles, not bound to undefined', async () => {
    // Two own ventures, no invoices, no contacts, the same project name on both — so
    // every name is a case-insensitive substring of another and no write could resolve
    // one — and the absent name sitting in a note.
    given({
      clients: [
        {
          id: 'll',
          name: 'Ledgerlight',
          status: 'active',
          engagement_kind: 'own_venture',
          notes: 'Replaces the Initech spreadsheet we inherited.',
        },
        { id: 'sl', name: 'Statline', status: 'active', engagement_kind: 'artifact' },
      ],
      projects: [
        { id: 'p1', name: 'Platform', client_id: 'll' },
        { id: 'p2', name: 'Platform', client_id: 'sl' },
      ],
      time_entries: [{ project_id: 'p1', hours: '4.00', billable: false }],
    });

    const b = await bindRoles();
    auditBinding(b);

    // Every one of the nine. auditBinding has already checked each has a reason and no
    // key; this is the list, so a role that started binding by accident is noticed.
    expect(b.missing.map((m) => m.role).sort()).toEqual(
      [
        'absent_client',
        'client_multi_project',
        'client_of_contact',
        'client_with_invoices',
        'client_with_project',
        'contact_at_client',
        'inactive_client',
        'passed_lead',
        'single_project',
      ].sort()
    );
    expect(Object.keys(b.roles).sort()).toEqual(['hours', 'money']);
  });

  it('names what was missing, in words that send the reader to the data', async () => {
    given({
      clients: [
        { id: 'll', name: 'Ledgerlight', status: 'active', engagement_kind: 'own_venture' },
        { id: 'sl', name: 'Statline', status: 'active', engagement_kind: 'artifact' },
      ],
      projects: [
        { id: 'p1', name: 'Platform', client_id: 'll' },
        { id: 'p2', name: 'Platform', client_id: 'sl' },
      ],
    });
    const b = await bound();
    const because = (role: string): string => b.missing.find((m) => m.role === role)?.because ?? '';

    // "assertion failed" sends you reading SQL; naming the collision sends you to the
    // rows that caused it.
    expect(because('single_project')).toContain('Platform is inside Platform');
    expect(because('passed_lead')).toContain('engagement_kind=passed');
    expect(because('client_of_contact')).toContain('contact_at_client');
  });

  it('degrades the money and hours facts rather than skipping, and says which trap is disarmed', async () => {
    given(empty());
    const b = await bound();

    expect(b.roles.money).toEqual({
      outstandingCents: '0',
      // Equal to the right answer with no void and no draft, so it is NOT armed:
      // forbidding a figure that is also correct would fail every correct run.
      naiveOutstandingCents: null,
      collectedCents: '0',
      voidCount: 0,
      draftCount: 0,
      voidInvoice: null,
      draftInvoice: null,
    });
    expect(dollarSpellings(b.roles.money?.naiveOutstandingCents)).toEqual([]);

    const warnings = b.warnings.join('\n');
    expect(warnings).toContain("status <> 'paid'");
    expect(warnings).toContain('No void invoice');
    expect(warnings).toContain('own venture');
  });

  it('throws rather than reporting a database failure as absent data', async () => {
    // Nine unbound roles, seventeen skips, exit 0. That is what a swallowed query error
    // would look like, and it reports an outage as a fixture problem — the exact
    // confusion the skip mechanism exists to end.
    given(seedShaped());
    h.throwOn = "engagement_kind = 'passed'";
    await expect(bindRoles()).rejects.toThrow(/connection terminated/i);
  });

  it('refuses to bind absent_client when the verification query returns no row', async () => {
    given(seedShaped());
    h.emptyOn = 'union all';
    // A check that could not be made is not a check that passed: binding the name
    // anyway is how the case ends up testing the opposite of its purpose.
    await expect(bindRoles()).rejects.toThrow(/refusing to bind absent_client/i);
  });

  it('refuses to bind money facts an aggregate could not have failed to return', async () => {
    given(seedShaped());
    h.emptyOn = 'as outstanding_cents';
    await expect(bindRoles()).rejects.toThrow(/invoice totals query returned no row/i);
  });

  it('refuses to bind hours facts an aggregate could not have failed to return', async () => {
    given(seedShaped());
    h.emptyOn = 'as total_hours';
    await expect(bindRoles()).rejects.toThrow(/hours query returned no row/i);
  });
});

describe('a passed lead is not a client with projects', () => {
  it('leaves both project roles unbound when only a passed lead has projects', async () => {
    given({
      clients: [
        { id: 'qr', name: 'Quillon Robotics', status: 'inactive', engagement_kind: 'passed' },
      ],
      projects: [
        { id: 'p1', name: 'Warehouse Robotics Scoping', client_id: 'qr' },
        { id: 'p2', name: 'Cell Layout Review', client_id: 'qr' },
      ],
    });
    const b = await bound();

    // The failure this catches: a binder filtering on "has projects" alone binds the
    // lead, and every lookup case then asks about a company that was never a client.
    expect(b.roles.client_with_project).toBeUndefined();
    expect(b.roles.client_multi_project).toBeUndefined();
    expect(b.roles.passed_lead).toBe('Quillon Robotics');
    // The project itself is still a fine target for a write.
    expect(b.roles.single_project).toBe('Cell Layout Review');
  });

  it('passes over a passed lead that would otherwise sort first', async () => {
    given({
      clients: [
        // Sorts first, has more projects, and is not a client. Every tie-break in the
        // binder's ORDER BY points at this row; only the WHERE keeps it out.
        { id: 'ab', name: 'Abbot Robotics', status: 'inactive', engagement_kind: 'passed' },
        { id: 'zc', name: 'Zenith Cargo', status: 'active', engagement_kind: 'client' },
      ],
      projects: [
        { id: 'p1', name: 'Abbot Scoping Call', client_id: 'ab' },
        { id: 'p2', name: 'Abbot Cell Review', client_id: 'ab' },
        { id: 'p3', name: 'Cargo Dispatch', client_id: 'zc' },
        { id: 'p4', name: 'Cargo Billing', client_id: 'zc' },
      ],
    });
    const b = await bound();

    expect(b.roles.client_with_project).toBe('Zenith Cargo');
    expect(b.roles.client_multi_project).toBe('Zenith Cargo');
  });

  it('does not let an inactive passed lead bind inactive_client', async () => {
    given({
      clients: [
        // Both passed leads in the seed are 'inactive' too, which is exactly why the
        // role needs both columns: "mark them inactive" must already be true of a
        // CLIENT, or the case is asking about a company that was never one.
        { id: 'qr', name: 'Quillon Robotics', status: 'inactive', engagement_kind: 'passed' },
        { id: 'hf', name: 'Halden Freight', status: 'active', engagement_kind: 'client' },
      ],
    });
    const b = await bound();

    expect(b.roles.inactive_client).toBeUndefined();
    expect(b.missing.find((m) => m.role === 'inactive_client')?.because).toContain(
      'engagement_kind=client'
    );
  });
});

describe('the contact pair', () => {
  const billedClient: ClientRow = {
    id: 'hf',
    name: 'Halden Freight',
    status: 'active',
    engagement_kind: 'client',
  };
  const unbilledClient: ClientRow = {
    id: 'ad',
    name: 'Ashgrove Dental Group',
    status: 'prospect',
    engagement_kind: 'client',
  };
  const oneInvoice: InvoiceRow[] = [
    { number: 'INV-1001', client_id: 'hf', status: 'open', amount_cents: '1000000' },
  ];

  it('prefers a contact whose client has invoices, over one that wins every other tie-break', async () => {
    given({
      clients: [unbilledClient, billedClient],
      // Alma is at a client with no invoices, sorts first on both remaining tie-breaks,
      // and is the primary contact. The private binder took the first contact carrying
      // a client_id and got away with it on row order alone.
      contacts: [
        { id: 'ct1', client_id: 'ad', first_name: 'Alma', last_name: 'Beck', is_primary: true },
        { id: 'ct2', client_id: 'hf', first_name: 'Zeke', last_name: 'Odom', is_primary: false },
      ],
      invoices: oneInvoice,
    });
    const b = await bound();

    expect(b.roles.contact_at_client).toBe('Zeke Odom');
    expect(b.roles.client_of_contact).toBe('Halden Freight');
    // Nothing weakened, so nothing to warn about.
    expect(b.warnings.join('\n')).not.toContain('contact_at_client');
  });

  it('falls back to an unbilled client rather than going unbound, and says the case got weaker', async () => {
    given({
      clients: [unbilledClient],
      contacts: [
        { id: 'ct1', client_id: 'ad', first_name: 'Priya', last_name: 'Nandra', is_primary: true },
      ],
    });
    const b = await bound();

    // Preferred in the ORDER BY, not required in the WHERE: "we have not billed them"
    // is a legitimate answer, and the composition is still worth exercising.
    expect(b.roles.contact_at_client).toBe('Priya Nandra');
    expect(b.roles.client_of_contact).toBe('Ashgrove Dental Group');
    expect(b.missing.map((m) => m.role)).not.toContain('contact_at_client');

    const warning = b.warnings.find((w) => w.includes('contact_at_client')) ?? '';
    expect(warning).toContain('Priya Nandra');
    expect(warning).toContain('Ashgrove Dental Group');
    expect(warning).toContain('NO invoices');
  });

  it('binds both ends or neither', async () => {
    // No contacts at all: the pair is the only place two roles come from one row, so it
    // is the only place half a binding is possible.
    given({ clients: [billedClient], invoices: oneInvoice });
    const b = await bound();

    expect(b.roles.contact_at_client).toBeUndefined();
    expect(b.roles.client_of_contact).toBeUndefined();
    expect(b.missing.map((m) => m.role)).toContain('contact_at_client');
    expect(b.missing.map((m) => m.role)).toContain('client_of_contact');
  });

  it('does not bind a contact whose client_id points at nothing', async () => {
    // contacts.client_id is nullable and the binder INNER JOINs: someone met at a
    // conference is a real row with no engagement to ask a two-hop question about.
    given({
      clients: [billedClient],
      contacts: [
        { id: 'ct1', client_id: null, first_name: 'Ida', last_name: 'Kerr' },
        { id: 'ct2', client_id: 'gone', first_name: 'Owen', last_name: 'Falk' },
      ],
      invoices: oneInvoice,
    });
    const b = await bound();

    expect(b.roles.contact_at_client).toBeUndefined();
    expect(b.roles.client_of_contact).toBeUndefined();
  });

  it('never binds an empty name, even in preference to a billed client', async () => {
    // The schema's CHECK on contacts.first_name makes this impossible in Postgres, so
    // the filter is belt and braces. The promise being asserted is the binder's, not
    // the schema's: a role is a non-empty string or it is unbound, because a question
    // reading "Who is our contact at Halden Freight?" with an empty name interpolated
    // is a case that runs and asserts nothing.
    given({
      clients: [billedClient, unbilledClient],
      contacts: [
        { id: 'ct1', client_id: 'hf', first_name: '', last_name: '', is_primary: true },
        { id: 'ct2', client_id: 'ad', first_name: 'Rosa', last_name: 'Pike' },
      ],
      invoices: oneInvoice,
    });
    const b = await bound();

    expect(b.roles.contact_at_client).toBe('Rosa Pike');
    expect(b.roles.client_of_contact).toBe('Ashgrove Dental Group');
  });
});

describe('absent_client', () => {
  const client = (over: Partial<ClientRow> = {}): ClientRow => ({
    id: 'hf',
    name: 'Halden Freight',
    status: 'active',
    engagement_kind: 'client',
    ...over,
  });

  /**
   * Every text column a lookup could reach. A mention anywhere is enough to make the
   * case test the opposite of its purpose — the agent finds something, answers about
   * it, and is failed for not admitting ignorance.
   */
  const hidingPlaces: Array<[string, Partial<Dataset>]> = [
    ['clients.name', { clients: [client({ name: 'Initech' })] }],
    ['clients.notes', { clients: [client({ notes: 'Referred to us by Initech.' })] }],
    [
      'projects.name',
      { clients: [client()], projects: [{ id: 'p1', name: 'Initech Migration', client_id: 'hf' }] },
    ],
    [
      'projects.description',
      {
        clients: [client()],
        projects: [
          { id: 'p1', name: 'Migration', client_id: 'hf', description: 'Port off Initech.' },
        ],
      },
    ],
    [
      'contacts.last_name',
      { clients: [client()], contacts: [{ id: 'ct1', client_id: 'hf', first_name: 'Bill', last_name: 'Initech' }] },
    ],
    [
      'contacts.notes',
      {
        clients: [client()],
        contacts: [{ id: 'ct1', client_id: 'hf', first_name: 'Bill', notes: 'Came from Initech.' }],
      },
    ],
    [
      'invoices.number',
      {
        clients: [client()],
        invoices: [{ number: 'INITECH-1', client_id: 'hf', status: 'open', amount_cents: '100' }],
      },
    ],
    [
      'invoices.notes',
      {
        clients: [client()],
        invoices: [
          {
            number: 'INV-1001',
            client_id: 'hf',
            status: 'open',
            amount_cents: '100',
            notes: 'Reissued after the Initech merger.',
          },
        ],
      },
    ],
    [
      'invoices.description',
      {
        clients: [client()],
        invoices: [
          {
            number: 'INV-1001',
            client_id: 'hf',
            status: 'open',
            amount_cents: '100',
            description: 'Initech data migration',
          },
        ],
      },
    ],
    [
      'time_entries.note',
      {
        clients: [client()],
        projects: [{ id: 'p1', name: 'Migration', client_id: 'hf' }],
        time_entries: [{ project_id: 'p1', hours: '1.00', billable: true, note: 'Initech export' }],
      },
    ],
  ];

  for (const [where, data] of hidingPlaces) {
    it(`goes unbound when the name appears in ${where}`, async () => {
      given(data);
      const b = await bound();

      expect(b.roles.absent_client).toBeUndefined();
      const because = b.missing.find((m) => m.role === 'absent_client')?.because ?? '';
      expect(because).toContain('Initech');
      // The count, because one stray mention and thirty are different problems.
      expect(because).toMatch(/1 place\(s\)/);
    });
  }

  it('goes unbound however the name is capitalised', async () => {
    given({ clients: [client({ notes: 'Migrated off INITECH last spring.' })] });
    const b = await bound();
    expect(b.roles.absent_client).toBeUndefined();
  });

  it('binds when the name appears in none of them', async () => {
    given({
      clients: [client({ notes: 'Regional trucking. Dana signs off on scope.' })],
      projects: [{ id: 'p1', name: 'Dispatch Rewrite', client_id: 'hf', description: 'Rewrite.' }],
      contacts: [{ id: 'ct1', client_id: 'hf', first_name: 'Dana', last_name: 'Ruiz' }],
      invoices: [
        {
          number: 'INV-1001',
          client_id: 'hf',
          status: 'open',
          amount_cents: '100',
          notes: 'Net 30.',
        },
      ],
      time_entries: [{ project_id: 'p1', hours: '1.00', billable: true, note: 'Dispatch work' }],
    });
    const b = await bound();
    expect(b.roles.absent_client).toBe('Initech');
  });
});

describe('describeBinding', () => {
  it('prints every role whether it bound or not', async () => {
    given({
      clients: [{ id: 'll', name: 'Ledgerlight', status: 'active', engagement_kind: 'own_venture' }],
    });
    const printed = describeBinding(await bound());

    // A binding that lists only what it found makes an unbound role invisible in
    // exactly the situation where it matters.
    for (const role of ROLES) expect(printed).toContain(role);
    expect(printed).toContain('unbound: no row has engagement_kind=passed');
  });

  it('prints what a case will actually have been asked about', async () => {
    given(seedShaped());
    const printed = describeBinding(await bound());

    // A run has to be reproducible from its own output: the records, the figures, and
    // the fact that the absent name was checked rather than assumed.
    expect(printed).toContain('Dana Ruiz');
    expect(printed).toContain('Dispatch Rewrite');
    expect(printed).toContain('Initech (verified absent');
    expect(printed).toContain('$33,300.00');
    expect(printed).toContain('$110,500.00');
    expect(printed).toContain('INV-1006');
    expect(printed).toContain('257.50h logged, 217.00h billable');
  });

  it('flags a warning as a warning', async () => {
    given(empty());
    const printed = describeBinding(await bound());
    // Marked, because a case that quietly checks less than it says it does is the
    // failure the whole file is about.
    expect(printed).toMatch(/^ {2}! /m);
    expect(printed).toContain('cannot be got wrong here');
  });
});

describe('the spellings a case asserts on', () => {
  it('offers every honest way to write a money figure', () => {
    const spellings = dollarSpellings('3330000');
    // ANY-of when required, all-forbidden when not. Generous in the first direction so
    // the case does not measure vocabulary; every spelling is another way to catch the
    // wrong figure in the second.
    expect(spellings).toEqual(
      expect.arrayContaining(['$33,300.00', '$33,300', '33,300', '33300', '3330000'])
    );
    expect(new Set(spellings).size).toBe(spellings.length);
    for (const s of spellings) expect(s).not.toBe('');
  });

  it('keeps the cents when there are cents', () => {
    expect(dollarSpellings('3330050')).toContain('$33,300.50');
    expect(dollarSpellings('3330050')).not.toContain('$33,300');
  });

  it('asserts nothing about a figure of zero', () => {
    // A tool with nothing to total says "no invoices on file" rather than printing
    // $0.00, so requiring '$0.00' would fail a correct answer.
    expect(dollarSpellings('0')).toEqual([]);
    expect(dollarSpellings(null)).toEqual([]);
    expect(dollarSpellings(undefined)).toEqual([]);
    expect(dollarSpellings('not a number')).toEqual([]);
    expect(hourSpellings('0.00')).toEqual([]);
    expect(hourSpellings(null)).toEqual([]);
    expect(hourSpellings(undefined)).toEqual([]);
  });

  it('writes hours as the tools print them, and as a person would', () => {
    expect(hourSpellings('40.50')).toEqual(expect.arrayContaining(['40.50h', '40.50', '40.5']));
  });

  it('forbids the total presented as the billable figure, and only when it is a lie', () => {
    const facts = {
      totalHours: '257.50',
      billableHours: '217.00',
      nonBillableHours: '40.50',
      neverBillableHours: '29.50',
    };
    expect(conflatedBillableSpellings(facts)).toEqual(['257.50h billable', '257.50 billable']);

    // Equal figures make the phrase TRUE, so forbidding it would fail every correct run
    // on a dataset where all work is billable.
    expect(
      conflatedBillableSpellings({ ...facts, billableHours: '257.50', nonBillableHours: '0.00' })
    ).toEqual([]);
    expect(conflatedBillableSpellings(undefined)).toEqual([]);
  });

  it('does not forbid a phrase that the right answer contains', () => {
    const facts = {
      totalHours: '257.50',
      billableHours: '217.00',
      nonBillableHours: '40.50',
      neverBillableHours: '29.50',
    };
    // `never-billable-hours-are-not-billed` requires a spelling of the non-billable
    // figure and forbids the conflation. If one contained the other the case could
    // never pass.
    for (const required of hourSpellings(facts.nonBillableHours)) {
      for (const forbidden of conflatedBillableSpellings(facts)) {
        expect(forbidden.includes(required)).toBe(false);
        expect(required.includes(forbidden)).toBe(false);
      }
    }
  });
});

describe('the fake this file is built on', () => {
  it('refuses a query it does not recognise', () => {
    given(seedShaped());
    // The guard that keeps every test above meaningful. A query added to bindRoles and
    // not to the fake would otherwise return no rows, which reads as "this dataset has
    // no such row" — nine roles unbound and every assertion here still green.
    expect(() => answer('SELECT something FROM somewhere', [])).toThrow(/does not recognise/i);
  });

  it('is asked ten questions and no more', async () => {
    given(seedShaped());
    await bound();
    // Eight lookups for nine roles (the contact pair is one query), plus money and
    // hours. The clash query runs only when single_project cannot bind, and a binding
    // that needed a second query per role would be spending a round trip nobody asked
    // for on every run.
    expect(h.calls).toHaveLength(10);
    expect(asked('string_agg')).toEqual([]);
  });
});

describe('what the fake assumed, asserted against the SQL', () => {
  beforeEach(async () => {
    given(seedShaped());
    await bindRoles();
  });

  it('sums outstanding on the status it means, not on the negation of another', () => {
    const money = asked('as outstanding_cents')[0].toLowerCase();
    // The trap the seed's void and draft rows exist for. If these two swapped, the
    // binder would report the wrong figure as right and forbid the right one.
    expect(money).toMatch(/filter \(where status = 'open'\), 0\)::text as outstanding_cents/);
    expect(money).toMatch(/filter \(where status <> 'paid'\), 0\)::text as naive_cents/);
    expect(money).toMatch(/filter \(where status = 'paid'\), 0\)::text as collected_cents/);
  });

  it('reads never-billable hours from the engagement, not from the entry', () => {
    const hours = asked('as total_hours')[0].toLowerCase();
    // Whether work can be billed to anybody is a fact about the client, two joins from
    // time_entries.billable, which is why no CHECK constraint can see the rule.
    expect(hours).toContain("engagement_kind in ('own_venture', 'artifact')");
    expect(hours).toContain('join projects p');
    expect(hours).toContain('join clients c');
  });

  it('casts every money and hours total to text', () => {
    // BIGINT and NUMERIC already arrive as strings from this driver. The cast says so
    // out loud, so a parser change elsewhere cannot turn a total into a float behind
    // the suite's back.
    for (const statement of [...asked('as outstanding_cents'), ...asked('as total_hours')]) {
      const casts = statement.match(/::text/g) ?? [];
      expect(casts.length).toBeGreaterThanOrEqual(3);
    }
  });

  it('checks the absent name against a parameter, never an interpolated string', () => {
    const check = h.calls.find((c) => probe(c.text).includes('union all'));
    expect(check?.params).toEqual(['%initech%']);
    expect(probe(check?.text ?? '')).not.toContain('initech');
  });
});
