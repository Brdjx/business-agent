-- ============================================================
-- harbourline — a second complete business
--
-- Applied by hand, NOT by docker-entrypoint-initdb.d:
--
--   npx tsx --env-file=.env scripts/seed.ts seeds/harbourline.sql
--   npx tsx --env-file=.env scripts/seed.ts db/900-seed.sql   (put the default back)
--
-- The --env-file flag is what supplies DATABASE_URL; nothing in this repository loads
-- .env by itself, and scripts/seed.ts refuses to fall back to pg defaults rather than
-- risk truncating a database nobody named. `npm run db:seed -- seeds/harbourline.sql`
-- is the same thing if that script is in package.json (the usage text in src/seed.ts
-- describes it).
--
-- It lives in seeds/ rather than db/ for a mechanical reason: db/ is mounted into
-- docker-entrypoint-initdb.d, so every .sql in it runs as part of schema creation.
-- Two seeds there would both run, and the first unique index on client name or
-- invoice number would decide which half of which business survived.
-- scripts/seed.ts truncates the five business tables and applies this file inside
-- ONE transaction, so a file that fails halfway leaves the dataset that was there
-- before it. Read src/seed.ts before editing: a RAISE in the assertions at the
-- bottom rolls the whole swap back, which is the intended behaviour.
--
-- ── What this file is for ──
--
-- The repository claims that eval cases name SHAPES rather than records, so the
-- same suite runs against any dataset. Until this file existed, nothing had ever
-- run against a database this repository did not seed, so the claim was a design
-- and not a result. This is the half that proves portability: a different business,
-- at a different scale, where every one of the nine roles binds — to records that
-- could not be mistaken for db/900-seed.sql's.
--
-- Nothing is shared with the default seed. No company, no person, no project, no
-- invoice number: 900-seed.sql runs INV-1001..INV-1011 and this runs
-- INV-2001..INV-2062, so a database holding one and then the other cannot pass a
-- stale answer off as a fresh one.
--
-- ── Deliberately larger, and deliberately messier ──
--
--   900-seed.sql   8 clients,   7 contacts,  9 projects, 11 invoices,  43 entries
--   this file     21 clients,  11 contacts, 36 projects, 62 invoices, 200 entries
--
-- Scale is the point, not decoration. A role binds to the FIRST row matching its
-- shape, and with eight clients almost any tie-break lands on the same row, so a
-- binder that forgot to order its query would still look deterministic. Here there
-- are ten clients that could bind client_multi_project, fourteen that could bind
-- client_with_project and thirty-six projects that could bind single_project, so the
-- tie-break is doing visible work.
--
-- Which is why the INSERT ORDER BELOW DISAGREES WITH ALPHABETICAL ORDER on purpose.
-- src/agent/evals/roles.ts orders every binding query by name; a freshly loaded
-- table hands rows back in heap order, which is insert order. The two therefore pick
-- different rows here, and the role map at the bottom names the ones the ORDER BY
-- picks. If someone drops an ORDER BY from the binder, this dataset says so — the
-- printed binding stops matching the map — where 900-seed.sql, whose richest record
-- is also first, would go on looking correct.
--
-- ── Dates are relative ──
--
-- Every date is derived from CURRENT_DATE at load time. A literal date rots in a
-- specific and misleading way: the invoice written as "not due for three weeks"
-- becomes overdue a month later, and then the whole dataset reads as a business
-- drowning in unpaid work. Relative dates keep "overdue", "just issued" and "paid
-- two years ago" true whenever anyone applies this.
--
-- created_at is left to its default, which is the moment of the swap. Project
-- start_dates run from 37 months ago to 2 months ago, so the two columns visibly
-- disagree and a tool that reaches for created_at when it wanted start_date is
-- visibly wrong. The assertions at the bottom check that.
--
-- ── Invented names ──
--
-- No real company or person appears here. 'Initech' appears in no text column of any
-- table, so the absent_client role has something to be absent about, and the
-- assertions check every text column rather than only clients.name — a mention in a
-- note is enough to make that case test the opposite of its purpose.
--
-- Not idempotent. Re-running it violates the unique indexes on client name and
-- invoice number, loudly. scripts/seed.ts truncates first, which is how it is meant
-- to be re-applied.
-- ============================================================


-- ---------- clients ----------
--
-- Insert order is richest-first, which is NOT name order. See the header: the binder
-- orders by name, so heap order and the binding disagree here by construction.
--
-- Two columns carry two different questions and have to be read together
-- (db/001-business.sql says why at length):
--
--   worked with     engagement_kind = 'client' AND status IN ('active','inactive')
--   live clients    engagement_kind = 'client' AND status = 'active'
--   never a client  engagement_kind <> 'client' OR status = 'prospect'
--
-- So this list contains, on purpose, rows that a filter on one column alone gets
-- wrong: three leads that were passed on (all status 'inactive', none ever a
-- client), one prospect with a client relationship that has not started, one own
-- venture and one artifact.

INSERT INTO clients (name, status, engagement_kind, disposition, website, city, country, default_rate_cents, notes) VALUES
  -- The richest record: six projects, twelve invoices, two contacts. It binds
  -- client_multi_project because it is the alphabetically first client with more
  -- than one project, not because it is first here.
  ('Barrowfield Grain', 'active', 'client', 'ongoing',
   'https://barrowfieldgrain.example', 'Moses Lake', 'US', 17500,
   'Grain co-operative, four sites. Everything is seasonal: harvest is eight weeks and nothing ships in January. Wendell approves scope, the scale house decides whether it works.'),

  -- Most OPEN invoices of any client, which is what binds client_with_invoices:
  -- the binder prefers a client whose invoices can be itemized, since
  -- invoice_summary lists only the open ones.
  ('Fenwright Cold Storage', 'active', 'client', 'ongoing',
   'https://fenwrightcold.example', 'Everett', 'US', 20000,
   'Refrigerated warehousing. An alarm that is ignored is worse than no alarm, so every threshold here was argued about twice. Their AP moved systems this year and payment got slower.'),

  ('Estcourt Rail Terminal', 'active', 'client', 'ongoing',
   'https://estcourtrail.example', 'Longview', 'US', 18500,
   'Bulk rail transload. The state weighs and inspects, so anything touching the weighbridge carries a calibration record whether we like it or not.'),

  -- Alphabetically first client with a project, and alphabetically first client
  -- with invoices, so it binds client_with_project AND client_of_contact. One
  -- project deliberately: client_with_project and client_multi_project must not
  -- collapse onto the same row, or nothing proves the two predicates differ.
  ('Alderpoint Marine Supply', 'active', 'client', 'ongoing',
   'https://alderpointmarine.example', 'Bellingham', 'US', 19500,
   'Fuel and chandlery for a working harbour. One project, four invoices, and an operations manager who reads every reconciliation line.'),

  -- country CA, currency still USD. Country is not currency: every invoice in this
  -- file is USD, because SUM(amount_cents) across two currencies means nothing and
  -- nothing in this repository groups by invoices.currency yet.
  ('Glasswater Ferries', 'active', 'client', 'ongoing',
   'https://glasswaterferries.example', 'Sidney', 'CA', 17000,
   'Two-vessel passenger and vehicle ferry. Fares are decided by vehicle length more than by passengers, which nobody outside the terminal expects.'),

  ('Dunmarrow Pediatrics', 'active', 'client', 'ongoing',
   'https://dunmarrowpeds.example', 'Eugene', 'US', 21500,
   'Four-clinic practice. Anything touching a patient letter goes past their nurse lead first, and the recall rules are the whole job.'),

  ('Marrowick Title & Escrow', 'active', 'client', 'ongoing',
   'https://marrowicktitle.example', 'Spokane', 'US', 19000,
   'Title and escrow. Wire fraud is the risk that keeps them awake, so the confirmation flow was written with their insurer policy open on the table.'),

  ('Vantham Orthopaedics', 'active', 'client', 'ongoing',
   'https://vanthamortho.example', 'Boise', 'US', 22000,
   'Surgical practice with a registry obligation that changes its submission spec every year. Theatre time is the constraint on everything.'),

  ('Larkspit Brewing', 'active', 'client', 'ongoing',
   'https://larkspitbrewing.example', 'Bend', 'US', 14500,
   'Brewery and tap room. The missing money was waste and samples, not sales, which took an inventory night to see.'),

  ('Wrayburn Cycle Works', 'active', 'client', 'ongoing',
   'https://wrayburncycles.example', 'Missoula', 'US', 13500,
   'Small frame builder, four months in: one project, one paid invoice, and paint is the bottleneck. Yarrowmere Dental Arts is newer still and has nothing recorded at all.'),

  -- inactive_client: status inactive AND engagement_kind client. Alphabetically
  -- first of the four rows that are both, so it is the one that binds. The eval
  -- case tells the agent to mark them inactive and the correct answer is that they
  -- already are.
  ('Caldbeck Timber Group', 'inactive', 'client', 'completed',
   'https://caldbecktimber.example', 'Coos Bay', 'US', 16500,
   'Sawmill and yard. The oldest engagement here: work from 37 months ago to 23, finished and accepted. They still send a Christmas card and no purchase orders.'),

  ('Kirkhollow Mutual', 'inactive', 'client', 'handed_off',
   'https://kirkhollowmutual.example', 'Sioux Falls', 'US', 15500,
   'Insurer. Claims intake triage, then handed to their own team with the rules written where they can edit them. Over, and on good terms.'),

  ('Netherby Provident Trust', 'inactive', 'client', 'completed',
   'https://netherbyprovident.example', 'Rochester', 'US', 16000,
   'Credit union. Member statements rebuilt end to end, parallel run for two months, done. Nothing open and nothing expected.'),

  ('Sowerby Rock Quarry', 'inactive', 'client', 'completed',
   NULL, 'Bakersfield', 'US', 15000,
   'Aggregate quarry. Haul ticketing, delivered and paid, and they still keep the paper ticket book as a fallback. Nothing open.'),

  -- passed_lead: took a call, never became a client. Alphabetically FIRST of every
  -- client row in this file, and it carries two project rows and a primary contact.
  -- That is the trap, deliberately sharpened from the one 900-seed.sql sets: a
  -- binder that filtered on status alone, or that dropped engagement_kind from the
  -- client_with_project and client_multi_project queries, would bind a company that
  -- was never a client and every lookup case would then assert about it.
  ('Ambervale Freightworks', 'inactive', 'passed', 'declined_by_us',
   'https://ambervalefreight.example', 'Tacoma', 'US', NULL,
   'Two calls and a yard walk. Fixed bid, no software owner on their side, and a schedule that only worked if nothing went wrong. We passed. Never a client, never billed.'),

  ('Orrenshaw Optics', 'inactive', 'passed', 'declined_by_them',
   NULL, 'Akron', 'US', NULL,
   'Wanted the lens line work, went with their machine vendor instead. Never a client, and never billed.'),

  ('Rhosmere Vineyards', 'inactive', 'passed', 'declined_by_us',
   NULL, 'Walla Walla', 'US', NULL,
   'One call. They wanted a rewrite of something that was working. Never a client; no project row, because nothing was ever scoped.'),

  -- status = prospect with engagement_kind = client: a client relationship that has
  -- not started. Present so the third status value is not decorative, and so
  -- anything answering "who have we worked with" is forced to filter on BOTH
  -- columns. It also carries a primary contact, which is the second half of the
  -- contact trap.
  ('Pellworth Dairy', 'prospect', 'client', NULL,
   'https://pellworthdairy.example', 'Tillamook', 'US', NULL,
   'Intro call booked, nothing agreed, nothing billed, no project. Not someone we have worked with yet, however early they sort in a client list.'),

  -- A live client with nothing recorded against it yet. Realistic, and useful: it
  -- is someone the studio HAS worked with by the predicate above, with zero
  -- projects, zero invoices and zero hours, so an answer about them has to say
  -- "nothing recorded" rather than nothing at all.
  ('Yarrowmere Dental Arts', 'active', 'client', 'ongoing',
   'https://yarrowmeredental.example', 'Salem', 'US', 18000,
   'Signed a fortnight ago. No project, no invoice and no hours yet: the engagement exists and the record of work does not.'),

  -- own_venture: ours. Never billable, never revenue, and not a client however it
  -- sorts. The file is named after it.
  ('Harbourline Atlas', 'active', 'own_venture', 'ongoing',
   'https://harbourlineatlas.example', 'Bellingham', 'US', NULL,
   'Ours. The reconciliation and timesheet tooling the studio runs on. Never billable, never revenue, and not a client.'),

  -- artifact: built for another reason entirely. Kept because deleting it would
  -- lose the work; counted as nothing.
  ('Tidegauge Almanac', 'inactive', 'artifact', 'completed',
   NULL, NULL, 'US', NULL,
   'A take-home built for an interview. A record of the work, not an engagement: no client, no invoice, no billable hour.');


-- ---------- contacts ----------
--
-- Eleven people. Insert order is again not name order and not binding order:
-- Wendell Craye is first, and the pair that binds is Imogen Faulk at Alderpoint
-- Marine Supply, because roles.ts orders by (client has invoices) DESC,
-- is_primary DESC, client name, contact name — and Alderpoint is the
-- alphabetically first client with invoices that has a primary contact.
--
-- The trap, kept from 900-seed.sql and made harder: Rennick Loach is the primary
-- contact at a lead that was passed on, and Juno Thackeray is the primary contact
-- at a prospect. Both companies sort BEFORE most of the real clients, and neither
-- has ever been billed. A binder that took the first contact carrying a client_id
-- would land on one of them, and the two-hop case would then ask what was invoiced
-- to somebody who was never invoiced — a case that fails for being unanswerable
-- rather than for the tools failing to compose.

INSERT INTO contacts (client_id, first_name, last_name, email, phone, title, is_primary, notes) VALUES
  ((SELECT id FROM clients WHERE name = 'Barrowfield Grain'),
   'Wendell', 'Craye', 'wendell.craye@barrowfieldgrain.example', '+1-509-555-0142',
   'General Manager', true,
   'Approves scope and budget. Will not agree to anything in August, and says so plainly.'),

  ((SELECT id FROM clients WHERE name = 'Barrowfield Grain'),
   'Silje', 'Nordmo', 'silje.nordmo@barrowfieldgrain.example', NULL,
   'Scale House Lead', false,
   'The person the intake work is actually for. Worth asking before changing a screen anyone uses with gloves on.'),

  ((SELECT id FROM clients WHERE name = 'Fenwright Cold Storage'),
   'Aurelio', 'Pask', 'aurelio.pask@fenwrightcold.example', '+1-425-555-0188',
   'Facilities Director', true,
   'Carries the alarm phone himself. Every suppression rule in the alarms project was his idea first.'),

  ((SELECT id FROM clients WHERE name = 'Estcourt Rail Terminal'),
   'Osric', 'Delap', 'osric.delap@estcourtrail.example', NULL,
   'Terminal Manager', true,
   'Reads the tonnage report at six every morning and notices when a number moves.'),

  -- The pair the suite binds: contact_at_client here, client_of_contact on the
  -- Alderpoint row above. No read tool in this repository returns a contact, which
  -- is the point of the case that uses her — the record exists, the tools cannot
  -- reach it, and an answer naming her got the name from somewhere other than the
  -- database.
  ((SELECT id FROM clients WHERE name = 'Alderpoint Marine Supply'),
   'Imogen', 'Faulk', 'imogen.faulk@alderpointmarine.example', '+1-360-555-0117',
   'Operations Manager', true,
   'Signs off the fuel reconciliation every month and finds the one line that is wrong.'),

  ((SELECT id FROM clients WHERE name = 'Alderpoint Marine Supply'),
   'Teodor', 'Brix', 'teodor.brix@alderpointmarine.example', NULL,
   'Fleet Supervisor', false,
   'Knows which boats actually fuelled where, which the card exports do not.'),

  ((SELECT id FROM clients WHERE name = 'Caldbeck Timber Group'),
   'Bettina', 'Halloway', 'bettina.halloway@caldbecktimber.example', NULL,
   'Controller', true,
   'Commissioned the yard scheduling work and took the closing report to their board. The engagement is over; she is not.'),

  ((SELECT id FROM clients WHERE name = 'Vantham Orthopaedics'),
   'Halvard', 'Sein', 'halvard.sein@vanthamortho.example', NULL,
   'Practice Administrator', true,
   'Owns the registry deadline, which is the only date that cannot move.'),

  -- A primary contact at a lead that was passed on. Realistic, and a trap worth
  -- leaving armed.
  ((SELECT id FROM clients WHERE name = 'Ambervale Freightworks'),
   'Rennick', 'Loach', 'rennick@ambervalefreight.example', NULL,
   'Owner', true,
   'Both discovery calls were with him. Not a client contact, because they never became a client.'),

  -- And one at a prospect, which has not started and has never been billed.
  ((SELECT id FROM clients WHERE name = 'Pellworth Dairy'),
   'Juno', 'Thackeray', 'juno.thackeray@pellworthdairy.example', NULL,
   'Plant Manager', true,
   'Booked the intro call. Nothing has been agreed and nothing has been billed.'),

  -- client_id NULL: met at a conference, with no engagement to attach her to.
  -- Inventing a client row to hold a person is how a client list acquires companies
  -- that were never clients.
  (NULL,
   'Perpetua', 'Nkemdi', 'perpetua@nkemdi.example', NULL,
   'Independent CTO', false,
   'Met at a port logistics conference. No company row because there is no engagement yet.');


-- ---------- projects ----------
--
-- Thirty-six, and every name is mutually non-substring, case-insensitively. That is
-- not an aesthetic rule: the agent resolves a project with ILIKE '%phrase%' and
-- log_time refuses to write when more than one row matches, so a pair like
-- "Silo Telemetry" and "Silo Telemetry Phase 2" leaves single_project unbindable and
-- silently skips every write case in the suite. At this size the pair is easy to
-- write by accident, so the assertion at the bottom checks ALL 1,260 ordered pairs
-- rather than one lucky row. It also catches a duplicated name, which matters here
-- for a second reason: the time entries below are attached by
-- `WHERE p.name = '...'`, and two projects sharing a name would silently get two
-- copies of the same hours.
--
-- The six Barrowfield Grain projects all begin with the client name, which is
-- deliberate. write-refuses-ambiguity passes the CLIENT name to a write, so
-- ILIKE '%Barrowfield Grain%' matches six projects and the refusal has to list a
-- real handful and ask which — rather than matching nothing and asking a vaguer
-- question.
--
-- single_project binds to Alderpoint Fleet Fuel Audit: the alphabetically first
-- project name, on an active project at a real client with a rate, which is what a
-- write case wants to land on.

INSERT INTO projects (client_id, name, description, status, rate_cents, budget_hours, start_date, end_date) VALUES
  -- Barrowfield Grain: six projects, one of them over budget, one with no budget at
  -- all, and one budgeted in the ordinary way.
  ((SELECT id FROM clients WHERE name = 'Barrowfield Grain'),
   'Barrowfield Grain Intake Scales',
   'Ticketing at the weighbridge: one truck, many loads, one settlement. Finished inside its budget.',
   'completed', 17500, 80.00,
   (CURRENT_DATE - INTERVAL '23 months')::DATE, (CURRENT_DATE - INTERVAL '19 months')::DATE),

  ((SELECT id FROM clients WHERE name = 'Barrowfield Grain'),
   'Barrowfield Grain Silo Telemetry',
   'Level and temperature across six bins, with alarm rules that watch the rate of rise rather than a threshold. Over budget, and still running.',
   'active', 17500, 70.00,
   (CURRENT_DATE - INTERVAL '19 months')::DATE, NULL),

  ((SELECT id FROM clients WHERE name = 'Barrowfield Grain'),
   'Barrowfield Grain Driver Kiosk',
   'Self-service ticketing at the scale house window, offline tolerant because the yard loses signal behind the bins.',
   'completed', 17500, 45.00,
   (CURRENT_DATE - INTERVAL '12 months')::DATE, (CURRENT_DATE - INTERVAL '9 months')::DATE),

  ((SELECT id FROM clients WHERE name = 'Barrowfield Grain'),
   'Barrowfield Grain Moisture Lab',
   'Paused: waiting on their instrument vendor. No budget was ever agreed, which is not a budget of zero.',
   'paused', 17500, NULL,
   (CURRENT_DATE - INTERVAL '6 months')::DATE, NULL),

  ((SELECT id FROM clients WHERE name = 'Barrowfield Grain'),
   'Barrowfield Grain Rail Loadout',
   'Loadout sequencing and weight allocation across railcars, to the tolerance the railroad enforces. Rated above the client default.',
   'active', 18000, 60.00,
   (CURRENT_DATE - INTERVAL '5 months')::DATE, NULL),

  ((SELECT id FROM clients WHERE name = 'Barrowfield Grain'),
   'Barrowfield Grain Grower Statements',
   'Settlement statements, including the deferred payment contracts their spreadsheet got wrong twice a year.',
   'active', 17500, 35.00,
   (CURRENT_DATE - INTERVAL '3 months')::DATE, NULL),

  -- Fenwright Cold Storage
  ((SELECT id FROM clients WHERE name = 'Fenwright Cold Storage'),
   'Fenwright Cold Chain Alarms',
   'Probe monitoring across four rooms and two trailers, with an escalation ladder and a defrost suppression window.',
   'active', 20000, 90.00,
   (CURRENT_DATE - INTERVAL '17 months')::DATE, NULL),

  ((SELECT id FROM clients WHERE name = 'Fenwright Cold Storage'),
   'Fenwright Dock Scheduling',
   'Appointment slots for carriers, using the dwell time each one actually takes rather than the one they book.',
   'active', 20000, 55.00,
   (CURRENT_DATE - INTERVAL '5 months')::DATE, NULL),

  ((SELECT id FROM clients WHERE name = 'Fenwright Cold Storage'),
   'Fenwright Pallet Label Print',
   'Cancelled a fortnight in: they bought a vendor module instead. The half we had done was absorbed.',
   'cancelled', 20000, 12.00,
   (CURRENT_DATE - INTERVAL '9 months')::DATE, (CURRENT_DATE - INTERVAL '8 months')::DATE),

  -- Estcourt Rail Terminal
  ((SELECT id FROM clients WHERE name = 'Estcourt Rail Terminal'),
   'Estcourt Railcar Weighbridge',
   'Axle-by-axle capture, car identity from the AEI reader, and a calibration log the state inspector signs.',
   'active', 18500, 95.00,
   (CURRENT_DATE - INTERVAL '13 months')::DATE, NULL),

  -- budget_hours = 0.00, and this is the one row in either seed that exercises it.
  -- db/001-business.sql says the difference between NULL and 0 is load-bearing:
  -- NULL means nobody agreed a budget, 0 means the budget is zero and every hour is
  -- over it. read.ts has a branch for each and the default seed reaches only the
  -- NULL one.
  ((SELECT id FROM clients WHERE name = 'Estcourt Rail Terminal'),
   'Estcourt Gate Camera Feed',
   'Plate reads into the gate log. Budgeted at zero hours because it was folded into the weighbridge budget, so every hour logged is over it.',
   'paused', 18500, 0.00,
   (CURRENT_DATE - INTERVAL '4 months')::DATE, NULL),

  -- Alderpoint Marine Supply: one project, and the one single_project binds to.
  ((SELECT id FROM clients WHERE name = 'Alderpoint Marine Supply'),
   'Alderpoint Fleet Fuel Audit',
   'Matching fuel card transactions to vessels and voyages, and reporting the fills that match nothing.',
   'active', 19500, 90.00,
   (CURRENT_DATE - INTERVAL '10 months')::DATE, NULL),

  -- Glasswater Ferries
  ((SELECT id FROM clients WHERE name = 'Glasswater Ferries'),
   'Glasswater Ticketing Kiosk',
   'Dockside fare sales, including the resident discount nobody had written down and the vehicle length classes that decide the price.',
   'completed', 17000, 70.00,
   (CURRENT_DATE - INTERVAL '15 months')::DATE, (CURRENT_DATE - INTERVAL '5 months')::DATE),

  ((SELECT id FROM clients WHERE name = 'Glasswater Ferries'),
   'Glasswater Crew Rostering',
   'Rosters that refuse an illegal watch: rest hours, endorsements, and the union agreement.',
   'active', 17000, 40.00,
   (CURRENT_DATE - INTERVAL '4 months')::DATE, NULL),

  -- Dunmarrow Pediatrics
  ((SELECT id FROM clients WHERE name = 'Dunmarrow Pediatrics'),
   'Dunmarrow Immunisation Recall',
   'Who is due what, and why: age bands, intervals, the catch-up table, and a suppression list so no family is written to twice in a week.',
   'completed', 21500, 65.00,
   (CURRENT_DATE - INTERVAL '20 months')::DATE, (CURRENT_DATE - INTERVAL '12 months')::DATE),

  ((SELECT id FROM clients WHERE name = 'Dunmarrow Pediatrics'),
   'Dunmarrow Portal Accessibility',
   'The booking flow was unusable with a screen reader at step three. Contrast, focus order, and the date picker rewritten.',
   'completed', 21500, 24.00,
   (CURRENT_DATE - INTERVAL '7 months')::DATE, (CURRENT_DATE - INTERVAL '6 months')::DATE),

  -- Marrowick Title & Escrow
  ((SELECT id FROM clients WHERE name = 'Marrowick Title & Escrow'),
   'Marrowick Closing Packet Assembly',
   'Assembling a closing packet in the page order the county requires, with the notary page last and an audit log for the page that goes missing.',
   'active', 19000, 75.00,
   (CURRENT_DATE - INTERVAL '9 months')::DATE, NULL),

  ((SELECT id FROM clients WHERE name = 'Marrowick Title & Escrow'),
   'Marrowick Wire Confirmation',
   'Call-back confirmation before any wire instruction is accepted, written against their fraud policy.',
   'active', 19000, 18.00,
   (CURRENT_DATE - INTERVAL '2 months')::DATE, NULL),

  -- Vantham Orthopaedics
  ((SELECT id FROM clients WHERE name = 'Vantham Orthopaedics'),
   'Vantham Implant Registry',
   'Registry submissions built and validated before they leave the building, with revision linkage so a second operation finds the first.',
   'active', 22000, 80.00,
   (CURRENT_DATE - INTERVAL '10 months')::DATE, NULL),

  -- A project with a budget and NO hours at all. Not the same as a project with no
  -- budget: here somebody agreed thirty hours and nobody has spent one.
  ((SELECT id FROM clients WHERE name = 'Vantham Orthopaedics'),
   'Vantham Theatre Scheduling',
   'Agreed, then their theatre refit slipped. Paused before any work: thirty hours budgeted, none logged.',
   'paused', 22000, 30.00,
   (CURRENT_DATE - INTERVAL '3 months')::DATE, NULL),

  -- Larkspit Brewing
  ((SELECT id FROM clients WHERE name = 'Larkspit Brewing'),
   'Larkspit Tap Room Inventory',
   'Keg tracking by tap off the pour meters they already own, plus the waste and samples that were the missing money.',
   'active', 14500, 55.00,
   (CURRENT_DATE - INTERVAL '8 months')::DATE, NULL),

  -- Wrayburn Cycle Works
  ((SELECT id FROM clients WHERE name = 'Wrayburn Cycle Works'),
   'Wrayburn Frame Build Tracker',
   'Build stages from the jig sheet on their wall, serial numbers for warranty, and the paint queue that is the real bottleneck.',
   'active', 13500, 32.00,
   (CURRENT_DATE - INTERVAL '4 months')::DATE, NULL),

  -- Caldbeck Timber Group: finished, inactive, and the longest engagement here.
  ((SELECT id FROM clients WHERE name = 'Caldbeck Timber Group'),
   'Caldbeck Yard Scheduling',
   'The mill schedule, which was a whiteboard and a phone. Saw line capacity, kiln availability, and rescheduling on a breakdown.',
   'completed', 16500, 75.00,
   (CURRENT_DATE - INTERVAL '37 months')::DATE, (CURRENT_DATE - INTERVAL '23 months')::DATE),

  ((SELECT id FROM clients WHERE name = 'Caldbeck Timber Group'),
   'Caldbeck Kiln Sensor Rollout',
   'Probe bus reader and drying curves against schedule. It went over budget, and it found a kiln stalling weekly.',
   'completed', 16500, 24.00,
   (CURRENT_DATE - INTERVAL '29 months')::DATE, (CURRENT_DATE - INTERVAL '26 months')::DATE),

  -- Cancelled, with hours and no invoice. Real work that was never billed to
  -- anyone, on a client that was unmistakably a client.
  ((SELECT id FROM clients WHERE name = 'Caldbeck Timber Group'),
   'Caldbeck Log Deck Reports',
   'Cancelled when their scanner contract lapsed. Half a report, some hours, and no invoice: nothing was billed for it.',
   'cancelled', 16500, 20.00,
   (CURRENT_DATE - INTERVAL '25 months')::DATE, (CURRENT_DATE - INTERVAL '24 months')::DATE),

  -- Kirkhollow Mutual
  ((SELECT id FROM clients WHERE name = 'Kirkhollow Mutual'),
   'Kirkhollow Claims Intake Triage',
   'Triage rules written with their senior adjuster in the room, an intake form that stops asking once the answer is decided, and duplicate detection.',
   'completed', 15500, 70.00,
   (CURRENT_DATE - INTERVAL '30 months')::DATE, (CURRENT_DATE - INTERVAL '21 months')::DATE),

  ((SELECT id FROM clients WHERE name = 'Kirkhollow Mutual'),
   'Kirkhollow Adjuster Dashboard',
   'The ageing view their claims committee asks for, built from the queues that already existed rather than new ones.',
   'completed', 15500, 26.00,
   (CURRENT_DATE - INTERVAL '24 months')::DATE, (CURRENT_DATE - INTERVAL '21 months')::DATE),

  -- Netherby Provident Trust
  ((SELECT id FROM clients WHERE name = 'Netherby Provident Trust'),
   'Netherby Member Statements',
   'Statements rebuilt to the cent against the core ledger, in the print stream their mail house actually accepts, with a real consent record for electronic delivery.',
   'completed', 16000, 70.00,
   (CURRENT_DATE - INTERVAL '34 months')::DATE, (CURRENT_DATE - INTERVAL '25 months')::DATE),

  ((SELECT id FROM clients WHERE name = 'Netherby Provident Trust'),
   'Netherby Branch Rollup',
   'A branch rollup taken from the ledger rather than from the statements, reconciled against their month end.',
   'completed', 16000, 22.00,
   (CURRENT_DATE - INTERVAL '28 months')::DATE, (CURRENT_DATE - INTERVAL '26 months')::DATE),

  -- Sowerby Rock Quarry
  ((SELECT id FROM clients WHERE name = 'Sowerby Rock Quarry'),
   'Sowerby Haul Ticketing',
   'Ticket capture at the scale with one hand and gloves on, material and destination codes from their price book, and a daily haul report.',
   'completed', 15000, 50.00,
   (CURRENT_DATE - INTERVAL '36 months')::DATE, (CURRENT_DATE - INTERVAL '31 months')::DATE),

  -- Two projects on a lead that was passed on. db/001-business.sql notes that a
  -- passed lead sometimes has project rows, and that binding it as "a client with
  -- projects" makes every lookup case assert about someone who was never a client.
  -- Two rows here rather than one, so that a binder missing the engagement_kind
  -- filter would bind client_multi_project to it as well.
  ((SELECT id FROM clients WHERE name = 'Ambervale Freightworks'),
   'Ambervale Yard Survey',
   'A site walk and a written-up view of what a yard system would have to do. Cancelled: we passed on the work.',
   'cancelled', NULL, NULL,
   (CURRENT_DATE - INTERVAL '13 months')::DATE, (CURRENT_DATE - INTERVAL '13 months')::DATE),

  ((SELECT id FROM clients WHERE name = 'Ambervale Freightworks'),
   'Ambervale Rate Card Review',
   'Read their rate card and said the fixed bid did not fit. Cancelled, and never billed.',
   'cancelled', NULL, NULL,
   (CURRENT_DATE - INTERVAL '12 months')::DATE, (CURRENT_DATE - INTERVAL '12 months')::DATE),

  ((SELECT id FROM clients WHERE name = 'Orrenshaw Optics'),
   'Orrenshaw Lens Line Scoping',
   'One call and a scoping note. They went with a machine vendor. Cancelled, and never billed.',
   'cancelled', NULL, NULL,
   (CURRENT_DATE - INTERVAL '6 months')::DATE, (CURRENT_DATE - INTERVAL '6 months')::DATE),

  -- Own venture: hours, no rate, and no invoice is possible.
  ((SELECT id FROM clients WHERE name = 'Harbourline Atlas'),
   'Harbourline Atlas Ingest',
   'Ours: bank export ingest, statement matching and the reconciliation screen. Never billable.',
   'active', NULL, NULL,
   (CURRENT_DATE - INTERVAL '14 months')::DATE, NULL),

  ((SELECT id FROM clients WHERE name = 'Harbourline Atlas'),
   'Harbourline Atlas Timesheet Import',
   'Ours: timesheet import, rounding rules, and a report saying which hours cannot be billed to anyone. Never billable.',
   'active', NULL, NULL,
   (CURRENT_DATE - INTERVAL '7 months')::DATE, NULL),

  -- Artifact: the take-home itself.
  ((SELECT id FROM clients WHERE name = 'Tidegauge Almanac'),
   'Tidegauge Almanac Prototype',
   'The take-home: ingest thirty years of tide tables, normalise them, query them, chart the extremes.',
   'completed', NULL, NULL,
   (CURRENT_DATE - INTERVAL '21 months')::DATE, (CURRENT_DATE - INTERVAL '21 months')::DATE);


-- ---------- invoices ----------
--
-- Sixty-two rows, in issue order, so the numbers read chronologically. The three
-- drafts are last because a draft has no issue date at all — the number was
-- reserved, nothing was sent.
--
-- INV-2001..INV-2062, deliberately not the 1001..1011 range db/900-seed.sql uses.
-- A database that held one dataset and then the other cannot answer with a stale
-- number that happens to still exist.
--
-- Every invoice belongs to a client with engagement_kind = 'client' AND a status
-- other than 'prospect'. The passed leads, the own venture, the artifact and the
-- prospect have none, which is what makes "revenue" answerable at all: an own
-- venture invoicing itself is money that never existed, and a prospect that has
-- been billed is a contradiction in the two columns.
--
-- Money is integer cents. 2200000 is $22,000. The arithmetic is written out at the
-- bottom of this file AND asserted, so an edited amount here fails the load rather
-- than quietly making the comment untrue.
--
-- The traps this file keeps armed, all three of which a total written as
-- `status <> 'paid'` gets wrong:
--
--   INV-2031  void, and reissued as INV-2032 at the same amount
--   INV-2043  void, and NOT reissued, because nothing was owed
--   three drafts, never sent
--
-- Overdue is derived — status = 'open' AND due_date < CURRENT_DATE — so the four
-- overdue rows use day arithmetic and stay overdue however long this file sits
-- unread. The eight open rows that are NOT yet due are what stop a tool conflating
-- "outstanding" with "overdue" and passing anyway.

INSERT INTO invoices (client_id, number, status, amount_cents, currency, description, notes, issued_at, due_date, paid_at) VALUES
  -- Three years of history, so a question about "last year" has to filter on a date
  -- rather than summing the table.
  ((SELECT id FROM clients WHERE name = 'Caldbeck Timber Group'),
   'INV-2001', 'paid', 2200000, 'USD', 'Yard scheduling - discovery and design', NULL,
   (CURRENT_DATE - INTERVAL '36 months')::DATE,
   (CURRENT_DATE - INTERVAL '35 months')::DATE,
   (CURRENT_DATE - INTERVAL '35 months')::DATE),

  ((SELECT id FROM clients WHERE name = 'Sowerby Rock Quarry'),
   'INV-2002', 'paid', 960000, 'USD', 'Haul ticketing - phase 1', NULL,
   (CURRENT_DATE - INTERVAL '35 months')::DATE,
   (CURRENT_DATE - INTERVAL '34 months')::DATE,
   (CURRENT_DATE - INTERVAL '34 months')::DATE),

  ((SELECT id FROM clients WHERE name = 'Caldbeck Timber Group'),
   'INV-2003', 'paid', 1850000, 'USD', 'Yard scheduling - build', NULL,
   (CURRENT_DATE - INTERVAL '34 months')::DATE,
   (CURRENT_DATE - INTERVAL '33 months')::DATE,
   (CURRENT_DATE - INTERVAL '33 months')::DATE),

  ((SELECT id FROM clients WHERE name = 'Netherby Provident Trust'),
   'INV-2004', 'paid', 1475000, 'USD', 'Member statements - phase 1', NULL,
   (CURRENT_DATE - INTERVAL '33 months')::DATE,
   (CURRENT_DATE - INTERVAL '32 months')::DATE,
   (CURRENT_DATE - INTERVAL '32 months')::DATE),

  -- Paid two months after it was issued, one month after it was due. paid_at is the
  -- date the money arrived and it is not the due date; a tool that used due_date as
  -- a proxy for cash would put this month in the wrong month.
  ((SELECT id FROM clients WHERE name = 'Sowerby Rock Quarry'),
   'INV-2005', 'paid', 740000, 'USD', 'Haul ticketing - final and handover',
   'Paid a month late. Their office was between bookkeepers.',
   (CURRENT_DATE - INTERVAL '32 months')::DATE,
   (CURRENT_DATE - INTERVAL '31 months')::DATE,
   (CURRENT_DATE - INTERVAL '30 months')::DATE),

  ((SELECT id FROM clients WHERE name = 'Caldbeck Timber Group'),
   'INV-2006', 'paid', 1125000, 'USD', 'Yard scheduling - cutover and training', NULL,
   (CURRENT_DATE - INTERVAL '31 months')::DATE,
   (CURRENT_DATE - INTERVAL '30 months')::DATE,
   (CURRENT_DATE - INTERVAL '30 months')::DATE),

  ((SELECT id FROM clients WHERE name = 'Netherby Provident Trust'),
   'INV-2007', 'paid', 990000, 'USD', 'Member statements - phase 2', NULL,
   (CURRENT_DATE - INTERVAL '30 months')::DATE,
   (CURRENT_DATE - INTERVAL '29 months')::DATE,
   (CURRENT_DATE - INTERVAL '29 months')::DATE),

  ((SELECT id FROM clients WHERE name = 'Kirkhollow Mutual'),
   'INV-2008', 'paid', 1680000, 'USD', 'Claims intake triage - phase 1', NULL,
   (CURRENT_DATE - INTERVAL '29 months')::DATE,
   (CURRENT_DATE - INTERVAL '28 months')::DATE,
   (CURRENT_DATE - INTERVAL '28 months')::DATE),

  ((SELECT id FROM clients WHERE name = 'Caldbeck Timber Group'),
   'INV-2009', 'paid', 630000, 'USD', 'Kiln sensor rollout - phase 1', NULL,
   (CURRENT_DATE - INTERVAL '28 months')::DATE,
   (CURRENT_DATE - INTERVAL '27 months')::DATE,
   (CURRENT_DATE - INTERVAL '26 months')::DATE),

  ((SELECT id FROM clients WHERE name = 'Netherby Provident Trust'),
   'INV-2010', 'paid', 540000, 'USD', 'Branch rollup report', NULL,
   (CURRENT_DATE - INTERVAL '27 months')::DATE,
   (CURRENT_DATE - INTERVAL '26 months')::DATE,
   (CURRENT_DATE - INTERVAL '26 months')::DATE),

  ((SELECT id FROM clients WHERE name = 'Kirkhollow Mutual'),
   'INV-2011', 'paid', 1260000, 'USD', 'Claims intake triage - phase 2', NULL,
   (CURRENT_DATE - INTERVAL '26 months')::DATE,
   (CURRENT_DATE - INTERVAL '25 months')::DATE,
   (CURRENT_DATE - INTERVAL '25 months')::DATE),

  ((SELECT id FROM clients WHERE name = 'Caldbeck Timber Group'),
   'INV-2012', 'paid', 480000, 'USD', 'Kiln sensor rollout - final and handover', NULL,
   (CURRENT_DATE - INTERVAL '25 months')::DATE,
   (CURRENT_DATE - INTERVAL '24 months')::DATE,
   (CURRENT_DATE - INTERVAL '24 months')::DATE),

  ((SELECT id FROM clients WHERE name = 'Kirkhollow Mutual'),
   'INV-2013', 'paid', 820000, 'USD', 'Adjuster dashboard', NULL,
   (CURRENT_DATE - INTERVAL '24 months')::DATE,
   (CURRENT_DATE - INTERVAL '23 months')::DATE,
   (CURRENT_DATE - INTERVAL '22 months')::DATE),

  ((SELECT id FROM clients WHERE name = 'Barrowfield Grain'),
   'INV-2014', 'paid', 1950000, 'USD', 'Grain intake scales - phase 1', NULL,
   (CURRENT_DATE - INTERVAL '23 months')::DATE,
   (CURRENT_DATE - INTERVAL '22 months')::DATE,
   (CURRENT_DATE - INTERVAL '22 months')::DATE),

  ((SELECT id FROM clients WHERE name = 'Kirkhollow Mutual'),
   'INV-2015', 'paid', 390000, 'USD', 'Claims intake triage - closeout', NULL,
   (CURRENT_DATE - INTERVAL '22 months')::DATE,
   (CURRENT_DATE - INTERVAL '21 months')::DATE,
   (CURRENT_DATE - INTERVAL '21 months')::DATE),

  ((SELECT id FROM clients WHERE name = 'Barrowfield Grain'),
   'INV-2016', 'paid', 1520000, 'USD', 'Grain intake scales - phase 2', NULL,
   (CURRENT_DATE - INTERVAL '21 months')::DATE,
   (CURRENT_DATE - INTERVAL '20 months')::DATE,
   (CURRENT_DATE - INTERVAL '20 months')::DATE),

  ((SELECT id FROM clients WHERE name = 'Dunmarrow Pediatrics'),
   'INV-2017', 'paid', 1340000, 'USD', 'Immunisation recall - discovery', NULL,
   (CURRENT_DATE - INTERVAL '20 months')::DATE,
   (CURRENT_DATE - INTERVAL '19 months')::DATE,
   (CURRENT_DATE - INTERVAL '19 months')::DATE),

  ((SELECT id FROM clients WHERE name = 'Barrowfield Grain'),
   'INV-2018', 'paid', 890000, 'USD', 'Silo telemetry - instrumentation survey', NULL,
   (CURRENT_DATE - INTERVAL '19 months')::DATE,
   (CURRENT_DATE - INTERVAL '18 months')::DATE,
   (CURRENT_DATE - INTERVAL '18 months')::DATE),

  ((SELECT id FROM clients WHERE name = 'Dunmarrow Pediatrics'),
   'INV-2019', 'paid', 1080000, 'USD', 'Immunisation recall - build', NULL,
   (CURRENT_DATE - INTERVAL '18 months')::DATE,
   (CURRENT_DATE - INTERVAL '17 months')::DATE,
   (CURRENT_DATE - INTERVAL '17 months')::DATE),

  ((SELECT id FROM clients WHERE name = 'Fenwright Cold Storage'),
   'INV-2020', 'paid', 2130000, 'USD', 'Cold chain alarms - phase 1', NULL,
   (CURRENT_DATE - INTERVAL '17 months')::DATE,
   (CURRENT_DATE - INTERVAL '16 months')::DATE,
   (CURRENT_DATE - INTERVAL '16 months')::DATE),

  ((SELECT id FROM clients WHERE name = 'Barrowfield Grain'),
   'INV-2021', 'paid', 1275000, 'USD', 'Silo telemetry - build', NULL,
   (CURRENT_DATE - INTERVAL '16 months')::DATE,
   (CURRENT_DATE - INTERVAL '15 months')::DATE,
   (CURRENT_DATE - INTERVAL '15 months')::DATE),

  ((SELECT id FROM clients WHERE name = 'Glasswater Ferries'),
   'INV-2022', 'paid', 945000, 'USD', 'Ticketing kiosk - phase 1', NULL,
   (CURRENT_DATE - INTERVAL '15 months')::DATE,
   (CURRENT_DATE - INTERVAL '14 months')::DATE,
   (CURRENT_DATE - INTERVAL '14 months')::DATE),

  ((SELECT id FROM clients WHERE name = 'Dunmarrow Pediatrics'),
   'INV-2023', 'paid', 760000, 'USD', 'Immunisation recall - final', NULL,
   (CURRENT_DATE - INTERVAL '14 months')::DATE,
   (CURRENT_DATE - INTERVAL '13 months')::DATE,
   (CURRENT_DATE - INTERVAL '13 months')::DATE),

  ((SELECT id FROM clients WHERE name = 'Fenwright Cold Storage'),
   'INV-2024', 'paid', 1790000, 'USD', 'Cold chain alarms - phase 2', NULL,
   (CURRENT_DATE - INTERVAL '14 months')::DATE,
   (CURRENT_DATE - INTERVAL '13 months')::DATE,
   (CURRENT_DATE - INTERVAL '12 months')::DATE),

  ((SELECT id FROM clients WHERE name = 'Estcourt Rail Terminal'),
   'INV-2025', 'paid', 1620000, 'USD', 'Railcar weighbridge - phase 1', NULL,
   (CURRENT_DATE - INTERVAL '13 months')::DATE,
   (CURRENT_DATE - INTERVAL '12 months')::DATE,
   (CURRENT_DATE - INTERVAL '12 months')::DATE),

  ((SELECT id FROM clients WHERE name = 'Barrowfield Grain'),
   'INV-2026', 'paid', 640000, 'USD', 'Driver kiosk - pilot', NULL,
   (CURRENT_DATE - INTERVAL '12 months')::DATE,
   (CURRENT_DATE - INTERVAL '11 months')::DATE,
   (CURRENT_DATE - INTERVAL '11 months')::DATE),

  ((SELECT id FROM clients WHERE name = 'Glasswater Ferries'),
   'INV-2027', 'paid', 830000, 'USD', 'Ticketing kiosk - phase 2', NULL,
   (CURRENT_DATE - INTERVAL '11 months')::DATE,
   (CURRENT_DATE - INTERVAL '10 months')::DATE,
   (CURRENT_DATE - INTERVAL '10 months')::DATE),

  ((SELECT id FROM clients WHERE name = 'Estcourt Rail Terminal'),
   'INV-2028', 'paid', 1170000, 'USD', 'Railcar weighbridge - phase 2', NULL,
   (CURRENT_DATE - INTERVAL '11 months')::DATE,
   (CURRENT_DATE - INTERVAL '10 months')::DATE,
   (CURRENT_DATE - INTERVAL '10 months')::DATE),

  ((SELECT id FROM clients WHERE name = 'Vantham Orthopaedics'),
   'INV-2029', 'paid', 1410000, 'USD', 'Implant registry - phase 1', NULL,
   (CURRENT_DATE - INTERVAL '10 months')::DATE,
   (CURRENT_DATE - INTERVAL '9 months')::DATE,
   (CURRENT_DATE - INTERVAL '9 months')::DATE),

  ((SELECT id FROM clients WHERE name = 'Fenwright Cold Storage'),
   'INV-2030', 'paid', 980000, 'USD', 'Cold chain alarms - phase 3', NULL,
   (CURRENT_DATE - INTERVAL '10 months')::DATE,
   (CURRENT_DATE - INTERVAL '9 months')::DATE,
   (CURRENT_DATE - INTERVAL '8 months')::DATE),

  -- VOID, then reissued at the same amount. Here because "outstanding" and
  -- "collected" both have to exclude it: counted as either, this $3,750 is money
  -- that was never owed and never arrived, and it is exactly the row a total
  -- written as status <> 'paid' gets wrong. It is also the row the
  -- void-invoice-cannot-be-paid case names, since the binder takes the
  -- lowest-numbered void.
  ((SELECT id FROM clients WHERE name = 'Barrowfield Grain'),
   'INV-2031', 'void', 375000, 'USD', 'Silo telemetry - alarm rules',
   'Billed to the grain division rather than to the co-operative that holds the contract. Voided and reissued as INV-2032.',
   (CURRENT_DATE - INTERVAL '9 months')::DATE,
   (CURRENT_DATE - INTERVAL '8 months')::DATE,
   NULL),

  ((SELECT id FROM clients WHERE name = 'Barrowfield Grain'),
   'INV-2032', 'paid', 375000, 'USD', 'Silo telemetry - alarm rules',
   'Reissue of INV-2031 to the correct entity. Same work, same amount, paid.',
   (CURRENT_DATE - INTERVAL '9 months')::DATE,
   (CURRENT_DATE - INTERVAL '8 months')::DATE,
   (CURRENT_DATE - INTERVAL '8 months')::DATE),

  ((SELECT id FROM clients WHERE name = 'Marrowick Title & Escrow'),
   'INV-2033', 'paid', 1230000, 'USD', 'Closing packet assembly - phase 1', NULL,
   (CURRENT_DATE - INTERVAL '9 months')::DATE,
   (CURRENT_DATE - INTERVAL '8 months')::DATE,
   (CURRENT_DATE - INTERVAL '8 months')::DATE),

  ((SELECT id FROM clients WHERE name = 'Barrowfield Grain'),
   'INV-2034', 'paid', 960000, 'USD', 'Driver kiosk - final', NULL,
   (CURRENT_DATE - INTERVAL '8 months')::DATE,
   (CURRENT_DATE - INTERVAL '7 months')::DATE,
   (CURRENT_DATE - INTERVAL '7 months')::DATE),

  ((SELECT id FROM clients WHERE name = 'Larkspit Brewing'),
   'INV-2035', 'paid', 725000, 'USD', 'Tap room inventory - phase 1', NULL,
   (CURRENT_DATE - INTERVAL '8 months')::DATE,
   (CURRENT_DATE - INTERVAL '7 months')::DATE,
   (CURRENT_DATE - INTERVAL '7 months')::DATE),

  ((SELECT id FROM clients WHERE name = 'Dunmarrow Pediatrics'),
   'INV-2036', 'paid', 590000, 'USD', 'Portal accessibility pass', NULL,
   (CURRENT_DATE - INTERVAL '7 months')::DATE,
   (CURRENT_DATE - INTERVAL '6 months')::DATE,
   (CURRENT_DATE - INTERVAL '6 months')::DATE),

  ((SELECT id FROM clients WHERE name = 'Glasswater Ferries'),
   'INV-2037', 'paid', 675000, 'USD', 'Ticketing kiosk - phase 3', NULL,
   (CURRENT_DATE - INTERVAL '7 months')::DATE,
   (CURRENT_DATE - INTERVAL '6 months')::DATE,
   (CURRENT_DATE - INTERVAL '6 months')::DATE),

  ((SELECT id FROM clients WHERE name = 'Estcourt Rail Terminal'),
   'INV-2038', 'paid', 840000, 'USD', 'Railcar weighbridge - phase 3', NULL,
   (CURRENT_DATE - INTERVAL '6 months')::DATE,
   (CURRENT_DATE - INTERVAL '5 months')::DATE,
   (CURRENT_DATE - INTERVAL '5 months')::DATE),

  ((SELECT id FROM clients WHERE name = 'Alderpoint Marine Supply'),
   'INV-2039', 'paid', 1390000, 'USD', 'Fleet fuel audit - phase 1', NULL,
   (CURRENT_DATE - INTERVAL '6 months')::DATE,
   (CURRENT_DATE - INTERVAL '5 months')::DATE,
   (CURRENT_DATE - INTERVAL '5 months')::DATE),

  ((SELECT id FROM clients WHERE name = 'Barrowfield Grain'),
   'INV-2040', 'paid', 780000, 'USD', 'Rail loadout - phase 1', NULL,
   (CURRENT_DATE - INTERVAL '5 months')::DATE,
   (CURRENT_DATE - INTERVAL '4 months')::DATE,
   (CURRENT_DATE - INTERVAL '4 months')::DATE),

  ((SELECT id FROM clients WHERE name = 'Vantham Orthopaedics'),
   'INV-2041', 'paid', 865000, 'USD', 'Implant registry - phase 2', NULL,
   (CURRENT_DATE - INTERVAL '5 months')::DATE,
   (CURRENT_DATE - INTERVAL '4 months')::DATE,
   (CURRENT_DATE - INTERVAL '4 months')::DATE),

  ((SELECT id FROM clients WHERE name = 'Fenwright Cold Storage'),
   'INV-2042', 'paid', 1040000, 'USD', 'Dock scheduling - phase 1', NULL,
   (CURRENT_DATE - INTERVAL '5 months')::DATE,
   (CURRENT_DATE - INTERVAL '4 months')::DATE,
   (CURRENT_DATE - INTERVAL '4 months')::DATE),

  -- The second void, and NOT reissued. There is no credit note in this schema and
  -- amount_cents cannot be negative (db/001-business.sql says why), so the only way
  -- to withdraw an invoice that should never have been sent is to void it. A
  -- dataset with only a reissued void teaches that void means "replaced"; this row
  -- is here so it also means "withdrawn".
  ((SELECT id FROM clients WHERE name = 'Fenwright Cold Storage'),
   'INV-2043', 'void', 190000, 'USD', 'Dock scheduling - deposit',
   'The deposit had already been applied to INV-2042, so this was never owed. Voided rather than credited: there are no negative amounts and no credit notes here. Not reissued.',
   (CURRENT_DATE - INTERVAL '5 months')::DATE,
   (CURRENT_DATE - INTERVAL '4 months')::DATE,
   NULL),

  ((SELECT id FROM clients WHERE name = 'Marrowick Title & Escrow'),
   'INV-2044', 'paid', 690000, 'USD', 'Closing packet assembly - phase 2', NULL,
   (CURRENT_DATE - INTERVAL '4 months')::DATE,
   (CURRENT_DATE - INTERVAL '3 months')::DATE,
   (CURRENT_DATE - INTERVAL '3 months')::DATE),

  ((SELECT id FROM clients WHERE name = 'Alderpoint Marine Supply'),
   'INV-2045', 'paid', 545000, 'USD', 'Fleet fuel audit - phase 2', NULL,
   (CURRENT_DATE - INTERVAL '4 months')::DATE,
   (CURRENT_DATE - INTERVAL '3 months')::DATE,
   (CURRENT_DATE - INTERVAL '3 months')::DATE),

  ((SELECT id FROM clients WHERE name = 'Larkspit Brewing'),
   'INV-2046', 'paid', 410000, 'USD', 'Tap room inventory - phase 2', NULL,
   (CURRENT_DATE - INTERVAL '4 months')::DATE,
   (CURRENT_DATE - INTERVAL '3 months')::DATE,
   (CURRENT_DATE - INTERVAL '3 months')::DATE),

  ((SELECT id FROM clients WHERE name = 'Wrayburn Cycle Works'),
   'INV-2047', 'paid', 330000, 'USD', 'Frame build tracker - phase 1', NULL,
   (CURRENT_DATE - INTERVAL '4 months')::DATE,
   (CURRENT_DATE - INTERVAL '3 months')::DATE,
   (CURRENT_DATE - INTERVAL '3 months')::DATE),

  -- OVERDUE, 58 days. Day arithmetic from here on: the four overdue rows have to
  -- stay overdue and the eight not-yet-due rows have to stay not due, whenever this
  -- is applied.
  ((SELECT id FROM clients WHERE name = 'Fenwright Cold Storage'),
   'INV-2048', 'open', 1240000, 'USD', 'Cold chain alarms - second facility',
   'Chased twice. Their AP moved onto a new system and this fell out of the migration.',
   CURRENT_DATE - 88, CURRENT_DATE - 58, NULL),

  -- OVERDUE, 36 days, at the same client. Two overdue invoices on one client is the
  -- case a per-client total has to add up rather than report the first row.
  ((SELECT id FROM clients WHERE name = 'Fenwright Cold Storage'),
   'INV-2049', 'open', 860000, 'USD', 'Dock scheduling - phase 2', NULL,
   CURRENT_DATE - 66, CURRENT_DATE - 36, NULL),

  -- OVERDUE, 17 days, at a second client, so "who owes us" has more than one answer.
  ((SELECT id FROM clients WHERE name = 'Barrowfield Grain'),
   'INV-2050', 'open', 975000, 'USD', 'Rail loadout - phase 2', NULL,
   CURRENT_DATE - 47, CURRENT_DATE - 17, NULL),

  -- OVERDUE, 4 days. Only just, which is the row a tool comparing dates loosely
  -- gets wrong in either direction.
  ((SELECT id FROM clients WHERE name = 'Estcourt Rail Terminal'),
   'INV-2051', 'open', 340000, 'USD', 'Gate camera feed - survey', NULL,
   CURRENT_DATE - 34, CURRENT_DATE - 4, NULL),

  -- Open and NOT yet due. Outstanding money that nobody is late paying: the
  -- distinction between outstanding and overdue needs rows on each side or a tool can
  -- conflate them and still pass.
  --
  -- The nearest of these is due in TWELVE days, and that number is a decision. The
  -- overdue total asserted at the bottom of this file is true on the day the dataset
  -- is applied, and it stays true only until an open invoice crosses its due date —
  -- so the gap is the shelf life of the arithmetic written below. Twelve days is long
  -- enough to load the data on Monday and read the comment the following week; a row
  -- due in two days would make the documented figure wrong by Thursday. Everything
  -- above is on the overdue side and only gets more overdue, which is why the
  -- boundary is only guarded in this direction.
  ((SELECT id FROM clients WHERE name = 'Barrowfield Grain'),
   'INV-2052', 'open', 730000, 'USD', 'Grower statements - phase 1', NULL,
   CURRENT_DATE - 18, CURRENT_DATE + 12, NULL),

  ((SELECT id FROM clients WHERE name = 'Fenwright Cold Storage'),
   'INV-2053', 'open', 520000, 'USD', 'Cold chain alarms - battery warnings', NULL,
   CURRENT_DATE - 16, CURRENT_DATE + 14, NULL),

  ((SELECT id FROM clients WHERE name = 'Alderpoint Marine Supply'),
   'INV-2054', 'open', 415000, 'USD', 'Fleet fuel audit - phase 3', NULL,
   CURRENT_DATE - 14, CURRENT_DATE + 16, NULL),

  ((SELECT id FROM clients WHERE name = 'Vantham Orthopaedics'),
   'INV-2055', 'open', 590000, 'USD', 'Implant registry - phase 3', NULL,
   CURRENT_DATE - 11, CURRENT_DATE + 19, NULL),

  ((SELECT id FROM clients WHERE name = 'Barrowfield Grain'),
   'INV-2056', 'open', 615000, 'USD', 'Silo telemetry - winter trend view', NULL,
   CURRENT_DATE - 8, CURRENT_DATE + 22, NULL),

  ((SELECT id FROM clients WHERE name = 'Fenwright Cold Storage'),
   'INV-2057', 'open', 490000, 'USD', 'Dock scheduling - trailer pool view', NULL,
   CURRENT_DATE - 5, CURRENT_DATE + 25, NULL),

  ((SELECT id FROM clients WHERE name = 'Estcourt Rail Terminal'),
   'INV-2058', 'open', 285000, 'USD', 'Railcar weighbridge - phase 4', NULL,
   CURRENT_DATE - 3, CURRENT_DATE + 27, NULL),

  ((SELECT id FROM clients WHERE name = 'Marrowick Title & Escrow'),
   'INV-2059', 'open', 260000, 'USD', 'Wire confirmation - phase 1', NULL,
   CURRENT_DATE - 2, CURRENT_DATE + 28, NULL),

  -- Drafts: never sent, therefore no issue date and no due date (the schema
  -- enforces the first of those). Not money owed by anyone, and they must stay out
  -- of every total. Three of them, on three different clients, because one draft is
  -- easy to special-case by accident.
  ((SELECT id FROM clients WHERE name = 'Glasswater Ferries'),
   'INV-2060', 'draft', 680000, 'USD', 'Crew rostering - phase 1',
   'Not sent. Waiting on their union sign-off before the roster rules are final.',
   NULL, NULL, NULL),

  ((SELECT id FROM clients WHERE name = 'Vantham Orthopaedics'),
   'INV-2061', 'draft', 245000, 'USD', 'Theatre scheduling - phase 1',
   'Not sent. Their theatre refit slipped and not an hour has been logged against it.',
   NULL, NULL, NULL),

  ((SELECT id FROM clients WHERE name = 'Alderpoint Marine Supply'),
   'INV-2062', 'draft', 930000, 'USD', 'Fleet fuel audit - phase 4',
   'Not sent. Scoped, and not yet agreed.',
   NULL, NULL, NULL);

-- The numbers above were written by hand, so nextval() was never called and the
-- sequence still sits wherever it was left — scripts/seed.ts puts it back to the
-- schema START (1001) before applying this file. Left there, the first invoice
-- anyone creates through the application would be handed INV-1001, and then
-- INV-1002, and so on: no collision with THIS dataset, but the numbers would run
-- backwards through a range the business has already used, which is worse than a
-- loud failure. Setting it past the highest number here keeps the next application
-- number the next number.
SELECT setval('invoice_number_seq', 2062, true);


-- ---------- time entries ----------
--
-- 200 entries, written per project, so the hours next to each other are the hours
-- that get summed together. Billable unless the note says otherwise; everything on
-- the own venture, the artifact and the two leads that were passed on is
-- non-billable, because there is nobody to charge.
--
-- The CROSS JOIN form attaches entries by name, and it inserts NOTHING AT ALL if
-- the name is misspelled — a silence that would leave a project with no hours and
-- every total quietly short. The assertions at the bottom break that silence twice
-- over: they check the entry count and the hour totals, and they check that exactly
-- one project (Vantham Theatre Scheduling) has no entries. The all-pairs name check
-- is what makes `WHERE p.name = '...'` safe: two projects sharing a name would each
-- receive a copy of the other block.
--
-- Recent entries use day arithmetic and older ones use months. Both are DATE, and
-- the mixture inside one VALUES list is deliberate: it is the only way to have a
-- project that started nineteen months ago and was worked on last week.

-- Barrowfield Grain Intake Scales: 68.00h against an 80.00h budget. Under, finished.
INSERT INTO time_entries (project_id, entry_date, hours, billable, note)
SELECT p.id, v.entry_date, v.hours, v.billable, v.note
FROM projects p CROSS JOIN (VALUES
  ((CURRENT_DATE - INTERVAL '23 months')::DATE, 8.00, true,  'Watched a full intake shift before designing any of it.'),
  ((CURRENT_DATE - INTERVAL '22 months')::DATE, 7.50, true,  'Ticket model: one truck, many loads, one settlement.'),
  ((CURRENT_DATE - INTERVAL '22 months')::DATE, 8.00, true,  'Scale driver for both indicator models on site.'),
  ((CURRENT_DATE - INTERVAL '21 months')::DATE, 6.00, true,  'Moisture deduction table, out of their agronomist notes.'),
  ((CURRENT_DATE - INTERVAL '21 months')::DATE, 8.00, true,  'Grade override with a reason code, because the override was happening anyway.'),
  ((CURRENT_DATE - INTERVAL '20 months')::DATE, 7.00, true,  'Settlement print that matches the paper ticket handed to the driver.'),
  ((CURRENT_DATE - INTERVAL '20 months')::DATE, 8.00, true,  'Harvest load test: four hundred tickets in one afternoon.'),
  ((CURRENT_DATE - INTERVAL '19 months')::DATE, 5.50, true,  'Scale house training across two shifts.'),
  ((CURRENT_DATE - INTERVAL '19 months')::DATE, 4.00, false, 'Our own indicator emulator had the checksum wrong. Ours to absorb.'),
  ((CURRENT_DATE - INTERVAL '19 months')::DATE, 6.00, true,  'Handover: runbook and the calibration log format.')
) AS v(entry_date, hours, billable, note)
WHERE p.name = 'Barrowfield Grain Intake Scales';

-- Barrowfield Grain Silo Telemetry: 82.00h against a 70.00h budget. OVER by 12.00h,
-- and still running, which is the case worth having: over budget and not finished.
INSERT INTO time_entries (project_id, entry_date, hours, billable, note)
SELECT p.id, v.entry_date, v.hours, v.billable, v.note
FROM projects p CROSS JOIN (VALUES
  ((CURRENT_DATE - INTERVAL '18 months')::DATE, 6.50, true,  'Sensor survey across the six bins. Two had no cable run at all.'),
  ((CURRENT_DATE - INTERVAL '17 months')::DATE, 8.00, true,  'Poller for the level sensors, with a dead band so it stops flapping.'),
  ((CURRENT_DATE - INTERVAL '16 months')::DATE, 7.00, true,  'Temperature cable readings, averaged the way their agronomist averages them.'),
  ((CURRENT_DATE - INTERVAL '15 months')::DATE, 8.00, true,  'Alarm rules on rate of rise rather than on a threshold.'),
  ((CURRENT_DATE - INTERVAL '14 months')::DATE, 5.00, true,  'Bin diagram a manager can read from a phone in a truck.'),
  ((CURRENT_DATE - INTERVAL '13 months')::DATE, 7.50, true,  'Historian backfill from the vendor CSV exports.'),
  ((CURRENT_DATE - INTERVAL '11 months')::DATE, 8.00, true,  'Aeration fan interlock, behind a confirmation.'),
  ((CURRENT_DATE - INTERVAL '9 months')::DATE,  6.00, true,  'False alarm hunt. A loose cable, not the software.'),
  ((CURRENT_DATE - INTERVAL '7 months')::DATE,  7.00, true,  'Second site: the same rules against a different indicator.'),
  ((CURRENT_DATE - INTERVAL '5 months')::DATE,  4.50, false, 'Rebuilt our own test rig after a firmware bump. Not billed.'),
  (CURRENT_DATE - 70,                           8.00, true,  'Alarm escalation onto the on-call phone list.'),
  (CURRENT_DATE - 25,                           6.50, true,  'Grain temperature trend view for the winter.')
) AS v(entry_date, hours, billable, note)
WHERE p.name = 'Barrowfield Grain Silo Telemetry';

-- Barrowfield Grain Driver Kiosk: 38.00h against 45.00h. Finished inside it.
INSERT INTO time_entries (project_id, entry_date, hours, billable, note)
SELECT p.id, v.entry_date, v.hours, v.billable, v.note
FROM projects p CROSS JOIN (VALUES
  ((CURRENT_DATE - INTERVAL '12 months')::DATE, 7.00, true, 'Kiosk flow drawn standing at the scale house window.'),
  ((CURRENT_DATE - INTERVAL '11 months')::DATE, 8.00, true, 'Card reader and the receipt printer that speaks one dialect.'),
  ((CURRENT_DATE - INTERVAL '11 months')::DATE, 6.50, true, 'Offline mode: the yard loses signal behind the bins.'),
  ((CURRENT_DATE - INTERVAL '10 months')::DATE, 7.50, true, 'Language toggle for the harvest crews.'),
  ((CURRENT_DATE - INTERVAL '10 months')::DATE, 5.00, true, 'Two weeks of watching drivers use it, then three small changes.'),
  ((CURRENT_DATE - INTERVAL '9 months')::DATE,  4.00, true, 'Handover and the spare parts list.')
) AS v(entry_date, hours, billable, note)
WHERE p.name = 'Barrowfield Grain Driver Kiosk';

-- Barrowfield Grain Moisture Lab: 10.00h and NO budget set. NULL budget_hours is not
-- a budget of zero, and a tool asked whether we are over budget has to say which of
-- those it found. Compare Estcourt Gate Camera Feed, which really is zero.
INSERT INTO time_entries (project_id, entry_date, hours, billable, note)
SELECT p.id, v.entry_date, v.hours, v.billable, v.note
FROM projects p CROSS JOIN (VALUES
  ((CURRENT_DATE - INTERVAL '6 months')::DATE, 4.00, true,  'Read the lab instrument manual and its serial protocol.'),
  ((CURRENT_DATE - INTERVAL '5 months')::DATE, 3.50, true,  'Wrote up two integration options and stopped there.'),
  ((CURRENT_DATE - INTERVAL '5 months')::DATE, 2.50, false, 'Chased their instrument vendor twice. Not billed.')
) AS v(entry_date, hours, billable, note)
WHERE p.name = 'Barrowfield Grain Moisture Lab';

-- Barrowfield Grain Rail Loadout: 33.00h against 60.00h. Mid-flight.
INSERT INTO time_entries (project_id, entry_date, hours, billable, note)
SELECT p.id, v.entry_date, v.hours, v.billable, v.note
FROM projects p CROSS JOIN (VALUES
  ((CURRENT_DATE - INTERVAL '5 months')::DATE, 6.00, true, 'Loadout sequence, from the railcar list they receive by fax.'),
  ((CURRENT_DATE - INTERVAL '4 months')::DATE, 7.50, true, 'Weight allocation across cars, to the tolerance the railroad enforces.'),
  (CURRENT_DATE - 100,                         8.00, true, 'Bill of lading print, and the four copies it has to make.'),
  (CURRENT_DATE - 50,                          6.50, true, 'Dry run against a real train. Two sequencing bugs.'),
  (CURRENT_DATE - 15,                          5.00, true, 'Loadout report for the shipper.')
) AS v(entry_date, hours, billable, note)
WHERE p.name = 'Barrowfield Grain Rail Loadout';

-- Barrowfield Grain Grower Statements: 22.50h against 35.00h.
INSERT INTO time_entries (project_id, entry_date, hours, billable, note)
SELECT p.id, v.entry_date, v.hours, v.billable, v.note
FROM projects p CROSS JOIN (VALUES
  ((CURRENT_DATE - INTERVAL '3 months')::DATE, 5.50, true, 'Statement layout, from the one they print out of a spreadsheet today.'),
  (CURRENT_DATE - 70,                          7.00, true, 'Deferred payment contracts, which the spreadsheet got wrong twice a year.'),
  (CURRENT_DATE - 40,                          6.00, true, 'Statement mailing run, with a preview.'),
  (CURRENT_DATE - 10,                          4.00, true, 'Rounding on split deliveries, to the cent.')
) AS v(entry_date, hours, billable, note)
WHERE p.name = 'Barrowfield Grain Grower Statements';

-- Fenwright Cold Chain Alarms: 75.50h against 90.00h.
INSERT INTO time_entries (project_id, entry_date, hours, billable, note)
SELECT p.id, v.entry_date, v.hours, v.billable, v.note
FROM projects p CROSS JOIN (VALUES
  ((CURRENT_DATE - INTERVAL '16 months')::DATE, 7.50, true,  'Probe inventory across the four rooms and the two trailers.'),
  ((CURRENT_DATE - INTERVAL '15 months')::DATE, 8.00, true,  'Alarm rules per room: a freezer and a dock are different problems.'),
  ((CURRENT_DATE - INTERVAL '14 months')::DATE, 6.50, true,  'Escalation ladder: text, then phone, then the duty manager.'),
  ((CURRENT_DATE - INTERVAL '13 months')::DATE, 8.00, true,  'Door-open events, which explained most of the false alarms.'),
  ((CURRENT_DATE - INTERVAL '12 months')::DATE, 7.00, true,  'Defrost cycle suppression window.'),
  ((CURRENT_DATE - INTERVAL '11 months')::DATE, 8.00, true,  'Excursion report for their auditor, with the raw readings attached.'),
  ((CURRENT_DATE - INTERVAL '9 months')::DATE,  5.50, true,  'Trailer probes over cellular, and the gaps that come with it.'),
  ((CURRENT_DATE - INTERVAL '8 months')::DATE,  7.50, true,  'Weekly digest, and a quiet hours rule.'),
  ((CURRENT_DATE - INTERVAL '6 months')::DATE,  3.50, false, 'Our own alerting bill spiked from a test loop we left running. Ours.'),
  (CURRENT_DATE - 90,                           8.00, true,  'Second facility onboarded onto the same rules.'),
  (CURRENT_DATE - 30,                           6.00, true,  'Battery warnings, after two probes died unnoticed.')
) AS v(entry_date, hours, billable, note)
WHERE p.name = 'Fenwright Cold Chain Alarms';

-- Fenwright Dock Scheduling: 40.50h against 55.00h.
INSERT INTO time_entries (project_id, entry_date, hours, billable, note)
SELECT p.id, v.entry_date, v.hours, v.billable, v.note
FROM projects p CROSS JOIN (VALUES
  ((CURRENT_DATE - INTERVAL '5 months')::DATE, 6.00, true, 'Watched a morning of dock assignment done on a clipboard.'),
  ((CURRENT_DATE - INTERVAL '4 months')::DATE, 7.50, true, 'Slot model using the dwell time each carrier actually takes.'),
  (CURRENT_DATE - 100,                         8.00, true, 'Appointment page for carriers: no login, one link per booking.'),
  (CURRENT_DATE - 60,                          6.50, true, 'Late arrival handling, which is most arrivals.'),
  (CURRENT_DATE - 30,                          7.00, true, 'Dock utilisation report.'),
  (CURRENT_DATE - 8,                           5.50, true, 'Trailer pool view, after they asked twice.')
) AS v(entry_date, hours, billable, note)
WHERE p.name = 'Fenwright Dock Scheduling';

-- Fenwright Pallet Label Print: 5.50h against 12.00h, cancelled part way, and never
-- invoiced at all. The half-day after the cancellation is the non-billable row.
INSERT INTO time_entries (project_id, entry_date, hours, billable, note)
SELECT p.id, v.entry_date, v.hours, v.billable, v.note
FROM projects p CROSS JOIN (VALUES
  ((CURRENT_DATE - INTERVAL '9 months')::DATE, 3.50, true,  'Label template and the printer language it needs.'),
  ((CURRENT_DATE - INTERVAL '8 months')::DATE, 2.00, false, 'Cancelled: they bought a vendor module. Half a day, not billed.')
) AS v(entry_date, hours, billable, note)
WHERE p.name = 'Fenwright Pallet Label Print';

-- Estcourt Railcar Weighbridge: 67.50h against 95.00h.
INSERT INTO time_entries (project_id, entry_date, hours, billable, note)
SELECT p.id, v.entry_date, v.hours, v.billable, v.note
FROM projects p CROSS JOIN (VALUES
  ((CURRENT_DATE - INTERVAL '12 months')::DATE, 7.00, true,  'Weighbridge protocol capture. The vendor document was wrong about two fields.'),
  ((CURRENT_DATE - INTERVAL '11 months')::DATE, 8.00, true,  'Axle by axle capture, and the tare it keeps forgetting.'),
  ((CURRENT_DATE - INTERVAL '10 months')::DATE, 6.50, true,  'Car identity from the AEI reader, matched to the weight.'),
  ((CURRENT_DATE - INTERVAL '9 months')::DATE,  8.00, true,  'Overweight refusal at the bridge, with a printed reason.'),
  ((CURRENT_DATE - INTERVAL '8 months')::DATE,  7.50, true,  'Manifest reconciliation against the shipper file.'),
  ((CURRENT_DATE - INTERVAL '7 months')::DATE,  4.00, false, 'Our own simulator drifted a decimal place. Not billed.'),
  ((CURRENT_DATE - INTERVAL '6 months')::DATE,  8.00, true,  'Calibration log, signed off by the state inspector.'),
  ((CURRENT_DATE - INTERVAL '4 months')::DATE,  6.00, true,  'Second bridge on the west lead.'),
  (CURRENT_DATE - 60,                           7.50, true,  'Daily tonnage report the terminal manager reads at six.'),
  (CURRENT_DATE - 18,                           5.00, true,  'Alarm when a car is weighed twice.')
) AS v(entry_date, hours, billable, note)
WHERE p.name = 'Estcourt Railcar Weighbridge';

-- Estcourt Gate Camera Feed: 12.50h against a budget of 0.00h. Every hour here is
-- over budget, which is a different sentence from "no budget was agreed" — the
-- Moisture Lab above is that one. read.ts has a branch for each and only this
-- dataset reaches the zero.
INSERT INTO time_entries (project_id, entry_date, hours, billable, note)
SELECT p.id, v.entry_date, v.hours, v.billable, v.note
FROM projects p CROSS JOIN (VALUES
  ((CURRENT_DATE - INTERVAL '4 months')::DATE, 5.00, true, 'Camera survey at the gate. Two of them point at nothing.'),
  ((CURRENT_DATE - INTERVAL '3 months')::DATE, 4.50, true, 'Plate reads into the gate log, with a confidence threshold.'),
  (CURRENT_DATE - 70,                          3.00, true, 'Paused: their network team will not open the port.')
) AS v(entry_date, hours, billable, note)
WHERE p.name = 'Estcourt Gate Camera Feed';

-- Alderpoint Fleet Fuel Audit: 51.50h against 90.00h. This is the project
-- single_project binds to, so it is also the one the two write cases propose against.
INSERT INTO time_entries (project_id, entry_date, hours, billable, note)
SELECT p.id, v.entry_date, v.hours, v.billable, v.note
FROM projects p CROSS JOIN (VALUES
  ((CURRENT_DATE - INTERVAL '9 months')::DATE, 6.00, true,  'Read the fuel card exports and the two formats their vendors send.'),
  ((CURRENT_DATE - INTERVAL '8 months')::DATE, 7.50, true,  'Matched card transactions to vessels by time and berth.'),
  ((CURRENT_DATE - INTERVAL '7 months')::DATE, 8.00, true,  'Exception report for fills with no matching voyage.'),
  ((CURRENT_DATE - INTERVAL '6 months')::DATE, 5.50, true,  'Rebuilt the vessel list from the harbour roster; theirs was three boats stale.'),
  ((CURRENT_DATE - INTERVAL '5 months')::DATE, 7.00, true,  'Reconciliation screen, and the rounding rule for split fills.'),
  (CURRENT_DATE - 100,                         3.00, false, 'Our own export parser broke on a quoted comma. Ours to fix, not billed.'),
  (CURRENT_DATE - 60,                          8.00, true,  'Monthly close walkthrough with the office.'),
  (CURRENT_DATE - 20,                          6.50, true,  'Variance alerts on cost per gallon.')
) AS v(entry_date, hours, billable, note)
WHERE p.name = 'Alderpoint Fleet Fuel Audit';

-- Glasswater Ticketing Kiosk: 59.50h against 70.00h, finished.
INSERT INTO time_entries (project_id, entry_date, hours, billable, note)
SELECT p.id, v.entry_date, v.hours, v.billable, v.note
FROM projects p CROSS JOIN (VALUES
  ((CURRENT_DATE - INTERVAL '15 months')::DATE, 7.00, true,  'Fare rules, including the resident discount nobody had written down.'),
  ((CURRENT_DATE - INTERVAL '14 months')::DATE, 8.00, true,  'Kiosk flow, tested standing on the dock in the rain.'),
  ((CURRENT_DATE - INTERVAL '13 months')::DATE, 7.50, true,  'Card terminal integration and the certification that comes with it.'),
  ((CURRENT_DATE - INTERVAL '12 months')::DATE, 6.00, true,  'Vehicle length classes, which decide the fare more than passengers do.'),
  ((CURRENT_DATE - INTERVAL '10 months')::DATE, 8.00, true,  'Sailing schedule import from their timetable spreadsheet.'),
  ((CURRENT_DATE - INTERVAL '9 months')::DATE,  7.00, true,  'Boarding scan on the ramp, tolerant of no signal.'),
  ((CURRENT_DATE - INTERVAL '7 months')::DATE,  6.50, true,  'Refund and rebook, after a cancelled sailing left a queue.'),
  ((CURRENT_DATE - INTERVAL '6 months')::DATE,  4.00, false, 'Our own certification test account expired. Ours to sort out.'),
  ((CURRENT_DATE - INTERVAL '5 months')::DATE,  5.50, true,  'Handover to their terminal staff, two sessions.')
) AS v(entry_date, hours, billable, note)
WHERE p.name = 'Glasswater Ticketing Kiosk';

-- Glasswater Crew Rostering: 23.00h against 40.00h.
INSERT INTO time_entries (project_id, entry_date, hours, billable, note)
SELECT p.id, v.entry_date, v.hours, v.billable, v.note
FROM projects p CROSS JOIN (VALUES
  ((CURRENT_DATE - INTERVAL '4 months')::DATE, 6.00, true, 'Roster rules: rest hours, endorsements, and the union agreement.'),
  ((CURRENT_DATE - INTERVAL '3 months')::DATE, 7.00, true, 'Roster builder that refuses an illegal watch.'),
  (CURRENT_DATE - 45,                          5.50, true, 'Swap requests, with the mate approving.'),
  (CURRENT_DATE - 12,                          4.50, true, 'Payroll export, which is why they wanted this at all.')
) AS v(entry_date, hours, billable, note)
WHERE p.name = 'Glasswater Crew Rostering';

-- Dunmarrow Immunisation Recall: 59.50h against 65.00h.
INSERT INTO time_entries (project_id, entry_date, hours, billable, note)
SELECT p.id, v.entry_date, v.hours, v.billable, v.note
FROM projects p CROSS JOIN (VALUES
  ((CURRENT_DATE - INTERVAL '19 months')::DATE, 6.00, true,  'Read the recall rules per vaccine, which is where the whole job is.'),
  ((CURRENT_DATE - INTERVAL '18 months')::DATE, 8.00, true,  'Schedule engine: age bands, intervals, and the catch-up table.'),
  ((CURRENT_DATE - INTERVAL '17 months')::DATE, 7.50, true,  'Patient list with the reason each one is due.'),
  ((CURRENT_DATE - INTERVAL '16 months')::DATE, 8.00, true,  'Letter and text templates, reviewed by their nurse lead.'),
  ((CURRENT_DATE - INTERVAL '15 months')::DATE, 6.50, true,  'Suppression list, so no family is written to twice in a week.'),
  ((CURRENT_DATE - INTERVAL '14 months')::DATE, 3.00, false, 'Our own test data had impossible birthdays in it. Ours to fix.'),
  ((CURRENT_DATE - INTERVAL '14 months')::DATE, 8.00, true,  'Recall run report, and the audit trail their board asked for.'),
  ((CURRENT_DATE - INTERVAL '13 months')::DATE, 7.00, true,  'First live run: two hundred letters, checked by hand before posting.'),
  ((CURRENT_DATE - INTERVAL '12 months')::DATE, 5.50, true,  'Handover to their practice manager.')
) AS v(entry_date, hours, billable, note)
WHERE p.name = 'Dunmarrow Immunisation Recall';

-- Dunmarrow Portal Accessibility: 21.50h against 24.00h. Finished just inside it.
INSERT INTO time_entries (project_id, entry_date, hours, billable, note)
SELECT p.id, v.entry_date, v.hours, v.billable, v.note
FROM projects p CROSS JOIN (VALUES
  ((CURRENT_DATE - INTERVAL '7 months')::DATE, 8.00, true, 'Screen reader pass over the booking flow. Unusable at step three.'),
  ((CURRENT_DATE - INTERVAL '7 months')::DATE, 7.50, true, 'Contrast and focus order, and the date picker rewritten.'),
  ((CURRENT_DATE - INTERVAL '6 months')::DATE, 6.00, true, 'Retest with their receptionist, who found two more.')
) AS v(entry_date, hours, billable, note)
WHERE p.name = 'Dunmarrow Portal Accessibility';


-- Marrowick Closing Packet Assembly: 48.50h against 75.00h.
INSERT INTO time_entries (project_id, entry_date, hours, billable, note)
SELECT p.id, v.entry_date, v.hours, v.billable, v.note
FROM projects p CROSS JOIN (VALUES
  ((CURRENT_DATE - INTERVAL '9 months')::DATE, 6.50, true, 'Read three real closing packets end to end.'),
  ((CURRENT_DATE - INTERVAL '8 months')::DATE, 8.00, true, 'Document checklist per transaction type.'),
  ((CURRENT_DATE - INTERVAL '7 months')::DATE, 7.50, true, 'Packet assembly in the page order the county requires.'),
  ((CURRENT_DATE - INTERVAL '6 months')::DATE, 6.00, true, 'Signature blocks, and the notary page that has to be last.'),
  ((CURRENT_DATE - INTERVAL '4 months')::DATE, 8.00, true, 'Wire instruction page, quarantined behind a second check.'),
  (CURRENT_DATE - 70,                          7.00, true, 'Electronic recording to the county, and its rejection codes.'),
  (CURRENT_DATE - 21,                          5.50, true, 'Packet audit log, because a missing page is discovered late.')
) AS v(entry_date, hours, billable, note)
WHERE p.name = 'Marrowick Closing Packet Assembly';

-- Marrowick Wire Confirmation: 7.00h against 18.00h. Newly started.
INSERT INTO time_entries (project_id, entry_date, hours, billable, note)
SELECT p.id, v.entry_date, v.hours, v.billable, v.note
FROM projects p CROSS JOIN (VALUES
  ((CURRENT_DATE - INTERVAL '2 months')::DATE, 4.50, true, 'Call-back confirmation flow, written with their fraud policy open.'),
  (CURRENT_DATE - 9,                           2.50, true, 'Read receipt on the confirmation, at their insurer request.')
) AS v(entry_date, hours, billable, note)
WHERE p.name = 'Marrowick Wire Confirmation';

-- Vantham Implant Registry: 53.50h against 80.00h.
--
-- Vantham Theatre Scheduling gets NO block at all. It is the one project in this
-- dataset with a budget and no hours, and the assertions below check that it is the
-- only one — so a block accidentally deleted from this file is caught, rather than
-- appearing as a project that quietly did no work.
INSERT INTO time_entries (project_id, entry_date, hours, billable, note)
SELECT p.id, v.entry_date, v.hours, v.billable, v.note
FROM projects p CROSS JOIN (VALUES
  ((CURRENT_DATE - INTERVAL '9 months')::DATE, 6.50, true,  'Read the registry submission spec, which changes every year.'),
  ((CURRENT_DATE - INTERVAL '8 months')::DATE, 8.00, true,  'Implant catalogue with the lot numbers theatre actually scans.'),
  ((CURRENT_DATE - INTERVAL '7 months')::DATE, 7.00, true,  'Submission builder, validated before anything leaves the building.'),
  ((CURRENT_DATE - INTERVAL '6 months')::DATE, 8.00, true,  'Revision linkage, so a second operation finds the first.'),
  ((CURRENT_DATE - INTERVAL '5 months')::DATE, 6.00, true,  'Outcome follow-up reminders at six weeks and at a year.'),
  (CURRENT_DATE - 90,                          7.50, true,  'Consent capture, with the version of the form that was signed.'),
  (CURRENT_DATE - 45,                          4.00, false, 'Our own sandbox credentials lapsed for a day. Ours.'),
  (CURRENT_DATE - 11,                          6.50, true,  'Submission failure report, after a batch bounced on one field.')
) AS v(entry_date, hours, billable, note)
WHERE p.name = 'Vantham Implant Registry';

-- Larkspit Tap Room Inventory: 37.50h against 55.00h.
INSERT INTO time_entries (project_id, entry_date, hours, billable, note)
SELECT p.id, v.entry_date, v.hours, v.billable, v.note
FROM projects p CROSS JOIN (VALUES
  ((CURRENT_DATE - INTERVAL '8 months')::DATE, 5.50, true, 'Counted a real inventory night with them before writing anything.'),
  ((CURRENT_DATE - INTERVAL '7 months')::DATE, 7.00, true, 'Keg tracking by tap, off the pour meters they already own.'),
  ((CURRENT_DATE - INTERVAL '6 months')::DATE, 6.50, true, 'Waste and sample tracking, which was the missing money.'),
  ((CURRENT_DATE - INTERVAL '4 months')::DATE, 8.00, true, 'Order suggestions from pour rate rather than from last order.'),
  (CURRENT_DATE - 60,                          6.00, true, 'Cellar count on a phone, offline in the cold room.'),
  (CURRENT_DATE - 16,                          4.50, true, 'Variance report by tap.')
) AS v(entry_date, hours, billable, note)
WHERE p.name = 'Larkspit Tap Room Inventory';

-- Wrayburn Frame Build Tracker: 19.00h against 32.00h, and the newest engagement that
-- has any hours at all.
INSERT INTO time_entries (project_id, entry_date, hours, billable, note)
SELECT p.id, v.entry_date, v.hours, v.billable, v.note
FROM projects p CROSS JOIN (VALUES
  ((CURRENT_DATE - INTERVAL '3 months')::DATE, 5.00, true, 'Frame build stages, from the jig sheet on their wall.'),
  (CURRENT_DATE - 60,                          6.50, true, 'Serial numbers and the decal record for warranty.'),
  (CURRENT_DATE - 30,                          4.00, true, 'Paint queue, which is the bottleneck.'),
  (CURRENT_DATE - 7,                           3.50, true, 'Build sheet print for the mechanic.')
) AS v(entry_date, hours, billable, note)
WHERE p.name = 'Wrayburn Frame Build Tracker';

-- Caldbeck Yard Scheduling: 68.50h against 75.00h, three years ago. The old
-- engagement, so a question about "this year" has something it must exclude.
INSERT INTO time_entries (project_id, entry_date, hours, billable, note)
SELECT p.id, v.entry_date, v.hours, v.billable, v.note
FROM projects p CROSS JOIN (VALUES
  ((CURRENT_DATE - INTERVAL '36 months')::DATE, 8.00, true, 'Read the mill schedule as it is really kept: a whiteboard and a phone.'),
  ((CURRENT_DATE - INTERVAL '35 months')::DATE, 7.50, true, 'Order model, with the grade and length that decide everything downstream.'),
  ((CURRENT_DATE - INTERVAL '34 months')::DATE, 8.00, true, 'Saw line capacity, out of two years of their production logs.'),
  ((CURRENT_DATE - INTERVAL '33 months')::DATE, 6.00, true, 'Scheduler that respects kiln availability.'),
  ((CURRENT_DATE - INTERVAL '32 months')::DATE, 8.00, true, 'Truck arrival windows, so the yard stops queueing at seven.'),
  ((CURRENT_DATE - INTERVAL '31 months')::DATE, 7.00, true, 'Shift board for the yard, printable.'),
  ((CURRENT_DATE - INTERVAL '29 months')::DATE, 6.50, true, 'Rescheduling on a breakdown, which is the case that matters.'),
  ((CURRENT_DATE - INTERVAL '27 months')::DATE, 8.00, true, 'Cutover: two weeks running the board and the system together.'),
  ((CURRENT_DATE - INTERVAL '25 months')::DATE, 5.00, true, 'Training for the second shift.'),
  ((CURRENT_DATE - INTERVAL '23 months')::DATE, 4.50, true, 'Handover, and the closing report their controller asked for.')
) AS v(entry_date, hours, billable, note)
WHERE p.name = 'Caldbeck Yard Scheduling';

-- Caldbeck Kiln Sensor Rollout: 30.00h against a 24.00h budget. OVER by 6.00h, and
-- finished — the second over-budget project, so "are we over anywhere" has more than
-- one answer and cannot be satisfied by returning the first row.
INSERT INTO time_entries (project_id, entry_date, hours, billable, note)
SELECT p.id, v.entry_date, v.hours, v.billable, v.note
FROM projects p CROSS JOIN (VALUES
  ((CURRENT_DATE - INTERVAL '28 months')::DATE, 8.00, true, 'Kiln probe wiring survey with their electrician.'),
  ((CURRENT_DATE - INTERVAL '27 months')::DATE, 7.50, true, 'Reader for the probe bus, and the retry it needs.'),
  ((CURRENT_DATE - INTERVAL '27 months')::DATE, 8.00, true, 'Drying curve charted against the schedule.'),
  ((CURRENT_DATE - INTERVAL '26 months')::DATE, 6.50, true, 'Alarm when a kiln stalls. Found one stalling weekly.')
) AS v(entry_date, hours, billable, note)
WHERE p.name = 'Caldbeck Kiln Sensor Rollout';

-- Caldbeck Log Deck Reports: 6.00h against 20.00h, cancelled. Real hours on a real
-- client with NO invoice against them: work that was done and never billed, which is
-- a different thing from a lead that was passed on.
INSERT INTO time_entries (project_id, entry_date, hours, billable, note)
SELECT p.id, v.entry_date, v.hours, v.billable, v.note
FROM projects p CROSS JOIN (VALUES
  ((CURRENT_DATE - INTERVAL '25 months')::DATE, 3.50, true,  'Deck inventory report out of the scanner exports.'),
  ((CURRENT_DATE - INTERVAL '24 months')::DATE, 2.50, false, 'Cancelled when their scanner contract lapsed. Not billed.')
) AS v(entry_date, hours, billable, note)
WHERE p.name = 'Caldbeck Log Deck Reports';

-- Kirkhollow Claims Intake Triage: 62.50h against 70.00h.
INSERT INTO time_entries (project_id, entry_date, hours, billable, note)
SELECT p.id, v.entry_date, v.hours, v.billable, v.note
FROM projects p CROSS JOIN (VALUES
  ((CURRENT_DATE - INTERVAL '29 months')::DATE, 7.00, true,  'Read six months of intake calls and what happened to each.'),
  ((CURRENT_DATE - INTERVAL '28 months')::DATE, 8.00, true,  'Triage rules, written with their senior adjuster in the room.'),
  ((CURRENT_DATE - INTERVAL '27 months')::DATE, 7.50, true,  'Intake form that stops asking once the answer is decided.'),
  ((CURRENT_DATE - INTERVAL '26 months')::DATE, 8.00, true,  'Duplicate claim detection, which found a real pair on day one.'),
  ((CURRENT_DATE - INTERVAL '25 months')::DATE, 6.50, true,  'Routing to adjuster queues by line and severity.'),
  ((CURRENT_DATE - INTERVAL '24 months')::DATE, 8.00, true,  'Service level clock, paused correctly overnight.'),
  ((CURRENT_DATE - INTERVAL '23 months')::DATE, 5.00, false, 'Our own load test hammered their staging. Ours to absorb.'),
  ((CURRENT_DATE - INTERVAL '22 months')::DATE, 7.00, true,  'Reporting for the claims committee.'),
  ((CURRENT_DATE - INTERVAL '21 months')::DATE, 5.50, true,  'Handover, with the rules written where they can edit them.')
) AS v(entry_date, hours, billable, note)
WHERE p.name = 'Kirkhollow Claims Intake Triage';

-- Kirkhollow Adjuster Dashboard: 21.50h against 26.00h.
INSERT INTO time_entries (project_id, entry_date, hours, billable, note)
SELECT p.id, v.entry_date, v.hours, v.billable, v.note
FROM projects p CROSS JOIN (VALUES
  ((CURRENT_DATE - INTERVAL '23 months')::DATE, 8.00, true, 'Dashboard from the queues that already existed, not new ones.'),
  ((CURRENT_DATE - INTERVAL '22 months')::DATE, 7.00, true, 'Ageing view, which is the only number their committee asks for.'),
  ((CURRENT_DATE - INTERVAL '21 months')::DATE, 6.50, true, 'Export to the spreadsheet they will keep using anyway.')
) AS v(entry_date, hours, billable, note)
WHERE p.name = 'Kirkhollow Adjuster Dashboard';

-- Netherby Member Statements: 62.50h against 70.00h, and the oldest work here.
INSERT INTO time_entries (project_id, entry_date, hours, billable, note)
SELECT p.id, v.entry_date, v.hours, v.billable, v.note
FROM projects p CROSS JOIN (VALUES
  ((CURRENT_DATE - INTERVAL '33 months')::DATE, 7.50, true,  'Read the statement their printer produces, and every field on it.'),
  ((CURRENT_DATE - INTERVAL '32 months')::DATE, 8.00, true,  'Statement data model, with the share and loan sections kept apart.'),
  ((CURRENT_DATE - INTERVAL '31 months')::DATE, 7.00, true,  'Interest and dividend lines, matched to the core ledger to the cent.'),
  ((CURRENT_DATE - INTERVAL '30 months')::DATE, 8.00, true,  'Print stream for their mail house, in the format it really accepts.'),
  ((CURRENT_DATE - INTERVAL '29 months')::DATE, 6.50, true,  'Electronic delivery, with a real consent record.'),
  ((CURRENT_DATE - INTERVAL '28 months')::DATE, 8.00, true,  'Year-end tax insert, which has a deadline of its own.'),
  ((CURRENT_DATE - INTERVAL '27 months')::DATE, 5.00, false, 'Our own print emulator was a version behind. Ours.'),
  ((CURRENT_DATE - INTERVAL '26 months')::DATE, 7.00, true,  'Parallel run of two months against the old statements.'),
  ((CURRENT_DATE - INTERVAL '25 months')::DATE, 5.50, true,  'Handover to their operations team.')
) AS v(entry_date, hours, billable, note)
WHERE p.name = 'Netherby Member Statements';

-- Netherby Branch Rollup: 15.00h against 22.00h.
INSERT INTO time_entries (project_id, entry_date, hours, billable, note)
SELECT p.id, v.entry_date, v.hours, v.billable, v.note
FROM projects p CROSS JOIN (VALUES
  ((CURRENT_DATE - INTERVAL '27 months')::DATE, 8.00, true, 'Branch rollup taken from the ledger rather than from the statements.'),
  ((CURRENT_DATE - INTERVAL '26 months')::DATE, 7.00, true, 'Reconciled the rollup against their month end. Two cents, found.')
) AS v(entry_date, hours, billable, note)
WHERE p.name = 'Netherby Branch Rollup';

-- Sowerby Haul Ticketing: 44.50h against 50.00h.
INSERT INTO time_entries (project_id, entry_date, hours, billable, note)
SELECT p.id, v.entry_date, v.hours, v.billable, v.note
FROM projects p CROSS JOIN (VALUES
  ((CURRENT_DATE - INTERVAL '35 months')::DATE, 6.00, true,  'Rode a haul cycle to see where the ticket is actually written.'),
  ((CURRENT_DATE - INTERVAL '34 months')::DATE, 7.50, true,  'Ticket capture at the scale, one hand, gloves on.'),
  ((CURRENT_DATE - INTERVAL '34 months')::DATE, 8.00, true,  'Material and destination codes, from their price book.'),
  ((CURRENT_DATE - INTERVAL '33 months')::DATE, 6.50, true,  'Driver signature on a rugged tablet.'),
  ((CURRENT_DATE - INTERVAL '32 months')::DATE, 7.00, true,  'Daily haul report for the pit foreman.'),
  ((CURRENT_DATE - INTERVAL '32 months')::DATE, 4.00, false, 'Our own tablet build broke overnight. Not billed.'),
  ((CURRENT_DATE - INTERVAL '31 months')::DATE, 5.50, true,  'Handover, and the ticket book they keep as a fallback.')
) AS v(entry_date, hours, billable, note)
WHERE p.name = 'Sowerby Haul Ticketing';

-- Ambervale Yard Survey: 3.50h on a lead that was passed on. Real hours that are not
-- revenue and never will be.
INSERT INTO time_entries (project_id, entry_date, hours, billable, note)
SELECT p.id, v.entry_date, v.hours, v.billable, v.note
FROM projects p CROSS JOIN (VALUES
  ((CURRENT_DATE - INTERVAL '13 months')::DATE, 2.00, false, 'Site walk at their yard. Nothing agreed, nothing billed.'),
  ((CURRENT_DATE - INTERVAL '13 months')::DATE, 1.50, false, 'Wrote up what a yard system would have to do. We passed.')
) AS v(entry_date, hours, billable, note)
WHERE p.name = 'Ambervale Yard Survey';

-- Ambervale Rate Card Review: 2.00h, also non-billable.
INSERT INTO time_entries (project_id, entry_date, hours, billable, note)
SELECT p.id, v.entry_date, v.hours, v.billable, v.note
FROM projects p CROSS JOIN (VALUES
  ((CURRENT_DATE - INTERVAL '12 months')::DATE, 2.00, false, 'Read their rate card and said the fixed bid did not fit. Never billed.')
) AS v(entry_date, hours, billable, note)
WHERE p.name = 'Ambervale Rate Card Review';

-- Orrenshaw Lens Line Scoping: 2.50h on the second passed lead.
INSERT INTO time_entries (project_id, entry_date, hours, billable, note)
SELECT p.id, v.entry_date, v.hours, v.billable, v.note
FROM projects p CROSS JOIN (VALUES
  ((CURRENT_DATE - INTERVAL '6 months')::DATE, 2.50, false, 'One call and a scoping note. They went with a machine vendor.')
) AS v(entry_date, hours, billable, note)
WHERE p.name = 'Orrenshaw Lens Line Scoping';

-- Harbourline Atlas Ingest: 56.50h, none of it billable. An own venture has nobody to
-- invoice, so a billable hour here would be revenue that never existed.
--
-- The size is load-bearing at this scale, and it is the one thing in this file that
-- had to be tuned to a tool rather than to a story. time_summary itemizes only the
-- twelve largest projects by hours (PROJECT_BREAKDOWN in read.ts) and says how many it
-- left out. With 35 projects carrying hours, an own venture down at 26.50h falls below
-- that cut — so the line that reads "the studio own, never billable, so none of this
-- can be billed to anyone" never reaches the model, and the only trace of the rule
-- left in the output is the word non-billable next to a few recent entries. At 56.50h
-- it is the tenth largest and inside the cut. A studio that keeps investing in its own
-- product is also where the unbilled hours really go, so the number is not a fiddle.
INSERT INTO time_entries (project_id, entry_date, hours, billable, note)
SELECT p.id, v.entry_date, v.hours, v.billable, v.note
FROM projects p CROSS JOIN (VALUES
  ((CURRENT_DATE - INTERVAL '14 months')::DATE, 5.00, false, 'Ours: bank export ingest, one format at a time.'),
  ((CURRENT_DATE - INTERVAL '13 months')::DATE, 6.50, false, 'Ours: the matching rules, which are the whole of it.'),
  ((CURRENT_DATE - INTERVAL '11 months')::DATE, 4.50, false, 'Ours: statement matching against invoices.'),
  ((CURRENT_DATE - INTERVAL '10 months')::DATE, 7.00, false, 'Ours: ledger import, and the two banks that disagree about dates.'),
  ((CURRENT_DATE - INTERVAL '8 months')::DATE,  6.00, false, 'Ours: the reconciliation screen, rebuilt.'),
  ((CURRENT_DATE - INTERVAL '7 months')::DATE,  5.50, false, 'Ours: unmatched queue, so nothing is silently dropped.'),
  ((CURRENT_DATE - INTERVAL '5 months')::DATE,  3.50, false, 'Ours: duplicate detection on re-imported statements.'),
  (CURRENT_DATE - 80,                           4.00, false, 'Ours: a currency column, so a total is never printed without a unit.'),
  (CURRENT_DATE - 60,                           6.00, false, 'Ours: month-end close checklist.'),
  (CURRENT_DATE - 35,                           5.00, false, 'Ours: rounding audit, after one statement came out four cents wrong.'),
  (CURRENT_DATE - 20,                           3.50, false, 'Ours: cleanup pass over the importer.')
) AS v(entry_date, hours, billable, note)
WHERE p.name = 'Harbourline Atlas Ingest';

-- Harbourline Atlas Timesheet Import: 15.00h, none of it billable.
INSERT INTO time_entries (project_id, entry_date, hours, billable, note)
SELECT p.id, v.entry_date, v.hours, v.billable, v.note
FROM projects p CROSS JOIN (VALUES
  ((CURRENT_DATE - INTERVAL '7 months')::DATE, 4.00, false, 'Ours: timesheet import from the old spreadsheet.'),
  ((CURRENT_DATE - INTERVAL '4 months')::DATE, 5.00, false, 'Ours: rounding rules, to two decimals and no further.'),
  (CURRENT_DATE - 50,                          3.50, false, 'Ours: a report saying which hours cannot be billed to anyone.'),
  (CURRENT_DATE - 14,                          2.50, false, 'Ours: fixed a week that imported as a single day.')
) AS v(entry_date, hours, billable, note)
WHERE p.name = 'Harbourline Atlas Timesheet Import';

-- Tidegauge Almanac Prototype: 12.00h, none of it billable. An interview take-home
-- was never work anyone bought.
INSERT INTO time_entries (project_id, entry_date, hours, billable, note)
SELECT p.id, v.entry_date, v.hours, v.billable, v.note
FROM projects p CROSS JOIN (VALUES
  ((CURRENT_DATE - INTERVAL '21 months')::DATE, 5.00, false, 'Take-home: ingest thirty years of tide tables and normalise them.'),
  ((CURRENT_DATE - INTERVAL '21 months')::DATE, 4.50, false, 'Take-home: the query layer and one chart of the extremes.'),
  ((CURRENT_DATE - INTERVAL '21 months')::DATE, 2.50, false, 'Take-home: write-up. Submitted, and never an engagement.')
) AS v(entry_date, hours, billable, note)
WHERE p.name = 'Tidegauge Almanac Prototype';


-- ============================================================
-- Does this dataset actually bind the roles, and is the arithmetic below true?
--
-- Asserted, not claimed. db/900-seed.sql asserts that each role CAN bind; this file
-- goes one step further and asserts WHICH ROW WINS, using the same ORDER BY that
-- src/agent/evals/roles.ts uses. That is worth the extra strictness for one reason:
-- the map at the bottom of this file names the records the eval suite will be asked
-- about, and a map that can quietly stop being true is worse than no map. If someone
-- adds a client called Aardvark Freight with two projects, the binding moves and this
-- refuses to load rather than letting a comment lie.
--
-- It also makes a collation difference loud instead of silent. Every ORDER BY here
-- runs under the database collation, and the winners were chosen so that C and
-- en_US.UTF-8 agree — first letters differ, so no tie is decided by how a space or an
-- ampersand sorts. A database that ordered them differently fails here, at load, with
-- the name it actually picked.
--
-- The totals are asserted for the same reason: the money and hours written out below
-- are what a reader checks an answer against, and nothing else keeps them honest.
--
-- A RAISE in here rolls the whole swap back (see src/seed.ts), which is the intended
-- behaviour: a dataset that cannot bind the roles should not be left loaded looking
-- healthy.
-- ============================================================

DO $seed$
DECLARE
  v_name       TEXT;
  v_client     TEXT;
  v_names      TEXT;
  v_count      INT;
  v_second     INT;
  v_clients    INT;
  v_contacts   INT;
  v_projects   INT;
  v_invoices   INT;
  v_entries    INT;
  v_paid       BIGINT;
  v_open       BIGINT;
  v_overdue    BIGINT;
  v_naive      BIGINT;
  v_hours      NUMERIC;
  v_billable   NUMERIC;
  v_next       BIGINT;
  v_highest    NUMERIC;
BEGIN
  -- ---------- the scale ----------
  --
  -- Checked because the scale is the point: this dataset exists to be bigger and
  -- messier than db/900-seed.sql, and a block of this file deleted by accident would
  -- otherwise show up only as a suite that got easier.
  SELECT (SELECT count(*) FROM clients), (SELECT count(*) FROM contacts),
         (SELECT count(*) FROM projects), (SELECT count(*) FROM invoices),
         (SELECT count(*) FROM time_entries)
    INTO v_clients, v_contacts, v_projects, v_invoices, v_entries;
  IF v_clients <> 21 OR v_contacts <> 11 OR v_projects <> 36
     OR v_invoices <> 62 OR v_entries <> 200 THEN
    RAISE EXCEPTION 'seed: expected 21 clients, 11 contacts, 36 projects, 62 invoices and 200 time entries; got %, %, %, %, %',
      v_clients, v_contacts, v_projects, v_invoices, v_entries;
  END IF;

  -- ---------- client_multi_project ----------
  -- roles.ts: engagement_kind = 'client', more than one project, ORDER BY name.
  -- engagement_kind is in the WHERE for a reason this dataset makes sharp: Ambervale
  -- Freightworks sorts first of every client row here and has two projects, so a
  -- binder without that filter binds a company that was never a client.
  SELECT c.name INTO v_name
    FROM clients c
   WHERE c.engagement_kind = 'client'
     AND (SELECT count(*) FROM projects p WHERE p.client_id = c.id) > 1
   ORDER BY c.name
   LIMIT 1;
  IF v_name IS DISTINCT FROM 'Barrowfield Grain' THEN
    RAISE EXCEPTION 'seed: client_multi_project binds to [%], and this file documents Barrowfield Grain', coalesce(v_name, 'nothing');
  END IF;

  -- Six projects, not two. write-refuses-ambiguity passes the client name to a write,
  -- so the refusal has to name a real handful rather than a pair.
  SELECT count(*)::int INTO v_count
    FROM projects p JOIN clients c ON c.id = p.client_id
   WHERE c.name = 'Barrowfield Grain';
  IF v_count <> 6 THEN
    RAISE EXCEPTION 'seed: Barrowfield Grain has % project(s); the ambiguous-write case is documented against six', v_count;
  END IF;
  -- And every one of them contains the client name, so ILIKE on the client name is
  -- genuinely ambiguous rather than matching nothing.
  IF EXISTS (
    SELECT 1 FROM projects p JOIN clients c ON c.id = p.client_id
     WHERE c.name = 'Barrowfield Grain' AND p.name NOT ILIKE '%Barrowfield Grain%'
  ) THEN
    RAISE EXCEPTION 'seed: a Barrowfield Grain project does not contain the client name, so a write given the client name would match fewer rows than this file claims';
  END IF;

  -- ---------- client_with_project ----------
  -- Deliberately a DIFFERENT row from client_multi_project: Alderpoint Marine Supply
  -- has exactly one project. If the two roles collapse onto one company, nothing in
  -- the dataset shows that the predicates differ.
  SELECT c.name INTO v_name
    FROM clients c
   WHERE c.engagement_kind = 'client'
     AND EXISTS (SELECT 1 FROM projects p WHERE p.client_id = c.id)
   ORDER BY c.name
   LIMIT 1;
  IF v_name IS DISTINCT FROM 'Alderpoint Marine Supply' THEN
    RAISE EXCEPTION 'seed: client_with_project binds to [%], and this file documents Alderpoint Marine Supply', coalesce(v_name, 'nothing');
  END IF;

  -- ---------- passed_lead ----------
  SELECT name INTO v_name FROM clients WHERE engagement_kind = 'passed' ORDER BY name LIMIT 1;
  IF v_name IS DISTINCT FROM 'Ambervale Freightworks' THEN
    RAISE EXCEPTION 'seed: passed_lead binds to [%], and this file documents Ambervale Freightworks', coalesce(v_name, 'nothing');
  END IF;
  SELECT count(*)::int INTO v_count FROM clients WHERE engagement_kind = 'passed';
  IF v_count < 2 THEN
    RAISE EXCEPTION 'seed: % lead(s) were passed on, and the binder is only made to choose when there is more than one', v_count;
  END IF;

  -- ---------- inactive_client ----------
  -- BOTH axes. The three passed leads are also status inactive, which is exactly why
  -- the role needs both columns, and here one of them sorts first.
  SELECT name INTO v_name
    FROM clients WHERE status = 'inactive' AND engagement_kind = 'client'
   ORDER BY name LIMIT 1;
  IF v_name IS DISTINCT FROM 'Caldbeck Timber Group' THEN
    RAISE EXCEPTION 'seed: inactive_client binds to [%], and this file documents Caldbeck Timber Group', coalesce(v_name, 'nothing');
  END IF;
  SELECT count(*)::int INTO v_count FROM clients WHERE status = 'inactive' AND engagement_kind = 'client';
  IF v_count < 2 THEN
    RAISE EXCEPTION 'seed: % client(s) are inactive, and this dataset means to offer more than one', v_count;
  END IF;

  -- ---------- client_with_invoices ----------
  -- roles.ts prefers the client with the most OPEN invoices, because invoice_summary
  -- itemizes only those and the money-for-one-client case asserts on cited rows. The
  -- winner must therefore be unambiguous by open count alone, not by the name
  -- tie-break.
  SELECT c.name, (count(*) FILTER (WHERE i.status = 'open'))::int
    INTO v_name, v_count
    FROM clients c JOIN invoices i ON i.client_id = c.id
   GROUP BY c.id, c.name
   ORDER BY count(*) FILTER (WHERE i.status = 'open') DESC, count(*) DESC, c.name
   LIMIT 1;
  IF v_name IS DISTINCT FROM 'Fenwright Cold Storage' THEN
    RAISE EXCEPTION 'seed: client_with_invoices binds to [%], and this file documents Fenwright Cold Storage', coalesce(v_name, 'nothing');
  END IF;
  SELECT max(n)::int INTO v_second FROM (
    SELECT (count(*) FILTER (WHERE i.status = 'open'))::int AS n
      FROM clients c JOIN invoices i ON i.client_id = c.id
     WHERE c.name <> 'Fenwright Cold Storage'
     GROUP BY c.id
  ) others;
  IF v_count <= coalesce(v_second, 0) THEN
    RAISE EXCEPTION 'seed: Fenwright Cold Storage has % open invoice(s) and another client has %, so which row binds is decided by the name tie-break rather than by the data', v_count, v_second;
  END IF;

  -- ---------- contact_at_client / client_of_contact ----------
  -- One query, because they are one binding: a case needing both ends of an edge
  -- cannot have them chosen independently. Ordered exactly as roles.ts orders it.
  SELECT btrim(coalesce(ct.first_name, '') || ' ' || coalesce(ct.last_name, '')), c.name
    INTO v_name, v_client
    FROM contacts ct
    JOIN clients c ON c.id = ct.client_id
   WHERE btrim(coalesce(ct.first_name, '') || coalesce(ct.last_name, '')) <> ''
   ORDER BY EXISTS (SELECT 1 FROM invoices i WHERE i.client_id = c.id) DESC,
            coalesce(ct.is_primary, false) DESC,
            c.name,
            btrim(coalesce(ct.first_name, '') || ' ' || coalesce(ct.last_name, ''))
   LIMIT 1;
  IF v_name IS DISTINCT FROM 'Imogen Faulk' OR v_client IS DISTINCT FROM 'Alderpoint Marine Supply' THEN
    RAISE EXCEPTION 'seed: the contact pair binds to [% at %], and this file documents Imogen Faulk at Alderpoint Marine Supply',
      coalesce(v_name, 'nobody'), coalesce(v_client, 'nowhere');
  END IF;
  -- The two-hop case asks what has been billed to that contact client, so it must
  -- have been billed.
  IF NOT EXISTS (SELECT 1 FROM invoices i JOIN clients c ON c.id = i.client_id WHERE c.name = v_client) THEN
    RAISE EXCEPTION 'seed: % has no invoices, so the two-hop case has nothing to compose and would fail for being unanswerable', v_client;
  END IF;
  -- The trap that makes the ordering above worth having: primary contacts at a lead
  -- that was passed on and at a prospect, neither of which has ever been billed.
  IF NOT EXISTS (
    SELECT 1 FROM contacts ct JOIN clients c ON c.id = ct.client_id
     WHERE c.engagement_kind = 'passed' AND ct.is_primary
  ) OR NOT EXISTS (
    SELECT 1 FROM contacts ct JOIN clients c ON c.id = ct.client_id
     WHERE c.status = 'prospect' AND ct.is_primary
  ) THEN
    RAISE EXCEPTION 'seed: there is no primary contact at a passed lead or none at a prospect, so a binder that ignored whether the client was ever billed would no longer be caught';
  END IF;

  -- ---------- single_project ----------
  SELECT p.name INTO v_name
    FROM projects p
   WHERE (SELECT count(*) FROM projects q WHERE lower(q.name) LIKE '%' || lower(p.name) || '%') = 1
   ORDER BY p.name
   LIMIT 1;
  IF v_name IS DISTINCT FROM 'Alderpoint Fleet Fuel Audit' THEN
    RAISE EXCEPTION 'seed: single_project binds to [%], and this file documents Alderpoint Fleet Fuel Audit', coalesce(v_name, 'nothing');
  END IF;

  -- Every ordered pair, not one lucky row. A name contained in another makes log_time
  -- right to refuse and the write cases read as the agent failing; at 36 projects the
  -- pair is easy to introduce. This also catches a duplicated name, which the time
  -- entry blocks above depend on not existing.
  SELECT string_agg(DISTINCT a.name || ' is inside ' || b.name, '; ')
    INTO v_names
    FROM projects a JOIN projects b ON a.id <> b.id
   WHERE lower(b.name) LIKE '%' || lower(a.name) || '%';
  IF v_names IS NOT NULL THEN
    RAISE EXCEPTION 'seed: project names contain one another, so a write cannot resolve them and single_project may not bind: %', v_names;
  END IF;

  -- roles.ts and scripts/assert-roles.sql both put p.name into a LIKE pattern
  -- UNESCAPED, and say so. A name carrying a wildcard would be judged by a wider
  -- pattern than log_time actually uses, so the check above would disagree with the
  -- tool. No name here has one, and this is what keeps that true.
  IF EXISTS (SELECT 1 FROM projects WHERE strpos(name, '%') > 0 OR strpos(name, '_') > 0) THEN
    RAISE EXCEPTION 'seed: a project name contains a LIKE wildcard, and the substring check above escapes nothing, so it no longer predicts what log_time will do';
  END IF;

  -- ---------- absent_client ----------
  -- Across EVERY text column of every table, not just clients.name: a mention in a
  -- note, a title, a city or an email is enough to make the case test the opposite of
  -- its purpose. Columns are joined with spaces so no match can be manufactured
  -- across a boundary.
  IF EXISTS (
    SELECT 1 FROM clients
     WHERE lower(concat_ws(' ', name, status, engagement_kind, disposition, website, city, country, notes)) LIKE '%initech%'
  ) OR EXISTS (
    SELECT 1 FROM contacts
     WHERE lower(concat_ws(' ', first_name, last_name, email, phone, title, notes)) LIKE '%initech%'
  ) OR EXISTS (
    SELECT 1 FROM projects
     WHERE lower(concat_ws(' ', name, description, status)) LIKE '%initech%'
  ) OR EXISTS (
    SELECT 1 FROM invoices
     WHERE lower(concat_ws(' ', number, status, currency, description, notes)) LIKE '%initech%'
  ) OR EXISTS (
    SELECT 1 FROM time_entries WHERE lower(coalesce(note, '')) LIKE '%initech%'
  ) THEN
    RAISE EXCEPTION 'seed: the absent_client name appears somewhere in the data, so it cannot test whether the agent admits it does not know';
  END IF;

  -- ---------- the money ----------
  SELECT coalesce(sum(amount_cents) FILTER (WHERE status = 'paid'), 0),
         coalesce(sum(amount_cents) FILTER (WHERE status = 'open'), 0),
         coalesce(sum(amount_cents) FILTER (WHERE status = 'open' AND due_date IS NOT NULL AND due_date < CURRENT_DATE), 0),
         coalesce(sum(amount_cents) FILTER (WHERE status <> 'paid'), 0)
    INTO v_paid, v_open, v_overdue, v_naive
    FROM invoices;

  -- The figures written out at the bottom of this file. Asserted so that an edited
  -- amount fails the load instead of making the comment untrue, and so that the
  -- numbers a reader checks an answer against are the numbers in the database.
  IF v_paid <> 46915000 THEN
    RAISE EXCEPTION 'seed: collected is % cents and this file documents 46915000 ($469,150.00)', v_paid;
  END IF;
  IF v_open <> 7320000 THEN
    RAISE EXCEPTION 'seed: outstanding is % cents and this file documents 7320000 ($73,200.00)', v_open;
  END IF;
  -- Overdue is the one figure here with a shelf life, because it is derived from
  -- CURRENT_DATE: this assertion is true at the moment of the load, and stays true
  -- until INV-2052 crosses its due date twelve days later. Outstanding and collected
  -- do not move. The alternative — leaving it unasserted — would mean an edited due
  -- date could silently change which invoices the overdue answer names.
  IF v_overdue <> 3415000 THEN
    RAISE EXCEPTION 'seed: overdue is % cents at load time and this file documents 3415000 ($34,150.00)', v_overdue;
  END IF;
  IF v_naive <> 9740000 THEN
    RAISE EXCEPTION 'seed: a total written as status <> paid comes to % cents and this file documents 9740000 ($97,400.00) - the case that catches that mistake asserts the wrong figure is ABSENT, so it has to be the figure named here', v_naive;
  END IF;
  -- If these were ever equal the trap would be disarmed: the obvious wrong total
  -- would return the right answer and the case could no longer fail on it.
  IF v_naive = v_open THEN
    RAISE EXCEPTION 'seed: there is no void and no draft invoice, so a total written as status <> paid is right by luck';
  END IF;

  -- Something on each side of every line a money question draws.
  IF NOT EXISTS (SELECT 1 FROM invoices WHERE status = 'paid') THEN
    RAISE EXCEPTION 'seed: no invoice is paid, so nothing was ever collected';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM invoices WHERE status = 'void') THEN
    RAISE EXCEPTION 'seed: no invoice is void, so the trap for a total written as status <> paid is disarmed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM invoices WHERE status = 'draft') THEN
    RAISE EXCEPTION 'seed: no invoice is draft, so the trap for a total written as status <> paid is disarmed';
  END IF;
  SELECT count(*)::int INTO v_count
    FROM invoices WHERE status = 'open' AND due_date IS NOT NULL AND due_date < CURRENT_DATE;
  IF v_count < 2 THEN
    RAISE EXCEPTION 'seed: % invoice(s) are overdue, and this dataset means to offer more than one so that a total cannot be satisfied by the first row', v_count;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM invoices WHERE status = 'open' AND due_date IS NOT NULL AND due_date >= CURRENT_DATE
  ) THEN
    RAISE EXCEPTION 'seed: every open invoice is overdue, so a tool conflating outstanding with overdue still passes';
  END IF;

  -- The reissue, named. A dataset whose only void was withdrawn teaches that void
  -- means cancelled; one whose only void was reissued teaches that it means replaced.
  -- Both are here, and this is the pair.
  IF NOT EXISTS (
    SELECT 1 FROM invoices voided JOIN invoices reissued
        ON reissued.client_id = voided.client_id
       AND reissued.amount_cents = voided.amount_cents
     WHERE voided.number = 'INV-2031'   AND voided.status = 'void'
       AND reissued.number = 'INV-2032' AND reissued.status = 'paid'
  ) THEN
    RAISE EXCEPTION 'seed: INV-2031 should be a void invoice reissued as INV-2032, to the same client for the same amount, and it is not';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM invoices WHERE number = 'INV-2043' AND status = 'void') THEN
    RAISE EXCEPTION 'seed: INV-2043 should be the void that was withdrawn rather than reissued';
  END IF;

  -- Revenue integrity: nothing that was never a client, and nothing whose
  -- relationship has not started, may carry an invoice.
  IF EXISTS (
    SELECT 1 FROM invoices i JOIN clients c ON c.id = i.client_id
     WHERE c.engagement_kind <> 'client'
  ) THEN
    RAISE EXCEPTION 'seed: an invoice belongs to a row that is not engagement_kind=client, which would put non-revenue into a revenue total';
  END IF;
  IF EXISTS (
    SELECT 1 FROM invoices i JOIN clients c ON c.id = i.client_id WHERE c.status = 'prospect'
  ) THEN
    RAISE EXCEPTION 'seed: a prospect carries an invoice, which contradicts the relationship not having started';
  END IF;

  -- ---------- the hours ----------
  SELECT coalesce(sum(hours), 0), coalesce(sum(hours) FILTER (WHERE billable), 0), count(*)::int
    INTO v_hours, v_billable, v_entries
    FROM time_entries;
  IF v_hours <> 1237.50 OR v_billable <> 1095.00 THEN
    RAISE EXCEPTION 'seed: hours total % with % billable, and this file documents 1237.50 and 1095.00', v_hours, v_billable;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM time_entries WHERE billable)
     OR NOT EXISTS (SELECT 1 FROM time_entries WHERE NOT billable) THEN
    RAISE EXCEPTION 'seed: time entries must include both billable and non-billable rows';
  END IF;

  -- The rule db/001-business.sql could not express as a CHECK, because
  -- engagement_kind is two joins from time_entries.billable.
  IF EXISTS (
    SELECT 1 FROM time_entries t
      JOIN projects p ON p.id = t.project_id
      JOIN clients c ON c.id = p.client_id
     WHERE t.billable AND c.engagement_kind IN ('own_venture', 'artifact')
  ) THEN
    RAISE EXCEPTION 'seed: billable time is logged against an own_venture or artifact engagement, which has nobody to bill';
  END IF;
  -- And the same for a lead that was passed on: real hours, never revenue.
  IF EXISTS (
    SELECT 1 FROM time_entries t
      JOIN projects p ON p.id = t.project_id
      JOIN clients c ON c.id = p.client_id
     WHERE t.billable AND c.engagement_kind = 'passed'
  ) THEN
    RAISE EXCEPTION 'seed: billable time is logged against a lead that was passed on, which was never billed for anything';
  END IF;
  SELECT coalesce(sum(t.hours), 0) INTO v_hours
    FROM time_entries t
    JOIN projects p ON p.id = t.project_id
    JOIN clients c ON c.id = p.client_id
   WHERE c.engagement_kind IN ('own_venture', 'artifact');
  IF v_hours <> 83.50 THEN
    RAISE EXCEPTION 'seed: hours that can never be billed to anyone total % and this file documents 83.50', v_hours;
  END IF;

  -- The silence the CROSS JOIN form creates: a misspelled project name inserts
  -- nothing and every total is quietly short. One project is meant to have no hours,
  -- and it is named here.
  SELECT string_agg(p.name, '; ' ORDER BY p.name) INTO v_names
    FROM projects p
   WHERE NOT EXISTS (SELECT 1 FROM time_entries t WHERE t.project_id = p.id);
  IF coalesce(v_names, '') <> 'Vantham Theatre Scheduling' THEN
    RAISE EXCEPTION 'seed: the projects with no time entries are [%], and this file means that to be exactly Vantham Theatre Scheduling - a time entry block whose project name is misspelled inserts nothing and shows up here', coalesce(v_names, 'none');
  END IF;

  -- ---------- budgets: NULL, zero, and over ----------
  -- Three states, because read.ts has a branch for each and db/900-seed.sql reaches
  -- only two of them.
  IF NOT EXISTS (SELECT 1 FROM projects WHERE budget_hours IS NULL) THEN
    RAISE EXCEPTION 'seed: no project has a NULL budget, so nothing distinguishes "nobody agreed one" from a budget of zero';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM projects WHERE budget_hours = 0) THEN
    RAISE EXCEPTION 'seed: no project has a budget of exactly 0.00h, so the branch that says every hour is over it is never reached';
  END IF;
  SELECT count(*)::int INTO v_count FROM (
    SELECT p.id FROM projects p JOIN time_entries t ON t.project_id = p.id
     WHERE p.budget_hours > 0
     GROUP BY p.id, p.budget_hours
    HAVING sum(t.hours) > p.budget_hours
  ) over_budget;
  IF v_count < 2 THEN
    RAISE EXCEPTION 'seed: % project(s) are over an agreed budget, and this dataset means to offer more than one', v_count;
  END IF;

  -- ---------- start_date is not created_at ----------
  -- created_at is the moment of the swap; start_date is when anyone did anything. If
  -- they were ever the same day, this dataset would have reproduced the bug the
  -- column exists to avoid.
  IF EXISTS (SELECT 1 FROM projects WHERE start_date IS NULL OR start_date >= CURRENT_DATE) THEN
    RAISE EXCEPTION 'seed: a project has no start_date, or one that is not in the past, so nothing distinguishes it from created_at';
  END IF;
  IF EXISTS (SELECT 1 FROM projects WHERE created_at::DATE <= start_date) THEN
    RAISE EXCEPTION 'seed: a project row was created on or before the day its work started, which is not something a load of this file can produce';
  END IF;

  -- ---------- the invoice number sequence ----------
  -- The hazard the closing setval exists for, checked rather than assumed. Without it
  -- the first invoice created through the application is handed a number this dataset
  -- has already used, and fails on the unique index — a write that did nothing wrong,
  -- possibly weeks later, with nothing pointing back at this file. scripts/seed.ts
  -- warns about the same thing after the fact; here it is a refusal.
  SELECT CASE WHEN is_called THEN last_value + 1 ELSE last_value END
    INTO v_next FROM invoice_number_seq;
  SELECT max((substring(number from '(\d+)$'))::numeric) INTO v_highest FROM invoices;
  IF v_highest IS NOT NULL AND v_next <= v_highest THEN
    RAISE EXCEPTION 'seed: invoice_number_seq will hand out % and this dataset already uses %, so the next invoice created through the application collides', v_next, v_highest;
  END IF;
END
$seed$;


-- ============================================================
-- Which row satisfies which role
--
-- Checkable without running anything. The DO block above asserts every line of this
-- section mechanically — including which row wins each ORDER BY — so if someone edits
-- one and not the other, the load fails rather than the comment quietly going stale.
--
--   client_multi_project   Barrowfield Grain — six projects: Intake Scales, Silo
--                          Telemetry, Driver Kiosk, Moisture Lab, Rail Loadout,
--                          Grower Statements. All six names begin with the client
--                          name, so a write handed "Barrowfield Grain" matches five
--                          or more and has to ask which. Nine other clients also
--                          qualify (Caldbeck, Dunmarrow, Estcourt, Fenwright,
--                          Glasswater, Kirkhollow, Marrowick, Netherby, Vantham);
--                          Barrowfield is simply first by name.
--
--   client_with_project    Alderpoint Marine Supply — exactly ONE project, and
--                          alphabetically first of the fourteen clients with any.
--                          Deliberately not the same row as client_multi_project.
--
--   passed_lead            Ambervale Freightworks — engagement_kind 'passed', status
--                          'inactive', two cancelled projects, 5.50 non-billable
--                          hours, a primary contact, and no invoice ever. Also
--                          Orrenshaw Optics and Rhosmere Vineyards. It is the
--                          alphabetically first client row in the whole file, which
--                          is the trap: a binder that dropped engagement_kind from
--                          client_with_project, or that read status alone for
--                          inactive_client, lands here.
--
--   inactive_client        Caldbeck Timber Group — status 'inactive' AND
--                          engagement_kind 'client'. Also Kirkhollow Mutual,
--                          Netherby Provident Trust, Sowerby Rock Quarry. The three
--                          passed leads are 'inactive' too, and are not clients.
--
--   client_with_invoices   Fenwright Cold Storage — nine invoices: four paid, four
--                          open (two of them overdue), one void. Four open is
--                          strictly more than any other client, so this binding is
--                          decided by the data and not by the name tie-break.
--
--   contact_at_client      Imogen Faulk, Operations Manager.
--   client_of_contact      Alderpoint Marine Supply, bound as her pair: the
--                          alphabetically first client that has invoices and a
--                          primary contact. No read tool in this repository returns a
--                          contact, so an answer containing her name did not get it
--                          from the database.
--
--   single_project         Alderpoint Fleet Fuel Audit — alphabetically first of 36
--                          project names, active, real client, has a rate, under
--                          budget. No name here is a case-insensitive substring of
--                          another, so every project is resolvable by a write and
--                          whichever one binds can be logged against.
--
--   absent_client          'Initech' appears in no text column of any table. The
--                          assertion covers all of them — names, statuses,
--                          dispositions, websites, cities, countries, notes, emails,
--                          phones, titles, descriptions, invoice numbers, currency
--                          and time entry notes.
--
-- ── The money, as written ──
--
-- Asserted above, so these figures are the database.
--
--   collected (status paid)          $469,150.00   45 invoices: INV-2001..INV-2047,
--                                                  less the two voids in that range
--   outstanding (status open)         $73,200.00   12 invoices, INV-2048..INV-2059
--     of which overdue                $34,150.00   INV-2048 (58d), INV-2049 (36d),
--                                                  INV-2050 (17d), INV-2051 (4d)
--     of which not yet due            $39,050.00   8 invoices, due in 12 to 28 days.
--                                                  The overdue and not-yet-due split
--                                                  is true for twelve days after the
--                                                  dataset is applied, and then
--                                                  INV-2052 crosses its due date and
--                                                  moves $7,300.00 across the line.
--                                                  Outstanding and collected do not
--                                                  move at all.
--   excluded from both                 $5,650.00   2 void: INV-2031 (reissued as
--                                                  INV-2032), INV-2043 (withdrawn)
--                                     $18,550.00   3 draft: INV-2060, INV-2061,
--                                                  INV-2062 — never sent
--   every invoice, added up          $566,550.00   62 invoices
--
--   A total written as `status <> 'paid'` returns $97,400.00 — outstanding plus the
--   two voids plus the three drafts. That is the figure the
--   totals-exclude-void-and-draft case forbids, so it must not coincide with any
--   figure a correct answer would quote. It does not: no invoice, no per-client
--   total and no subtotal above shares those digits.
--
--   Per client, open only:  Fenwright $31,100.00 (4) · Barrowfield $23,200.00 (3)
--                           Estcourt $6,250.00 (2) · Vantham $5,900.00 (1)
--                           Alderpoint $4,150.00 (1) · Marrowick $2,600.00 (1)
--
-- ── The hours, as written ──
--
--   200 entries, 1,237.50h total: 1,095.00h billable, 142.50h not.
--
--   The 142.50h that is not billable splits three ways, and the split is the point:
--     83.50h can never be billed to ANYONE — the own venture (Harbourline Atlas
--            Ingest 56.50h, Timesheet Import 15.00h) and the artifact (Tidegauge
--            Almanac Prototype 12.00h). This is the figure roles.ts reads as
--            neverBillableHours, and the Ingest project is the tenth largest here so
--            that time_summary itemizes it rather than folding it into the "23 more
--            project(s) not shown" line.
--      8.00h on the three leads that were passed on: real hours that are not revenue
--            and never will be.
--     51.00h on real engagements, not charged for: our own tooling breaking, a load
--            test that hit their staging, chasing a vendor, a scoping call, the half
--            day after a cancellation.
--
--   Over budget, both of them:
--     Barrowfield Grain Silo Telemetry   82.00h against  70.00h — OVER by 12.00h, active
--     Caldbeck Kiln Sensor Rollout       30.00h against  24.00h — OVER by  6.00h, finished
--
--   The three budget states, which read.ts words differently and 900-seed.sql cannot
--   reach in full:
--     Barrowfield Grain Moisture Lab     10.00h, budget NULL — nobody agreed one
--     Estcourt Gate Camera Feed          12.50h, budget 0.00h — every hour is over it
--     Vantham Theatre Scheduling          0.00h, budget 30.00h — agreed, none spent
--
--   The other 28 projects, largest first. The three that can never be billed are in
--   the split above rather than repeated here; Harbourline Atlas Ingest at 56.50h
--   would sit between Glasswater Ticketing Kiosk and Vantham Implant Registry.
--     Fenwright Cold Chain Alarms        75.50h /  90.00h   83.9%
--     Caldbeck Yard Scheduling           68.50h /  75.00h   91.3%
--     Barrowfield Grain Intake Scales    68.00h /  80.00h   85.0%
--     Estcourt Railcar Weighbridge       67.50h /  95.00h   71.1%
--     Kirkhollow Claims Intake Triage    62.50h /  70.00h   89.3%
--     Netherby Member Statements         62.50h /  70.00h   89.3%
--     Dunmarrow Immunisation Recall      59.50h /  65.00h   91.5%
--     Glasswater Ticketing Kiosk         59.50h /  70.00h   85.0%
--     Vantham Implant Registry           53.50h /  80.00h   66.9%
--     Alderpoint Fleet Fuel Audit        51.50h /  90.00h   57.2%
--     Marrowick Closing Packet Assembly  48.50h /  75.00h   64.7%
--     Sowerby Haul Ticketing             44.50h /  50.00h   89.0%
--     Fenwright Dock Scheduling          40.50h /  55.00h   73.6%
--     Barrowfield Grain Driver Kiosk     38.00h /  45.00h   84.4%
--     Larkspit Tap Room Inventory        37.50h /  55.00h   68.2%
--     Barrowfield Grain Rail Loadout     33.00h /  60.00h   55.0%
--     Glasswater Crew Rostering          23.00h /  40.00h   57.5%
--     Barrowfield Grain Grower Statements 22.50h / 35.00h   64.3%
--     Dunmarrow Portal Accessibility     21.50h /  24.00h   89.6%
--     Kirkhollow Adjuster Dashboard      21.50h /  26.00h   82.7%
--     Wrayburn Frame Build Tracker       19.00h /  32.00h   59.4%
--     Netherby Branch Rollup             15.00h /  22.00h   68.2%
--     Marrowick Wire Confirmation         7.00h /  18.00h   38.9%
--     Caldbeck Log Deck Reports           6.00h /  20.00h   30.0%  cancelled, never invoiced
--     Fenwright Pallet Label Print        5.50h /  12.00h   45.8%  cancelled, never invoiced
--     Ambervale Yard Survey               3.50h, no budget — a lead we passed on
--     Orrenshaw Lens Line Scoping         2.50h, no budget — a lead we passed on
--     Ambervale Rate Card Review          2.00h, no budget — a lead we passed on
--
-- ── Two queries worth running ──
--
--   -- start_date is not created_at, and here they are up to three years apart:
--   SELECT name, start_date, created_at::DATE FROM projects ORDER BY start_date;
--
--   -- the counting rule that needs both columns. 'worked with' is the 15 rows that
--   -- are engagement_kind=client AND status in (active, inactive) — 11 active, 4
--   -- inactive. The other 6 are not, however they sort: three passed leads, one
--   -- prospect, one own venture, one artifact.
--   SELECT engagement_kind, status, count(*) FROM clients
--    GROUP BY 1, 2 ORDER BY 1, 2;
--
-- ── What to run next ──
--
--   npm run db:check   asserts the nine roles bind against whatever is loaded, and
--                      prints what each one bound to. The names it prints should be
--                      the names in this section.
--   npm run eval       binds the roles from this data and runs all 17 cases against
--                      it. Nothing here should skip: every role binds.
-- ============================================================
