-- ============================================================
-- 900 — A synthetic consulting studio
--
-- Numbered 900 so docker-entrypoint-initdb.d loads it after every schema file,
-- whatever gets added between 001 and here.
--
-- ── What this file is for ──
--
-- The eval suite does not name companies. A case declares the ROLES it needs —
-- a client with several projects, a lead that was passed on, a name that must
-- match nothing — and the runner binds those roles to whatever the database
-- holds before anything runs. A role that cannot bind SKIPS its cases with a
-- reason, which is honest, and which also means a thin seed makes the suite
-- quietly cover less than its output claims.
--
-- So this file is written against the role list, not against a story. Every
-- role below has at least one row that can bind it, and the DO block at the
-- bottom asserts that at load time rather than asking you to take it on trust.
-- If an assertion fires, the container's init aborts — which is the point: a
-- database that cannot bind the roles should not come up looking healthy.
--
-- ── Dates are relative ──
--
-- Every date here is derived from CURRENT_DATE at load time. Hard-coded dates
-- rot in a specific and misleading way: the invoice written as "not due for
-- three weeks" becomes overdue a month later, and then the whole seed reads as
-- a business drowning in unpaid work. Relative dates keep "overdue", "just
-- issued" and "paid last spring" true whenever anyone clones this.
--
-- created_at is left to its default, which is the load timestamp. Project
-- start_dates are months and years earlier on purpose: the two columns must
-- visibly disagree, or nothing catches a tool that reaches for created_at when
-- it wanted start_date.
--
-- ── The names are invented ──
--
-- No real company appears here, and 'Initech' appears nowhere in the data, so
-- the absent_client role has something to be absent about.
--
-- Not idempotent. Re-running it violates the unique indexes on client name and
-- invoice number, loudly. To reload: drop the volume, or
-- `TRUNCATE clients CASCADE;` followed by `ALTER SEQUENCE invoice_number_seq
-- RESTART WITH 1001;` and run this file again.
-- ============================================================


-- ---------- clients ----------
--
-- Insert order is not decoration. A role binder scanning an unordered
-- SELECT gets rows back in heap order on a freshly loaded table, so the first
-- real client here is the one most likely to bind client_with_project and
-- client_multi_project. Halden Freight is first because it is the richest
-- record: three projects, four issued invoices, two contacts.

INSERT INTO clients (name, status, engagement_kind, disposition, website, city, country, default_rate_cents, notes) VALUES
  ('Halden Freight', 'active', 'client', 'ongoing',
   'https://haldenfreight.example', 'Portland', 'US', 18500,
   'Regional trucking. Dispatch is the whole business, so every project touches it. Dana signs off on scope.'),

  ('Calderwood Diagnostics', 'active', 'client', 'ongoing',
   'https://calderwooddx.example', 'Providence', 'US', 21000,
   'Clinical lab. Everything ships through a compliance review, so estimates carry a week of slack that is not padding.'),

  -- inactive_client: status inactive AND engagement_kind client. The engagement
  -- is over; they were unmistakably a client. The eval case tells the agent to
  -- "mark them inactive" and the correct answer is that they already are.
  ('Northaven Credit Union', 'inactive', 'client', 'completed',
   'https://northavencu.example', 'Duluth', 'US', 17500,
   'Audit finished, report accepted, nothing open. They said to call in the spring.'),

  -- passed_lead: took a call, never became a client. This is the distinction
  -- the two-column design exists for, and the row the suite uses to test that
  -- the agent never reports a passed lead as a client or as revenue.
  ('Quillon Robotics', 'inactive', 'passed', 'declined_by_us',
   'https://quillonrobotics.example', 'Ann Arbor', 'US', NULL,
   'One discovery call. Warehouse robotics with no software owner on their side and a fixed bid we would not take. Never a client.'),

  ('Sable & Vane Interiors', 'inactive', 'passed', 'declined_by_them',
   NULL, 'Austin', 'US', NULL,
   'Wanted the work, went with a cheaper studio. Never a client, and never billed.'),

  -- own_venture: ours. Never billable, never revenue. Its time entries exist to
  -- give the billable rule something to be right about.
  ('Ledgerlight', 'active', 'own_venture', 'ongoing',
   'https://ledgerlight.example', 'Portland', 'US', NULL,
   'Ours. The invoicing and reconciliation the studio runs on. Never billable, never revenue, and not a client however it sorts in a list.'),

  -- artifact: built for another reason entirely. Kept because deleting it would
  -- lose the work, counted as nothing.
  ('Statline Hockey', 'inactive', 'artifact', 'completed',
   NULL, NULL, 'US', NULL,
   'A take-home built for an interview. A record of the work, not an engagement: no client, no invoice, no billable hour.'),

  -- status = prospect with engagement_kind = client: a client relationship that
  -- has not started. Present so the third status value is not decorative, and
  -- so anything answering "who have we worked with" is forced to filter on BOTH
  -- columns. engagement_kind alone would count this intro call as a past
  -- engagement.
  ('Ashgrove Dental Group', 'prospect', 'client', NULL,
   'https://ashgrovedental.example', 'Boise', 'US', NULL,
   'Intro call booked, nothing agreed, nothing billed. Not someone we have worked with yet.');


-- ---------- contacts ----------
--
-- Dana Ruiz is first, deliberately. contact_at_client and client_of_contact are
-- bound as a pair, and the two-hop eval case asks what the studio has billed
-- that contact's client — so the first bindable contact needs to work at a
-- client that HAS invoices. Nothing in SQL promises heap order, so a binder
-- should prefer a contact whose client has invoices rather than rely on this.

INSERT INTO contacts (client_id, first_name, last_name, email, phone, title, is_primary, notes) VALUES
  ((SELECT id FROM clients WHERE name = 'Halden Freight'),
   'Dana', 'Ruiz', 'dana.ruiz@haldenfreight.example', '+1-503-555-0117',
   'Operations Director', true,
   'Decides scope and reads every release note. Wants bad news early.'),

  ((SELECT id FROM clients WHERE name = 'Halden Freight'),
   'Miles', 'Okafor', 'miles.okafor@haldenfreight.example', NULL,
   'Dispatch Lead', false,
   'The person the dispatch rewrite is actually for. Worth asking before changing a screen.'),

  ((SELECT id FROM clients WHERE name = 'Calderwood Diagnostics'),
   'Priya', 'Raman', 'priya.raman@calderwooddx.example', '+1-401-555-0143',
   'CTO', true,
   'Technical and fast. Reviews migrations herself.'),

  ((SELECT id FROM clients WHERE name = 'Northaven Credit Union'),
   'Glen', 'Whitcombe', 'glen.whitcombe@northavencu.example', NULL,
   'VP Lending', true,
   'Commissioned the audit. Took the findings to their board.'),

  -- A contact at a passed lead. Realistic, and a trap worth leaving in: a
  -- binder that grabs any contact with a client_id can land here, and then the
  -- two-hop case asks what was billed to someone who was never billed.
  ((SELECT id FROM clients WHERE name = 'Quillon Robotics'),
   'Rhea', 'Sandoval', 'rhea@quillonrobotics.example', NULL,
   'Founder', true,
   'The discovery call was with her. Not a client contact, because they never became a client.'),

  ((SELECT id FROM clients WHERE name = 'Ashgrove Dental Group'),
   'Karl', 'Beddoe', 'karl.beddoe@ashgrovedental.example', NULL,
   'Practice Manager', true,
   'Booked the intro call.'),

  -- client_id NULL: met at a conference, no engagement to attach her to.
  -- Inventing a client row to hold a person is how a client list acquires
  -- companies that were never clients.
  (NULL,
   'Odette', 'Marsh', 'odette@marshconsulting.example', NULL,
   'Independent CTO', false,
   'Met at a conference. No company row because there is no engagement yet.');


-- ---------- projects ----------
--
-- Every name below is mutually non-substring, case-insensitively. That is not
-- an aesthetic choice: the agent resolves a project with ILIKE '%phrase%' and
-- refuses to write when more than one row matches, so a pair like "Platform"
-- and "Platform v2" leaves single_project unbindable and silently skips every
-- write case in the suite. The DO block at the bottom checks all pairs.
--
-- Dispatch Rewrite is first for the same heap-order reason as Halden Freight:
-- it is the project a write case should land on — active, real client, has a
-- rate, has a budget it is not yet over.

INSERT INTO projects (client_id, name, description, status, rate_cents, budget_hours, start_date, end_date) VALUES
  ((SELECT id FROM clients WHERE name = 'Halden Freight'),
   'Dispatch Rewrite',
   'Replacing the stored-procedure dispatch engine, one terminal at a time.',
   'active', 18500, 120.00,
   (CURRENT_DATE - INTERVAL '14 months')::DATE, NULL),

  ((SELECT id FROM clients WHERE name = 'Halden Freight'),
   'Driver Mobile App',
   'Offline-first app for drivers. Shipped and handed over. It went over budget.',
   'completed', 18500, 60.00,
   (CURRENT_DATE - INTERVAL '22 months')::DATE, (CURRENT_DATE - INTERVAL '13 months')::DATE),

  ((SELECT id FROM clients WHERE name = 'Halden Freight'),
   'Terminal Yard Sensors',
   'Paused: waiting on their hardware vendor. No budget was ever agreed.',
   'paused', 18500, NULL,
   (CURRENT_DATE - INTERVAL '5 months')::DATE, NULL),

  ((SELECT id FROM clients WHERE name = 'Calderwood Diagnostics'),
   'Lab Results Portal',
   'Patient-facing results with an audit log their compliance officer asked for first.',
   'active', 21000, 80.00,
   (CURRENT_DATE - INTERVAL '7 months')::DATE, NULL),

  ((SELECT id FROM clients WHERE name = 'Calderwood Diagnostics'),
   'HL7 Feed Cleanup',
   'Quarantine and replay for malformed messages, instead of dropping them.',
   'completed', 21000, 24.00,
   (CURRENT_DATE - INTERVAL '13 months')::DATE, (CURRENT_DATE - INTERVAL '11 months')::DATE),

  ((SELECT id FROM clients WHERE name = 'Northaven Credit Union'),
   'Loan Origination Audit',
   'Read the origination flow, reproduced the duplicate-application bug, wrote it up.',
   'completed', 17500, 40.00,
   (CURRENT_DATE - INTERVAL '30 months')::DATE, (CURRENT_DATE - INTERVAL '25 months')::DATE),

  -- Own venture. Has hours, has no rate, and can never have an invoice.
  ((SELECT id FROM clients WHERE name = 'Ledgerlight'),
   'Ledgerlight Internal Tooling',
   'Our own invoicing and reconciliation. Never billable.',
   'active', NULL, NULL,
   (CURRENT_DATE - INTERVAL '8 months')::DATE, NULL),

  ((SELECT id FROM clients WHERE name = 'Statline Hockey'),
   'Statline Hockey Prototype',
   'The take-home itself: ingest a season of box scores, query it, chart one thing.',
   'completed', NULL, NULL,
   (CURRENT_DATE - INTERVAL '20 months')::DATE, (CURRENT_DATE - INTERVAL '20 months')::DATE),

  -- A project belonging to a lead that was passed on. The private system's role
  -- binder carries a comment about exactly this: a passed lead sometimes has
  -- project rows, and binding it as "a client with projects" makes every lookup
  -- case assert about someone who was never a client. This row is here so that
  -- filter has something to filter.
  ((SELECT id FROM clients WHERE name = 'Quillon Robotics'),
   'Warehouse Robotics Scoping',
   'Discovery call and a scoping note. Cancelled: we passed on the work.',
   'cancelled', NULL, NULL,
   (CURRENT_DATE - INTERVAL '9 months')::DATE, (CURRENT_DATE - INTERVAL '9 months')::DATE);


-- ---------- invoices ----------
--
-- Eleven rows, in issue order, so the numbers read chronologically. Not a
-- complete billing history and not trying to be: eleven invoices can be added
-- up by hand to check what a tool claims, and two hundred cannot.
--
-- Every invoice belongs to a client with engagement_kind = 'client'. The passed
-- leads, the own venture and the artifact have none, which is what makes
-- "revenue" answerable at all — an own venture invoicing itself is money that
-- never existed.
--
-- Money is integer cents. 1_650_000 is $16,500.

INSERT INTO invoices (client_id, number, status, amount_cents, currency, description, notes, issued_at, due_date, paid_at) VALUES
  -- Paid, and old. Two years of history so a "last year" question has to filter
  -- on a date rather than summing the table.
  ((SELECT id FROM clients WHERE name = 'Northaven Credit Union'),
   'INV-1001', 'paid', 4200000, 'USD',
   'Loan origination audit - phase 1', NULL,
   (CURRENT_DATE - INTERVAL '26 months')::DATE,
   (CURRENT_DATE - INTERVAL '25 months')::DATE,
   (CURRENT_DATE - INTERVAL '25 months')::DATE),

  ((SELECT id FROM clients WHERE name = 'Northaven Credit Union'),
   'INV-1002', 'paid', 1100000, 'USD',
   'Loan origination audit - findings and board walkthrough', NULL,
   (CURRENT_DATE - INTERVAL '25 months')::DATE,
   (CURRENT_DATE - INTERVAL '24 months')::DATE,
   (CURRENT_DATE - INTERVAL '24 months')::DATE),

  ((SELECT id FROM clients WHERE name = 'Halden Freight'),
   'INV-1003', 'paid', 1800000, 'USD',
   'Driver mobile app - final', NULL,
   (CURRENT_DATE - INTERVAL '13 months')::DATE,
   (CURRENT_DATE - INTERVAL '12 months')::DATE,
   (CURRENT_DATE - INTERVAL '12 months')::DATE),

  ((SELECT id FROM clients WHERE name = 'Halden Freight'),
   'INV-1004', 'paid', 2400000, 'USD',
   'Dispatch rewrite - discovery and phase 1', NULL,
   (CURRENT_DATE - INTERVAL '9 months')::DATE,
   (CURRENT_DATE - INTERVAL '8 months')::DATE,
   (CURRENT_DATE - INTERVAL '8 months')::DATE),

  ((SELECT id FROM clients WHERE name = 'Calderwood Diagnostics'),
   'INV-1005', 'paid', 1250000, 'USD',
   'Lab results portal - phase 1', NULL,
   (CURRENT_DATE - INTERVAL '6 months')::DATE,
   (CURRENT_DATE - INTERVAL '5 months')::DATE,
   (CURRENT_DATE - INTERVAL '5 months')::DATE),

  -- Void, then reissued. Here because "outstanding" and "collected" both have
  -- to exclude it: counted as either, this $3,000 is money that was never owed
  -- and never arrived, and it is exactly the row a tool that filters on
  -- status <> 'paid' gets wrong.
  ((SELECT id FROM clients WHERE name = 'Calderwood Diagnostics'),
   'INV-1006', 'void', 300000, 'USD',
   'HL7 feed cleanup - final',
   'Billed to the wrong legal entity. Voided and reissued as INV-1007.',
   (CURRENT_DATE - INTERVAL '4 months')::DATE,
   (CURRENT_DATE - INTERVAL '3 months')::DATE,
   NULL),

  ((SELECT id FROM clients WHERE name = 'Calderwood Diagnostics'),
   'INV-1007', 'paid', 300000, 'USD',
   'HL7 feed cleanup - final',
   'Reissue of INV-1006 to the correct entity.',
   (CURRENT_DATE - INTERVAL '4 months')::DATE,
   (CURRENT_DATE - INTERVAL '3 months')::DATE,
   (CURRENT_DATE - INTERVAL '3 months')::DATE),

  -- OVERDUE: open, and the due date is 40 days in the past. The suite needs at
  -- least one, and "overdue" is derived from these two columns rather than
  -- stored, so this row stays overdue however long the file sits unread.
  ((SELECT id FROM clients WHERE name = 'Halden Freight'),
   'INV-1008', 'open', 1650000, 'USD',
   'Dispatch rewrite - phase 2',
   'Chased once. Their AP runs on the 1st and this missed the cutoff.',
   CURRENT_DATE - 70, CURRENT_DATE - 40, NULL),

  -- OVERDUE by 25 days, at a second client, so "who owes us" has more than one
  -- answer and cannot be satisfied by returning the first row.
  ((SELECT id FROM clients WHERE name = 'Calderwood Diagnostics'),
   'INV-1009', 'open', 780000, 'USD',
   'Lab results portal - phase 2', NULL,
   CURRENT_DATE - 55, CURRENT_DATE - 25, NULL),

  -- Open and NOT yet due. Outstanding money that nobody is late paying: the
  -- distinction between "outstanding" and "overdue" needs a row on each side or
  -- a tool can conflate them and still pass.
  ((SELECT id FROM clients WHERE name = 'Halden Freight'),
   'INV-1010', 'open', 900000, 'USD',
   'Dispatch rewrite - cutover support', NULL,
   CURRENT_DATE - 12, CURRENT_DATE + 18, NULL),

  -- Draft: never sent, therefore no issue date and no due date. Not money owed
  -- to anyone, and it must stay out of every total.
  ((SELECT id FROM clients WHERE name = 'Halden Freight'),
   'INV-1011', 'draft', 450000, 'USD',
   'Terminal yard sensors - phase 1',
   'Not sent. Waiting on their hardware vendor before we scope it.',
   NULL, NULL, NULL);

-- The numbers above were written by hand, so nextval() was never called and the
-- sequence still sits at 1001. Left alone, the first invoice anyone creates
-- through the application is handed INV-1001, collides with a seeded row, and
-- fails on a write that did nothing wrong.
SELECT setval('invoice_number_seq', 1011, true);


-- ---------- time entries ----------
--
-- Written per project, so the hours next to each other are the hours that get
-- summed together. Billable unless the note says otherwise; everything on the
-- own venture, the artifact and the passed lead is non-billable, because there
-- is nobody to charge.
--
-- The CROSS JOIN form inserts nothing at all if the project name is misspelled,
-- which is a silence the DO block at the bottom exists to break.

-- Dispatch Rewrite: 62.00h logged against a 120.00h budget. Under, mid-flight.
INSERT INTO time_entries (project_id, entry_date, hours, billable, note)
SELECT p.id, v.entry_date, v.hours, v.billable, v.note
FROM projects p CROSS JOIN (VALUES
  (CURRENT_DATE - 58, 6.00, true,  'Read the old dispatch queue end to end before touching any of it.'),
  (CURRENT_DATE - 54, 7.50, true,  'Pulled the routing rules out of the stored procedure they were living in.'),
  (CURRENT_DATE - 47, 8.00, true,  'New assignment service behind a flag; the old path is still the default.'),
  (CURRENT_DATE - 40, 5.00, true,  'Backfill for the legacy job ids.'),
  (CURRENT_DATE - 33, 7.00, true,  'Load test at 4x peak. Found the lock on driver_status.'),
  (CURRENT_DATE - 26, 2.50, false, 'Our own staging environment fought us for an afternoon. Not billed.'),
  (CURRENT_DATE - 19, 8.00, true,  'Cutover rehearsal with the dispatch team against a copy of prod.'),
  (CURRENT_DATE - 12, 6.50, true,  'Fixed the double-assignment race the rehearsal exposed.'),
  (CURRENT_DATE -  6, 7.00, true,  'First terminal moved onto the new path.'),
  (CURRENT_DATE -  3, 4.50, true,  'Watching the first terminal. Two small corrections.')
) AS v(entry_date, hours, billable, note)
WHERE p.name = 'Dispatch Rewrite';

-- Driver Mobile App: 67.50h against a 60.00h budget. The over-budget case, and
-- the reason budget_hours is worth storing at all.
INSERT INTO time_entries (project_id, entry_date, hours, billable, note)
SELECT p.id, v.entry_date, v.hours, v.billable, v.note
FROM projects p CROSS JOIN (VALUES
  ((CURRENT_DATE - INTERVAL '21 months')::DATE, 8.00, true,  'Offline queue. Trucks lose signal inside the yard.'),
  ((CURRENT_DATE - INTERVAL '20 months')::DATE, 7.50, true,  'Photo capture with upload retry.'),
  ((CURRENT_DATE - INTERVAL '19 months')::DATE, 6.00, true,  'Signature capture. The tablet keyboard kept stealing focus.'),
  ((CURRENT_DATE - INTERVAL '18 months')::DATE, 8.00, true,  'Route list, ordered the way dispatchers actually read it.'),
  ((CURRENT_DATE - INTERVAL '17 months')::DATE, 7.00, true,  'Push notifications and the certificate dance that comes with them.'),
  ((CURRENT_DATE - INTERVAL '16 months')::DATE, 6.50, true,  'Battery profiling. The GPS poll was the whole problem.'),
  ((CURRENT_DATE - INTERVAL '15 months')::DATE, 8.00, true,  'Store submission, and the two rejections that followed.'),
  ((CURRENT_DATE - INTERVAL '14 months')::DATE, 5.50, true,  'Field fixes from the first week of real use.'),
  ((CURRENT_DATE - INTERVAL '14 months')::DATE, 4.00, false, 'Internal retro on the store rejections. Ours to absorb.'),
  ((CURRENT_DATE - INTERVAL '13 months')::DATE, 7.00, true,  'Handover: build pipeline and signing keys to their team.')
) AS v(entry_date, hours, billable, note)
WHERE p.name = 'Driver Mobile App';

-- Terminal Yard Sensors: 7.50h and no budget set. NULL budget_hours is not a
-- budget of zero, and a tool asked "are we over budget" has to say which it is.
INSERT INTO time_entries (project_id, entry_date, hours, billable, note)
SELECT p.id, v.entry_date, v.hours, v.billable, v.note
FROM projects p CROSS JOIN (VALUES
  (CURRENT_DATE - 96, 4.00, true, 'Sensor spec review with the yard manager.'),
  (CURRENT_DATE - 89, 3.50, true, 'Wrote up the integration options and stopped: they are waiting on the vendor.')
) AS v(entry_date, hours, billable, note)
WHERE p.name = 'Terminal Yard Sensors';

-- Lab Results Portal: 38.50h against 80.00h, including one non-billable call.
INSERT INTO time_entries (project_id, entry_date, hours, billable, note)
SELECT p.id, v.entry_date, v.hours, v.billable, v.note
FROM projects p CROSS JOIN (VALUES
  (CURRENT_DATE - 95, 6.00, true,  'Sample HL7 messages, and the three variants they actually send.'),
  (CURRENT_DATE - 80, 8.00, true,  'Result rendering, including the reference ranges that decide the colour.'),
  (CURRENT_DATE - 66, 7.50, true,  'Audit log on every view. Their compliance officer asked before anyone else did.'),
  (CURRENT_DATE - 52, 3.00, false, 'Scoping call for phase two. Not billed.'),
  (CURRENT_DATE - 38, 8.00, true,  'Patient search that tolerates a misspelled surname.'),
  (CURRENT_DATE - 20, 6.00, true,  'Accessibility pass over the results table.')
) AS v(entry_date, hours, billable, note)
WHERE p.name = 'Lab Results Portal';

-- HL7 Feed Cleanup: 21.50h against 24.00h. Finished just inside its budget.
INSERT INTO time_entries (project_id, entry_date, hours, billable, note)
SELECT p.id, v.entry_date, v.hours, v.billable, v.note
FROM projects p CROSS JOIN (VALUES
  ((CURRENT_DATE - INTERVAL '12 months')::DATE, 8.00, true, 'Quarantine for malformed messages instead of dropping them on the floor.'),
  ((CURRENT_DATE - INTERVAL '12 months')::DATE, 7.00, true, 'Replay tool for the quarantine.'),
  ((CURRENT_DATE - INTERVAL '11 months')::DATE, 6.50, true, 'Two weeks of live monitoring, then handed over the runbook.')
) AS v(entry_date, hours, billable, note)
WHERE p.name = 'HL7 Feed Cleanup';

-- Loan Origination Audit: 29.50h against 40.00h, two years ago. The old
-- engagement, so a question about "this year" has something it must exclude.
INSERT INTO time_entries (project_id, entry_date, hours, billable, note)
SELECT p.id, v.entry_date, v.hours, v.billable, v.note
FROM projects p CROSS JOIN (VALUES
  ((CURRENT_DATE - INTERVAL '29 months')::DATE, 8.00, true, 'Read the origination flow and wrote down what it really does.'),
  ((CURRENT_DATE - INTERVAL '28 months')::DATE, 8.00, true, 'Reproduced the duplicate-application bug they could not.'),
  ((CURRENT_DATE - INTERVAL '27 months')::DATE, 7.50, true, 'Findings written up for their board.'),
  ((CURRENT_DATE - INTERVAL '26 months')::DATE, 6.00, true, 'Walked the findings through with the lending team.')
) AS v(entry_date, hours, billable, note)
WHERE p.name = 'Loan Origination Audit';

-- Ledgerlight Internal Tooling: 14.50h, none of it billable. An own venture has
-- nobody to invoice, so a billable hour here would be revenue that never
-- existed.
INSERT INTO time_entries (project_id, entry_date, hours, billable, note)
SELECT p.id, v.entry_date, v.hours, v.billable, v.note
FROM projects p CROSS JOIN (VALUES
  (CURRENT_DATE - 120, 3.00, false, 'Our own invoice reminders. Never billable - this is ours.'),
  (CURRENT_DATE -  96, 5.00, false, 'Ledger import from the bank export.'),
  (CURRENT_DATE -  64, 4.00, false, 'Reconciliation screen.'),
  (CURRENT_DATE -  30, 2.50, false, 'Cleanup pass over the import.')
) AS v(entry_date, hours, billable, note)
WHERE p.name = 'Ledgerlight Internal Tooling';

-- Statline Hockey Prototype: 15.00h, none of it billable. An interview
-- take-home was never work anyone bought.
INSERT INTO time_entries (project_id, entry_date, hours, billable, note)
SELECT p.id, v.entry_date, v.hours, v.billable, v.note
FROM projects p CROSS JOIN (VALUES
  ((CURRENT_DATE - INTERVAL '20 months')::DATE, 5.00, false, 'Take-home: ingest and normalise a season of box scores.'),
  ((CURRENT_DATE - INTERVAL '20 months')::DATE, 6.00, false, 'Take-home: the query layer and one chart.'),
  ((CURRENT_DATE - INTERVAL '20 months')::DATE, 4.00, false, 'Take-home: write-up. Submitted, and never an engagement.')
) AS v(entry_date, hours, billable, note)
WHERE p.name = 'Statline Hockey Prototype';

-- Warehouse Robotics Scoping: 1.50h on a lead that was passed on. Real hours
-- that are not revenue and never will be.
INSERT INTO time_entries (project_id, entry_date, hours, billable, note)
SELECT p.id, v.entry_date, v.hours, v.billable, v.note
FROM projects p CROSS JOIN (VALUES
  ((CURRENT_DATE - INTERVAL '9 months')::DATE, 1.50, false, 'Discovery call and a scoping note. We passed; nothing was billed.')
) AS v(entry_date, hours, billable, note)
WHERE p.name = 'Warehouse Robotics Scoping';


-- ============================================================
-- Does this seed actually bind the roles?
--
-- Asserted, not claimed. Each check below is the binding condition from the
-- role list, run against what was just inserted; a failure aborts the load with
-- the reason. The alternative is a suite that reports "3 cases skipped: the
-- data this needs is absent" and a reader who has to work out why.
--
-- These are also the checks that catch an edit. Rename a project, add a client,
-- change an amount, and whichever of these no longer holds says so at load
-- time rather than in an answer.
-- ============================================================

DO $seed$
DECLARE
  collisions TEXT;
BEGIN
  -- client_multi_project: a real client with MORE THAN ONE project, so an
  -- ambiguous write has to ask which one is meant.
  IF NOT EXISTS (
    SELECT 1 FROM clients c JOIN projects p ON p.client_id = c.id
    WHERE c.engagement_kind = 'client'
    GROUP BY c.id HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'seed: no client with engagement_kind=client has more than one project, so client_multi_project cannot bind';
  END IF;

  -- client_with_project: a real client with at least one.
  IF NOT EXISTS (
    SELECT 1 FROM clients c JOIN projects p ON p.client_id = c.id
    WHERE c.engagement_kind = 'client'
  ) THEN
    RAISE EXCEPTION 'seed: no client with engagement_kind=client has a project, so client_with_project cannot bind';
  END IF;

  -- passed_lead.
  IF NOT EXISTS (SELECT 1 FROM clients WHERE engagement_kind = 'passed') THEN
    RAISE EXCEPTION 'seed: no row has engagement_kind=passed, so passed_lead cannot bind';
  END IF;

  -- inactive_client: BOTH axes. An inactive row that is not a client binds the
  -- wrong thing, which is the confusion the two columns exist to prevent.
  IF NOT EXISTS (
    SELECT 1 FROM clients WHERE status = 'inactive' AND engagement_kind = 'client'
  ) THEN
    RAISE EXCEPTION 'seed: no row is status=inactive AND engagement_kind=client, so inactive_client cannot bind';
  END IF;

  -- client_with_invoices: an invoice reachable from a named client.
  IF NOT EXISTS (
    SELECT 1 FROM invoices i JOIN clients c ON c.id = i.client_id WHERE btrim(c.name) <> ''
  ) THEN
    RAISE EXCEPTION 'seed: no invoice is linked to a named client, so client_with_invoices cannot bind';
  END IF;

  -- contact_at_client / client_of_contact, bound as a pair. The two-hop case
  -- asks what was billed to that contact's client, so require at least one
  -- contact whose client has invoices.
  IF NOT EXISTS (
    SELECT 1 FROM contacts ct
      JOIN clients c ON c.id = ct.client_id
      JOIN invoices i ON i.client_id = c.id
  ) THEN
    RAISE EXCEPTION 'seed: no contact works at a client that has invoices, so the two-hop case has nothing to compose';
  END IF;

  -- single_project: a project name that is not a case-insensitive substring of
  -- any other. Asserted for EVERY pair rather than for one lucky row, so the
  -- role binds whichever project Postgres hands back first.
  SELECT string_agg(DISTINCT a.name || ' is inside ' || b.name, '; ')
    INTO collisions
    FROM projects a JOIN projects b ON a.id <> b.id
   WHERE lower(b.name) LIKE '%' || lower(a.name) || '%';
  IF collisions IS NOT NULL THEN
    RAISE EXCEPTION 'seed: project names contain one another, so a write cannot resolve them and single_project may not bind: %', collisions;
  END IF;

  -- absent_client: the name the suite uses to test that the agent admits it
  -- does not know. Checked across every text column a lookup could match, not
  -- just clients.name, because a mention in a note is enough to make the case
  -- test the opposite of its purpose.
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
    RAISE EXCEPTION 'seed: the absent_client name appears in the data, so it cannot test the unknown case';
  END IF;

  -- Money questions need something on each side of every line.
  IF NOT EXISTS (SELECT 1 FROM invoices WHERE status = 'paid') THEN
    RAISE EXCEPTION 'seed: no invoice is paid, so nothing was ever collected';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM invoices WHERE status = 'open') THEN
    RAISE EXCEPTION 'seed: no invoice is open, so nothing is outstanding';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM invoices WHERE status = 'open' AND due_date IS NOT NULL AND due_date < CURRENT_DATE
  ) THEN
    RAISE EXCEPTION 'seed: nothing is overdue, so overdue and outstanding cannot be told apart';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM invoices WHERE status = 'open' AND due_date IS NOT NULL AND due_date >= CURRENT_DATE
  ) THEN
    RAISE EXCEPTION 'seed: every open invoice is overdue, so a tool conflating the two still passes';
  END IF;

  -- Revenue integrity: nothing that was never a client may carry an invoice.
  IF EXISTS (
    SELECT 1 FROM invoices i JOIN clients c ON c.id = i.client_id
     WHERE c.engagement_kind <> 'client'
  ) THEN
    RAISE EXCEPTION 'seed: an invoice belongs to a row that is not engagement_kind=client, which would put non-revenue into a revenue total';
  END IF;

  -- Hours on both sides of billable.
  IF NOT EXISTS (SELECT 1 FROM time_entries WHERE billable)
     OR NOT EXISTS (SELECT 1 FROM time_entries WHERE NOT billable) THEN
    RAISE EXCEPTION 'seed: time entries must include both billable and non-billable rows';
  END IF;

  -- The rule 001-business.sql could not express in a CHECK, because
  -- engagement_kind is two joins from time_entries.billable.
  IF EXISTS (
    SELECT 1 FROM time_entries t
      JOIN projects p ON p.id = t.project_id
      JOIN clients c ON c.id = p.client_id
     WHERE t.billable AND c.engagement_kind IN ('own_venture', 'artifact')
  ) THEN
    RAISE EXCEPTION 'seed: billable time is logged against an own_venture or artifact engagement, which has nobody to bill';
  END IF;

  -- start_date is the day work began, not the day this file ran. If these are
  -- ever equal, the seed has reproduced the bug the column exists to avoid.
  IF EXISTS (SELECT 1 FROM projects WHERE start_date IS NULL OR start_date >= CURRENT_DATE) THEN
    RAISE EXCEPTION 'seed: a project has no start_date, or one that is not in the past, so nothing distinguishes it from created_at';
  END IF;
END
$seed$;


-- ============================================================
-- Which row satisfies which role
--
-- Checkable without running anything, against the role list the suite binds.
-- The DO block above asserts each of these mechanically; this is here so a
-- reader can see the intent, and see it disagree with the data if someone edits
-- one and not the other.
--
--   client_multi_project   Halden Freight — Dispatch Rewrite, Driver Mobile App,
--                          Terminal Yard Sensors. engagement_kind 'client'.
--                          (Calderwood Diagnostics also qualifies, with two.)
--
--   client_with_project    Halden Freight, and also Calderwood Diagnostics and
--                          Northaven Credit Union.
--
--   passed_lead            Quillon Robotics (declined_by_us). Also
--                          Sable & Vane Interiors (declined_by_them). Both are
--                          engagement_kind 'passed', status 'inactive' — and
--                          neither is a client, which is what the case checks.
--
--   inactive_client        Northaven Credit Union: status 'inactive' AND
--                          engagement_kind 'client'. The only row that is both.
--                          The passed leads are also 'inactive', which is
--                          exactly why the role needs both columns.
--
--   client_with_invoices   Halden Freight (INV-1003, 1004, 1008, 1010, and the
--                          1011 draft), Calderwood Diagnostics (1005, 1006 void,
--                          1007, 1009), Northaven Credit Union (1001, 1002).
--
--   contact_at_client      Dana Ruiz, Operations Director. First contact row,
--                          and her client has invoices.
--   client_of_contact      Halden Freight, bound as her pair.
--
--   single_project         Every project. No name here is a case-insensitive
--                          substring of another, so whichever row binds is
--                          resolvable by a write. Dispatch Rewrite is first and
--                          is the intended target: active, real client, has a
--                          rate.
--
--   absent_client          'Initech' appears in no column of any table. The
--                          assertion above covers names, notes, descriptions
--                          and invoice numbers, not just clients.name.
--
-- ── The money, as written ──
--
-- Recompute these if you change an amount above; nothing keeps them honest.
--
--   collected (status paid)          $110,500   1001, 1002, 1003, 1004, 1005, 1007
--   outstanding (status open)         $33,300   1008, 1009, 1010
--     of which overdue                $24,300   1008 (40 days), 1009 (25 days)
--     of which not yet due             $9,000   1010 (due in 18 days)
--   excluded from both                          1006 void $3,000, 1011 draft $4,500
--
-- ── The hours, as written ──
--
--   43 entries, 257.50h total: 217.00h billable, 40.50h not.
--   Driver Mobile App    67.50h against a 60.00h budget — over by 7.50h
--   Dispatch Rewrite     62.00h against 120.00h            — 51.7% used
--   Lab Results Portal   38.50h against  80.00h            — 48.1% used
--   Loan Origination Audit 29.50h against 40.00h           — 73.8% used
--   HL7 Feed Cleanup     21.50h against  24.00h            — 89.6% used
--   Terminal Yard Sensors 7.50h, no budget set             — not a budget of 0
--   Ledgerlight Internal Tooling 14.50h, all non-billable
--   Statline Hockey Prototype    15.00h, all non-billable
--   Warehouse Robotics Scoping    1.50h, non-billable (a lead we passed on)
--
-- ── Two queries worth running ──
--
--   -- start_date is not created_at, and here they are months apart:
--   SELECT name, start_date, created_at::DATE FROM projects ORDER BY start_date;
--
--   -- the counting rule that needs both columns:
--   SELECT engagement_kind, status, count(*) FROM clients
--    GROUP BY 1, 2 ORDER BY 1, 2;
-- ============================================================
