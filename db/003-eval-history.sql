-- ============================================================
-- 003 — The eval suite records itself
--
-- The suite runs against a live model and, without this, leaves no trace.
-- Every assertion is checked, printed to a terminal, and lost. That has
-- already cost something concrete: one case passed at 22:11 and failed at
-- 22:20 on identical code, and the only reason anyone noticed was that the
-- suite happened to be run twice in one evening by hand. A suite whose only
-- output is scrollback can tell you that today is fine. It cannot tell you
-- that something changed, which is the question you actually want answered.
--
-- What is worth keeping is not the pass count. It is:
--
--   * which case, in which suite run, with which outcome
--   * WHICH RECORDS it was asked about — the cases bind roles rather than
--     naming clients, so "client_with_project" is one company on one run and
--     another on the next, and a failure is not debuggable without knowing
--     which
--   * which model answered, because a regression after a model change and a
--     regression after a prompt change are different investigations
--   * the failed assertions themselves, in the words the runner used
--
-- Two things this file does NOT do, deliberately:
--
-- agent_runs.kind is defined in 002, not added here by ALTER. The reasoning
-- for the column — that synthetic runs would otherwise swamp every health
-- figure — is recorded there, with the column it explains.
--
-- The rule that recording must never break the thing it records is enforced
-- in the runner, not in the schema: every write here is swallowed and logged,
-- and a suite whose opening insert failed degrades to printing and exiting
-- with the right code. A suite that failed because it could not write its own
-- bookkeeping would turn observability into an outage, and worse than in
-- production, because the failure would look like the agent regressing.
--
-- Applies after 002 — agent_eval_runs references agent_runs(id).
-- ============================================================

-- ---------- agent_eval_suites ----------
--
-- One row per execution of the whole suite. This is the unit worth comparing:
-- "what changed between Tuesday's run and Thursday's" is the question the
-- history exists to answer.
CREATE TABLE IF NOT EXISTS agent_eval_suites (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL,

  started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Stamped at the end, along with the totals, rather than computed when the
  -- suite opened. A suite with no finished_at is one that crashed or was
  -- killed partway, and that is worth being able to see.
  finished_at  TIMESTAMPTZ,

  -- Which model answered. A regression after a model change and one after a
  -- prompt change are different investigations, and without this they are
  -- indistinguishable a month later.
  model_id     TEXT,
  -- The commit the suite ran against, when the runner can determine it.
  git_sha      TEXT,

  -- total is written when the suite opens and counts every case ATTEMPTED,
  -- including the ones that will skip. The other three are written at the
  -- end. total <> passed + failed + skipped therefore means the suite did not
  -- finish, which is the same signal as a null finished_at and is worth
  -- having twice.
  total        INT NOT NULL DEFAULT 0,
  passed       INT NOT NULL DEFAULT 0,
  failed       INT NOT NULL DEFAULT 0,
  skipped      INT NOT NULL DEFAULT 0,

  -- The role binding, verbatim. The cases name shapes rather than records, so
  -- the same case asks about different rows on different days; a failure
  -- cannot be read without knowing which. Stored as given, so a run is
  -- reproducible from its own history rather than from someone's memory of
  -- what the database looked like.
  roles        JSONB NOT NULL DEFAULT '{}'::jsonb
);

COMMENT ON COLUMN agent_eval_suites.roles IS
  'What each declared role bound to on this run, verbatim. Without it a '
  'failure says a case broke but not which records it was asked about.';

CREATE INDEX IF NOT EXISTS idx_agent_eval_suites_user
  ON agent_eval_suites(user_id, started_at DESC);

-- ---------- agent_eval_runs ----------
-- One row per case per suite.
CREATE TABLE IF NOT EXISTS agent_eval_runs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- CASCADE, unlike everything else in this schema: a case result outside its
  -- suite has nothing to be compared against, so deleting the suite should
  -- take it.
  suite_id      UUID NOT NULL REFERENCES agent_eval_suites(id) ON DELETE CASCADE,

  -- The run itself, with its trace. Nullable and ON DELETE SET NULL: losing a
  -- trace to pruning must not lose the record that the case ran and what it
  -- decided. Null also covers the case that never got far enough to have a
  -- run at all.
  agent_run_id  UUID REFERENCES agent_runs(id) ON DELETE SET NULL,

  case_id       TEXT NOT NULL,

  -- The question as actually asked, after roles were substituted. Kept
  -- because the template lives in code and code changes; this is what the
  -- model saw.
  question      TEXT,

  passed        BOOLEAN NOT NULL DEFAULT FALSE,

  -- A skip is what an honest suite does when the data a case needs is not
  -- there. Two things arriving as one — "the agent got this wrong" and "there
  -- is no inactive client in this dataset" — is exactly the confusion the
  -- role system exists to end, and only one of them is worth fixing.
  skipped       BOOLEAN NOT NULL DEFAULT FALSE,

  -- Why it was skipped, or why it errored before any assertion ran.
  note          TEXT,

  -- The assertions that did not hold, in the runner's own words:
  -- [{ check, detail }]. A count tells you something regressed; this tells
  -- you what.
  failures      JSONB NOT NULL DEFAULT '[]'::jsonb,

  duration_ms   INT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON COLUMN agent_eval_runs.skipped IS
  'The data a case needed was not present. Never counted as a failure — a '
  'missing fixture and a wrong answer are different findings.';

CREATE INDEX IF NOT EXISTS idx_agent_eval_runs_suite
  ON agent_eval_runs(suite_id);

-- The query that finds a regression: every outcome of one case, newest first.
-- Not covered by the suite index — reading one case ACROSS suites is the
-- opposite access pattern, and it is the one the function below runs.
CREATE INDEX IF NOT EXISTS idx_agent_eval_runs_case
  ON agent_eval_runs(case_id, created_at DESC);

-- ---------- the question the history exists to answer ----------
--
-- A case that has both passed and failed within the window is a case whose
-- behaviour is not deterministic, and that is the most valuable thing a suite
-- can tell you. It is also exactly what went unnoticed until someone ran the
-- suite twice in one evening: the case that refuses to remember what a table
-- owns had passed nine minutes before it failed, on identical code.
--
-- The counting rule that matters: a SKIP IS NOT A FAILURE. A case that ran
-- once and skipped four times is not unstable, it is under-fixtured, and
-- folding the two together would bury the real flake under a list of missing
-- data. So failures are counted as `NOT passed AND NOT skipped` throughout,
-- and skips are reported in their own column where they can be read as what
-- they are.
CREATE OR REPLACE FUNCTION agent_eval_flaky(
  p_user_id UUID,
  -- Most recent suites, not days. A window in time says nothing when nobody
  -- ran the suite for a fortnight.
  p_suites  INT DEFAULT 20
) RETURNS TABLE (
  case_id     TEXT,
  runs        BIGINT,
  passes      BIGINT,
  failures    BIGINT,
  skips       BIGINT,
  last_seen   TIMESTAMPTZ,
  -- Null when a case has only ever done one thing. Non-null means the same
  -- code produced different verdicts, which is a finding in itself.
  flaky_since TIMESTAMPTZ
) LANGUAGE plpgsql STABLE AS $$
BEGIN
  RETURN QUERY
  WITH recent AS (
    SELECT s.id
    FROM agent_eval_suites s
    WHERE s.user_id = p_user_id
    ORDER BY s.started_at DESC
    LIMIT p_suites
  ),
  case_rows AS (
    SELECT e.*
    FROM agent_eval_runs e
    WHERE e.suite_id IN (SELECT recent.id FROM recent)
  )
  SELECT
    r.case_id,
    count(*),
    count(*) FILTER (WHERE r.passed),
    count(*) FILTER (WHERE NOT r.passed AND NOT r.skipped),
    count(*) FILTER (WHERE r.skipped),
    max(r.created_at),
    CASE
      WHEN count(*) FILTER (WHERE r.passed) > 0
       AND count(*) FILTER (WHERE NOT r.passed AND NOT r.skipped) > 0
      -- The earliest outcome still in the window, not the moment the flake
      -- began: the window is the only evidence available, and claiming a
      -- start date from it would be inventing one.
      THEN min(r.created_at)
      ELSE NULL
    END
  FROM case_rows r
  GROUP BY r.case_id
  -- Unstable first, then most-failing: the order someone would want to read.
  ORDER BY
    (count(*) FILTER (WHERE r.passed) > 0
     AND count(*) FILTER (WHERE NOT r.passed AND NOT r.skipped) > 0) DESC,
    count(*) FILTER (WHERE NOT r.passed AND NOT r.skipped) DESC,
    r.case_id;
END;
$$;

COMMENT ON FUNCTION agent_eval_flaky(UUID, INT) IS
  'Per case over the last N suites: passes, failures, skips, and whether the '
  'case has produced both outcomes. A skip is never counted as a failure.';
