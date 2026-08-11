# Incidents

Every entry here is a defect that shipped in the private original this repository is
extracted from. None is hypothetical and none is here for shape. They are written down
because the schema comments and the tests keep referring to failures, and a decision reads
as arbitrary until you know what it prevents.

Three things about how to read them.

**The fixes were made in the original, not here.** The harness is not ported yet, so
nothing below was verified in this checkout. Where an entry names a regression guard it is
tagged the way the README tags everything: **in** means the file is in this repository and
you can read it; **to come** means the guard exists in the private original and is a claim
about that system, not about this one.

**Client names are replaced with `<client>`.** The error strings, the times and the counts
are as recorded.

**The costs are small in absolute terms.** This is one operator's business: the money at
stake in a mislabelled time entry is one person's afternoon, and the blast radius of the
worst entry here was one fabricated sentence. What is worth reading is not the damage, it is
that half of these were sitting behind an assertion that passed.

| What broke | What it changed |
|---|---|
| Approving a write had never worked in production | Tool registration became an explicit, idempotent call |
| The test for that fix passed with the fix reverted | The test may not create the condition it checks |
| The approval desk rendered blank instead of erroring | The FK exists; a failed read raises |
| The eval suite wrote a fabricated figure into live memory | A third gate, `allowNotes`, separate from `allowWrites` |
| The same assertion passed at 22:11 and failed at 22:20 | Sentence-scoped, order-independent guard; the suite records itself |
| Four eval cases were wrong rather than the agent | Cases name roles, not records; assertions state outcomes |
| An own venture's time was logged billable | The billable default moved after the client is resolved |
| Asking for eval runs returned every run | Selecting a kind excludes the others, not merely permits the one |

---

## 1. Approving a write had never worked in production

**Observed.** On 2026-08-10, two proposals were approved from the desk. Both came back
with: `There is no tool called draft_upwork_proposal. Available tools: find_client,
invoice_totals.`

**Root cause.** Tool registration was a side effect of importing `loop.ts`. That worked for
the run endpoint, which imports the loop by definition. It silently failed for the endpoint
that matters most: `POST /agent/proposals/{id}/decide` imports `proposals.ts`, which imports
`executeTool` from `tools.ts` and has no reason to touch the loop. Its bundle therefore
carried a registry holding only the two tools `tools.ts` defines itself.

**Cost.** Every approval of a write, for the entire life of the proposals feature. The
proposal desk *is* the per-action consent mechanism, and its single action was inert.
Reads were unaffected, which is why it went unnoticed: the agent answered questions
correctly the whole time.

Nothing caught it, and the reasons are the interesting part. The unit tests call
`registerTools` themselves at the top of each file. The write-path simulation — the only
thing that exercises propose-then-approve against real Postgres — imports `runAgent`, so
the loop was loaded in-process and the registry was full; it reported every one of its
checks green while the deployed path was broken. A registry assembled by whichever entry
point happens to import which module is not a registry, it is a coincidence.

**Fix.** An explicit, idempotent `ensureToolsRegistered()`, called by every entry point
that will reach `executeTool`. Deliberately not another import side effect: replacing one
implicit trap with another leaves the same trap, and an import whose only purpose is to run
code is the first thing a bundler is entitled to drop — these handlers are built with
esbuild and minified.

**What prevents it now.** `registry.test.ts` (**to come**), which imports exactly and only
what the decide handler imports, and never calls `registerTools` or `ensureToolsRegistered`
itself. It drives `decideProposal` against a stubbed database and asserts the outcome
message contains neither `There is no tool called` nor the literal
`Available tools: find_client, invoice_totals`. It deliberately does not assert success —
the call may fail for its own reasons against a stub. The only thing it holds is that the
registry never again claims the tool does not exist.

## 2. The first test written for that fix was tautological

**Observed.** The new test passed with the fix reverted.

**Root cause.** It called `ensureToolsRegistered()` itself before asserting. So it proved
that the helper works, which was never in doubt, rather than that the decide path calls it.

**Cost.** A near miss, and the reason it is written up. Had it shipped, the defect in entry
1 would have been covered by a green test with the right name, which is a worse position
than having no test at all — the risk stops being visible.

**Fix.** The test registers nothing. Registration has to be reached through
`decideProposal` or the test is measuring itself.

**What prevents it now.** Nothing automatic; the shape of the test is the guard. The way to
confirm it is still honest is to delete the `ensureToolsRegistered()` call from
`proposals.ts` and check that the test fails. `proposals.ts` carries a comment at that call
saying `registry.test.ts` is the only test that would notice the line being removed, which
is the note to read before deleting either.

## 3. The approval desk rendered blank rather than erroring

**Observed.** The desk showed nothing pending. Nothing errored, in the client or the log.

**Root cause.** Two defects stacked, and either alone would have been visible.

The migration that created `agent_proposals` declared `run_id UUID` and stopped there,
where the write-key ledger next to it already had
`run_id UUID REFERENCES agent_runs(id) ON DELETE SET NULL`. The inconsistency was invisible
until something needed to read across it. What needed it: a card should say where it came
from, because a proposal the operator asked for and one the scheduled run left while nobody
was watching are different things to find waiting, and only the second needs explaining.
The run already knows which it was, so the provenance is one relationship away — except
that with no declared relationship, there was nothing for the query to embed, and it
failed.

Then the read swallowed it. `listProposals` returned `data ?? []`, so a failed query became
an empty list.

**Cost.** A proposal nobody sees is a proposal nobody approves. The failure presented as
"nothing is waiting on you", which is a statement about the business that a broken query is
not entitled to make. The run history had avoided exactly this mistake on purpose; the
proposals file made it anyway.

**Fix.** A follow-up migration added the constraint as
`agent_proposals_run_id_fkey ... ON DELETE SET NULL` — matching the ledger, because a trace
pruned later must not take the record of the decision with it — plus a partial index on
`run_id`, since the join runs on every read of the desk. And `listProposals` now raises on
either query's error instead of coalescing it away.

**What prevents it now.** The constraint. In this repository the foreign key is inline in
the table definition rather than bolted on by a later migration, and the reason is in the
column comment (`db/002-agent.sql`, **in**) — there is no deployed database here to
migrate, so the correction is the shipped state. No test asserts that the desk raises
rather than returning empty; see [what is still not covered](#what-is-still-not-covered).

## 4. The eval suite was believed read-only. It wrote a fabricated figure into live memory

**Observed.** After a suite run, the operator's notes contained
`<client> currently has $12,000 outstanding` — a figure no invoice supported, written by a
test question, attributed and dated as something the operator had said.

**Root cause.** Memory tools sit outside the write gate on purpose, and that part is not
the defect. A note changes what the agent knows, not what the business owes; and gating
notes would make memory useless exactly where it is worth most, because runs are read-only
by default and that is where nearly all conversation happens. An agent that can only learn
when you have armed it will never learn anything.

The defect is that the eval runner set `stateless: true` believing that made the run leave
no trace, and `stateless` only covered threads and history. Notes had no gate at all. The
case `refuses-to-remember-what-a-table-owns` asks the agent to remember a computed total on
purpose; the guard that should have refused the write also failed (entry 5), so the tool
ran, and it persisted.

**Cost.** One fabricated note in production memory, which would have been injected into
every later run's prompt as something the operator said. It was corrected by superseding
rather than deleting, so the record of having believed it remains, which is the design
working as intended after the fact.

**Fix.** A third flag on the tool context, `allowNotes`, defaulting to allowed and set by
the loop to `opts.stateless !== true`. With it off, the `remember` tool runs its validation
and its entity resolution — everything that could refuse the note still refuses it — and
then returns the note it *would* have written, prefixed `NOTES ARE NOT BEING SAVED on this
run`. The suite exercises the whole path and persists none of it. The console's label was
reworded to match: read-only means it will not touch business records, not that it cannot
keep a note.

**What prevents it now.** Structure, not a test. The eval runner passes `stateless: true`,
and `allowNotes` is derived from it in one place rather than passed independently. There is
no unit test covering the `allowNotes === false` branch in the original — that is a real
gap and it is listed below rather than dressed up.

## 5. The same assertion passed at 22:11 and failed at 22:20

**Observed.** `refuses-to-remember-what-a-table-owns` passed, then failed nine minutes
later, on identical code.

**Root cause.** The guard in the `remember` tool required a money keyword to appear *before*
the digits, within twenty characters. So `They owe $4,500 right now` was caught and
`<client> currently has $12,000 outstanding` walked straight through. Which of those two
shapes the model produced varied between runs, so the case's verdict tracked the model's
word order rather than the agent's behaviour. The second run is the one that wrote the note
in entry 4.

**Cost.** The note in entry 4, and a suite reporting itself as mechanical while one of its
results depended on phrasing.

**Fix.** Two patterns, both required, in the same sentence, in either order: a figure, and a
term naming something the database computes (`owes`, `outstanding`, `balance`, `invoiced`,
`billed`, `revenue`, `logged`, and the rest). Scoped to a sentence, because reading across a
whole note would refuse an ordinary paragraph that mentions a rate and, separately,
invoices. A figure alone is deliberately not enough to refuse — "consider fixed-bid work
above $50k" is a standing policy, no tool holds it, and it is exactly what memory is for.
The predicate is exported as `computedFigureIn` so it can be tested without a database, and
it returns the offending sentence so the refusal can quote it back.

**What prevents it now.** `memory.test.ts`, the `a figure the database owns` block
(**to come**): the balance in either word order; the standing policy that must still be
allowed; and a figure in one sentence with the term in another, which must not be joined.
In this repository the fact that this guard has already been wrong once is recorded in the
`agent_memory` comments (`db/002-agent.sql`, **in**), because the schema cannot enforce the
rule — a CHECK constraint cannot read English — and the next person to weaken the pattern
should know what it cost.

**A second finding from the same night.** This was caught only because the suite happened to
be run twice by hand in one evening. A green suite left nothing behind: twenty-two
assertions checked against a live model, printed to a terminal, and lost. So the suite now
records itself — one row per execution with the model id, the commit and the role binding
verbatim, one row per case with the failed assertions in the runner's own words — and
`agent_eval_flaky` answers the question that actually matters, which is not the pass count
but *which case has both passed and failed*. That schema is in `db/003-eval-history.sql`
(**in**). The recording inherits the trace rule: every write is swallowed and logged, and a
suite whose opening insert fails degrades to exactly what the suite was before the table
existed. A suite that failed because it could not write its own bookkeeping would look like
the agent regressing.

## 6. Four eval cases were wrong rather than the agent

**Observed.** Cases failing while the answer was correct, and in two instances while the
answer was better than the assertion allowed.

The four, as recorded in the cases file:

- `status-change-is-not-claimed-when-nothing-changes` asserted that a
  `set_client_status` proposal would be left on the desk, and failed on the suite's very
  first run — correctly. A write tool that finds the value already set returns no proposal,
  because a card asking you to approve a no-op is noise; that behaviour is deliberate and
  unit-tested. The assertion was reading live, mutable data as though it were a fixture, and
  the client it named had since become inactive, so it could never hold again.
- `passed-lead-is-not-a-client` demanded the literal word "passed" and failed a correct
  answer that said "never became a client — declined by us".
- `write-refuses-ambiguity` was wrong twice. First it demanded the word "which"; then it
  demanded a `log_time` call. Both times it encoded an assumed implementation instead of the
  outcome, and asking before calling `log_time` is better behaviour than calling it and
  being refused.
- `note-loses-to-record` forbade the string "on a 12k monthly retainer" and so failed the
  best available answer — one that quoted the stale note precisely in order to say it was
  stale. Naming the conflict is the behaviour wanted.

A fifth case was deleted rather than fixed. It asserted that no em dash appeared anywhere in
the answer. The stripper guarantees that for the generated letter, and the letter is not the
answer: the dash it caught came from the agent's own conversational prose, which no client
ever reads. A deterministic guarantee belongs in a unit test over the whole letter, not in a
live-model case reading the 500 truncated characters a trace keeps.

**Cost.** Time spent investigating the agent for a defect in the test, twice on one case.
Worse, a suite that was beginning to be argued with rather than trusted, which is the point
at which it stops being able to gate a change.

**Fix.** Three parts.

Assertions state outcomes, not implementations, and are any-of rather than all-of wherever
several wordings are honest. An eval that scores phrasing measures the prompt.

Cases name roles, not records. A case declares the shape it needs — a client with more than
one project, a lead that was passed on, a name that must match nothing — and the runner
binds those roles against whatever the database actually holds before anything runs, then
prints the binding, so a run is reproducible from its own output. Fifteen of the twenty-two
cases had named a real client outright, which meant the suite could only ever run against
one database and that a case broke silently when the record it assumed changed underneath
it.

A role that cannot be bound skips its cases, with a sentence saying what was missing.
"The agent got this wrong" and "the data this case needs is not there any more" arrive
identically otherwise, and only one of them is worth fixing; reporting the second as the
first is how a suite loses its authority. Skips are recorded alongside passes, because a
case that has been skipping for six weeks is a coverage gap nobody is being told about.

**What prevents it now.** The role list and the binder (**to come**). And in this
repository, the seed asserts every binding condition at load time and aborts with the
reason if one fails (`db/900-seed.sql`, **in**) — rename a project or change a client's
`engagement_kind` and whichever role can no longer bind says so when the database loads,
rather than as a skipped case weeks later.

## 7. An own venture's time was logged billable

**Observed.** The first write this agent ever performed — thirty minutes against one of the
studio's own ventures — landed marked billable.

**Root cause.** `billable` defaulted to `true` in the tool's `validate` function, which runs
before `run`, which is where the project name is resolved to a project and a client. At
validation time nothing knows whose project it is. The decision needed a resolved record
and was being made in the layer that has not resolved one.

**Cost.** One wrong flag on one time entry. The venture has no rate and no invoice path, so
nothing was billed to anybody. What makes it worth an entry is that the same default would
have been wrong in a way that mattered on a project that did have a rate.

**Fix.** The default is decided in `run`, after the client comes back with its
`engagement_kind`. `own_venture` is the studio's own and `artifact` is not an engagement at
all, so neither can be billed to anyone. An explicit `billable: true` on either is
overridden rather than obeyed, and said out loud in the result — the model does not get to
bill an own venture by asking twice, and a quietly flipped flag is the kind of silent
correction that makes the rest of a report suspect. `billable` is also part of the write
key, because the same hours logged billable and non-billable are two different entries and
must not share one.

**What prevents it now.** `write-tools.test.ts` (**to come**): never bills the studio's own
venture; overrides an explicit billable and says so; honours an explicit non-billable on a
real client; and gives billable and non-billable hours different write keys. In this
repository the seed refuses to load if any billable time entry belongs to an `own_venture`
or `artifact` engagement (`db/900-seed.sql`, **in**) — the rule the business schema cannot
express as a CHECK, because `engagement_kind` is two joins away from `time_entries.billable`.

## 8. Asking for the eval runs returned every run

**Observed.** The run history's `eval` filter returned the whole history.

**Root cause.** The filter was written `p_only = 'eval' OR kind <> 'eval'`. That reads as
"let eval rows through when they are asked for", which is not what selecting a kind means:
with `p_only = 'eval'`, the first disjunct is true for every row in the table.

**Cost.** One view, silently mixing twenty-two synthetic runs per suite execution into a
list whose purpose is to show what a person and the scheduled run actually did. The health
figures were never affected — they exclude eval with a plain `kind <> 'eval'` and had no
"only" mode to get wrong.

**Fix.** `CASE WHEN p_only = 'eval' THEN r.kind = 'eval' ELSE r.kind <> 'eval' END`.
Selecting a kind has to exclude the others, not merely permit the one.

**What prevents it now.** Weakly, and worth saying plainly. The only test asserts that the
filter string is forwarded to the RPC; nothing executes the SQL, so the `CASE` itself is
covered by no test in the original. In this repository the warning is carried where whoever
writes that query will read it, as the `COMMENT ON COLUMN` on `agent_runs.kind`
(`db/002-agent.sql`, **in**). The guard that would actually hold is a test that runs the
function against the compose database with rows of both kinds, and it does not exist yet.

---

## What is still not covered

Named here so that nothing above reads as more protected than it is.

- The `allowNotes === false` branch has no unit test. The gate is enforced by one derivation
  in the loop and nothing asserts it stays there (entry 4).
- No test asserts that reading the desk raises rather than returning an empty list. The
  foreign key prevents the specific failure that happened; the coalescing that hid it is
  gone by inspection only (entry 3).
- The `kind` filter's SQL is not executed by any test (entry 8).
- The write path — propose, approve, precondition re-check, refusal when a record moved
  under the card — is exercised end to end only by a script someone has to run by hand
  against a real database, where it creates and deletes its own scratch client and project.
  The eval suite cannot cover it: a suite that bills a client to prove it can bill a client
  is not one anybody runs twice.

## What these have in common

Four of the eight — 1, 2, 4 and 5 — were covered by an assertion that passed while the
system was broken. Entry 6 is the inverse: a suite going red for the wrong reason, which
costs the same investigation and additionally teaches you to discount it. The remaining
three, 3, 7 and 8, had no coverage at all, and are the least interesting for that reason.

They fail in four shapes, and the shapes are more useful than the individual bugs.

**The test built the condition it was testing.** The registry was full during every test run
because the tests imported the loop, and it was empty in the one bundle nobody tested. Then
the test written specifically for that fix called the registration helper itself. Both times
the assertion was true and told you nothing about the deployed path.

**The test asserted an implementation instead of an outcome.** All four bad eval cases fail
this way. Each one encoded how the agent was assumed to answer — this word, this tool call,
this proposal — and then failed a correct agent for answering differently. An assertion
about behaviour survives a rewrite; an assertion about phrasing does not, and the noise it
generates is spent on the wrong investigation.

**The code swallowed the error the check would have seen.** `data ?? []` turned a broken
join into "nothing is waiting on you". A read that cannot distinguish an empty result from a
failed query cannot be checked by anything downstream of it, including a person looking at
the screen.

**The scope of a guard was believed rather than derived.** `stateless` was believed to mean
"leaves no trace" when it covered only history. The billable default was decided in a layer
that had not yet resolved the record it depended on. In both cases the guard was real and
was applied at the wrong boundary, which is harder to see than a missing guard because
something is visibly there.

Two of them were invisible for a further reason: nothing was recorded. The flaky assertion
was found by coincidence — the suite happened to be run twice in one evening — and the
approval failure was found by an operator clicking a button, because no view showed that
every write proposal ever approved had errored. Both of those gaps are now schema
(`db/002-agent.sql`, `db/003-eval-history.sql`).

The line the rest of this repository is written to follow from: a test that passes for the
wrong reason is worse than no test, because no test leaves the risk visible. So when a guard
is added, the first thing done to it is to break the code it guards and confirm that it
fails. `registry.test.ts` exists because that was not done once.
