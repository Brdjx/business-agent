/**
 * The world a case needs, described rather than assumed.
 *
 * ── The problem this replaces ──
 *
 * In the private suite fifteen of twenty-two cases named a real client outright —
 * "what is the status of <client>", "is <company> a client" — and one named a real
 * person. That coupling cost three things:
 *
 * **It cannot be handed to anyone.** The suite only ran against one database, and a
 * stranger cloning a public repository has none of those records.
 *
 * **It was silently fragile.** A case needs not only the name but the SHAPE — that
 * this client has several projects, that this one is a lead that was passed on.
 * Those are live, mutable facts. One case asserted a proposal for a client that had
 * since gone inactive, so the assertion could never hold, and it read as the agent
 * failing.
 *
 * **A failure meant two different things.** "The agent got this wrong" and "the data
 * this case needs is not there any more" arrived identically, and only one of them is
 * worth fixing.
 *
 * ── What replaces it ──
 *
 * A case declares the roles it needs, and `bindRoles` binds those roles to whatever
 * the database actually holds before anything runs. Same cases file, any dataset: the
 * synthetic seed in `db/900-seed.sql`, or your own records.
 *
 * A role that cannot be bound SKIPS its cases, with a sentence saying what was
 * missing — never fails them. That is the runner's job; this file's job is to produce
 * the sentence.
 *
 * ── This file and `scripts/assert-roles.sql` are one decision in two languages ──
 *
 * Each binding query below is the same predicate as the matching block in
 * `scripts/assert-roles.sql`, which is what `npm run db:check` runs. That is the
 * point of having both: db:check tells you which cases would silently skip BEFORE
 * you spend a suite's worth of model calls finding out. If you change a predicate
 * here, change it there, or db:check stops predicting what the suite will do.
 *
 * Where the two are allowed to differ is the tie-break — which of several qualifying
 * rows is picked. This file orders explicitly (see below); the SQL file takes
 * whichever row comes back first, because it only needs to know that one exists.
 *
 * ── Two things the private version got wrong ──
 *
 * `contact_at_client` and `client_of_contact` bind as a PAIR, preferring a contact
 * whose client has invoices. The private binder took the first contact with a
 * client_id and got away with it on row order alone.
 *
 * `absent_client` is verified absent across every text column a lookup could reach,
 * not just `clients.name`. A mention in a note is enough to make that case test the
 * opposite of its purpose.
 *
 * ── Read-only, and it does not swallow a broken query ──
 *
 * Nothing here writes. A suite that mutated the data it measures would measure what
 * an earlier run left behind.
 *
 * A failed QUERY is not an unbound role, and this file lets it throw. Turning a
 * database error into nine unbound roles would skip every case, print "0 passed, 16
 * skipped for missing data", and exit successfully — reporting an outage as a
 * fixture problem, which is precisely the confusion the skip mechanism exists to
 * end.
 *
 * The business tables have no `user_id` column in this schema (see `src/db.ts`), so
 * there is no operator scope to pass here. The `agent_*` tables do, and the runner
 * scopes those.
 */

// Only `one`: every query here asks for a single row, and a role is a row or it is
// unbound. `one` returns null rather than throwing on a miss, which is exactly the
// difference between "this dataset has no passed lead" and "the query failed" — the
// second still throws, and must (see the note above).
import { one } from '../../db';

/**
 * What a case can ask for. Each is a shape, never a name.
 *
 * Deliberately nine, and the same nine as `scripts/assert-roles.sql`. Every role is
 * meant to be load-bearing for more than one case; a role invented for one case is a
 * fixture with extra steps.
 */
export type Role =
  /** A client with more than one project, so an ambiguous write has to ask which. */
  | 'client_multi_project'
  /** Any client with at least one project, for plain lookup. */
  | 'client_with_project'
  /** Took a call, never became a client. The distinction the schema exists for. */
  | 'passed_lead'
  /** A client whose status is inactive, so "mark them inactive" is already true. */
  | 'inactive_client'
  /** A client with invoices, so an answer about money has rows to rest on. */
  | 'client_with_invoices'
  /** A contact who works at a client. */
  | 'contact_at_client'
  /**
   * The client that contact works at. Bound TOGETHER with the contact, because a
   * case that needs both ends of one edge cannot bind them independently: that asks
   * about a person and a company with nothing between them, and the case then fails
   * for being unanswerable rather than for the agent being wrong.
   */
  | 'client_of_contact'
  /** A project name a write can resolve unambiguously. */
  | 'single_project'
  /** A name that must match nothing, so "I don't know" can be tested. */
  | 'absent_client';

/**
 * The nine, in the order a binding is printed.
 *
 * The two type-level lines below are the guard that keeps this list and the union in
 * step. `satisfies` catches a typo or an invented role; the `Exclude` check catches a
 * role added to the union and forgotten here — which would otherwise bind fine and
 * simply never appear in the printed binding, where nobody would miss it.
 */
export const ROLES = [
  'client_multi_project',
  'client_with_project',
  'passed_lead',
  'inactive_client',
  'client_with_invoices',
  'contact_at_client',
  'client_of_contact',
  'single_project',
  'absent_client',
] as const satisfies readonly Role[];

type RoleNotListed = Exclude<Role, (typeof ROLES)[number]>;
/** A compile error here means a Role was added to the union and not to ROLES. */
const _everyRoleIsListed: RoleNotListed extends never ? true : never = true;
void _everyRoleIsListed;

/**
 * Money as the binder read it, so a case can assert on a figure without hardcoding
 * one.
 *
 * NOT a role, for the same reason `scripts/assert-roles.sql` keeps its money block
 * separate: no case is skipped for want of an invoice. It is the same class of
 * silent failure though — the seed carries a void invoice and a draft specifically
 * so that a total written as `status <> 'paid'` is caught, and if either row goes
 * missing that trap is disarmed while the case still reports a pass.
 *
 * Cents arrive from the driver as STRINGS (BIGINT; see `src/db.ts`) and are kept as
 * strings here. Nothing in this file adds money up.
 */
export interface MoneyFacts {
  /** `status = 'open'`. The figure a correct answer reports as outstanding. */
  outstandingCents: string;
  /**
   * `status <> 'paid'`. What a total written the obvious wrong way returns, because
   * it swallows a voided invoice that was reissued and a draft that was never sent.
   *
   * Null when it equals the correct figure — a dataset with no void and no draft
   * disarms the trap, and forbidding a figure that is also the right answer would
   * fail every correct run.
   */
  naiveOutstandingCents: string | null;
  /** `status = 'paid'`. */
  collectedCents: string;
  voidCount: number;
  draftCount: number;
  /**
   * One invoice number per status, so a case about a void invoice can name a row
   * without a record being written into the case file. Null when none exists, and
   * the case that uses it then asks a weaker question rather than being skipped —
   * there is no role for "an invoice that was voided", and inventing a tenth role
   * for one case is the fixture-with-extra-steps this design exists to avoid.
   */
  voidInvoice: string | null;
  draftInvoice: string | null;
}

/**
 * Hours as the binder read it. `time_entries.hours` is NUMERIC(5,2), so these arrive
 * as strings like '257.50' and stay that way.
 */
export interface HoursFacts {
  totalHours: string;
  billableHours: string;
  nonBillableHours: string;
  /**
   * Hours against an `own_venture` or an `artifact`: work with nobody to charge, two
   * joins away from `time_entries.billable`, which is why no CHECK constraint can
   * see the rule and the write tool owns it outright.
   */
  neverBillableHours: string;
}

/**
 * What the roles bound to, plus the figures above.
 *
 * The whole object is what a case's `question` and expectation functions receive, and
 * what the runner stores verbatim in `agent_eval_suites.roles` — so a failure read a
 * month later says which records the case was asked about AND which figures the
 * assertions were built from. Without the second half, "expected the outstanding
 * total" is not a debuggable sentence.
 */
export interface Bound extends Partial<Record<Role, string>> {
  money?: MoneyFacts;
  hours?: HoursFacts;
}

export interface Binding {
  roles: Bound;
  /** Roles that could not be filled, and why, for the runner to report per case. */
  missing: Array<{ role: Role; because: string }>;
  /**
   * Things that are not unbound roles and still weaken the suite: a binding that
   * fell back to a worse row, a trap in the data that is disarmed. Printed with the
   * binding, because a case that quietly checks less than it says it does is the
   * failure this whole file is about.
   */
  warnings: string[];
}

/**
 * A name no dataset should contain.
 *
 * Fixed rather than derived. The case is that the agent admits it does not know, and
 * a name chosen by looking at the data could accidentally exist — while a name
 * derived to be absent would drift every time the data changed, so two runs would be
 * testing different questions.
 */
const ABSENT = 'Initech';

/* ─── how a figure is spelled, so a case can assert on one ─── */

/**
 * The same formatter the read tools use.
 *
 * A third copy of these four lines (`read.ts` and `write.ts` have the others), and
 * deliberately not imported: the tools' formatter is private to them, and the suite's
 * job is to check what a reader sees rather than to share the code that produced it.
 * The cost is that a change to the tools' formatting shows up here as a failing
 * money case, which is the right direction for it to show up in — the spellings
 * below include the raw cent count precisely so that a formatting change does not
 * fail a run on its own.
 */
const USD = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const unique = (xs: string[]): string[] => [...new Set(xs.filter((x) => x.length > 0))];

/**
 * Every honest way an answer might write one money figure.
 *
 * Used two ways, and the direction matters:
 *
 * As `expectContains` (ANY-of), a generous list is what stops the case measuring
 * vocabulary — `$33,300.00`, `$33,300` and `3330000 cents` are the same statement.
 *
 * As `expectAbsent` (all forbidden), each spelling is another way for the wrong
 * figure to be caught. The residual risk is a dataset where the wrong figure happens
 * to equal some other figure an answer legitimately quotes; nothing here can detect
 * that, and it is why the naive total is only armed when it differs from the right
 * one.
 *
 * A zero yields NO spellings, on purpose. A tool with nothing to total says "no
 * invoices on file" rather than printing `$0.00`, so asserting on `$0.00` would fail
 * a correct answer.
 *
 * The spellings overlap on purpose ('40800' is inside '4080000'), so one wrong figure
 * can report as two failed assertions. That is noise in a failure list rather than a
 * second finding, and it is cheaper than choosing which spelling to go without.
 */
export function dollarSpellings(cents: string | null | undefined): string[] {
  if (cents === null || cents === undefined) return [];
  const n = Number(cents);
  if (!Number.isFinite(n) || n === 0) return [];

  const formatted = USD.format(n / 100); // $33,300.00
  const noCents = formatted.replace(/\.00$/, ''); // $33,300
  const bare = noCents.replace('$', ''); // 33,300
  const plain = bare.replace(/,/g, ''); // 33300
  return unique([formatted, noCents, bare, plain, String(cents)]);
}

/**
 * The same, for an hours figure as the tools print it (`40.50h`).
 *
 * The trimmed spelling ('40.5') is a substring of a longer number ('140.50'), so a
 * contains-assertion built from it can pass on the wrong figure. That is a false
 * PASS, not a false failure, and the alternative — refusing the spelling a person
 * would actually write — fails correct answers instead.
 */
export function hourSpellings(hours: string | null | undefined): string[] {
  if (hours === null || hours === undefined) return [];
  const n = Number(hours);
  if (!Number.isFinite(n) || n === 0) return [];
  return unique([`${n.toFixed(2)}h`, n.toFixed(2), String(n)]);
}

/**
 * The one conflation about hours worth forbidding: the TOTAL presented as the
 * billable figure.
 *
 * "257.50h billable" when 40.50h of it cannot be billed to anybody is the failure —
 * a figure that would be repeated into an invoice. It is safe to forbid as a
 * substring because no honest wording puts the total and the word "billable"
 * adjacent: a correct answer writes "257.50h logged, 217.00h billable".
 *
 * Empty when the two figures are equal, because then the phrase is TRUE and
 * forbidding it would fail every correct run on a dataset where all work is
 * billable.
 */
export function conflatedBillableSpellings(h: HoursFacts | undefined): string[] {
  if (!h) return [];
  const total = Number(h.totalHours);
  const billable = Number(h.billableHours);
  if (!Number.isFinite(total) || !Number.isFinite(billable) || total === billable) return [];
  return unique([`${total.toFixed(2)}h billable`, `${total.toFixed(2)} billable`]);
}

/* ─── the binding pass ─── */

/**
 * Bind every role against the live database.
 *
 * One pass, read-only, before any case runs. Sequential rather than concurrent: this
 * is a handful of indexed lookups against a local database once per suite, and the
 * cost of reading it in the order the roles are documented is worth more than the
 * milliseconds.
 *
 * Every query below orders explicitly. `scripts/assert-roles.sql` does not, because
 * it only asks whether a qualifying row exists — but a suite wants the SAME row on
 * two runs against the same data. Heap order is not a promise Postgres makes, and a
 * case that behaved differently on Tuesday is not debuggable if the binding may also
 * have moved. Which qualifying row is picked is otherwise irrelevant: that is what
 * makes it a role.
 */
export async function bindRoles(): Promise<Binding> {
  const roles: Bound = {};
  const missing: Array<{ role: Role; because: string }> = [];
  const warnings: string[] = [];
  const need = (role: Role, because: string): void => {
    missing.push({ role, because });
  };

  /* ---------- client_multi_project ---------- */
  // An ambiguous write has to ask WHICH project, so the case needs a client where
  // the question is genuinely ambiguous. `engagement_kind = 'client'` throughout:
  // a passed lead sometimes has project rows, and binding one as "a client with
  // projects" would make every lookup case assert about someone who was never a
  // client.
  const multi = await one<{ name: string }>(
    `SELECT c.name
       FROM clients c
      WHERE c.engagement_kind = 'client'
        AND (SELECT count(*) FROM projects p WHERE p.client_id = c.id) > 1
      ORDER BY c.name
      LIMIT 1`
  );
  if (multi) roles.client_multi_project = multi.name;
  else
    need(
      'client_multi_project',
      'no client with engagement_kind=client has more than one project, so nothing in ' +
        'this dataset makes an ambiguous write ambiguous'
    );

  /* ---------- client_with_project ---------- */
  const withProject = await one<{ name: string }>(
    `SELECT c.name
       FROM clients c
      WHERE c.engagement_kind = 'client'
        AND EXISTS (SELECT 1 FROM projects p WHERE p.client_id = c.id)
      ORDER BY c.name
      LIMIT 1`
  );
  if (withProject) roles.client_with_project = withProject.name;
  else need('client_with_project', 'no client with engagement_kind=client has any project');

  /* ---------- passed_lead ---------- */
  // The distinction the two-axis schema exists for: took a call, never became a
  // client. Without it nothing tests that a passed lead is not reported as one.
  const passed = await one<{ name: string }>(
    `SELECT name FROM clients WHERE engagement_kind = 'passed' ORDER BY name LIMIT 1`
  );
  if (passed) roles.passed_lead = passed.name;
  else need('passed_lead', 'no row has engagement_kind=passed');

  /* ---------- inactive_client ---------- */
  // BOTH columns. An inactive row that is not a client binds the wrong thing, which
  // is the confusion the two columns exist to prevent — the passed leads in the seed
  // are also 'inactive'.
  const inactive = await one<{ name: string }>(
    `SELECT name
       FROM clients
      WHERE status = 'inactive' AND engagement_kind = 'client'
      ORDER BY name
      LIMIT 1`
  );
  if (inactive) roles.inactive_client = inactive.name;
  else
    need(
      'inactive_client',
      'no row is status=inactive AND engagement_kind=client, so "mark them inactive" is ' +
        'not already true of anybody'
    );

  /* ---------- client_with_invoices ---------- */
  // Same condition as the SQL file: an invoice reachable from a named client. The
  // ordering prefers a client with OPEN invoices and then the most invoices, so the
  // case that asks for a client's invoices has rows to be itemized and cited. A
  // client whose every invoice is paid is still a valid binding — `invoice_summary`
  // itemizes only the open ones, so the answer would then rest on the client row
  // alone.
  const billed = await one<{ name: string }>(
    `SELECT c.name
       FROM clients c
       JOIN invoices i ON i.client_id = c.id
      GROUP BY c.id, c.name
      ORDER BY count(*) FILTER (WHERE i.status = 'open') DESC, count(*) DESC, c.name
      LIMIT 1`
  );
  if (billed) roles.client_with_invoices = billed.name;
  else need('client_with_invoices', 'no invoice is linked to a client');

  /* ---------- contact_at_client / client_of_contact ---------- */
  //
  // One query, because they are one binding. A case needing both ends of an edge
  // cannot have them chosen independently.
  //
  // `client_billed` is preferred in the ORDER BY rather than required in the WHERE:
  // a question about what has been billed to that contact's client has no answer at
  // a client with no invoices, and the case is weaker for it — but the composition
  // is still worth exercising, and "we have not billed them" is a legitimate answer.
  // The fallback is reported as a warning rather than passed over in silence.
  //
  // The private binder took the first contact carrying a client_id, which worked on
  // row order alone. The seed deliberately puts contacts on a passed lead and on a
  // prospect, neither of which is ever billed.
  const pair = await one<{ contact: string; client: string; client_billed: boolean }>(
    `SELECT btrim(coalesce(ct.first_name, '') || ' ' || coalesce(ct.last_name, '')) AS contact,
            c.name                                                                 AS client,
            EXISTS (SELECT 1 FROM invoices i WHERE i.client_id = c.id)             AS client_billed
       FROM contacts ct
       JOIN clients c ON c.id = ct.client_id
      WHERE btrim(coalesce(ct.first_name, '') || coalesce(ct.last_name, '')) <> ''
      -- Ordered by the output column rather than by repeating the sublink: one
      -- expression, so the preference cannot drift from the flag that reports it.
      ORDER BY client_billed DESC,
               -- coalesced, because DESC puts NULLs first in Postgres and an
               -- unflagged contact would then outrank the primary one.
               coalesce(ct.is_primary, false) DESC,
               c.name,
               contact
      LIMIT 1`
  );
  if (pair) {
    roles.contact_at_client = pair.contact;
    roles.client_of_contact = pair.client;
    if (!pair.client_billed) {
      warnings.push(
        `contact_at_client bound to ${pair.contact} at ${pair.client}, which has NO invoices. ` +
          'A case asking what was billed to that client is weaker than intended — the honest ' +
          'answer there is "nothing", so it can no longer tell a composition failure from an ' +
          'empty result.'
      );
    }
  } else {
    need('contact_at_client', 'no named contact is attached to a client that exists');
    need('client_of_contact', 'bound with contact_at_client, which could not be bound');
  }

  /* ---------- single_project ---------- */
  //
  // A project a write can name unambiguously. `log_time` resolves a project with
  // ILIKE '%phrase%' and refuses when more than one row matches, so a name contained
  // in another name makes the tool right to refuse and the case read as the agent
  // failing.
  //
  // Same predicate as the SQL file, and the same limitation: `p.name` goes into the
  // LIKE pattern unescaped, so a project whose name contains % or _ is judged by a
  // wider pattern than the one `log_time` actually uses (it escapes both). Left
  // identical on purpose — a binder that disagreed with `npm run db:check` about
  // which cases will skip is worse than a shared edge case.
  const single = await one<{ name: string }>(
    `SELECT p.name
       FROM projects p
      WHERE (SELECT count(*) FROM projects q
              WHERE lower(q.name) LIKE '%' || lower(p.name) || '%') = 1
      ORDER BY p.name
      LIMIT 1`
  );
  if (single) roles.single_project = single.name;
  else {
    // Names the collisions, because "every project name is a substring of another"
    // sends you reading SQL and "Platform is inside Platform v2" sends you to the
    // data.
    const clash = await one<{ pairs: string | null }>(
      `SELECT string_agg(DISTINCT a.name || ' is inside ' || b.name, '; ') AS pairs
         FROM projects a JOIN projects b ON a.id <> b.id
        WHERE lower(b.name) LIKE '%' || lower(a.name) || '%'`
    );
    need(
      'single_project',
      'every project name is a case-insensitive substring of another, so no write can resolve one' +
        (clash?.pairs ? ` (${clash.pairs})` : ' (and no project rows exist at all)')
    );
  }

  /* ---------- absent_client ---------- */
  //
  // Verified absent, across every text column a lookup could reach — not just
  // clients.name. A mention in a note is enough to make the case test the opposite
  // of its purpose.
  //
  // ABSENT is a literal in this file with no LIKE wildcards in it, so the pattern
  // needs no escaping. Escape it if that ever changes.
  const pattern = `%${ABSENT.toLowerCase()}%`;
  const hits = await one<{ hits: number }>(
    `SELECT count(*)::int AS hits FROM (
       SELECT 1 FROM clients
        WHERE lower(name) LIKE $1 OR lower(coalesce(notes, '')) LIKE $1
       UNION ALL
       SELECT 1 FROM projects
        WHERE lower(name) LIKE $1 OR lower(coalesce(description, '')) LIKE $1
       UNION ALL
       SELECT 1 FROM contacts
        WHERE lower(coalesce(first_name, '') || ' ' || coalesce(last_name, '') || ' ' ||
                    coalesce(notes, '')) LIKE $1
       UNION ALL
       SELECT 1 FROM invoices
        WHERE lower(number || ' ' || coalesce(description, '') || ' ' ||
                    coalesce(notes, '')) LIKE $1
       UNION ALL
       SELECT 1 FROM time_entries
        WHERE lower(coalesce(note, '')) LIKE $1
     ) found`,
    [pattern]
  );
  if (!hits) {
    // A check that cannot be made is not a check that passed. Binding the absent name
    // without having verified it is how the case ends up testing the opposite of its
    // purpose, so this throws rather than assuming the count was zero.
    throw new Error(
      `The query verifying that ${ABSENT} is absent returned no row, so nothing has been ` +
        'verified. Refusing to bind absent_client on an unchecked assumption.'
    );
  }
  if (hits.hits > 0) {
    need(
      'absent_client',
      `the name ${ABSENT} appears in ${hits.hits} place(s) in this dataset, so it cannot test ` +
        'whether the agent admits it does not know'
    );
  } else {
    roles.absent_client = ABSENT;
  }

  /* ---------- the money, and the trap in it ---------- */
  //
  // Not a role: no case skips for want of an invoice. Computed here so that a case
  // can assert on the RIGHT total and against the WRONG one without a number ever
  // being written into the cases file.
  const money = await one<{
    outstanding_cents: string;
    naive_cents: string;
    collected_cents: string;
    void_count: number;
    draft_count: number;
    void_invoice: string | null;
    draft_invoice: string | null;
  }>(
    // Cast to text explicitly. BIGINT already arrives as a string from this driver
    // and the cast says so out loud, so a parser change somewhere else cannot turn
    // these into floats behind the suite's back.
    `SELECT coalesce(sum(amount_cents) FILTER (WHERE status = 'open'), 0)::text   AS outstanding_cents,
            coalesce(sum(amount_cents) FILTER (WHERE status <> 'paid'), 0)::text  AS naive_cents,
            coalesce(sum(amount_cents) FILTER (WHERE status = 'paid'), 0)::text   AS collected_cents,
            (count(*) FILTER (WHERE status = 'void'))::int                        AS void_count,
            (count(*) FILTER (WHERE status = 'draft'))::int                       AS draft_count,
            (SELECT number FROM invoices WHERE status = 'void'  ORDER BY number LIMIT 1) AS void_invoice,
            (SELECT number FROM invoices WHERE status = 'draft' ORDER BY number LIMIT 1) AS draft_invoice
       FROM invoices`
  );
  if (!money) {
    // Thrown rather than warned about. An aggregate cannot return no row, so this
    // means the query is reading a shape this file does not understand — and every
    // money assertion built from it would be wrong. Bind time, before a single model
    // call has been paid for, is the cheapest place to find that out.
    throw new Error(
      'The invoice totals query returned no row, which an aggregate cannot mean as "no ' +
        'invoices". Refusing to bind money facts that would be asserted on.'
    );
  }

  const trapArmed = money.naive_cents !== money.outstanding_cents;
  roles.money = {
    outstandingCents: money.outstanding_cents,
    naiveOutstandingCents: trapArmed ? money.naive_cents : null,
    collectedCents: money.collected_cents,
    voidCount: money.void_count,
    draftCount: money.draft_count,
    voidInvoice: money.void_invoice,
    draftInvoice: money.draft_invoice,
  };
  if (!trapArmed) {
    warnings.push(
      'No void and no draft invoice, so a total written as `status <> \'paid\'` returns the ' +
        'right answer by luck. The case that catches that mistake still runs and can no longer ' +
        'fail on it.'
    );
  }
  if (!money.void_invoice) {
    warnings.push(
      'No void invoice, so the case about marking a void invoice paid asks a weaker question: ' +
        'it cannot name the row, and the agent may fail to find one at all.'
    );
  }

  /* ---------- the hours ---------- */
  const hours = await one<{
    total_hours: string;
    billable_hours: string;
    nonbillable_hours: string;
    never_billable_hours: string;
  }>(
    // NUMERIC, so these are strings too. The join to clients is what makes the last
    // column possible: whether work can be billed to anybody is a fact about the
    // engagement, two joins from `time_entries.billable`.
    `SELECT coalesce(sum(t.hours), 0)::text                                     AS total_hours,
            coalesce(sum(t.hours) FILTER (WHERE t.billable), 0)::text            AS billable_hours,
            coalesce(sum(t.hours) FILTER (WHERE NOT t.billable), 0)::text        AS nonbillable_hours,
            coalesce(sum(t.hours) FILTER (
              WHERE c.engagement_kind IN ('own_venture', 'artifact')
            ), 0)::text                                                          AS never_billable_hours
       FROM time_entries t
       JOIN projects p ON p.id = t.project_id
       JOIN clients  c ON c.id = p.client_id`
  );
  if (!hours) {
    throw new Error(
      'The hours query returned no row, which an aggregate cannot mean as "no time entries". ' +
        'Refusing to bind hours facts that would be asserted on.'
    );
  }
  roles.hours = {
    totalHours: hours.total_hours,
    billableHours: hours.billable_hours,
    nonBillableHours: hours.nonbillable_hours,
    neverBillableHours: hours.never_billable_hours,
  };
  if (Number(hours.never_billable_hours) === 0) {
    warnings.push(
      'No hours are logged against an own venture or an artifact, so nothing in this dataset ' +
        'exercises the rule that such work can never be billed to anyone.'
    );
  }

  return { roles, missing, warnings };
}

/* ─── printing it ─── */

/**
 * One line per role, then the figures, then the warnings.
 *
 * Printed at the top of every run and stored with the suite, so a run is reproducible
 * from its own output: if a case behaved oddly, this says which records it was
 * actually asked about and which figures its assertions were built from.
 *
 * Every role is printed whether or not it bound, in a fixed order. A binding that
 * only lists what it found makes an unbound role invisible in exactly the situation
 * where it matters.
 */
export function describeBinding(b: Binding): string {
  const pad = (s: string) => s.padEnd(22);
  const lines: string[] = [];

  for (const role of ROLES) {
    const value = b.roles[role];
    if (value === undefined) {
      const because = b.missing.find((m) => m.role === role)?.because ?? 'not bound';
      lines.push(`  ${pad(role)} — unbound: ${because}`);
    } else if (role === 'absent_client') {
      lines.push(
        `  ${pad(role)} ${value} (verified absent from every text column a lookup could reach)`
      );
    } else {
      lines.push(`  ${pad(role)} ${value}`);
    }
  }

  const m = b.roles.money;
  if (m) {
    lines.push(
      `  ${pad('money')} outstanding ${cash(m.outstandingCents)}, collected ${cash(m.collectedCents)}` +
        (m.naiveOutstandingCents
          ? `; a total written as status <> 'paid' would say ${cash(m.naiveOutstandingCents)} ` +
            `(${m.voidCount} void, ${m.draftCount} draft)`
          : '; no void or draft invoice, so that total cannot be got wrong here')
    );
    if (m.voidInvoice) lines.push(`  ${pad('void invoice')} ${m.voidInvoice}`);
    if (m.draftInvoice) lines.push(`  ${pad('draft invoice')} ${m.draftInvoice}`);
  }

  const h = b.roles.hours;
  if (h) {
    lines.push(
      `  ${pad('hours')} ${h.totalHours}h logged, ${h.billableHours}h billable, ` +
        `${h.nonBillableHours}h not, of which ${h.neverBillableHours}h can never be billed to anyone`
    );
  }

  for (const w of b.warnings) lines.push(`  ! ${w}`);

  return lines.join('\n');
}

/** A cent string as a person reads it, for the printout only. */
function cash(cents: string): string {
  const n = Number(cents);
  return Number.isFinite(n) ? USD.format(n / 100) : `${cents} cents (unreadable)`;
}
