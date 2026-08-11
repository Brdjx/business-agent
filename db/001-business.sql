-- ============================================================
-- 001 — The business
--
-- What a small consulting studio keeps: who it works with, who it talks to
-- there, what work is underway, what it billed, and where the hours went.
-- Five tables, and each one is here because the agent gets asked a question
-- it cannot answer without it.
--
-- This is a port of a private production schema, cut down hard. Dropped:
-- staff and auth (there is one operator here, and a user_id column holding
-- one value teaches nothing), the lead pipeline, the accounting ledger, the
-- knowledge graph, Stripe fields, invoice line items, and every JSONB
-- catch-all. What is left is what the eval suite actually asks about.
--
-- Loaded by docker-entrypoint-initdb.d in lexical order, so this file runs
-- before the agent's own tables and long before 900-seed.sql.
-- ============================================================

-- No extensions.
--
-- gen_random_uuid() has been in core Postgres since 13 and the compose file
-- pins postgres:17, so pgcrypto is not needed. That is worth keeping true
-- rather than adding the extension defensively: CREATE EXTENSION needs rights
-- that a managed Postgres often will not grant, and a schema that cannot be
-- applied to a hosted database for one unnecessary line is harder to adopt
-- than it looks. Nothing below depends on an extension.
--
-- On a server older than 13, add `CREATE EXTENSION IF NOT EXISTS pgcrypto;`
-- here.


-- ---------- updated_at ----------
--
-- One function, shared. Every table below carries updated_at, and every one of
-- them gets it from here rather than from application code: the agent is not
-- the only thing that writes to this database (a person with psql is the
-- other), and a timestamp maintained by whichever client remembered to set it
-- is a timestamp nobody can reason about.
--
-- CREATE OR REPLACE so a later schema file can define the same function
-- without the load order deciding who wins.

CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;


-- ============================================================
-- clients
--
-- Two columns carry two different questions, and keeping them apart is the
-- most load-bearing decision in this file.
--
--   engagement_kind — what this relationship IS
--   status          — where it stands
--
-- They were one column once. `status` held active | inactive | lead, so a
-- prospect who took one discovery call and passed had to be stored as
-- `inactive` — the same value a five-year client who finished gets. In the
-- system this is ported from, "who have we worked with" therefore answered
-- with a company that had never been a client, and nothing in the answer
-- suggested checking. Worse was coming: a work-history import brought in the
-- studio's own products and one take-home built for an interview, and storing
-- those as active clients would have put both into the client count and into
-- the revenue answer.
--
-- So one column says what a row is and the other says whether it is live:
--
--   engagement_kind = 'client'      a real commercial relationship
--   engagement_kind = 'passed'      took a call, never became a client —
--                                   never count as a client, never as revenue
--   engagement_kind = 'own_venture' ours; never billable, never revenue
--   engagement_kind = 'artifact'    built for another reason entirely, such as
--                                   a take-home; a record, not an engagement
--
--   status = 'active'    live right now
--   status = 'inactive'  over, or dormant
--   status = 'prospect'  a relationship that has not started
--
-- Which means the two have to be read TOGETHER. The predicates the tools and
-- the eval suite depend on:
--
--   worked with     engagement_kind = 'client' AND status IN ('active','inactive')
--   live clients    engagement_kind = 'client' AND status = 'active'
--   never a client  engagement_kind <> 'client' OR status = 'prospect'
--
-- Filter on engagement_kind alone and an open prospect counts as someone the
-- studio worked for. Filter on status alone and a lead that was passed on
-- counts as a client that went quiet. No single column answers the question.
-- That is the point, and the eval suite tests exactly this.
--
-- There is deliberately no CHECK forbidding ('passed', 'active') and the other
-- nonsense pairs. A constraint violation reaches the agent as a Postgres error
-- string, which it then has to explain to a person; a write tool that refuses
-- in a sentence is the same protection with an answer attached. If you add the
-- constraint, add the refusal first.
-- ============================================================

CREATE TABLE clients (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- An empty name is worse than a missing row: the agent cites records by
  -- name, so a blank one arrives in an answer as evidence with no label and
  -- reads as a bug in the agent.
  name               TEXT NOT NULL CHECK (btrim(name) <> ''),

  status             TEXT NOT NULL DEFAULT 'active'
                     CHECK (status IN ('active', 'inactive', 'prospect')),

  engagement_kind    TEXT NOT NULL DEFAULT 'client'
                     CHECK (engagement_kind IN ('client', 'passed', 'own_venture', 'artifact')),

  -- How it ended, where anyone recorded it. Nullable on purpose: for most rows
  -- nobody wrote it down, and an invented disposition is worse than an absent
  -- one — the agent will repeat it.
  disposition        TEXT
                     CHECK (disposition IN ('ongoing', 'completed', 'handed_off',
                                            'declined_by_us', 'declined_by_them')),

  website            TEXT,
  city               TEXT,
  country            TEXT DEFAULT 'US',

  -- The studio's default rate for this client, in cents per hour. Nullable
  -- because a passed lead and an own venture have no rate, and 0 would read as
  -- free work.
  default_rate_cents INTEGER CHECK (default_rate_cents IS NULL OR default_rate_cents >= 0),

  -- Free text a person wrote. The agent may quote it; it must never outrank the
  -- columns above, because a note is a memory of a fact and these are the fact.
  notes              TEXT,

  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON COLUMN clients.engagement_kind IS
  'What this row IS. client: a real commercial relationship. passed: took a '
  'call, never became a client - must never be counted as one or as revenue. '
  'own_venture: ours, never billable. artifact: built for another reason, such '
  'as a take-home. Read together with status: engagement_kind alone counts a '
  'prospect as a past client.';

COMMENT ON COLUMN clients.status IS
  'Where the relationship stands: active (live), inactive (over or dormant), '
  'prospect (has not started). Says nothing about what the relationship is - '
  'see engagement_kind.';

-- One row per client name, case-insensitively.
--
-- The agent resolves a client from a name in a sentence. Two rows differing
-- only in case are an ambiguity it cannot see and will resolve by whichever
-- row Postgres hands back first. A larger business would eventually regret
-- this constraint and need real disambiguation; this one needs the agent to be
-- right more than it needs two clients called the same thing.
CREATE UNIQUE INDEX uniq_clients_name_ci ON clients (lower(name));

CREATE INDEX idx_clients_kind_status ON clients (engagement_kind, status);


-- ============================================================
-- contacts
--
-- People. Reachable only through their client, which is what makes the
-- two-hop question ("who is our contact at X, and what have we billed X")
-- a graph walk rather than a lookup.
-- ============================================================

CREATE TABLE contacts (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Nullable. Someone met at a conference, with no engagement to attach them
  -- to, still needs somewhere to live; the alternative is inventing a client
  -- row to hold them, which is how a client list acquires companies that were
  -- never clients. The two-hop eval case needs a contact WITH a client, so the
  -- binder filters this column rather than assuming it.
  client_id  UUID REFERENCES clients(id) ON DELETE CASCADE,

  first_name TEXT NOT NULL CHECK (btrim(first_name) <> ''),
  -- Nullable: plenty of records hold one name, and requiring a surname invites
  -- a placeholder like '-' that then appears in answers.
  last_name  TEXT,
  email      TEXT,
  phone      TEXT,
  title      TEXT,
  is_primary BOOLEAN NOT NULL DEFAULT false,
  notes      TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_contacts_client ON contacts (client_id);


-- ============================================================
-- projects
--
-- The unit work and time hang off. Names matter more here than anywhere else
-- in the schema: the agent resolves a project from a phrase in a sentence with
-- ILIKE '%phrase%', so two projects whose names contain one another are an
-- ambiguity it must refuse rather than resolve. 900-seed.sql asserts that no
-- seeded project name is a substring of another, because "Platform" and
-- "Platform v2" is an easy pair to write by accident and it silently disables
-- every write case in the suite.
-- ============================================================

CREATE TABLE projects (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id    UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  name         TEXT NOT NULL CHECK (btrim(name) <> ''),
  description  TEXT,

  status       TEXT NOT NULL DEFAULT 'active'
               CHECK (status IN ('active', 'completed', 'paused', 'cancelled')),

  -- Rate in cents per hour, overriding the client's default. Cents, not a
  -- float: see the note on invoices.amount_cents.
  rate_cents   INTEGER CHECK (rate_cents IS NULL OR rate_cents >= 0),

  -- Hours, not money, so a decimal is fine here. Nullable, and the difference
  -- between NULL and 0 is load-bearing: NULL means nobody set a budget, 0 means
  -- the budget is zero and every hour is over it. A tool asked "are we over
  -- budget" must say which of those it found.
  budget_hours NUMERIC(8,2) CHECK (budget_hours IS NULL OR budget_hours >= 0),

  -- When the work began. NOT created_at.
  --
  -- The system this is ported from learned that the expensive way: a bulk
  -- import wrote every project row in one afternoon, an activity feed read
  -- created_at, and it reported the entire fourteen-year history as having
  -- started that afternoon. created_at is when this row was typed. start_date
  -- is when anyone did anything. They are almost never the same day, and the
  -- seed deliberately makes them differ so a tool that reaches for the wrong
  -- one is visibly wrong.
  start_date   DATE,
  end_date     DATE,

  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Work cannot finish before it starts. Cheap, and it catches the transposed
  -- pair that would otherwise be reported as a project of negative duration.
  CHECK (end_date IS NULL OR start_date IS NULL OR end_date >= start_date)
);

COMMENT ON COLUMN projects.start_date IS
  'When the work began. NOT created_at, which is when the row was written - a '
  'bulk import makes every created_at the same afternoon.';

CREATE UNIQUE INDEX uniq_projects_client_name_ci ON projects (client_id, lower(name));
CREATE INDEX idx_projects_client ON projects (client_id);


-- ============================================================
-- invoices
--
-- Money. Nothing in this file is more likely to be quoted back to a person as
-- fact, so the column types do the arguing.
-- ============================================================

CREATE SEQUENCE invoice_number_seq START WITH 1001;

CREATE TABLE invoices (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- RESTRICT, where contacts and projects CASCADE. Deleting a client should
  -- not quietly delete the record that money changed hands; the delete fails
  -- and a person decides what to do about the invoices.
  client_id    UUID NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,

  -- Human-readable and unique, because this is the identifier a person says
  -- out loud, and the eval suite asserts the agent quotes one rather than
  -- describing "an invoice".
  number       TEXT NOT NULL UNIQUE
               DEFAULT 'INV-' || lpad(nextval('invoice_number_seq')::TEXT, 4, '0'),

  status       TEXT NOT NULL DEFAULT 'draft'
               CHECK (status IN ('draft', 'open', 'paid', 'void')),

  -- Integer cents. Never float, and never NUMERIC-as-dollars either.
  --
  -- The float part is the well-known part. The other half is that a money
  -- column read straight into a language model's context is about to be added
  -- up, formatted, and repeated; an integer count of cents has exactly one
  -- reading, where 1650.00 leaves open whether it is dollars, and a total that
  -- is wrong by a factor of a hundred is stated with the same confidence as
  -- one that is right.
  --
  -- No negatives: there is no credit-note concept here, and a negative amount
  -- would silently reduce a revenue total nobody asked it to.
  amount_cents BIGINT NOT NULL CHECK (amount_cents >= 0),

  -- Every seeded row is USD. The column exists so no total is ever printed
  -- without a unit. If a second currency ever lands here, SUM(amount_cents)
  -- across rows stops meaning anything and every total has to group by this
  -- column - nothing in this repo does that yet.
  currency     TEXT NOT NULL DEFAULT 'USD',

  description  TEXT,
  notes        TEXT,

  -- Dates, not timestamps. Nobody knows what hour an invoice was paid, and a
  -- timestamptz invites a month total to shift by a day depending on the
  -- session time zone. The _at names are kept because that is what the tools
  -- and the eval cases say.
  issued_at    DATE,
  due_date     DATE,

  -- When the money actually arrived.
  --
  -- The private system had no such column for a long time, so "how much came
  -- in during March" fell back on updated_at — the moment the row was last
  -- touched. Marking six historical retainers paid in one sitting therefore
  -- put every one of those dollars into the current month. paid_at is the real
  -- date, and it can be backdated.
  paid_at      DATE,

  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- paid and paid_at are one fact, so the database holds them together rather
  -- than trusting whoever wrote the update. Without this, a row marked paid
  -- with no date is invisible to every question about when money arrived, and
  -- a row carrying a date while still open is counted as outstanding money
  -- that is already in the bank.
  CHECK (
    (status =  'paid' AND paid_at IS NOT NULL) OR
    (status <> 'paid' AND paid_at IS NULL)
  ),

  -- A draft was never sent, so it has no issue date. Everything else does.
  CHECK (status = 'draft' OR issued_at IS NOT NULL),

  CHECK (due_date IS NULL OR issued_at IS NULL OR due_date >= issued_at),
  CHECK (paid_at  IS NULL OR issued_at IS NULL OR paid_at  >= issued_at)
);

COMMENT ON COLUMN invoices.amount_cents IS
  'Integer cents. Never dollars, never float. Totals are summed in Postgres and '
  'formatted once, at the edge.';

COMMENT ON COLUMN invoices.paid_at IS
  'The date money arrived, backdateable. Not updated_at, which is when the row '
  'was last touched.';

-- Overdue is not a status.
--
-- It is a status plus a date, and it must stay derived:
--
--   status = 'open' AND due_date IS NOT NULL AND due_date < CURRENT_DATE
--
-- An `overdue` column would need a nightly job to stay true, and on the
-- morning after that job first failed the agent would report yesterday's truth
-- in the present tense. Anything answering "what is overdue" uses the
-- expression above, and this partial index is what makes it cheap.
CREATE INDEX idx_invoices_open_due ON invoices (due_date) WHERE status = 'open';

CREATE INDEX idx_invoices_client ON invoices (client_id);
CREATE INDEX idx_invoices_paid_at ON invoices (paid_at DESC) WHERE status = 'paid';


-- ============================================================
-- time_entries
--
-- Where the hours went. No user_id: there is one operator in this repo, and a
-- column holding one value would only teach the wrong lesson about what the
-- agent can attribute.
-- ============================================================

CREATE TABLE time_entries (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- NOT NULL. An entry with no project cannot be billed, cannot be counted
  -- against a budget, and cannot be attributed to a client — it is a number
  -- with nowhere to go that still shows up in a total.
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,

  -- The day the work happened. A date, because that is what anyone logging
  -- time knows.
  --
  -- The private system stores a start_time / end_time pair plus
  -- duration_minutes, and every read of it divides by 60 at the point of
  -- display — four separate conversions in one file, each of which could round
  -- differently. Here the column is the unit the questions are asked in.
  entry_date DATE NOT NULL,

  -- Hours, two decimal places. Hours are not money: 1.50 has one reading and
  -- no cent to lose. The ceiling is a day, because a 40 in this column is a
  -- week that someone typed into the wrong field, and it lands in a billable
  -- total that nobody re-checks.
  hours      NUMERIC(5,2) NOT NULL CHECK (hours > 0 AND hours <= 24),

  note       TEXT,

  -- Whether anyone can be charged for this.
  --
  -- An own_venture or an artifact engagement is NEVER billable: the studio's
  -- own product has nobody to invoice, and a take-home built for an interview
  -- was never work anyone bought. That rule lives two joins away from this
  -- column (time_entries -> projects -> clients.engagement_kind), so a CHECK
  -- cannot see it. A trigger could, and would arrive in the agent's tool
  -- output as a Postgres error string instead of a sentence a person can act
  -- on — so the write tool owns the rule, defaults billable from the client's
  -- engagement_kind, and says out loud when it overrides an explicit request.
  -- 900-seed.sql asserts the invariant over the seeded rows so a violation is
  -- caught at load rather than in an answer.
  billable   BOOLEAN NOT NULL DEFAULT true,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON COLUMN time_entries.billable IS
  'False for anything on an own_venture or artifact engagement - those can never '
  'be billed to anyone. Enforced by the write tool, not by a constraint: the '
  'engagement_kind is two joins away.';

-- No future-dating CHECK against CURRENT_DATE. It would be tempting and it is
-- not immutable: a dump taken today can fail to restore tomorrow, because rows
-- that satisfied the constraint when written no longer do. A write tool
-- refusing a date next March is the same guard with a better error message.

CREATE INDEX idx_time_entries_project ON time_entries (project_id);
CREATE INDEX idx_time_entries_date ON time_entries (entry_date);


-- ============================================================
-- What is deliberately NOT indexed
--
-- Every name lookup the agent performs is ILIKE '%phrase%', and no btree index
-- serves a leading wildcard. The honest options are a pg_trgm GIN index or a
-- sequential scan, and at this size — dozens of clients, dozens of projects —
-- the sequential scan is the correct plan. Adding the extension here would be
-- a performance story about a table that fits in one page.
-- ============================================================


-- ---------- triggers ----------

CREATE TRIGGER trg_clients_updated_at      BEFORE UPDATE ON clients
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER trg_contacts_updated_at     BEFORE UPDATE ON contacts
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER trg_projects_updated_at     BEFORE UPDATE ON projects
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER trg_invoices_updated_at     BEFORE UPDATE ON invoices
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER trg_time_entries_updated_at BEFORE UPDATE ON time_entries
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
