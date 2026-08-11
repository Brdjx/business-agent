/**
 * The read tools: six lookups over the business, and the judgment that makes
 * their answers safe to repeat.
 *
 * None of them is registered here. That happens in `../registry`, by an explicit
 * call, and never as a side effect of an import — see that file for what the
 * side-effect version cost.
 *
 * Five rules run through every tool below. Each one is a failure that has
 * already happened in the system this is extracted from.
 *
 * - **A total is computed in Postgres.** A model handed fifteen rows and asked
 *   for a sum will produce one, confidently, and the wrongness is invisible.
 *   Every figure here comes back from a `SUM` with its own `FILTER`, and the
 *   tool says how many rows the total covered so a partial answer reads as
 *   partial.
 *
 * - **Nothing found is said out loud, as data.** An empty result returned as an
 *   empty string is how a model ends up calling the same tool three times hoping
 *   for a different answer. And "no invoices match that filter" invites the
 *   conclusion that there are no invoices, so a miss names the filter it applied
 *   and what is on file instead.
 *
 * - **A failed query must never be able to say "there is nothing".** No result
 *   here is coalesced to an empty list. `sql()` throws, `executeTool` turns the
 *   throw into an error result, and the model is told the lookup failed. The
 *   original shipped the opposite once: a broken join was read as `data ?? []`
 *   and the approval desk rendered blank, which is a statement about the
 *   business that a broken read is not entitled to make.
 *
 * - **The two columns are read together.** `engagement_kind` says what a
 *   relationship IS; `status` says where it stands. Neither alone answers "have
 *   we worked with X": filter on `engagement_kind = 'client'` and an intro call
 *   that never started counts as a past engagement; filter on `status` and a
 *   lead that was passed on counts as a client that went quiet. The predicate is
 *   written once, below, as `WORKED_WITH`.
 *
 * - **Money is integer cents until the moment it is printed.** `amount_cents` is
 *   BIGINT and arrives from the driver as a string, as does every `SUM` over it.
 *   Nothing here accumulates money in JS; the string is parsed once, at the point
 *   it is formatted.
 *
 * None of these reads is scoped by `ctx.userId`, and that is the schema rather
 * than an omission: the business tables have no `user_id` column at all (see
 * `db/001-business.sql`) and only the `agent_*` tables do. A read that filtered
 * on it would match nothing, and nothing reads as an empty business.
 */

// `../tools` is the FILE src/agent/tools.ts, not this directory. Both spellings
// exist because the tools live in a directory named after the module that gates
// them; file resolution wins, and there is deliberately no index.ts in here that
// would make the two genuinely ambiguous.
import { sql, one } from '../../db';
import {
  ToolError,
  asObject,
  requireString,
  optionalString,
  optionalInt,
  optionalEnum,
  optionalDate,
  type Evidence,
  type Tool,
} from '../tools';

/* ─── the predicates this schema turns on ─── */

/**
 * "Have we worked with them" — both columns, together.
 *
 * Defined once and interpolated into the queries that need it, because the
 * schema comment on `clients.engagement_kind` is emphatic that no single column
 * answers this and the way to get it wrong is to write half of it in one place
 * and all of it in another. `db/900-seed.sql` contains a `('client',
 * 'prospect')` row precisely so that the half-version is visibly wrong: an
 * intro call, nothing agreed, nothing billed.
 *
 * Unqualified on purpose — every query that uses it reads `clients` as its only
 * unaliased table.
 */
const WORKED_WITH = `engagement_kind = 'client' AND status IN ('active', 'inactive')`;

/**
 * Overdue is derived, never stored.
 *
 * An `overdue` column would need a nightly job to stay true, and on the morning
 * after that job first failed the agent would report yesterday's truth in the
 * present tense. So it is a status plus a date, and the date comparison happens
 * in Postgres against `CURRENT_DATE` rather than in JS against the process
 * clock: the two can disagree by a day, and "overdue" has to be one answer.
 *
 * `due_date IS NOT NULL` is not redundant. An open invoice with no due date is
 * outstanding and cannot be late — nobody was told when to pay — and `NULL <
 * CURRENT_DATE` is NULL, which a `NOT` would then turn into something a reader
 * has to reason about.
 *
 * These two constants are the only strings this file puts into SQL text. They
 * are literals from this source, not values from anywhere: every value is a
 * numbered parameter.
 */
const OVERDUE = `i.status = 'open' AND i.due_date IS NOT NULL AND i.due_date < CURRENT_DATE`;

/** Open, and not late: either not yet due, or never given a due date. */
const NOT_DUE = `i.status = 'open' AND (i.due_date IS NULL OR i.due_date >= CURRENT_DATE)`;

/* ─── engagement kinds and statuses ─── */

/** Business order, not alphabetical: what the studio did, then what it did not. */
const KINDS = ['client', 'passed', 'own_venture', 'artifact'] as const;
const CLIENT_STATUSES = ['active', 'inactive', 'prospect'] as const;
const PROJECT_STATUSES = ['active', 'completed', 'paused', 'cancelled'] as const;
const INVOICE_STATUSES = ['draft', 'open', 'paid', 'void'] as const;

/**
 * What each kind means, in the words the model must not get wrong.
 *
 * These travel with every group heading and every client line, because the
 * distinction is the whole reason the column exists and a bare enum value in a
 * list is an invitation to treat all five rows as the same sort of thing.
 */
const KIND_NOTE: Record<string, string> = {
  client: 'a real commercial relationship',
  passed:
    'took a call and never became a client — never count one as a client or as revenue',
  own_venture: "the studio's own — never billable, never revenue",
  artifact: 'built for another reason, such as a take-home — a record, not an engagement',
};

/** Why a particular row is, or is not, someone the studio has worked with. */
function workedWithNote(kind: string, status: string, worked: boolean): string {
  if (worked) return `YES — engagement_kind ${kind}, status ${status}.`;
  if (kind !== 'client') {
    return `NO — engagement_kind ${kind}: ${KIND_NOTE[kind] ?? 'not a client relationship'}.`;
  }
  return (
    `NO — a client relationship with status ${status}: it has not started. ` +
    'Nothing was agreed and nothing was billed.'
  );
}

/* ─── name lookups ─── */

/** A name lookup is a lookup, not a page of a table. */
const MAX_NAME_MATCHES = 5;

/** Enough projects for several matched clients without turning a lookup into a dump. */
const PROJECT_READ_CAP = 25;

/** How many names a miss may list back, so a misspelling is recoverable. */
const NAME_HINTS = 12;

/**
 * An ILIKE pattern from a string the model wrote.
 *
 * The value goes in as a parameter, so there is no injection to worry about —
 * but `%` and `_` are still wildcards to `LIKE`, and an unescaped `_` matches
 * any single character. That does not fail; it silently widens the lookup and
 * the extra match reads like a hit. Escaped with a backslash, which is `LIKE`'s
 * default escape character.
 *
 * No index serves a leading wildcard and none is expected to — see the note at
 * the end of `db/001-business.sql` on what is deliberately not indexed.
 */
function contains(needle: string): string {
  return `%${needle.replace(/[\\%_]/g, '\\$&')}%`;
}

/* ─── parsing what the driver hands back ─── */

const USD = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/**
 * A money value from Postgres, as a number of cents.
 *
 * `NULL` and `undefined` are refused rather than parsed, because `Number(null)`
 * is `0` and a total that could not be read is not a total of nothing. Every
 * query below coalesces its sums, so reaching this throw means the query was
 * edited and the shape moved — which is worth an error the tests can see, not a
 * confident `$0.00`.
 */
function toCents(value: unknown): number {
  if (value === null || value === undefined) {
    throw new ToolError(
      'A money total came back as NULL, which is not the same as zero. Refusing to report ' +
        'it as $0.00 — the query that produced it needs looking at.'
    );
  }
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new ToolError(`A money total came back unreadable: ${JSON.stringify(value)}.`);
  }
  return n;
}

/**
 * Cents, formatted for the model, and the raw count beside it.
 *
 * Both, deliberately. The formatted string is what the model should quote: asking
 * it to divide 3330000 by 100 is asking for arithmetic it is bad at, and a figure
 * wrong by a factor of a hundred is stated with exactly the same confidence as a
 * right one. The cent count is what makes the answer checkable against
 * `invoices.amount_cents` without anyone re-deriving it.
 *
 * The division by 100 happens here and nowhere else — after every sum, at the
 * point of display, which is the only place a float is safe.
 */
function money(cents: number): string {
  return `${USD.format(cents / 100)} (${cents} cents)`;
}

/** A single amount on an itemized line, where the cent count would be noise. */
function dollars(cents: number): string {
  return USD.format(cents / 100);
}

/** A rate per hour, or the fact that there isn't one. */
function rate(cents: unknown): string {
  if (cents === null || cents === undefined) {
    // NULL is not free work. A passed lead and an own venture have no rate, and
    // the schema chose NULL over 0 for exactly this reason.
    return 'no rate set';
  }
  return `${USD.format(toCents(cents) / 100)}/hour`;
}

/**
 * Hours from a `NUMERIC(5,2)` column or a `SUM` over one.
 *
 * Same rule as money: the driver hands back a string, it is parsed once here,
 * and nothing adds hours up in JS.
 */
function toHours(value: unknown): number {
  if (value === null || value === undefined) {
    throw new ToolError(
      'An hours total came back as NULL rather than zero. The query needs looking at ' +
        'before the number is reported.'
    );
  }
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new ToolError(`An hours total came back unreadable: ${JSON.stringify(value)}.`);
  }
  return n;
}

const fmtHours = (value: unknown) => `${toHours(value).toFixed(2)}h`;

/** Prose a person wrote, shortened. A label is for recognising a row, not reading it. */
function clip(value: unknown, max = 160): string {
  const s = String(value ?? '').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/* ─── what is on file, for when a filter matches nothing ─── */

type CensusRow = { engagement_kind: string; status: string; n: number };

/**
 * Every (kind, status) pair with its count, in one grouped query.
 *
 * One round trip rather than one count per kind, and it is the same query the
 * README suggests running by hand. The counts are the database's over the whole
 * table, so summing a few of these rows in JS is still counting the table — what
 * must never happen is a count taken from the rows that fit on the page, because
 * the model will repeat it as the size of the business.
 */
async function clientCensus(): Promise<CensusRow[]> {
  return sql<CensusRow>(
    `SELECT engagement_kind, status, (count(*))::int AS n
       FROM clients
      GROUP BY engagement_kind, status
      ORDER BY engagement_kind, status`
  );
}

const censusCount = (rows: CensusRow[], pred: (r: CensusRow) => boolean) =>
  rows.filter(pred).reduce((t, r) => t + r.n, 0);

/** "4 client, 2 passed, 1 own_venture" — kinds with rows, in business order. */
function censusByKind(rows: CensusRow[]): string {
  const known = KINDS.map((k) => k as string);
  const seen = [...new Set([...known, ...rows.map((r) => r.engagement_kind)])];
  return seen
    .map((k) => ({ k, n: censusCount(rows, (r) => r.engagement_kind === k) }))
    .filter((g) => g.n > 0)
    .map((g) => `${g.n} ${g.k}`)
    .join(', ');
}

type NameRow = { id: string; name: string; total: number };

/**
 * A few names, and how many there are in total.
 *
 * `count(*) OVER ()` is evaluated before `LIMIT`, so the total is the table's and
 * not the page's, in one query. Used only on the miss paths: a misspelling and an
 * empty table must not arrive at the model looking the same.
 */
async function clientNames(): Promise<NameRow[]> {
  return sql<NameRow>(
    `SELECT id, name, (count(*) OVER ())::int AS total
       FROM clients
      ORDER BY name
      LIMIT $1`,
    [NAME_HINTS]
  );
}

async function projectNames(): Promise<NameRow[]> {
  return sql<NameRow>(
    `SELECT id, name, (count(*) OVER ())::int AS total
       FROM projects
      ORDER BY name
      LIMIT $1`,
    [NAME_HINTS]
  );
}

/**
 * Evidence for the names a miss listed.
 *
 * The miss paths returned no evidence, which looked defensible — the answer is
 * that a name is ABSENT, and an absence has no row to cite. But the message also
 * hands the model every client name on file, and the model repeats them to the
 * operator as fact. So the answer did rest on records, and the CLI printed
 * "nothing above rests on a record; treat it as a claim" underneath eight true
 * names read straight out of the table.
 *
 * Under-reporting evidence is the safer direction to be wrong in, and it is still
 * wrong: the point of the evidence line is that it can be trusted in both
 * directions. Citing these rows also makes a name the model invented into the
 * listed set detectable, which is the specific failure this whole mechanism
 * exists to catch.
 */
function namesEvidence(table: 'clients' | 'projects', rows: NameRow[]): Evidence[] {
  return rows.map((r) => ({ table, id: r.id, label: r.name }));
}

/** What a miss says instead of nothing. */
function nothingNamed(kindOfThing: string, needle: string, onFile: NameRow[]): string {
  if (onFile.length === 0) {
    return (
      `No ${kindOfThing} matches "${needle}", and there are no ${kindOfThing} records on file ` +
      'at all. Say the table is empty — do not guess at a name.'
    );
  }
  const total = onFile[0].total;
  const names = onFile.map((r) => r.name).join(', ');
  return (
    `No ${kindOfThing} matches "${needle}". Nothing was computed. ` +
    `${total} ${kindOfThing} ${plural(total, 'record is', 'records are')} on file` +
    `${onFile.length < total ? `; the first ${onFile.length} by name are` : ', named'}: ${names}. ` +
    'A name that matches nothing is not an empty business: say plainly that no record of ' +
    'that name is on file, and do not guess which was meant.'
  );
}

/* ─── resolving a name to rows ─── */

type ClientRow = {
  id: string;
  name: string;
  status: string;
  engagement_kind: string;
  disposition: string | null;
  website: string | null;
  city: string | null;
  country: string | null;
  default_rate_cents: number | null;
  notes: string | null;
  worked_with: boolean;
};

/**
 * Clients whose name contains the needle.
 *
 * `worked_with` is computed in SQL from the shared predicate rather than
 * re-derived here from the two columns. That is the point of the constant: the
 * sentence the model reads and the filter `list_clients` applies cannot drift
 * apart into two different definitions of "client".
 *
 * Ordered by name length first, so the tightest containing match leads. That is
 * a display heuristic and nothing more — where picking the wrong row would
 * matter, the tool refuses instead of ordering more cleverly.
 */
async function clientsByName(needle: string, limit = MAX_NAME_MATCHES): Promise<ClientRow[]> {
  return sql<ClientRow>(
    `SELECT id, name, status, engagement_kind, disposition, website, city, country,
            default_rate_cents, notes,
            (${WORKED_WITH}) AS worked_with
       FROM clients
      WHERE name ILIKE $1
      ORDER BY length(name), name
      LIMIT $2`,
    [contains(needle), limit]
  );
}

type ProjectRow = {
  id: string;
  name: string;
  status: string;
  rate_cents: number | null;
  budget_hours: string | null;
  start_date: string | null;
  end_date: string | null;
  client_id: string;
  client_name: string;
  engagement_kind: string;
  client_status: string;
};

async function projectsByName(needle: string, limit = MAX_NAME_MATCHES): Promise<ProjectRow[]> {
  return sql<ProjectRow>(
    `SELECT p.id, p.name, p.status, p.rate_cents, p.budget_hours, p.start_date, p.end_date,
            c.id AS client_id, c.name AS client_name, c.engagement_kind,
            c.status AS client_status
       FROM projects p
       JOIN clients c ON c.id = p.client_id
      WHERE p.name ILIKE $1
      ORDER BY length(p.name), p.name
      LIMIT $2`,
    [contains(needle), limit]
  );
}

/**
 * The refusal a total owes an ambiguous name.
 *
 * `find_client` lists everything that matched and lets the model choose, because
 * a list attributes nothing. A tool that returns a *figure* cannot do that: hours
 * or money attributed to the wrong client is wrong in the way nobody thinks to
 * re-check, and picking the likeliest match is how it happens. So the tool says
 * what matched, computes nothing, and asks.
 */
function tooManyMatches(
  kindOfThing: string,
  needle: string,
  labels: string[]
): string {
  return (
    `"${needle}" matches ${labels.length} ${kindOfThing}: ${labels.join(', ')}. ` +
    'Nothing was computed. Ask which one is meant — a total against the wrong record is ' +
    'not something anyone will notice afterwards.'
  );
}

/** The distinguishing part of a project match, for the refusal above. */
const projectLabel = (p: ProjectRow) => `${p.name} (${p.client_name})`;

/* ─── invoices: the totals, in one query ─── */

type TotalsRow = {
  invoices: number;
  currencies: number;
  open_count: number;
  paid_count: number;
  void_count: number;
  draft_count: number;
  overdue_count: number;
  not_due_count: number;
  outstanding_cents: string;
  overdue_cents: string;
  not_due_cents: string;
  collected_cents: string;
  void_cents: string;
  draft_cents: string;
  first_paid_at: string | null;
  last_paid_at: string | null;
};

/**
 * Outstanding, collected and overdue, summed in Postgres.
 *
 * Every money line is a `SUM ... FILTER` on a status named positively, and that
 * is the load-bearing detail. Write the filter as `status <> 'paid'` — the
 * obvious spelling of "not yet collected" — and two rows in the seed are counted
 * as money someone owes: a void invoice that was billed to the wrong entity and
 * reissued, and a draft that was never sent. Neither is money. Both are reported
 * here as *excluded*, with their amounts, so the model can see why the lines do
 * not add up to the total on file instead of guessing at the difference.
 *
 * `collected` may be narrowed by a window on `paid_at` — the date the money
 * actually arrived, which is backdateable and is not `updated_at`. Nothing
 * narrows outstanding or overdue: money still owed is a present-tense fact and a
 * date window on it answers no question anyone asks.
 *
 * One row always comes back from an aggregate with no GROUP BY. A null row means
 * something other than "no invoices", so it raises rather than reporting zero.
 */
async function invoiceTotals(opts: {
  clientIds?: string[];
  paidFrom?: string;
  paidTo?: string;
}): Promise<TotalsRow> {
  const params: unknown[] = [];
  const paidWindow: string[] = [];

  if (opts.paidFrom) {
    params.push(opts.paidFrom);
    // Both sides are DATEs and the parameter is a 'YYYY-MM-DD' string, so there
    // is no time zone in the comparison to get wrong. That is why the schema
    // chose DATE over TIMESTAMPTZ, and why the driver is told to hand DATE back
    // as a string.
    paidWindow.push(`AND i.paid_at >= $${params.length}`);
  }
  if (opts.paidTo) {
    params.push(opts.paidTo);
    paidWindow.push(`AND i.paid_at <= $${params.length}`);
  }

  let scope = '';
  if (opts.clientIds) {
    params.push(opts.clientIds);
    scope = `WHERE i.client_id = ANY($${params.length}::uuid[])`;
  }

  const row = await one<TotalsRow>(
    `SELECT (count(*))::int                                              AS invoices,
            (count(DISTINCT i.currency))::int                            AS currencies,
            (count(*) FILTER (WHERE i.status = 'open'))::int              AS open_count,
            (count(*) FILTER (WHERE i.status = 'paid'))::int              AS paid_count,
            (count(*) FILTER (WHERE i.status = 'void'))::int              AS void_count,
            (count(*) FILTER (WHERE i.status = 'draft'))::int             AS draft_count,
            (count(*) FILTER (WHERE ${OVERDUE}))::int                     AS overdue_count,
            (count(*) FILTER (WHERE ${NOT_DUE}))::int                     AS not_due_count,
            coalesce(sum(i.amount_cents) FILTER (WHERE i.status = 'open'), 0)
                                                                          AS outstanding_cents,
            coalesce(sum(i.amount_cents) FILTER (WHERE ${OVERDUE}), 0)     AS overdue_cents,
            coalesce(sum(i.amount_cents) FILTER (WHERE ${NOT_DUE}), 0)     AS not_due_cents,
            coalesce(sum(i.amount_cents) FILTER (WHERE i.status = 'paid' ${paidWindow.join(' ')}), 0) AS collected_cents,
            coalesce(sum(i.amount_cents) FILTER (WHERE i.status = 'void'), 0)
                                                                          AS void_cents,
            coalesce(sum(i.amount_cents) FILTER (WHERE i.status = 'draft'), 0)
                                                                          AS draft_cents,
            min(i.paid_at) FILTER (WHERE i.status = 'paid')               AS first_paid_at,
            max(i.paid_at) FILTER (WHERE i.status = 'paid')               AS last_paid_at
       FROM invoices i
       ${scope}`,
    params
  );

  if (!row) {
    throw new ToolError(
      'The invoice totals query returned no row at all, which cannot mean "no invoices" — ' +
        'an aggregate always returns one. Report that the lookup failed rather than reporting $0.'
    );
  }
  return row;
}

/**
 * The money lines, worded once.
 *
 * `invoice_summary` and `client_invoices` both print these. Two renderers would
 * eventually disagree about which statuses a total covers, and the disagreement
 * would be invisible — both answers look like money.
 */
function renderTotals(
  t: TotalsRow,
  scope: string,
  window: { from?: string; to?: string }
): string[] {
  const lines: string[] = [];

  if (t.currencies > 1) {
    // Every seeded row is USD and the column exists so no total is printed
    // without a unit. If a second currency ever lands here, SUM over the column
    // stops meaning anything and nothing in this repo groups by it yet.
    lines.push(
      `WARNING: these invoices span ${t.currencies} currencies. The totals below add ` +
        'different units together and are not meaningful. Report that, and nothing else.'
    );
  }

  lines.push(`${t.invoices} invoice(s)${scope}.`);

  lines.push(
    `outstanding (status open): ${money(toCents(t.outstanding_cents))} across ` +
      `${t.open_count} invoice(s)`
  );
  lines.push(
    `  of which overdue (open, and due_date before today): ` +
      `${money(toCents(t.overdue_cents))} across ${t.overdue_count} invoice(s)`
  );
  lines.push(
    `  of which not yet due (or with no due date): ${money(toCents(t.not_due_cents))} across ` +
      `${t.not_due_count} invoice(s)`
  );

  const collected = `collected (status paid): ${money(toCents(t.collected_cents))}`;
  if (window.from || window.to) {
    lines.push(
      `${collected}, counting only money that arrived ` +
        `${window.from ? `on or after ${window.from}` : 'at any time'}` +
        `${window.to ? ` and on or before ${window.to}` : ''} ` +
        '(the window is on paid_at, the date the money arrived).'
    );
    lines.push(
      `  outstanding and overdue above are NOT windowed — they are as of today. ` +
        `${t.paid_count} invoice(s) are paid in total.`
    );
  } else {
    lines.push(
      `${collected} across ${t.paid_count} invoice(s)` +
        (t.first_paid_at && t.last_paid_at
          ? `, paid between ${t.first_paid_at} and ${t.last_paid_at}`
          : '')
    );
  }

  // Named, with amounts, rather than quietly dropped. A reader adding the lines
  // above and comparing them to the number of invoices needs to see where the
  // difference went, or they will assume one of the totals is wrong.
  const excluded: string[] = [];
  if (t.void_count > 0) {
    excluded.push(
      `${t.void_count} void (${dollars(toCents(t.void_cents))}) — voided, never owed`
    );
  }
  if (t.draft_count > 0) {
    excluded.push(
      `${t.draft_count} draft (${dollars(toCents(t.draft_cents))}) — never sent, so nobody owes it`
    );
  }
  if (excluded.length > 0) {
    lines.push(
      `excluded from every figure above: ${excluded.join('; ')}. Neither is money. A filter ` +
        "written as status <> 'paid' would count both as outstanding."
    );
  }

  return lines;
}

/* ─── invoices: the rows behind the totals ─── */

type InvoiceRow = {
  id: string;
  number: string;
  status: string;
  amount_cents: string;
  currency: string;
  description: string | null;
  issued_at: string | null;
  due_date: string | null;
  paid_at: string | null;
  client_id: string;
  client_name: string;
  is_overdue: boolean;
  days_overdue: number | null;
};

/**
 * Invoices, with lateness computed in the database.
 *
 * `days_overdue` is `CURRENT_DATE - due_date`, so "40 days overdue" is the
 * database's arithmetic on two DATEs rather than a subtraction of milliseconds in
 * a process that may be in another time zone.
 */
async function invoiceRows(
  where: string[],
  params: unknown[],
  order: string,
  limit: number
): Promise<InvoiceRow[]> {
  return sql<InvoiceRow>(
    `SELECT i.id, i.number, i.status, i.amount_cents, i.currency, i.description,
            i.issued_at, i.due_date, i.paid_at,
            c.id AS client_id, c.name AS client_name,
            (${OVERDUE}) AS is_overdue,
            CASE WHEN ${OVERDUE} THEN CURRENT_DATE - i.due_date END AS days_overdue
       FROM invoices i
       JOIN clients c ON c.id = i.client_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY ${order}
      LIMIT $${params.length + 1}`,
    [...params, limit]
  );
}

function renderInvoiceLine(r: InvoiceRow): string {
  const when =
    r.status === 'paid'
      ? `paid ${r.paid_at ?? 'date missing'}`
      : r.status === 'draft'
        ? 'never sent'
        : r.is_overdue
          ? `due ${r.due_date}, ${r.days_overdue} days overdue`
          : r.due_date
            ? `due ${r.due_date}`
            : 'no due date recorded, so it cannot be overdue';

  return (
    `  ${r.number} — ${r.client_name} — ${dollars(toCents(r.amount_cents))} — ` +
    `${r.status} — ${when}` +
    (r.description ? ` — ${clip(r.description, 80)}` : '')
  );
}

const invoiceEvidence = (rows: InvoiceRow[]): Evidence[] =>
  rows.map((r) => ({ table: 'invoices', id: r.id, label: r.number }));

/* ═══ find_client ═══ */

/**
 * The lookup every question about a named company starts from.
 *
 * It is deliberately the first tool, and it exists in this shape because of what
 * it is asked to settle. "Is Quillon Robotics a client?" is answerable only from
 * `engagement_kind` and `status` together, so the tool states the verdict
 * outright — computed by the same predicate `list_clients` filters on — rather
 * than printing two enum values and leaving the model to combine them.
 */
export const findClient: Tool = {
  name: 'find_client',
  description:
    'Find a client by name, or part of one. Returns each match with its status, ' +
    'engagement kind, disposition, rate, notes and projects, and says outright ' +
    'whether the studio has actually worked with them — which needs both ' +
    'engagement_kind and status, so do not infer it from one. Use this before ' +
    'answering anything about a named company, including whether it is a client ' +
    'at all. For money use invoice_summary or client_invoices; for hours use ' +
    'time_summary.',
  inputSchema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'The client name or a distinctive part of it, e.g. "Halden".',
      },
    },
    required: ['name'],
  },
  validate: (raw) => {
    const o = asObject(raw);
    return { name: requireString(o, 'name', { max: 120 }) };
  },
  run: async (args) => {
    const name = args.name as string;
    const matches = await clientsByName(name);

    if (matches.length === 0) {
      // Said as data, and with what does exist. An empty answer here is how a
      // model ends up calling the same tool again with the same spelling.
      const onFile = await clientNames();
      return {
        content: nothingNamed('client', name, onFile),
        evidence: namesEvidence('clients', onFile),
      };
    }

    // One query for the projects of every matched client, not one per client.
    const projects = await sql<ProjectRow>(
      `SELECT p.id, p.name, p.status, p.rate_cents, p.budget_hours, p.start_date, p.end_date,
              c.id AS client_id, c.name AS client_name, c.engagement_kind,
              c.status AS client_status
         FROM projects p
         JOIN clients c ON c.id = p.client_id
        WHERE p.client_id = ANY($1::uuid[])
        ORDER BY p.start_date DESC NULLS LAST, p.name
        LIMIT $2`,
      [matches.map((c) => c.id), PROJECT_READ_CAP]
    );

    const lines: string[] = [];
    const evidence: Evidence[] = [];

    if (matches.length > 1) {
      lines.push(
        `${matches.length} clients match "${name}" (at most ${MAX_NAME_MATCHES} are returned). ` +
          'All of them are below — do not merge them, and do not assume the first is the one meant.'
      );
      lines.push('');
    }

    for (const c of matches) {
      lines.push(
        `${c.name} — status ${c.status}, engagement_kind ${c.engagement_kind}` +
          (c.disposition ? `, ${c.disposition}` : '')
      );
      lines.push(
        `  worked with: ${workedWithNote(c.engagement_kind, c.status, c.worked_with)}`
      );

      const place = [c.city, c.country].filter(Boolean).join(', ');
      const about = [place, c.website ?? '', `default rate ${rate(c.default_rate_cents)}`].filter(
        Boolean
      );
      lines.push(`  ${about.join(' — ')}`);

      if (c.notes) {
        // Quotable, and outranked. A note is a memory of a fact; the columns
        // above are the fact, and the design rule is that where they disagree the
        // record wins and the disagreement is named rather than resolved quietly.
        lines.push(`  note (a person wrote this; the columns above outrank it): ${clip(c.notes)}`);
      }

      evidence.push({ table: 'clients', id: c.id, label: c.name });

      const mine = projects.filter((p) => p.client_id === c.id);
      if (mine.length === 0) {
        lines.push('  projects: none recorded');
      } else {
        lines.push(`  projects (${mine.length}):`);
        for (const p of mine) {
          // start_date, never created_at. created_at is when the row was typed —
          // a bulk import once made every project look as though it had started
          // the same afternoon, and the schema comment keeps that lesson.
          const span = p.start_date
            ? `started ${p.start_date}${p.end_date ? `, ended ${p.end_date}` : ', open'}`
            : 'no start date recorded';
          lines.push(
            `    ${p.name} — ${p.status} — ${span} — ${rate(p.rate_cents)} — ` +
              (p.budget_hours === null
                ? 'no budget set'
                : `budget ${fmtHours(p.budget_hours)}`)
          );
          evidence.push({ table: 'projects', id: p.id, label: p.name });
        }
      }
      lines.push('');
    }

    if (projects.length === PROJECT_READ_CAP) {
      lines.push(
        `NOTE: the project list was capped at ${PROJECT_READ_CAP} rows, so a client above may ` +
          'have more than is shown. Use list_projects for one client at a time.'
      );
    }

    return { content: lines.join('\n').trimEnd(), evidence };
  },
};

/* ═══ list_clients ═══ */

/**
 * List clients, and default to the true narrow answer.
 *
 * "Who have we worked with" is the most ordinary question this business gets,
 * and the way to answer it wrongly is to filter on one column. So the default
 * here is both: `engagement_kind = 'client' AND status IN ('active','inactive')`.
 * Everything else — the leads that were passed on, the studio's own venture, the
 * take-home, and the prospect whose relationship has not started — has to be
 * asked for by name, and the answer says what it left out and how many.
 */
export const listClients: Tool = {
  name: 'list_clients',
  description:
    'List client records. By default lists only the ones the studio has actually ' +
    'worked with: engagement_kind "client" AND status active or inactive. Leads ' +
    'that were passed on, the studio\'s own ventures, artifacts such as ' +
    'take-homes, and prospects whose relationship has not started are excluded ' +
    'and counted separately, because none of them is someone the studio worked ' +
    'for. Pass engagement_kind ("client", "passed", "own_venture", "artifact", or ' +
    '"all") and/or status ("active", "inactive", "prospect") to see those. Every ' +
    'count comes from the database, not from the rows shown.',
  inputSchema: {
    type: 'object',
    properties: {
      engagement_kind: {
        type: 'string',
        enum: [...KINDS, 'all'],
        description:
          'Which kind of record to list. Defaults to "client". "all" returns every ' +
          'kind, grouped. There is no "prospect" kind — a prospect is a client ' +
          'relationship with status "prospect".',
      },
      status: {
        type: 'string',
        enum: [...CLIENT_STATUSES],
        description:
          'Optional status filter: active, inactive, or prospect. There is no ' +
          '"lead" status. Passing nothing, with engagement_kind "client", means ' +
          'active and inactive only — the ones actually worked with.',
      },
      limit: { type: 'integer', description: 'Max records to itemize. Default 25.' },
    },
    required: [],
  },
  validate: (raw) => {
    const o = asObject(raw);
    const out: Record<string, unknown> = { limit: optionalInt(o, 'limit', { default: 25, max: 100 }) };

    const kind = optionalEnum(o, 'engagement_kind', [...KINDS, 'all'] as const);
    if (kind) out.engagement_kind = kind;

    const status = optionalEnum(o, 'status', CLIENT_STATUSES);
    if (status) out.status = status;

    return out;
  },
  run: async (args) => {
    const kind = (args.engagement_kind as string | undefined) ?? 'client';
    const status = args.status as string | undefined;
    const limit = args.limit as number;

    const where: string[] = [];
    const params: unknown[] = [];

    if (kind !== 'all') {
      params.push(kind);
      where.push(`engagement_kind = $${params.length}`);
    }
    if (status) {
      params.push(status);
      where.push(`status = $${params.length}`);
    } else if (kind === 'client') {
      // The second half of the predicate, and the reason this tool exists.
      // Without it, an intro call that never started is listed among the
      // engagements — which is precisely the row db/900-seed.sql adds on purpose.
      where.push(WORKED_WITH);
    }

    const rows = await sql<ClientRow>(
      `SELECT id, name, status, engagement_kind, disposition, website, city, country,
              default_rate_cents, notes,
              (${WORKED_WITH}) AS worked_with
         FROM clients
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY engagement_kind, name
        LIMIT $${params.length + 1}`,
      [...params, limit]
    );

    // Grouped counts over the whole table, so nothing below is a count of what
    // fit on the page.
    const census = await clientCensus();
    // The same three conditions as the WHERE above, in the same order, because a
    // count that describes a different filter than the list is worse than no
    // count: both look like facts about the same query.
    const inFilter = (r: CensusRow) =>
      (kind === 'all' || r.engagement_kind === kind) &&
      (status
        ? r.status === status
        : kind !== 'client' || r.status === 'active' || r.status === 'inactive');
    const matched = censusCount(census, inFilter);

    const filterWords =
      (kind === 'all' ? 'any engagement kind' : `engagement_kind "${kind}"`) +
      (status
        ? ` and status "${status}"`
        : kind === 'client'
          ? ' and status active or inactive'
          : '');

    if (rows.length === 0) {
      const breakdown = censusByKind(census);
      return {
        content:
          `No client record matches ${filterWords}. ` +
          (breakdown
            ? `On file there are: ${breakdown}. A filter matching nothing is not the same as ` +
              'having no clients — say which filter came up empty, and do not guess at names.'
            : 'There are no client records at all. Say the table is empty.'),
        evidence: [],
      };
    }

    const lines: string[] = [
      `${matched} client record(s) match ${filterWords}.`,
    ];

    if (kind === 'client' && !status) {
      const prospects = censusCount(
        census,
        (r) => r.engagement_kind === 'client' && r.status === 'prospect'
      );
      lines.push(
        'That filter is what "worked with" means here: both columns, together.' +
          (prospects > 0
            ? ` ${prospects} further client relationship(s) have status "prospect" and are NOT ` +
              'in this list — nothing agreed, nothing billed. Ask for status "prospect" to see them.'
            : '')
      );
      const others = KINDS.filter((k) => k !== 'client')
        .map((k) => ({ k, n: censusCount(census, (r) => r.engagement_kind === k) }))
        .filter((g) => g.n > 0);
      if (others.length > 0) {
        lines.push(
          `Also excluded, and on file: ${others.map((g) => `${g.n} ${g.k}`).join(', ')}. ` +
            'None of those is someone the studio worked for.'
        );
      }
    }

    // Known kinds first, then anything the data holds that the enum does not, so
    // an unexpected value is reported rather than silently dropped.
    const groups = [...new Set([...KINDS.map(String), ...rows.map((r) => r.engagement_kind)])];

    for (const k of groups) {
      const mine = rows.filter((r) => r.engagement_kind === k);
      if (mine.length === 0) continue;

      const total = censusCount(census, (r) => r.engagement_kind === k && inFilter(r));
      lines.push('');
      lines.push(`${k} — ${KIND_NOTE[k] ?? 'unrecognised engagement kind'} (${total} matching)`);
      lines.push(`  itemized (${mine.length} of ${total}):`);

      for (const c of mine) {
        const place = [c.city, c.country].filter(Boolean).join(', ');
        lines.push(
          `    ${c.name} — ${c.status}` +
            (c.disposition ? `, ${c.disposition}` : '') +
            (place ? ` — ${place}` : '')
        );
      }

      if (mine.length < total) {
        lines.push(
          `    (${total - mine.length} more not itemized; the count above is the database's ` +
            'and covers all of them)'
        );
      }
    }

    return {
      content: lines.join('\n'),
      evidence: rows.map((c) => ({ table: 'clients', id: c.id, label: c.name })),
    };
  },
};

/* ═══ list_projects ═══ */

/**
 * Projects, for one client or across the business.
 *
 * The client filter resolves a name to rows first rather than joining an ILIKE
 * into the project query, because the three answers are different and a join
 * collapses two of them: "no client of that name", "that client has no
 * projects", and a list. The second is a fact about a client; the first is a
 * fact about the question.
 */
export const listProjects: Tool = {
  name: 'list_projects',
  description:
    'List projects, either for one client (by name) or the most recent across ' +
    'the business. Returns each project with its status, rate, budget hours and ' +
    'the dates work began and ended, plus which client it belongs to and what ' +
    'kind of engagement that client is. Use this for "what are we working on" or ' +
    '"what projects does X have". For hours logged against a project use ' +
    'time_summary — this tool does not read time entries.',
  inputSchema: {
    type: 'object',
    properties: {
      client_name: {
        type: 'string',
        description: 'Optional. Only projects for clients whose name contains this.',
      },
      status: {
        type: 'string',
        enum: [...PROJECT_STATUSES],
        description: 'Optional status filter: active, completed, paused, cancelled.',
      },
      limit: { type: 'integer', description: 'Max projects to itemize. Default 20.' },
    },
    required: [],
  },
  validate: (raw) => {
    const o = asObject(raw);
    const out: Record<string, unknown> = { limit: optionalInt(o, 'limit', { default: 20, max: 100 }) };

    const clientName = optionalString(o, 'client_name', { max: 120 });
    if (clientName) out.client_name = clientName;

    const status = optionalEnum(o, 'status', PROJECT_STATUSES);
    if (status) out.status = status;

    return out;
  },
  run: async (args) => {
    const clientName = args.client_name as string | undefined;
    const status = args.status as string | undefined;
    const limit = args.limit as number;

    const where: string[] = [];
    const params: unknown[] = [];
    const evidence: Evidence[] = [];
    let scope = 'across the business';

    if (clientName) {
      const clients = await clientsByName(clientName);
      if (clients.length === 0) {
        const onFile = await clientNames();
        return {
          content: nothingNamed('client', clientName, onFile),
          evidence: namesEvidence('clients', onFile),
        };
      }
      params.push(clients.map((c) => c.id));
      where.push(`p.client_id = ANY($${params.length}::uuid[])`);
      scope = `for ${clients.map((c) => c.name).join(', ')}`;
      for (const c of clients) evidence.push({ table: 'clients', id: c.id, label: c.name });
    }

    if (status) {
      params.push(status);
      where.push(`p.status = $${params.length}`);
    }

    const rows = await sql<ProjectRow & { total: number }>(
      `SELECT p.id, p.name, p.status, p.rate_cents, p.budget_hours, p.start_date, p.end_date,
              c.id AS client_id, c.name AS client_name, c.engagement_kind,
              c.status AS client_status,
              (count(*) OVER ())::int AS total
         FROM projects p
         JOIN clients c ON c.id = p.client_id
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY p.start_date DESC NULLS LAST, p.name
        LIMIT $${params.length + 1}`,
      [...params, limit]
    );

    if (rows.length === 0) {
      const onFile = await projectNames();
      const total = onFile[0]?.total ?? 0;
      return {
        content:
          `No project is on file ${scope}${status ? ` with status "${status}"` : ''}. ` +
          (total === 0
            ? 'There are no projects on file at all. Say the table is empty.'
            : `${total} project(s) are on file overall, including: ` +
              `${onFile.map((r) => r.name).join(', ')}. A filter matching nothing is not an ` +
              'empty business — say which filter came up empty.'),
        evidence,
      };
    }

    // The window count, which survives the LIMIT.
    const matched = rows[0].total;
    const lines: string[] = [
      `${matched} project(s) ${scope}${status ? `, status "${status}"` : ''}.`,
      `itemized (${rows.length} of ${matched}), most recently started first:`,
    ];

    for (const p of rows) {
      const span = p.start_date
        ? `${p.start_date} to ${p.end_date ?? 'open'}`
        : 'no start date recorded';
      // Flagged on the project line, because the hours and any money attached to
      // a project inherit what kind of engagement its client is.
      const kindNote =
        p.engagement_kind === 'client' ? '' : ` — ${KIND_NOTE[p.engagement_kind] ?? p.engagement_kind}`;

      lines.push(
        `  ${p.name} — ${p.status} — ${p.client_name} (${p.engagement_kind}, ` +
          `${p.client_status})${kindNote} — ${span} — ${rate(p.rate_cents)} — ` +
          (p.budget_hours === null
            ? 'no budget set (which is not a budget of 0.00h — nobody agreed one)'
            : `budget ${fmtHours(p.budget_hours)}`)
      );
      evidence.push({ table: 'projects', id: p.id, label: p.name });
    }

    if (rows.length < matched) {
      lines.push(
        `  (${matched - rows.length} more not itemized; the count above is the database's ` +
          `and covers all ${matched})`
      );
    }

    return { content: lines.join('\n'), evidence };
  },
};

/* ═══ invoice_summary ═══ */

/**
 * The money question, answered in SQL.
 *
 * Invoices are the clearest case for a tool over retrieval: they carry no
 * embedding, so a vector index cannot see them at all, and what anyone wants is
 * a total. The three figures are computed by `invoiceTotals` and the open
 * invoices are itemized oldest-due first, because "who owes us" is the question
 * behind the number.
 */
export const invoiceSummary: Tool = {
  name: 'invoice_summary',
  description:
    'Invoice totals computed in the database: outstanding (open), overdue (open ' +
    'and past its due date), and collected (paid). Void and draft invoices are ' +
    'excluded from every total and reported separately, because a void invoice ' +
    'was never owed and a draft was never sent. Optionally narrow to one client, ' +
    'or narrow the collected figure to a window on paid_at. Itemizes the open ' +
    'invoices, oldest due first. Use this for any question about amounts, money ' +
    'owed, overdue money or revenue — never add invoices up yourself.',
  inputSchema: {
    type: 'object',
    properties: {
      client_name: {
        type: 'string',
        description: 'Optional. Only invoices for clients whose name contains this.',
      },
      paid_from: {
        type: 'string',
        description:
          'Optional YYYY-MM-DD. Narrows the COLLECTED figure to money that arrived on or ' +
          'after this date. Outstanding and overdue are always as of today.',
      },
      paid_to: {
        type: 'string',
        description: 'Optional YYYY-MM-DD. The other end of the collected window.',
      },
      limit: { type: 'integer', description: 'Max open invoices to itemize. Default 10.' },
    },
    required: [],
  },
  validate: (raw) => {
    const o = asObject(raw);
    const out: Record<string, unknown> = { limit: optionalInt(o, 'limit', { default: 10, max: 50 }) };

    const clientName = optionalString(o, 'client_name', { max: 120 });
    if (clientName) out.client_name = clientName;

    const from = optionalDate(o, 'paid_from');
    const to = optionalDate(o, 'paid_to');
    if (from && to && from > to) {
      // Comparable as strings because they are 'YYYY-MM-DD'. Refused rather than
      // swapped: a window that cannot contain anything would return $0.00
      // collected, and a zero that came from a typo is indistinguishable from a
      // quarter with no income.
      throw new ToolError(
        `"paid_from" (${from}) is after "paid_to" (${to}), so the window is empty. ` +
          'Swap them if that was a typo.'
      );
    }
    if (from) out.paid_from = from;
    if (to) out.paid_to = to;

    return out;
  },
  run: async (args) => {
    const clientName = args.client_name as string | undefined;
    const paidFrom = args.paid_from as string | undefined;
    const paidTo = args.paid_to as string | undefined;
    const limit = args.limit as number;

    const evidence: Evidence[] = [];
    let clientIds: string[] | undefined;
    let scope = '';

    if (clientName) {
      const clients = await clientsByName(clientName);
      if (clients.length === 0) {
        const onFile = await clientNames();
        return {
          content: nothingNamed('client', clientName, onFile),
          evidence: namesEvidence('clients', onFile),
        };
      }
      clientIds = clients.map((c) => c.id);
      scope = ` for ${clients.map((c) => c.name).join(', ')}`;
      for (const c of clients) evidence.push({ table: 'clients', id: c.id, label: c.name });
    }

    const totals = await invoiceTotals({ clientIds, paidFrom, paidTo });

    if (totals.invoices === 0) {
      // Two different facts, kept apart. A named client with no invoices is a
      // fact about that client — and for a passed lead or an own venture it is
      // the expected one, since neither has anyone to bill.
      const statuses = await sql<{ status: string; n: number }>(
        `SELECT status, (count(*))::int AS n FROM invoices GROUP BY status ORDER BY status`
      );
      const breakdown = statuses.map((r) => `${r.n} ${r.status}`).join(', ');
      return {
        content:
          `No invoices${scope || ' on file'}. ` +
          (clientName
            ? 'Nothing has been billed to them. That is not the same as owing nothing — ' +
              'there is no invoice at all. '
            : '') +
          (breakdown
            ? `Across the business the invoices on file are: ${breakdown}.`
            : 'There are no invoices on file at all.'),
        evidence,
      };
    }

    const lines = renderTotals(totals, scope || ' on file', { from: paidFrom, to: paidTo });

    // The open ones, because that is the actionable half of the answer.
    const where = [`i.status = 'open'`];
    const params: unknown[] = [];
    if (clientIds) {
      params.push(clientIds);
      where.push(`i.client_id = ANY($${params.length}::uuid[])`);
    }
    const open = await invoiceRows(
      where,
      params,
      // Nulls last so an open invoice with no due date does not lead a list
      // ordered by who is latest.
      '(i.due_date IS NULL), i.due_date, i.number',
      limit
    );

    if (open.length > 0) {
      lines.push('');
      lines.push(`open invoices, oldest due first (${open.length} of ${totals.open_count}):`);
      for (const r of open) lines.push(renderInvoiceLine(r));
      if (open.length < totals.open_count) {
        lines.push(
          `  (${totals.open_count - open.length} more not itemized; the totals above are ` +
            'database sums over all of them)'
        );
      }
      evidence.push(...invoiceEvidence(open));
    }

    return { content: lines.join('\n'), evidence };
  },
};

/* ═══ client_invoices ═══ */

/**
 * One client's invoices, individually.
 *
 * Ambiguity is refused here rather than listed. `invoice_summary` may span
 * several matched clients because it says whose totals it added; a list of
 * invoices under one heading cannot, and money attributed to the wrong company
 * is the error nobody re-checks.
 */
export const clientInvoices: Tool = {
  name: 'client_invoices',
  description:
    'The individual invoices for one client, with that client\'s outstanding, ' +
    'overdue and collected totals computed in the database. Optionally filter the ' +
    'itemized list by status (draft, open, paid, void); the totals always cover ' +
    'every invoice for the client. Use this when the question is about a specific ' +
    'client\'s invoices, or when a total needs its rows shown. If the name matches ' +
    'more than one client, nothing is computed and it asks which.',
  inputSchema: {
    type: 'object',
    properties: {
      client_name: {
        type: 'string',
        description: 'The client name or a distinctive part of it.',
      },
      status: {
        type: 'string',
        enum: [...INVOICE_STATUSES],
        description:
          'Optional. Narrows the itemized list only — the totals still cover every invoice.',
      },
      limit: { type: 'integer', description: 'Max invoices to itemize. Default 20.' },
    },
    required: ['client_name'],
  },
  validate: (raw) => {
    const o = asObject(raw);
    const out: Record<string, unknown> = {
      client_name: requireString(o, 'client_name', { max: 120 }),
      limit: optionalInt(o, 'limit', { default: 20, max: 100 }),
    };
    const status = optionalEnum(o, 'status', INVOICE_STATUSES);
    if (status) out.status = status;
    return out;
  },
  run: async (args) => {
    const clientName = args.client_name as string;
    const status = args.status as string | undefined;
    const limit = args.limit as number;

    const clients = await clientsByName(clientName);
    if (clients.length === 0) {
      const onFile = await clientNames();
        return {
          content: nothingNamed('client', clientName, onFile),
          evidence: namesEvidence('clients', onFile),
        };
    }
    if (clients.length > 1) {
      return {
        content: tooManyMatches('clients', clientName, clients.map((c) => c.name)),
        evidence: clients.map((c) => ({ table: 'clients', id: c.id, label: c.name })),
      };
    }

    const client = clients[0];
    const evidence: Evidence[] = [{ table: 'clients', id: client.id, label: client.name }];
    const totals = await invoiceTotals({ clientIds: [client.id] });

    if (totals.invoices === 0) {
      const why =
        client.engagement_kind === 'client'
          ? client.status === 'prospect'
            ? ' The relationship has not started, so there would be nothing to bill.'
            : ''
          : ` They are engagement_kind ${client.engagement_kind}: ` +
            `${KIND_NOTE[client.engagement_kind] ?? 'not a billable relationship'}, so an ` +
            'invoice would not be expected.';
      return {
        content:
          `${client.name} has no invoices on file at all.${why} Nothing was billed and ` +
          'nothing is owed — say that, rather than reporting a total of zero as though ' +
          'invoices had been summed.',
        evidence,
      };
    }

    const lines = renderTotals(totals, ` for ${client.name}`, {});

    const where = [`i.client_id = $1`];
    const params: unknown[] = [client.id];
    if (status) {
      params.push(status);
      where.push(`i.status = $${params.length}`);
    }
    const rows = await invoiceRows(
      where,
      params,
      // Issue order, newest first. A draft has no issue date and sorts last,
      // which is where something never sent belongs.
      'i.issued_at DESC NULLS LAST, i.number DESC',
      limit
    );

    lines.push('');
    if (rows.length === 0) {
      // The totals above already proved the client has invoices, so a filter
      // matching nothing must say so or it reads as no invoices at all.
      lines.push(
        `No invoice for ${client.name} has status "${status}". The totals above still stand — ` +
          'a filter matching nothing is not an absence of invoices.'
      );
      return { content: lines.join('\n'), evidence };
    }

    lines.push(
      `itemized (${rows.length}${status ? ` of the "${status}" invoices` : ` of ${totals.invoices}`}` +
        ', newest issued first):'
    );
    for (const r of rows) lines.push(renderInvoiceLine(r));
    if (status) {
      lines.push(
        `  the totals above cover ALL ${totals.invoices} invoice(s) for this client, not only ` +
          'these.'
      );
    }
    evidence.push(...invoiceEvidence(rows));

    return { content: lines.join('\n'), evidence };
  },
};

/* ═══ time_summary ═══ */

/** Enough projects to see where the hours went; more than this is reported as capped. */
const PROJECT_BREAKDOWN = 12;

type TimeTotalsRow = {
  entries: number;
  projects: number;
  total_hours: string;
  billable_hours: string;
  nonbillable_hours: string;
  first_entry: string | null;
  last_entry: string | null;
};

type TimeProjectRow = {
  project_id: string;
  project_name: string;
  project_status: string;
  budget_hours: string | null;
  client_id: string;
  client_name: string;
  engagement_kind: string;
  entries: number;
  total_hours: string;
  billable_hours: string;
  budget_pct: string | null;
};

type TimeEntryRow = {
  id: string;
  entry_date: string;
  hours: string;
  billable: boolean;
  note: string | null;
  project_name: string;
};

/**
 * The filter, built once and reused across the three queries this tool runs.
 *
 * Returned as text plus its own parameter array rather than shared mutable
 * state, because the miss path rebuilds it without the date window: parameters
 * are positional, so dropping a condition from the text while leaving its value
 * in the array makes Postgres reject the whole statement.
 */
function timeWhere(scope: {
  projectIds?: string[];
  clientIds?: string[];
  from?: string;
  to?: string;
}): { where: string; params: unknown[] } {
  const parts: string[] = [];
  const params: unknown[] = [];

  if (scope.projectIds) {
    params.push(scope.projectIds);
    parts.push(`t.project_id = ANY($${params.length}::uuid[])`);
  }
  if (scope.clientIds) {
    params.push(scope.clientIds);
    parts.push(`p.client_id = ANY($${params.length}::uuid[])`);
  }
  if (scope.from) {
    params.push(scope.from);
    parts.push(`t.entry_date >= $${params.length}`);
  }
  if (scope.to) {
    params.push(scope.to);
    parts.push(`t.entry_date <= $${params.length}`);
  }

  return { where: parts.length ? `WHERE ${parts.join(' AND ')}` : '', params };
}

/**
 * Hours logged, billable and not, with the budget comparison.
 *
 * `entry_date` and `hours` are the columns the questions are asked in — this
 * schema deliberately does not store a start/end pair and a duration in minutes,
 * so nothing here divides by 60 and no two call sites can round differently.
 *
 * There is no `billable_only` argument, on purpose. The private original had
 * one, and its own comment records the trap: with the filter on, "no time is
 * logged against this project" is false for a project whose hours simply are not
 * billable, which is a different fact and the one that answers the question.
 * Reporting both figures always removes the filter's reason to exist.
 *
 * It also does not multiply hours by a rate. Billable hours times a rate is not
 * money anyone owes — nothing has been agreed, sent or accepted — and a figure
 * that looks like revenue but appears in no invoice is the kind of number that
 * gets repeated. Money lives in `invoice_summary`.
 */
export const timeSummary: Tool = {
  name: 'time_summary',
  description:
    'Hours logged, from the time entries. Returns total hours, billable hours and ' +
    'non-billable hours, all summed in the database, broken down per project with ' +
    'hours against budget where a budget was agreed, plus the most recent entries. ' +
    'Narrow it to one project, to one client, and/or to a date window on the day ' +
    'the work happened. Use this for any question about hours, effort, or being ' +
    'over budget — never add time entries up yourself. It reports no money: hours ' +
    'times a rate is not money anyone owes.',
  inputSchema: {
    type: 'object',
    properties: {
      project_name: {
        type: 'string',
        description:
          'Optional. The project name or a distinctive part of it. If it matches more ' +
          'than one project, nothing is computed and it asks which.',
      },
      client_name: {
        type: 'string',
        description: 'Optional. Every project belonging to this client.',
      },
      from: {
        type: 'string',
        description: 'Optional YYYY-MM-DD. Only entries on or after this day.',
      },
      to: { type: 'string', description: 'Optional YYYY-MM-DD. Only entries on or before it.' },
      limit: { type: 'integer', description: 'Max individual entries to itemize. Default 5.' },
    },
    required: [],
  },
  validate: (raw) => {
    const o = asObject(raw);
    const out: Record<string, unknown> = { limit: optionalInt(o, 'limit', { default: 5, max: 25 }) };

    const projectName = optionalString(o, 'project_name', { max: 200 });
    if (projectName) out.project_name = projectName;

    const clientName = optionalString(o, 'client_name', { max: 120 });
    if (clientName) out.client_name = clientName;

    const from = optionalDate(o, 'from');
    const to = optionalDate(o, 'to');
    if (from && to && from > to) {
      throw new ToolError(
        `"from" (${from}) is after "to" (${to}), so the window is empty. Swap them if that ` +
          'was a typo.'
      );
    }
    if (from) out.from = from;
    if (to) out.to = to;

    return out;
  },
  run: async (args) => {
    const projectName = args.project_name as string | undefined;
    const clientName = args.client_name as string | undefined;
    const from = args.from as string | undefined;
    const to = args.to as string | undefined;
    const limit = args.limit as number;

    const evidence: Evidence[] = [];
    const scopeWords: string[] = [];
    let projectIds: string[] | undefined;
    let clientIds: string[] | undefined;

    if (projectName) {
      const matches = await projectsByName(projectName);
      if (matches.length === 0) {
        const onFile = await projectNames();
        return {
          content: nothingNamed('project', projectName, onFile),
          evidence: namesEvidence('projects', onFile),
        };
      }
      if (matches.length > 1) {
        return {
          content: tooManyMatches('projects', projectName, matches.map(projectLabel)),
          evidence: matches.map((p) => ({ table: 'projects', id: p.id, label: p.name })),
        };
      }
      projectIds = [matches[0].id];
      scopeWords.push(`project ${matches[0].name} (${matches[0].client_name})`);
      evidence.push({ table: 'projects', id: matches[0].id, label: matches[0].name });
    }

    if (clientName) {
      const clients = await clientsByName(clientName);
      if (clients.length === 0) {
        const onFile = await clientNames();
        return {
          content: nothingNamed('client', clientName, onFile),
          evidence: namesEvidence('clients', onFile),
        };
      }
      if (clients.length > 1) {
        return {
          content: tooManyMatches('clients', clientName, clients.map((c) => c.name)),
          evidence: clients.map((c) => ({ table: 'clients', id: c.id, label: c.name })),
        };
      }
      clientIds = [clients[0].id];
      scopeWords.push(`client ${clients[0].name}`);
      evidence.push({ table: 'clients', id: clients[0].id, label: clients[0].name });
    }

    if (from || to) {
      scopeWords.push(
        `entry_date ${from ? `from ${from}` : 'from the first entry'} ` +
          `${to ? `to ${to}` : 'to the most recent'}`
      );
    }
    const scope = scopeWords.length ? scopeWords.join(', ') : 'every project on file';

    const { where, params } = timeWhere({ projectIds, clientIds, from, to });

    const totals = await one<TimeTotalsRow>(
      `SELECT (count(*))::int                                              AS entries,
              (count(DISTINCT t.project_id))::int                          AS projects,
              coalesce(sum(t.hours), 0)                                    AS total_hours,
              coalesce(sum(t.hours) FILTER (WHERE t.billable), 0)           AS billable_hours,
              coalesce(sum(t.hours) FILTER (WHERE NOT t.billable), 0)       AS nonbillable_hours,
              min(t.entry_date)                                            AS first_entry,
              max(t.entry_date)                                            AS last_entry
         FROM time_entries t
         JOIN projects p ON p.id = t.project_id
         JOIN clients c ON c.id = p.client_id
        ${where}`,
      params
    );

    if (!totals) {
      throw new ToolError(
        'The hours query returned no row, which an aggregate cannot mean as "no entries". ' +
          'Report that the lookup failed rather than reporting 0.00h.'
      );
    }

    if (totals.entries === 0) {
      // A project that exists and has no hours, and a date window that happens
      // to be empty, are different answers. Only the second is worth another
      // call, so the miss says which one it is.
      const lines = [`No time entries match ${scope}: 0 entries, 0.00h.`];
      if (from || to) {
        const outside = timeWhere({ projectIds, clientIds });
        const all = await one<TimeTotalsRow>(
          `SELECT (count(*))::int AS entries,
                  (count(DISTINCT t.project_id))::int AS projects,
                  coalesce(sum(t.hours), 0) AS total_hours,
                  coalesce(sum(t.hours) FILTER (WHERE t.billable), 0) AS billable_hours,
                  coalesce(sum(t.hours) FILTER (WHERE NOT t.billable), 0) AS nonbillable_hours,
                  min(t.entry_date) AS first_entry,
                  max(t.entry_date) AS last_entry
             FROM time_entries t
             JOIN projects p ON p.id = t.project_id
             JOIN clients c ON c.id = p.client_id
            ${outside.where}`,
          outside.params
        );
        if (all && all.entries > 0) {
          lines.push(
            `${all.entries} entr${all.entries === 1 ? 'y' : 'ies'} totalling ` +
              `${fmtHours(all.total_hours)} exist outside that window, between ` +
              `${all.first_entry} and ${all.last_entry}. The WINDOW is empty, not the record.`
          );
        } else {
          lines.push('No entries exist outside the window either.');
        }
      }
      lines.push(
        'Do not estimate hours: no entry is not an estimate of work done, and untracked work ' +
          'is invisible here either way.'
      );
      return { content: lines.join('\n'), evidence };
    }

    const lines: string[] = [
      `Hours for ${scope}.`,
      `${totals.entries} time entr${totals.entries === 1 ? 'y' : 'ies'} across ` +
        `${totals.projects} project(s), ${totals.first_entry} to ${totals.last_entry}.`,
      `total: ${fmtHours(totals.total_hours)}`,
      `billable: ${fmtHours(totals.billable_hours)}`,
      `non-billable: ${fmtHours(totals.nonbillable_hours)}`,
    ];

    // Per project, summed and compared to budget in SQL. The percentage is
    // rounded by Postgres for the same reason the sums are taken there.
    const breakdown = await sql<TimeProjectRow>(
      `SELECT p.id AS project_id, p.name AS project_name, p.status AS project_status,
              p.budget_hours, c.id AS client_id, c.name AS client_name, c.engagement_kind,
              (count(*))::int                                              AS entries,
              sum(t.hours)                                                 AS total_hours,
              coalesce(sum(t.hours) FILTER (WHERE t.billable), 0)           AS billable_hours,
              CASE WHEN p.budget_hours > 0
                   THEN round(100 * sum(t.hours) / p.budget_hours, 1) END   AS budget_pct
         FROM time_entries t
         JOIN projects p ON p.id = t.project_id
         JOIN clients c ON c.id = p.client_id
        ${where}
        GROUP BY p.id, p.name, p.status, p.budget_hours, c.id, c.name, c.engagement_kind
        ORDER BY sum(t.hours) DESC, p.name
        LIMIT $${params.length + 1}`,
      [...params, PROJECT_BREAKDOWN]
    );

    lines.push('');
    lines.push(`by project (${breakdown.length} of ${totals.projects}):`);

    for (const p of breakdown) {
      const logged = toHours(p.total_hours);
      let budget: string;
      if (p.budget_hours === null) {
        // NULL and 0 are different facts and the schema comment says so: nobody
        // agreed a budget, versus a budget of zero every hour is over.
        budget = 'no budget agreed, so hours against budget cannot be computed';
      } else if (toHours(p.budget_hours) === 0) {
        budget = 'budget is 0.00h — not "no budget": every hour logged is over it';
      } else {
        const budgetHours = toHours(p.budget_hours);
        budget =
          logged > budgetHours
            ? `budget ${fmtHours(p.budget_hours)} — ${p.budget_pct}% used, OVER BUDGET by ` +
              `${(logged - budgetHours).toFixed(2)}h`
            : `budget ${fmtHours(p.budget_hours)} — ${p.budget_pct}% used, ` +
              `${(budgetHours - logged).toFixed(2)}h remaining`;
      }

      const kindNote =
        p.engagement_kind === 'own_venture' || p.engagement_kind === 'artifact'
          ? ` — ${KIND_NOTE[p.engagement_kind]}, so none of this can be billed to anyone`
          : p.engagement_kind === 'passed'
            ? ` — ${KIND_NOTE.passed}`
            : '';

      lines.push(
        `  ${p.project_name} (${p.project_status}) — ${p.client_name}${kindNote} — ` +
          `${p.entries} entr${p.entries === 1 ? 'y' : 'ies'}, ${fmtHours(p.total_hours)}, ` +
          `${fmtHours(p.billable_hours)} billable — ${budget}`
      );
      evidence.push({ table: 'projects', id: p.project_id, label: p.project_name });
    }

    if (breakdown.length < totals.projects) {
      lines.push(
        `  (${totals.projects - breakdown.length} more project(s) not shown; the totals above ` +
          'are database sums over all of them)'
      );
    }

    // A sample of the rows, so the total is checkable against records rather
    // than believed.
    const entries = await sql<TimeEntryRow>(
      `SELECT t.id, t.entry_date, t.hours, t.billable, t.note, p.name AS project_name
         FROM time_entries t
         JOIN projects p ON p.id = t.project_id
         JOIN clients c ON c.id = p.client_id
        ${where}
        ORDER BY t.entry_date DESC, t.id
        LIMIT $${params.length + 1}`,
      [...params, limit]
    );

    lines.push('');
    lines.push(`most recent entries (${entries.length} of ${totals.entries}):`);
    for (const e of entries) {
      lines.push(
        `  ${e.entry_date} — ${fmtHours(e.hours)} — ${e.billable ? 'billable' : 'non-billable'} — ` +
          `${e.project_name}${e.note ? ` — ${clip(e.note, 80)}` : ''}`
      );
      evidence.push({
        table: 'time_entries',
        id: e.id,
        label: `${e.entry_date} — ${fmtHours(e.hours)} — ${e.project_name}`,
      });
    }
    if (entries.length < totals.entries) {
      lines.push(
        `  (${totals.entries - entries.length} more not itemized; every total above is a ` +
          `database sum over all ${totals.entries})`
      );
    }

    return { content: lines.join('\n'), evidence };
  },
};

/**
 * What `../registry` registers.
 *
 * Exported as data rather than registered here: a module that registers itself
 * on import is a module whose registration a bundler is entitled to drop, and
 * that is exactly the failure `registry.ts` exists to describe.
 */
export const READ_TOOLS: Tool[] = [
  findClient,
  listClients,
  listProjects,
  invoiceSummary,
  clientInvoices,
  timeSummary,
];
