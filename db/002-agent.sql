-- ============================================================
-- 002 — The agent's own storage
--
-- 001 holds the business: clients, contacts, projects, invoices, time
-- entries. Nothing in this file has a foreign key into any of it. That is
-- deliberate — the agent's bookkeeping can be dropped and rebuilt without
-- touching a record it reads, and pruning a year of traces cannot cascade
-- into an invoice. The one place it costs something is noted below, on
-- agent_memory.
--
-- Four tables, four different jobs, kept apart because they fail
-- differently:
--
--   agent_runs        what happened, in enough detail to debug it later
--   agent_proposals   consent to one action, rather than to a session
--   agent_write_keys  the ledger that stops a retry billing twice
--   agent_memory      what the agent was told, and by whom
--
-- ── One operator, on purpose ──
--
-- user_id is a plain uuid. There is no users table to point at, no row
-- level security, and no policies. This is a single-operator system and
-- building the multi-tenant version now would be scaffolding nobody uses.
--
-- It is a simplification with a stated exit. Every index and every unique
-- constraint here carries user_id already — except agent_write_keys, whose
-- key is a hash with the user inside it — so multi-tenant is mostly
-- additive: add the tenant table and the foreign keys, then enforce the
-- scope somewhere a forgotten WHERE cannot bypass, which means RLS against
-- a session-set claim or a database role per tenant. What must NOT be
-- carried forward is trusting the application to remember the scope. The
-- partial unique index on agent_proposals is the only thing standing
-- between "asked twice" and "two separately approvable cards", and it is
-- keyed on a user_id the application hands us.
--
-- gen_random_uuid() is in core PostgreSQL since 13, so no extension is
-- enabled here. This targets the official postgres:17 image.
--
-- Every object is IF NOT EXISTS, so applying the file twice is not an
-- error. 003 references agent_runs(id) and must be applied after this.
-- ============================================================

-- ---------- agent_runs ----------
--
-- Without a trace you cannot debug an agent. The model made six calls, one
-- of them was wrong, and by the time you read the answer every
-- intermediate step has been garbage collected — leaving you to guess at a
-- system that is non-deterministic by construction.
--
-- With one, every question about a run has an answer: what it was asked,
-- which tools it chose, what arguments it passed, what came back, how long
-- each step took, what it cost, and which wall it hit if it stopped early.
CREATE TABLE IF NOT EXISTS agent_runs (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL,

  question       TEXT NOT NULL,
  answer         TEXT,

  -- Who asked. See the COMMENT below — this column exists because the
  -- alternative was string-matching the question.
  kind           TEXT NOT NULL DEFAULT 'operator'
                 CHECK (kind IN ('operator', 'watch', 'eval')),

  -- 'answered', or the wall it hit: step_limit, token_limit, time_limit,
  -- tool_error_limit, aborted. Never null — a run that stopped for an
  -- unknown reason is the bug this column exists to make visible.
  --
  -- No CHECK here, unlike kind, and the difference is the point. kind is a
  -- closed set that queries branch on, so a typo must fail loudly. The
  -- stop-reason vocabulary belongs to the budget: adding a new wall is a
  -- code change, and it must not also be a migration, or the wall gets
  -- recorded as something it is not to avoid the ceremony.
  stop_reason    TEXT NOT NULL,

  steps          INTEGER NOT NULL DEFAULT 0,
  tokens         INTEGER NOT NULL DEFAULT 0,
  duration_ms    INTEGER NOT NULL DEFAULT 0,

  -- Whether this run was allowed to change anything. Worth reading on its
  -- own: it should be rare, and a climb means the read-only default is
  -- being worked around rather than used.
  writes_allowed BOOLEAN NOT NULL DEFAULT FALSE,

  -- The records the answer was allowed to rest on: [{table, id, label}].
  -- Not decoration — it is what lets an answer be checked afterwards, and
  -- what stops the model reporting something it cannot point at.
  evidence       JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- Every step, in order.
  trace          JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- ── The verdict ──
  --
  -- The agent has no way to know it was wrong, and without this there is no
  -- way to tell it. An eval suite written only from imagination drifts from
  -- what actually breaks; the failures worth testing are the ones that
  -- already happened on real data. So a run can be marked wrong, with a
  -- sentence saying why, and that sentence is what a future eval case is
  -- written from.
  --
  -- Two values and a note, deliberately. A five-point scale invites
  -- deliberation over whether something was a three or a four, which is how
  -- judging stops happening at all.
  --
  -- Null is the default and the honest majority: most runs are never
  -- judged, and an unjudged run must never be counted as a good one.
  verdict        TEXT CHECK (verdict IS NULL OR verdict IN ('good', 'wrong')),
  verdict_note   TEXT,
  verdict_at     TIMESTAMPTZ,

  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON COLUMN agent_runs.trace IS
  'Ordered steps: model turns and tool calls, with arguments, truncated output, '
  'timing and token counts. The only way to debug a run after the fact.';

-- ── Why there is a `kind` at all ──
--
-- Eval runs are runs: they have a trace, a token cost, a stop reason, and
-- whatever reads runs can already read them. Giving the suite its own
-- parallel storage would be worse. But twenty-two synthetic runs per
-- execution would swamp an operator's fourteen real ones, and every health
-- figure would quietly become a statement about the test suite instead of
-- about the business. One column separates them.
--
-- It fixes a second thing on the way. The unprompted morning run was
-- previously distinguishable only by its question starting with "watch:",
-- and deciding what a row IS by matching text that a caller chose is a
-- guess that holds right up until someone types that prefix.
--
-- A note for whoever writes the queries: health and history exclude eval by
-- default, and asking FOR eval must exclude the others. The first attempt at
-- that filter was `p_only = 'eval' OR kind <> 'eval'`, which reads as "let
-- eval rows through when they are asked for" — so asking for eval returned
-- every run instead of only the eval ones. Selecting a kind has to exclude
-- the rest, not merely permit the one.
COMMENT ON COLUMN agent_runs.kind IS
  'Who asked. operator = a person; watch = the unprompted scheduled run; '
  'eval = the mechanical suite. Health and history exclude eval by default, '
  'because a synthetic run is not evidence about the business.';

COMMENT ON COLUMN agent_runs.verdict_note IS
  'Why it was wrong, in the operator''s words. The raw material for an eval '
  'case: what actually broke, on real data, once.';

CREATE INDEX IF NOT EXISTS idx_agent_runs_user_created
  ON agent_runs(user_id, created_at DESC);

-- The kind filter is on every read of health and history, so it belongs in
-- the index rather than being applied to the rows it just fetched.
CREATE INDEX IF NOT EXISTS idx_agent_runs_kind
  ON agent_runs(user_id, kind, created_at DESC);

-- Finding the runs that went wrong is the common debugging query, and the
-- rows it wants are the minority. Partial, so the index stays small enough
-- to be worth having.
CREATE INDEX IF NOT EXISTS idx_agent_runs_stop_reason
  ON agent_runs(stop_reason) WHERE stop_reason <> 'answered';

CREATE INDEX IF NOT EXISTS idx_agent_runs_verdict
  ON agent_runs(user_id, verdict_at DESC) WHERE verdict IS NOT NULL;

-- ---------- agent_proposals ----------
--
-- The agent could already propose: with writes off, a write tool returns
-- what it WOULD do and does nothing. What was missing was the other half —
-- a way to say yes to that specific thing.
--
-- Before this, the only way to act was to enable writes and ask again. That
-- grants the NEXT WHOLE RUN permission to change anything the model decides
-- to change, so what gets approved is a session rather than an action.
-- Worse, the second run resolves the request from scratch: a different
-- project can match, a status can have moved, and the thing that happens is
-- then not the thing that was read and agreed to. Consent to a sentence is
-- not consent to whatever that sentence turns out to mean a minute later.
--
-- So a proposal becomes a record. It carries the validated arguments, the
-- row it resolved to, the write key it will claim, and the facts that were
-- true when it was shown. Approving it re-runs THAT call — not the question
-- that produced it — and refuses if the record moved underneath it.
CREATE TABLE IF NOT EXISTS agent_proposals (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL,

  -- The run that proposed it, as a real relationship.
  --
  -- Nullable and ON DELETE SET NULL: a trace lost to pruning, or a trace
  -- that failed to persist at all, must not cost the operator the proposal
  -- itself. The card is the durable thing; the run that suggested it is
  -- context.
  --
  -- The constraint is here rather than left as a bare `run_id UUID`, and
  -- that is worth recording because the private original shipped it bare.
  -- The inconsistency was invisible until something read across it: the
  -- approval desk wanted to say where a card came from — a proposal the
  -- operator asked for and one the scheduled run left while nobody was
  -- watching are different things to find waiting, and only the second needs
  -- explaining. With no declared relationship the embed failed, and it
  -- failed silently, because the desk read the result as "or empty". A
  -- broken join reported an empty desk instead of an error, and a proposal
  -- nobody sees is a proposal nobody approves.
  run_id          UUID REFERENCES agent_runs(id) ON DELETE SET NULL,

  -- The call, exactly as the harness validated it. Re-validated again on
  -- approval, so a row edited by hand cannot smuggle anything past the
  -- tool's own checks.
  tool_name       TEXT NOT NULL,
  args            JSONB NOT NULL,

  -- ── write_key vs subject_key ──
  --
  -- Two identities, and the distinction is load-bearing.
  --
  -- write_key identifies the exact ACT, content included. It is computed at
  -- propose time from the resolved ids, so the ledger recognises an approval
  -- as the same act whether it arrives from here, from a write-enabled run,
  -- or from a retry of either.
  --
  -- subject_key identifies what the proposal is ABOUT, and is stable across
  -- revisions. Ask for a draft, read it, ask for changes: the second draft
  -- is a genuinely different write, so it gets a different write_key — that
  -- is exactly what stops the ledger replaying draft one in place of draft
  -- two, and two keys is correct. But left alone the first card stays on the
  -- desk, still approvable, and approving it applies the letter that was
  -- rejected. The subject is the same in both — the job, whatever the letter
  -- says this time — so a new card can retire the pending card it supersedes
  -- without touching the ledger's notion of a distinct write.
  --
  -- Nullable: set it only where a revision is a real possibility. A status
  -- change has no drafts.
  write_key       TEXT NOT NULL,
  subject_key     TEXT,

  -- What a person reads before deciding. The card is the contract.
  summary         TEXT NOT NULL,
  target_table    TEXT,
  target_id       TEXT,
  target_label    TEXT,

  -- The facts the summary asserted, as {table, id, expect: {col: value}}.
  -- Checked again before the write. A card that says "active -> inactive" is
  -- a claim about the present tense; if the status has moved by the time it
  -- is approved, the card describes something that no longer exists and the
  -- answer is no.
  precondition    JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- 'superseded' is in this list rather than reusing 'declined'. Declining
  -- is a decision somebody made; being superseded is what happened to a card
  -- nobody decided about, and a desk that reports the second as the first is
  -- telling the operator they rejected something they never saw again.
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN (
                    'pending', 'applied', 'declined', 'stale', 'expired',
                    'failed', 'superseded'
                  )),

  -- What actually happened, in the words the tool used. Kept for the applied
  -- and the refused alike: "the client is no longer active" is the useful
  -- half of a proposal that went stale.
  result          TEXT,
  evidence        JSONB NOT NULL DEFAULT '[]'::jsonb,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at      TIMESTAMPTZ,

  -- A proposal you no longer remember reading is not one you can
  -- meaningfully approve. It ages out rather than waiting forever.
  expires_at      TIMESTAMPTZ NOT NULL DEFAULT now() + interval '24 hours'
);

COMMENT ON COLUMN agent_proposals.subject_key IS
  'What the proposal is about, stable across revisions. Distinct from '
  'write_key, which identifies the exact act including its content. A new '
  'pending proposal retires any pending one sharing this.';

-- Asking twice does not stack two cards for one act. The insert that loses
-- this race gets a unique violation, and the caller is expected to surface
-- the card that already exists instead of writing a second one — two
-- approvable cards for one write is two chances to do it, and the operator
-- consented once.
--
-- PARTIAL, and that is the whole reason it works. Constraining the pair
-- unconditionally would force a decided proposal to be deleted before the
-- same write could ever be proposed again, destroying the record of the
-- decision. The same write refused on Monday and approved on Tuesday is two
-- records of two decisions, which is the point.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_agent_proposals_pending
  ON agent_proposals(user_id, write_key)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_agent_proposals_pending
  ON agent_proposals(user_id, created_at DESC)
  WHERE status = 'pending';

-- The desk shows what was recently decided as well as what is waiting. That
-- half is not decoration: a desk showing only open cards cannot answer "did
-- I approve that?", and that question is the reason the record exists.
CREATE INDEX IF NOT EXISTS idx_agent_proposals_recent
  ON agent_proposals(user_id, decided_at DESC);

-- The lookup that runs before every insert: is there a pending card about
-- this same thing?
CREATE INDEX IF NOT EXISTS idx_agent_proposals_subject_pending
  ON agent_proposals(user_id, subject_key)
  WHERE status = 'pending' AND subject_key IS NOT NULL;

-- The join goes proposal -> run on every read of the desk.
CREATE INDEX IF NOT EXISTS idx_agent_proposals_run
  ON agent_proposals(run_id)
  WHERE run_id IS NOT NULL;

-- ---------- agent_write_keys ----------
--
-- The thing that makes write tools safe. A model can call the same tool
-- twice in one turn, and a retried step can replay a call that already
-- succeeded. For a lookup that is waste. For "log four hours against this
-- client" it is a second billable line against someone real.
--
-- Claim-before-write, not write-then-record. The ledger row is inserted
-- FIRST, so two concurrent attempts race on a primary key rather than on the
-- write itself; the loser reads the winner's result and reports that nothing
-- was done a second time. Recording afterwards would leave the window that
-- matters wide open.
CREATE TABLE IF NOT EXISTS agent_write_keys (
  -- Derived from the write's own content — tool name, user, and the resolved
  -- arguments in a canonical order — so the same intent produces the same key
  -- however many times the model proposes it, and a retry cannot rename its
  -- own act. The user is inside the hash, which is why the primary key is the
  -- key alone and not a composite.
  key         TEXT PRIMARY KEY,
  user_id     UUID NOT NULL,
  tool_name   TEXT NOT NULL,

  -- ON DELETE SET NULL for the same reason as the proposal's: pruning a
  -- trace must not drop the ledger entry that prevents a double write.
  run_id      UUID REFERENCES agent_runs(id) ON DELETE SET NULL,

  -- What the first attempt returned, replayed verbatim to any later attempt.
  --
  -- NOT NULL, but the claim writes '{}' and fills this in once the write has
  -- succeeded, so a row is a reservation first and a receipt second. Two
  -- consequences the caller has to handle: a write that FAILS must delete its
  -- claim, or one transient database error becomes a permanent refusal to
  -- ever do that thing again; and a process killed between the claim and the
  -- update leaves a row asserting a write nobody performed, after which a
  -- later attempt replays an empty result and reports "already done".
  -- Nothing here closes that second hole — it needs a claimed_at and a sweep,
  -- and it has not been built.
  result      JSONB NOT NULL,

  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE agent_write_keys IS
  'Idempotency ledger for agent write tools. A repeated key returns the '
  'original result rather than performing the write a second time.';

CREATE INDEX IF NOT EXISTS idx_agent_write_keys_user
  ON agent_write_keys(user_id, created_at DESC);

-- ---------- agent_memory ----------
--
-- Notes that outlive the conversation. This is the table that compounds and
-- the one that can go wrong permanently: get a note wrong and it is wrong in
-- every future answer until somebody notices.
--
-- ── Memory loses to the record ──
--
-- A note records what was SAID, not what is true. "We do not take fixed-bid
-- work" is a fact the agent has no standing to assert; "told on 2026-08-08:
-- we do not take fixed-bid work" is true whether or not the policy still
-- holds, degrades visibly as it ages, and can be argued with.
--
-- From that follows the rule that matters: anything a table already owns is
-- REFUSED, not stored. A client's status, an invoice total, an amount
-- outstanding — those have a source of truth that changes without telling
-- the agent, and a remembered copy is a stale copy that will one day
-- contradict the live one, leaving two answers and no way to choose. Memory
-- is for what the database has no column for.
--
-- The schema cannot enforce this; a CHECK constraint cannot read English. It
-- lives in the remember tool, and the eval suite has a case for it. It is
-- recorded here because the guard has already been wrong once: the pattern
-- required the money keyword before the digits, so "they owe $4,500 right
-- now" was caught and "<client> currently has $12,000 outstanding" walked
-- straight through — and the eval suite's own second run wrote exactly that
-- sentence into the notes, which is how it was found.
--
-- ── Nothing is overwritten ──
--
-- A correction supersedes, leaving the old note in place beside the row that
-- replaced it. "What did the agent believe" is then always answerable,
-- including for a past date, and a bad note can be traced to the run that
-- wrote it.
CREATE TABLE IF NOT EXISTS agent_memory (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL,

  -- 'global' applies to every run. 'entity' applies only when that record is
  -- in play, which is what keeps the prompt from growing without bound as
  -- the agent is told more.
  scope           TEXT NOT NULL DEFAULT 'global'
                  CHECK (scope IN ('global', 'entity')),

  -- Which record an entity-scoped note is about, named rather than
  -- referenced. There is no single entity table in 001 to point a foreign key
  -- at — a note can be about a client, a contact, or a project — and pointing
  -- at one of them would either pick a favourite or need three nullable
  -- columns.
  --
  -- The cost is real and belongs written down: without the foreign key,
  -- deleting a client leaves its notes behind, pointing at nothing. So the
  -- loader must resolve an entity note by reading the named row, and a note
  -- whose row is gone must not be injected into a prompt. A dangling note is
  -- an accurate record of something once said; it is not a fact about a
  -- client that no longer exists.
  entity_table    TEXT,
  entity_id       UUID,

  subject         TEXT NOT NULL,
  body            TEXT NOT NULL,

  -- How it came to be believed. 'told' is the operator saying so, which is
  -- the only source that is authoritative about preference or intent.
  -- 'observed' is the agent's own conclusion and is worth less — keeping them
  -- in one column with different weight is what lets a reader discount the
  -- second without deleting it.
  source          TEXT NOT NULL DEFAULT 'told'
                  CHECK (source IN ('told', 'observed')),

  -- The run that wrote it, so a bad note leads back to the reasoning that
  -- produced it. SET NULL for the usual reason: losing the trace must not
  -- lose the note.
  run_id          UUID REFERENCES agent_runs(id) ON DELETE SET NULL,

  -- When the claim was made, not when the row was written. They are usually
  -- the same and occasionally are not — a note recorded after the fact is
  -- about the date it was said, and ordering by insertion would put it last.
  observed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  superseded_at   TIMESTAMPTZ,
  superseded_by   UUID REFERENCES agent_memory(id) ON DELETE SET NULL,

  CONSTRAINT entity_scope_needs_entity
    CHECK (scope = 'global' OR (entity_table IS NOT NULL AND entity_id IS NOT NULL))
);

COMMENT ON TABLE agent_memory IS
  'Durable notes. A note is a claim about what was said, not about what is '
  'true, and anything a business table owns is refused rather than copied.';

CREATE INDEX IF NOT EXISTS idx_agent_memory_live
  ON agent_memory(user_id, scope, observed_at DESC)
  WHERE superseded_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_agent_memory_entity
  ON agent_memory(entity_table, entity_id, observed_at DESC)
  WHERE superseded_at IS NULL;

-- One live note per subject per scope. Remembering the same subject again is
-- a correction, and a correction that left the old note live would put two
-- contradictory statements in the same prompt — which is worse than either
-- of them alone, because now the model picks.
--
-- lower(subject) because "Rates" and "rates" are the same subject to
-- everyone except a byte comparison.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_agent_memory_live_global
  ON agent_memory(user_id, lower(subject))
  WHERE superseded_at IS NULL AND scope = 'global';

CREATE UNIQUE INDEX IF NOT EXISTS uniq_agent_memory_live_entity
  ON agent_memory(user_id, entity_table, entity_id, lower(subject))
  WHERE superseded_at IS NULL AND scope = 'entity';
