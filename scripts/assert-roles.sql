-- ============================================================
-- Can every eval role bind against this database?
--
-- The eval cases name shapes rather than records — "a client with several
-- projects", "a lead that was passed on" — and the runner binds those roles to
-- whatever the database actually holds. A role that cannot bind SKIPS its cases,
-- which is the honest behaviour and also the dangerous one: the suite goes green
-- while covering less than it claims, and nobody is told.
--
-- So the binding is asserted, not hoped for. Run this against any database the
-- suite will be pointed at:
--
--   npm run db:check
--
-- 900-seed.sql already asserts the same conditions at load time, so on the seeded
-- compose database this is belt and braces. It exists separately because it also
-- works on a database this repository did not seed — point it at your own records
-- and it tells you which cases would silently skip.
--
-- Every failure names the role and says what was missing, because "assertion
-- failed" sends you reading SQL and "no client has more than one project" sends
-- you to the data.
--
-- Deliberately NOT in db/: that directory is mounted into
-- docker-entrypoint-initdb.d, so any .sql placed there is executed as part of
-- schema creation.
-- ============================================================

\set ON_ERROR_STOP on

DO $$
DECLARE
  v_name    TEXT;
  v_count   INT;
  v_broken  TEXT;
BEGIN
  -- ---------- client_multi_project ----------
  -- An ambiguous write has to ask WHICH project, so the case needs a client
  -- where the question is genuinely ambiguous.
  SELECT c.name INTO v_name
    FROM clients c
   WHERE c.engagement_kind = 'client'
     AND (SELECT count(*) FROM projects p WHERE p.client_id = c.id) > 1
   LIMIT 1;
  IF v_name IS NULL THEN
    RAISE EXCEPTION 'role client_multi_project cannot bind: no client with engagement_kind=client has more than one project';
  END IF;
  RAISE NOTICE 'client_multi_project   %', v_name;

  -- ---------- client_with_project ----------
  SELECT c.name INTO v_name
    FROM clients c
   WHERE c.engagement_kind = 'client'
     AND EXISTS (SELECT 1 FROM projects p WHERE p.client_id = c.id)
   LIMIT 1;
  IF v_name IS NULL THEN
    RAISE EXCEPTION 'role client_with_project cannot bind: no client with engagement_kind=client has any project';
  END IF;
  RAISE NOTICE 'client_with_project    %', v_name;

  -- ---------- passed_lead ----------
  -- The distinction the two-axis schema exists for: took a call, never became a
  -- client. A suite without this cannot test that a passed lead is not reported
  -- as a client.
  SELECT name INTO v_name FROM clients WHERE engagement_kind = 'passed' LIMIT 1;
  IF v_name IS NULL THEN
    RAISE EXCEPTION 'role passed_lead cannot bind: no row has engagement_kind=passed';
  END IF;
  RAISE NOTICE 'passed_lead            %', v_name;

  -- ---------- inactive_client ----------
  SELECT name INTO v_name
    FROM clients WHERE status = 'inactive' AND engagement_kind = 'client' LIMIT 1;
  IF v_name IS NULL THEN
    RAISE EXCEPTION 'role inactive_client cannot bind: no client is status=inactive with engagement_kind=client';
  END IF;
  RAISE NOTICE 'inactive_client        %', v_name;

  -- ---------- client_with_invoices ----------
  SELECT c.name INTO v_name
    FROM clients c JOIN invoices i ON i.client_id = c.id LIMIT 1;
  IF v_name IS NULL THEN
    RAISE EXCEPTION 'role client_with_invoices cannot bind: no invoice is linked to a client';
  END IF;
  RAISE NOTICE 'client_with_invoices   %', v_name;

  -- ---------- contact_at_client / client_of_contact ----------
  -- Bound as a pair, and preferring a client that has actually been billed. The
  -- two-hop case asks "who is our contact at X, and what have we billed that
  -- client?" — if X has no invoices the second half has no answer, and the case
  -- fails for being unanswerable rather than for the tools failing to compose.
  -- That is not hypothetical: the private binder took the first contact with a
  -- client_id and got away with it on row order alone.
  SELECT trim(coalesce(ct.first_name, '') || ' ' || coalesce(ct.last_name, '')), c.name
    INTO v_name, v_broken
    FROM contacts ct
    JOIN clients c ON c.id = ct.client_id
   WHERE EXISTS (SELECT 1 FROM invoices i WHERE i.client_id = c.id)
   LIMIT 1;
  IF v_name IS NULL THEN
    -- Falls back to any contact at a client, matching the runner: the
    -- composition is still worth exercising, and "we have not billed them" is a
    -- legitimate answer.
    SELECT trim(coalesce(ct.first_name, '') || ' ' || coalesce(ct.last_name, '')), c.name
      INTO v_name, v_broken
      FROM contacts ct JOIN clients c ON c.id = ct.client_id LIMIT 1;
    IF v_name IS NULL THEN
      RAISE EXCEPTION 'roles contact_at_client and client_of_contact cannot bind: no contact is attached to a client that exists';
    END IF;
    RAISE WARNING 'contact_at_client binds only to a client with NO invoices (%); the two-hop case will be weaker than intended', v_broken;
  END IF;
  RAISE NOTICE 'contact_at_client      %', v_name;
  RAISE NOTICE 'client_of_contact      %', v_broken;

  -- ---------- single_project ----------
  -- A project a write can name unambiguously. If every name contains another,
  -- log_time is right to refuse and the case reads as the agent failing.
  SELECT p.name INTO v_name
    FROM projects p
   WHERE (SELECT count(*) FROM projects q WHERE lower(q.name) LIKE '%' || lower(p.name) || '%') = 1
   LIMIT 1;
  IF v_name IS NULL THEN
    SELECT string_agg(DISTINCT a.name || ' is inside ' || b.name, '; ')
      INTO v_broken
      FROM projects a JOIN projects b ON a.id <> b.id
     WHERE lower(b.name) LIKE '%' || lower(a.name) || '%';
    RAISE EXCEPTION 'role single_project cannot bind: every project name is a substring of another (%)', v_broken;
  END IF;
  RAISE NOTICE 'single_project         %', v_name;

  -- ---------- absent_client ----------
  -- The name that must match NOTHING, so "I do not know" can be tested. Checked
  -- across every text column a lookup could reach, not just clients.name: a
  -- mention in a note is enough to make the case test the opposite of its
  -- purpose.
  SELECT count(*) INTO v_count FROM (
    SELECT 1 FROM clients
     WHERE lower(name) LIKE '%initech%' OR lower(coalesce(notes, '')) LIKE '%initech%'
    UNION ALL
    SELECT 1 FROM projects
     WHERE lower(name) LIKE '%initech%' OR lower(coalesce(description, '')) LIKE '%initech%'
    UNION ALL
    SELECT 1 FROM contacts
     WHERE lower(coalesce(first_name, '') || ' ' || coalesce(last_name, '') || ' ' || coalesce(notes, '')) LIKE '%initech%'
    UNION ALL
    SELECT 1 FROM invoices
     WHERE lower(number || ' ' || coalesce(description, '') || ' ' || coalesce(notes, '')) LIKE '%initech%'
    UNION ALL
    SELECT 1 FROM time_entries
     WHERE lower(coalesce(note, '')) LIKE '%initech%'
  ) hits;
  IF v_count > 0 THEN
    RAISE EXCEPTION 'role absent_client cannot bind: the name Initech appears in % place(s), so it cannot test the unknown case', v_count;
  END IF;
  RAISE NOTICE 'absent_client          Initech (verified absent)';

  RAISE NOTICE 'all 9 roles bind';
END $$;

-- ---------- the money invariants ----------
--
-- Not a role, but the same class of silent failure. Several cases ask about
-- money, and they are only meaningful if there is something on each side of the
-- line. A void invoice that was reissued and a draft are seeded specifically to
-- catch a total written as `status <> 'paid'`, so both must still be here for
-- that trap to be armed.
DO $$
DECLARE
  v_paid INT; v_open INT; v_void INT; v_draft INT; v_overdue INT;
  v_billable INT; v_non_billable INT;
BEGIN
  SELECT count(*) FILTER (WHERE status = 'paid'),
         count(*) FILTER (WHERE status = 'open'),
         count(*) FILTER (WHERE status = 'void'),
         count(*) FILTER (WHERE status = 'draft'),
         count(*) FILTER (WHERE status = 'open' AND due_date IS NOT NULL AND due_date < CURRENT_DATE)
    INTO v_paid, v_open, v_void, v_draft, v_overdue
    FROM invoices;

  IF v_paid = 0 THEN RAISE EXCEPTION 'no paid invoice: "how much have we collected" has no answer'; END IF;
  IF v_open = 0 THEN RAISE EXCEPTION 'no open invoice: "how much is outstanding" has no answer'; END IF;
  IF v_overdue = 0 THEN RAISE EXCEPTION 'no overdue invoice: overdue is derived, and nothing exercises the derivation'; END IF;
  IF v_void = 0 THEN RAISE EXCEPTION 'no void invoice: the trap for a total written as status <> paid is disarmed'; END IF;
  IF v_draft = 0 THEN RAISE EXCEPTION 'no draft invoice: the trap for a total written as status <> paid is disarmed'; END IF;

  SELECT count(*) FILTER (WHERE billable), count(*) FILTER (WHERE NOT billable)
    INTO v_billable, v_non_billable FROM time_entries;
  IF v_billable = 0 OR v_non_billable = 0 THEN
    RAISE EXCEPTION 'time entries must include both billable and non-billable work: the own-venture rule has nothing to bite on';
  END IF;

  RAISE NOTICE 'money: % paid, % open (% overdue), % void, % draft', v_paid, v_open, v_overdue, v_void, v_draft;
  RAISE NOTICE 'hours: % billable, % non-billable', v_billable, v_non_billable;
END $$;
