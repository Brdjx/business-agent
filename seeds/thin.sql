-- ============================================================
-- thin — one operator, two months in
--
-- A deliberately SPARSE business. Three clients, one project each, three
-- invoices, twelve time entries, and no contacts at all.
--
-- ── What this file is for ──
--
-- The suite claims that a role which cannot bind SKIPS its cases with a sentence
-- saying what was missing, rather than failing them, and that the skips are
-- recorded because a case that has been skipping for six weeks is a coverage gap
-- nobody is being told about. Nothing in this repository demonstrated that:
-- db/900-seed.sql binds all nine roles on purpose, so every run so far has had
-- zero skips and the skip path has never executed.
--
-- This dataset makes five roles unbindable, and it does it by ABSENCE — there is
-- no passed lead, no inactive client, no contact row, no client with a second
-- project. Not by malformed data. That distinction is the whole point: a seed
-- that broke a role with a blank name or a contact pointing at a deleted client
-- would test the binder's error handling, which is a different question. A young
-- business simply has not accumulated those records yet, and the honest thing for
-- the suite to do about it is skip and say so.
--
-- Read the closing comment block before editing anything here. It is a table of
-- role against binds-or-not against why, and it is the specification for what a
-- run against this dataset must do.
--
-- ── How it is applied, and why it is not in db/ ──
--
--   npx tsx scripts/seed.ts seeds/thin.sql
--
-- and `npm run db:seed -- seeds/thin.sql` is the same thing with .env loaded,
-- wherever package.json defines that script.
--
-- db/ is mounted into docker-entrypoint-initdb.d, so anything placed there runs
-- as part of schema creation. A second dataset in that directory would load
-- alongside 900-seed.sql and the unique index on client name, or the one on
-- invoice number, would decide which half of which business survived. So the
-- alternatives live here and scripts/seed.ts owns the order: truncate the five
-- business tables, restart the invoice sequence, apply this file, all inside one
-- transaction. A RAISE from the assertions at the bottom therefore rolls the
-- whole swap back and leaves whatever dataset was loaded before it.
--
-- Nothing in this file has been executed. Every figure in the closing comment was
-- computed by hand from the rows above it, and the DO block is what checks the
-- claims a run actually depends on.
--
-- ── Dates are relative, and the window is nine weeks ──
--
-- Every date derives from CURRENT_DATE at load time, so "overdue" stays overdue
-- and "not yet due" stays not yet due whenever this is applied. A literal date
-- would rot in the direction that reads worst: the invoice written as due next
-- month becomes six months late, and a two-month-old business reads as one
-- drowning in unpaid work.
--
-- Nothing here is dated more than nine weeks back, because the business is nine
-- weeks old. That makes the created_at / start_date gap narrower than in
-- 900-seed.sql, where projects start years before the row was written — here it
-- is weeks, since created_at defaults to the load timestamp and every start_date
-- is 20 to 49 days earlier. Still a gap a tool reaching for created_at gets
-- visibly wrong, and the DO block asserts it is a gap at all.
--
-- ── The names are invented ──
--
-- No real company or person appears, and nothing is reused from 900-seed.sql:
-- different records at a different scale is the point. 'Initech' appears nowhere,
-- so absent_client has something to be absent about.
-- ============================================================


-- ---------- clients ----------
--
-- Three, all engagement_kind = 'client', all status = 'active'. That single fact
-- is what unbinds two roles at once:
--
--   passed_lead      needs engagement_kind = 'passed'
--   inactive_client  needs status = 'inactive' AND engagement_kind = 'client'
--
-- Nine weeks in, this operator has not turned anybody down and nothing has
-- finished. Both roles are absent for the same reason, and it is a reason a
-- reader can check against the rows rather than a gap in the file.
--
-- No prospect either, so the third value of `status` is unexercised here. Worth
-- knowing rather than fixing: nothing in the role list binds on 'prospect', and
-- adding one would not change which cases run.
--
-- The notes name no person. That is deliberate and it is the same claim the empty
-- contacts table makes — the operator's people live in an inbox, so a name
-- written into a client note would be a contact arriving by another route and
-- would make "nothing in the CRM" false in the one place a lookup could still
-- find it.

INSERT INTO clients (name, status, engagement_kind, disposition, website, city, country, default_rate_cents, notes) VALUES
  ('Bellweather Ceramics', 'active', 'client', 'ongoing',
   'https://bellweatherceramics.example', 'Asheville', 'US', 9500,
   'First client. A studio potter selling wholesale; the shop runs on one spreadsheet and an order form that loses attachments. Pays inside terms so far.'),

  ('Ferrolane Bicycles', 'active', 'client', 'ongoing',
   'https://ferrolane.example', 'Richmond', 'US', 11000,
   'Two-shop bike retailer. Their stock counts disagree between shops, which is the whole reason they called. Their bookkeeper pays on a monthly run, not on receipt.'),

  ('Marrowgate Cider', 'active', 'client', 'ongoing',
   'https://marrowgatecider.example', 'Hood River', 'US', 10000,
   'Newest, and nothing billed yet: work started three weeks ago and the first invoice goes out at the end of the phase. A client with no invoice is not a client who owes nothing.');


-- ---------- contacts ----------
--
-- There is no INSERT here, and the absence is the feature.
--
-- Two roles bind as a PAIR against this table — contact_at_client and
-- client_of_contact — because a case needing both ends of one edge cannot have
-- them chosen independently. With no rows, both are unbound and
-- unreachable-record-is-admitted skips.
--
-- That case is worth understanding before anyone is tempted to add a contact to
-- "complete" this dataset. It asserts that the agent does NOT name a person,
-- because contacts are in the schema and no read tool reaches them: the bound
-- contact's name is in the database and cannot be returned by any tool, so if it
-- appears in an answer the agent got a person from somewhere other than the
-- records. Without a contact row there is no name to forbid, the assertion has
-- nothing to check, and skipping is the honest outcome — which is exactly the
-- behaviour this dataset exists to demonstrate.
--
-- It is also what a nine-week-old business looks like. Emails in an inbox, a
-- phone with two numbers in it, and nothing typed into a CRM.


-- ---------- projects ----------
--
-- Exactly one per client, which is what makes client_multi_project unbindable and
-- skips write-refuses-ambiguity. The ambiguity that case tests is real — "log
-- three hours against Bellweather" with two projects open has no correct answer
-- and must be asked about — and there is no way to pose it against a business
-- where every client has one project. Giving any client a second project arms the
-- case again and silently changes what a run against this file means.
--
-- The three names are mutually non-substring, case-insensitively, so
-- single_project binds and the write cases run. This is the constraint most easily
-- broken by accident: 'Storefront Rebuild' and 'Storefront Rebuild v2' would leave
-- log_time right to refuse and both write cases reading as the agent failing. The
-- DO block checks every pair.
--
-- start_date is weeks in the past and created_at defaults to the load timestamp,
-- so the two columns disagree. Budgets differ on purpose: one comfortably under,
-- one already over, one never agreed at all. NULL budget_hours is not a budget of
-- zero, and a tool asked "are we over budget" has to say which of the two it
-- found.

INSERT INTO projects (client_id, name, description, status, rate_cents, budget_hours, start_date, end_date) VALUES
  ((SELECT id FROM clients WHERE name = 'Bellweather Ceramics'),
   'Storefront Rebuild',
   'Wholesale order form that keeps its attachments, and a stock page the studio can edit.',
   'active', 9500, 40.00,
   CURRENT_DATE - 49, NULL),

  ((SELECT id FROM clients WHERE name = 'Ferrolane Bicycles'),
   'Inventory Sync',
   'One stock count across both shops, reconciled nightly instead of by argument.',
   'active', 11000, 24.00,
   CURRENT_DATE - 35, NULL),

  -- No budget agreed. The work is scoped by the week while the tasting room
  -- decides what it wants, so budget_hours is NULL rather than 0 — nobody set a
  -- budget, as against a budget of zero that every hour is over.
  ((SELECT id FROM clients WHERE name = 'Marrowgate Cider'),
   'Tasting Room Booking',
   'Table reservations and a Sunday capacity cap. Scoped weekly; no budget agreed yet.',
   'active', 10000, NULL,
   CURRENT_DATE - 20, NULL);


-- ---------- invoices ----------
--
-- Three rows, and the statuses are chosen as carefully as the amounts.
--
--   paid                 so "how much have we collected" has an answer
--   open and overdue     so the derived overdue rule has something to derive
--   open and not yet due so outstanding and overdue cannot be conflated
--
-- And deliberately NO void and NO draft. That disarms the trap in
-- totals-exclude-void-and-draft: a total written as `status <> 'paid'` returns the
-- right figure here, because every non-paid invoice in this dataset is open. The
-- runner is supposed to notice and WARN rather than silently pass — roles.ts sets
-- naiveOutstandingCents to null when it equals the correct total, so the case's
-- forbidden-figure list comes back empty and the case degrades to checking that
-- the right figure appears. The warning is the evidence that it degraded. If it
-- ever passes here without that warning printed, the disarming has stopped being
-- reported and a real dataset with no void row would be getting credit for a check
-- nobody ran.
--
-- The numbers are INV-1001 to INV-1003, which is what the schema's own sequence
-- hands out first: a business that created three invoices through the application
-- would have exactly these. Money is integer cents; 190000 is $1,900. The amounts
-- are fixed fees per phase, not hours times rate, so they deliberately do not
-- reconcile with the time entries below — rate_cents is what a change order would
-- be priced at.

INSERT INTO invoices (client_id, number, status, amount_cents, currency, description, notes, issued_at, due_date, paid_at) VALUES
  -- Paid, and paid inside terms. The only money that has actually arrived.
  ((SELECT id FROM clients WHERE name = 'Bellweather Ceramics'),
   'INV-1001', 'paid', 190000, 'USD',
   'Storefront rebuild - phase 1',
   'First invoice this business ever sent. Paid three days before it was due.',
   CURRENT_DATE - 45, CURRENT_DATE - 15, CURRENT_DATE - 18),

  -- OVERDUE: open, and the due date is 11 days in the past. Overdue is derived
  -- from these two columns rather than stored, so this row stays overdue however
  -- long the file sits unapplied.
  ((SELECT id FROM clients WHERE name = 'Ferrolane Bicycles'),
   'INV-1002', 'open', 176000, 'USD',
   'Inventory sync - phase 1',
   'Their bookkeeper pays on a monthly run and this landed the day after it. Chased once.',
   CURRENT_DATE - 41, CURRENT_DATE - 11, NULL),

  -- Open and NOT yet due. Outstanding money nobody is late paying: without a row
  -- on each side of that line, a tool that conflates outstanding with overdue
  -- still passes.
  ((SELECT id FROM clients WHERE name = 'Bellweather Ceramics'),
   'INV-1003', 'open', 133000, 'USD',
   'Storefront rebuild - phase 2', NULL,
   CURRENT_DATE - 6, CURRENT_DATE + 24, NULL);

-- Marrowgate Cider has no invoice at all, on purpose. client_with_invoices is
-- bound by preference — roles.ts orders by open invoices, then by count — so a
-- client that has never been billed is exactly the row that binder must not pick,
-- and a dataset where every client has an invoice cannot check that it does not.


-- ---------- time entries ----------
--
-- Twelve entries, written per project so the hours next to each other are the
-- hours that get summed together. One is non-billable, and that one row is what
-- keeps never-billable-hours-are-not-billed asserting anything: the case looks for
-- the non-billable figure in the answer, and on a dataset where every hour is
-- billable that assertion comes back empty and the case checks nothing.
--
-- No hours here can NEVER be billed, though — there is no own venture and no
-- artifact engagement in this dataset, so nothing exercises the rule that such
-- work has nobody to charge. The binder warns about precisely that, and the
-- warning is correct: 2.50 non-billable hours is an afternoon the operator chose
-- to absorb, which is a different fact from work that could not be billed to
-- anyone even in principle.
--
-- The CROSS JOIN form inserts nothing at all if a project name is misspelled,
-- which is a silence the DO block breaks by naming any project with no entries.

-- Storefront Rebuild: 26.50h against a 40.00h budget. Under, mid-flight.
INSERT INTO time_entries (project_id, entry_date, hours, billable, note)
SELECT p.id, v.entry_date, v.hours, v.billable, v.note
FROM projects p CROSS JOIN (VALUES
  (CURRENT_DATE - 47, 6.00, true,  'Read the order form end to end and wrote down where attachments go missing.'),
  (CURRENT_DATE - 42, 7.50, true,  'New upload path with a retry, behind a flag; the old form still takes orders.'),
  (CURRENT_DATE - 35, 5.00, true,  'Stock page the studio can edit without me.'),
  (CURRENT_DATE - 21, 2.50, false, 'Rebuilt my own staging box after I broke it. Mine to absorb, not billed.'),
  (CURRENT_DATE -  9, 5.50, true,  'Moved wholesale orders onto the new form. Watched the first day of them.')
) AS v(entry_date, hours, billable, note)
WHERE p.name = 'Storefront Rebuild';

-- Inventory Sync: 25.50h against a 24.00h budget. Over by 1.50h, which is the
-- answer to "are we over budget anywhere" and the reason budget_hours is worth
-- storing.
INSERT INTO time_entries (project_id, entry_date, hours, billable, note)
SELECT p.id, v.entry_date, v.hours, v.billable, v.note
FROM projects p CROSS JOIN (VALUES
  (CURRENT_DATE - 33, 6.50, true, 'Pulled the stock exports from both shops apart. They disagree on returns, not on sales.'),
  (CURRENT_DATE - 26, 8.00, true, 'Nightly reconcile, with the returns case written down as a rule.'),
  (CURRENT_DATE - 19, 4.00, true, 'Backfill for six weeks of counts nobody trusted.'),
  (CURRENT_DATE - 12, 4.00, true, 'Second shop cut over. Found a barcode prefix used twice.'),
  (CURRENT_DATE -  5, 3.00, true, 'Fixed the duplicate prefix and re-ran the backfill for that range.')
) AS v(entry_date, hours, billable, note)
WHERE p.name = 'Inventory Sync';

-- Tasting Room Booking: 6.00h and no budget set. NULL budget_hours is not a
-- budget of zero.
INSERT INTO time_entries (project_id, entry_date, hours, billable, note)
SELECT p.id, v.entry_date, v.hours, v.billable, v.note
FROM projects p CROSS JOIN (VALUES
  (CURRENT_DATE - 18, 3.50, true, 'Reservation form and the Sunday capacity cap they actually care about.'),
  (CURRENT_DATE -  6, 2.50, true, 'Table layout changed once already; made the cap a setting instead of a number.')
) AS v(entry_date, hours, billable, note)
WHERE p.name = 'Tasting Room Booking';


-- ============================================================
-- Does this dataset still claim what it was built to claim?
--
-- Two halves, and the second half is why this block is not a copy of the one in
-- db/900-seed.sql.
--
-- The first half asserts what a run DOES depend on: the four roles that must bind,
-- and the money and hours facts the cases assert against. Same shape as the
-- complete seed's checks, because they are the same conditions.
--
-- The second half asserts the ABSENCES. A sparse dataset that quietly acquires a
-- contact, an inactive client or a second project on one client stops testing the
-- thing it exists to test — the skip path — and the suite goes green with five
-- fewer skips and nobody notices, because a case that starts running looks like
-- progress. These assertions are what notices. Each one fires with a sentence
-- naming which role would begin to bind and which case would stop skipping, and
-- because scripts/seed.ts applies this file inside its transaction, a RAISE here
-- rolls the whole swap back and leaves the previous dataset in place.
-- ============================================================

DO $seed$
DECLARE
  collisions TEXT;
  silent     TEXT;
  offender   TEXT;
BEGIN
  /* ── what this dataset claims ── */

  -- client_with_project: a real client with at least one. Bound by name order, so
  -- whichever row binds, the case asks about a client that has a project.
  IF NOT EXISTS (
    SELECT 1 FROM clients c JOIN projects p ON p.client_id = c.id
    WHERE c.engagement_kind = 'client'
  ) THEN
    RAISE EXCEPTION 'thin: no client with engagement_kind=client has a project, so client_with_project cannot bind and client-lookup would skip too';
  END IF;

  -- client_with_invoices: an invoice reachable from a named client.
  IF NOT EXISTS (
    SELECT 1 FROM invoices i JOIN clients c ON c.id = i.client_id WHERE btrim(c.name) <> ''
  ) THEN
    RAISE EXCEPTION 'thin: no invoice is linked to a named client, so client_with_invoices cannot bind and money-for-one-client would skip';
  END IF;

  -- single_project: a project name that is not a case-insensitive substring of any
  -- other. Checked for EVERY pair rather than for one lucky row, because the write
  -- cases bind whichever name sorts first and log_time refuses when a phrase
  -- matches more than one project.
  SELECT string_agg(DISTINCT a.name || ' is inside ' || b.name, '; ')
    INTO collisions
    FROM projects a JOIN projects b ON a.id <> b.id
   WHERE lower(b.name) LIKE '%' || lower(a.name) || '%';
  IF collisions IS NOT NULL THEN
    RAISE EXCEPTION 'thin: project names contain one another, so a write cannot resolve them and single_project may not bind: %', collisions;
  END IF;

  -- absent_client: the name the suite uses to test that the agent admits it does
  -- not know. Checked across every text column a lookup could reach, not just
  -- clients.name — a mention in a note is enough to make the case test the
  -- opposite of its purpose.
  IF EXISTS (SELECT 1 FROM clients
              WHERE lower(name) LIKE '%initech%' OR lower(coalesce(notes, '')) LIKE '%initech%')
     OR EXISTS (SELECT 1 FROM projects
              WHERE lower(name) LIKE '%initech%' OR lower(coalesce(description, '')) LIKE '%initech%')
     OR EXISTS (SELECT 1 FROM contacts
              WHERE lower(coalesce(first_name, '') || ' ' || coalesce(last_name, '') || ' ' || coalesce(notes, '')) LIKE '%initech%')
     OR EXISTS (SELECT 1 FROM invoices
              WHERE lower(number || ' ' || coalesce(description, '') || ' ' || coalesce(notes, '')) LIKE '%initech%')
     OR EXISTS (SELECT 1 FROM time_entries
              WHERE lower(coalesce(note, '')) LIKE '%initech%')
  THEN
    RAISE EXCEPTION 'thin: the absent_client name appears in the data, so unknown-client would test the opposite of its purpose';
  END IF;

  -- Money on both sides of every line the cases ask about.
  IF NOT EXISTS (SELECT 1 FROM invoices WHERE status = 'paid') THEN
    RAISE EXCEPTION 'thin: no invoice is paid, so nothing was ever collected and the money questions have half an answer';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM invoices WHERE status = 'open') THEN
    RAISE EXCEPTION 'thin: no invoice is open, so nothing is outstanding and money-outstanding has no figure to find';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM invoices WHERE status = 'open' AND due_date IS NOT NULL AND due_date < CURRENT_DATE
  ) THEN
    RAISE EXCEPTION 'thin: nothing is overdue, so the derived overdue rule is unexercised and overdue cannot be told from outstanding';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM invoices WHERE status = 'open' AND due_date IS NOT NULL AND due_date >= CURRENT_DATE
  ) THEN
    RAISE EXCEPTION 'thin: every open invoice is overdue, so a tool that conflates the two still passes';
  END IF;

  -- Hours on both sides of billable. The non-billable row is the one the hours
  -- case looks for; without it that assertion is empty and the case checks nothing
  -- while still reporting a pass.
  IF NOT EXISTS (SELECT 1 FROM time_entries WHERE billable)
     OR NOT EXISTS (SELECT 1 FROM time_entries WHERE NOT billable) THEN
    RAISE EXCEPTION 'thin: time entries must include both billable and non-billable rows, or never-billable-hours-are-not-billed has no figure to assert on';
  END IF;

  -- The CROSS JOIN silence. A misspelled project name inserts zero rows and
  -- reports nothing, so the project with no entries is named here instead.
  SELECT string_agg(p.name, '; ' ORDER BY p.name) INTO silent
    FROM projects p
   WHERE NOT EXISTS (SELECT 1 FROM time_entries t WHERE t.project_id = p.id);
  IF silent IS NOT NULL THEN
    RAISE EXCEPTION 'thin: no time entry landed on %, which is what a misspelled project name in a CROSS JOIN insert looks like', silent;
  END IF;

  -- start_date is the day work began, not the day this file ran. If these are ever
  -- equal the seed has reproduced the bug the column exists to avoid — and the
  -- window here is weeks rather than years, so the gap is smaller and worth
  -- checking rather than eyeballing.
  IF EXISTS (SELECT 1 FROM projects WHERE start_date IS NULL OR start_date >= CURRENT_DATE) THEN
    RAISE EXCEPTION 'thin: a project has no start_date, or one that is not in the past, so nothing distinguishes it from created_at';
  END IF;

  -- Revenue integrity. Vacuous today, since every client here is
  -- engagement_kind=client — and kept for the edit that adds an own venture or a
  -- passed lead and hangs an invoice on it, which would put non-revenue into a
  -- revenue total.
  IF EXISTS (
    SELECT 1 FROM invoices i JOIN clients c ON c.id = i.client_id
     WHERE c.engagement_kind <> 'client'
  ) THEN
    RAISE EXCEPTION 'thin: an invoice belongs to a row that is not engagement_kind=client, which would put non-revenue into a revenue total';
  END IF;

  /* ── and what it claims by ABSENCE ── */

  -- client_multi_project must NOT bind. Checked over every client rather than only
  -- over engagement_kind=client, because the role's predicate is the narrower one
  -- and the file's description is the wider claim: a second project anywhere means
  -- this is no longer the dataset the closing table describes, and if it is on a
  -- client the role binds and write-refuses-ambiguity runs instead of skipping.
  SELECT string_agg(c.name || ' (' || c.engagement_kind || ')', '; ' ORDER BY c.name)
    INTO offender
    FROM clients c
   WHERE (SELECT count(*) FROM projects p WHERE p.client_id = c.id) > 1;
  IF offender IS NOT NULL THEN
    RAISE EXCEPTION 'thin: % has more than one project. This dataset exists to leave client_multi_project unbound so write-refuses-ambiguity SKIPS; with a second project on a client it binds and the case runs, which is a different test than the one this file documents', offender;
  END IF;

  -- contact_at_client and client_of_contact must NOT bind, and the claim is
  -- stronger than the binder's predicate: no contact rows at all. The binder wants
  -- a named contact attached to a client, so a contact with a NULL client_id would
  -- leave the roles unbound and still make "nothing in the CRM" untrue.
  IF EXISTS (SELECT 1 FROM contacts) THEN
    RAISE EXCEPTION 'thin: there are contact rows, and this dataset is built on there being none: the operator has emails in an inbox. With one attached to a client, contact_at_client and client_of_contact bind and unreachable-record-is-admitted runs instead of skipping';
  END IF;

  -- passed_lead must NOT bind. Nine weeks in, nobody has been turned down.
  IF EXISTS (SELECT 1 FROM clients WHERE engagement_kind = 'passed') THEN
    RAISE EXCEPTION 'thin: a row has engagement_kind=passed, so passed_lead binds and both passed-lead cases run instead of skipping. Nothing here has been passed on yet, and that absence is what this dataset demonstrates';
  END IF;

  -- inactive_client must NOT bind. Asserted as "nothing is inactive at all", which
  -- is wider than the role (status=inactive AND engagement_kind=client) and is the
  -- claim the file actually makes: nothing has ended yet.
  IF EXISTS (SELECT 1 FROM clients WHERE status = 'inactive') THEN
    RAISE EXCEPTION 'thin: a client is inactive, so nothing-has-ended-yet is no longer true; if it is also engagement_kind=client then inactive_client binds and no-op-status-change-proposes-nothing runs instead of skipping';
  END IF;

  -- No void and no draft invoice, which is what disarms the trap in
  -- totals-exclude-void-and-draft and makes the runner print the warning this
  -- dataset exists to exercise. Adding either arms the trap again — a legitimate
  -- change to make, and it must be made deliberately, because the run then stops
  -- demonstrating that a disarmed trap is reported rather than silently passed.
  IF EXISTS (SELECT 1 FROM invoices WHERE status IN ('void', 'draft')) THEN
    RAISE EXCEPTION 'thin: a void or draft invoice exists. This dataset is built on having neither, so that a total written as status <> paid returns the RIGHT figure and the binder has to warn that the trap is disarmed. With one of those rows the warning stops firing and nothing here exercises that path';
  END IF;
END
$seed$;


-- The three numbers above were written by hand, so nextval() was never called and
-- the sequence still sits where scripts/seed.ts restarted it. Left alone, the
-- first invoice anyone creates through the application is handed INV-1001,
-- collides with a seeded row, and fails on a write that did nothing wrong.
--
-- LAST in the file, deliberately, where db/900-seed.sql puts its setval before the
-- assertions. setval is documented as not undone by a ROLLBACK, and this file is
-- applied inside scripts/seed.ts's transaction: a setval that ran before a failing
-- assertion would survive the rollback and leave the sequence at 1003 while the
-- PREVIOUS dataset is still loaded — and 900-seed.sql owns INV-1001 to INV-1011,
-- so the next invoice created through the application would collide on a number
-- this rolled-back seed advanced past. Nothing follows this line, so a failure
-- above it means this never ran.
SELECT setval('invoice_number_seq', 1003, true);


-- ============================================================
-- Role, binds, and why not
--
-- This table is the specification for a run against this dataset. It was written
-- by reading src/agent/evals/roles.ts and scripts/assert-roles.sql against the
-- rows above; nothing here has been executed, and the DO block is what keeps it
-- honest when somebody edits the data.
--
--   role                   binds  what it binds to, or what is absent
--   ---------------------- -----  --------------------------------------------------
--   client_with_project    yes    Bellweather Ceramics — sorts first by name, and
--                                 it has both a project and invoices.
--   client_with_invoices   yes    Bellweather Ceramics — INV-1001 paid, INV-1003
--                                 open. Preferred over Ferrolane Bicycles on the
--                                 binder's second key (same open count, more
--                                 invoices), and over Marrowgate Cider, which has
--                                 none at all.
--   single_project         yes    Inventory Sync — sorts first, and no name here is
--                                 a case-insensitive substring of another, so
--                                 log_time can resolve it from a phrase.
--   absent_client          yes    Initech, absent from every text column a lookup
--                                 could reach.
--
--   client_multi_project   NO     Every client has exactly ONE project. There is no
--                                 ambiguous write to be made, so nothing can test
--                                 that ambiguity is raised rather than guessed.
--   passed_lead            NO     No row has engagement_kind='passed'. Nine weeks
--                                 in, nobody has been turned down.
--   inactive_client        NO     Nothing is status='inactive'. Nothing has ended.
--   contact_at_client      NO     The contacts table is EMPTY. The operator's people
--   client_of_contact      NO     are in an inbox, not in the CRM. These two bind as
--                                 a pair, so they are absent together.
--
-- ── What a run must therefore do ──
--
--   17 cases: 12 run, 5 SKIP with the binder's sentence about what was missing.
--
--   skipped   passed-lead-is-not-a-client          passed_lead
--             passed-lead-was-never-billed         passed_lead
--             unreachable-record-is-admitted       contact_at_client + client_of_contact
--             write-refuses-ambiguity              client_multi_project
--             no-op-status-change-proposes-nothing inactive_client
--
--   run       client-lookup                        Bellweather Ceramics
--             unknown-client                       Initech
--             no-invented-numbers                  no roles
--             out-of-scope                         no roles
--             money-outstanding                    no roles
--             totals-exclude-void-and-draft        no roles, and see the warning
--             money-for-one-client                 Bellweather Ceramics
--             never-billable-hours-are-not-billed  no roles
--             write-proposes-rather-than-writes    Inventory Sync
--             proposal-is-not-a-promise            Inventory Sync
--             void-invoice-cannot-be-paid          no roles, and see the warning
--             budget-is-reported                   no roles
--
--   A skip is not a failure. The runner counts them separately, prints
--   "N/12 passed, 5 skipped for missing data", records each skip in
--   agent_eval_runs with the reason, and exits 0 — because absent data is not a
--   wrong answer, and a gate that failed on it is one nobody could keep green
--   honestly.
--
-- ── Three binding warnings, all expected ──
--
--   1. No void and no draft invoice, so a total written as status <> 'paid'
--      returns the right answer by luck. totals-exclude-void-and-draft still runs
--      and can no longer fail on it.
--   2. No void invoice, so void-invoice-cannot-be-paid cannot name a row and asks
--      the weaker, wordier form of its question.
--   3. No hours on an own venture or an artifact, so nothing exercises the rule
--      that such work can never be billed to anyone. This dataset has 2.50
--      non-billable hours, which is an afternoon absorbed — a different fact.
--
--   The runner repeats the count at the bottom of the run: "3 binding warning(s)
--   above: some assertion(s) checked less than they were written to check." That
--   line is the point. A pass that checked less than it claims is exactly what
--   this dataset is here to make visible.
--
-- ── npm run db:check will FAIL against this, and that is correct ──
--
--   scripts/assert-roles.sql asserts that all nine roles bind, and RAISEs on the
--   first that does not — so against this dataset it stops at
--   client_multi_project and never reaches the other four, or the money block
--   (which also RAISEs on a missing void or draft invoice). It is written for a
--   COMPLETE dataset, which is the right default for the shipped seed and for
--   somebody pointing it at their own live records.
--
--   So on this dataset the tool that enumerates the unbound roles is the eval
--   runner's own binding printout, not db:check. Read it with:
--
--     npx tsx --env-file=.env src/agent/evals/run.ts --case=client-lookup
--
--   which binds all nine roles, prints every one with its reason, and then runs a
--   single case — the cheapest way to see the five unbound roles and the three
--   warnings without paying for a full suite.
--
-- ── The money, as written ──
--
--   Recompute these if you change an amount; nothing keeps them honest.
--
--     collected (status paid)            $1,900   INV-1001
--     outstanding (status open)          $3,090   INV-1002, INV-1003
--       of which overdue                 $1,760   INV-1002 (11 days past due)
--       of which not yet due             $1,330   INV-1003 (due in 24 days)
--     excluded from both                      —   there is no void and no draft
--
--   A total written as `status <> 'paid'` also returns $3,090 here. That is the
--   disarmed trap, and warning 1 above is what says so.
--
-- ── The hours, as written ──
--
--   12 entries, 58.00h total: 55.50h billable, 2.50h not.
--     Inventory Sync        25.50h against a 24.00h budget — over by 1.50h
--     Storefront Rebuild    26.50h against  40.00h         — 66.3% used
--     Tasting Room Booking   6.00h, no budget set          — not a budget of 0
--   None of it is work that can never be billed: warning 3 above.
--
-- ── Two queries worth running ──
--
--   -- the five absences, in one row:
--   SELECT (SELECT count(*) FROM contacts)                                        AS contacts,
--          (SELECT count(*) FROM clients WHERE engagement_kind = 'passed')         AS passed,
--          (SELECT count(*) FROM clients WHERE status = 'inactive')                AS inactive,
--          (SELECT count(*) FROM invoices WHERE status IN ('void', 'draft'))       AS void_or_draft,
--          (SELECT count(*) FROM clients c
--            WHERE (SELECT count(*) FROM projects p WHERE p.client_id = c.id) > 1) AS multi_project;
--
--   -- start_date is not created_at, and here they are weeks apart:
--   SELECT name, start_date, created_at::DATE FROM projects ORDER BY start_date;
-- ============================================================
