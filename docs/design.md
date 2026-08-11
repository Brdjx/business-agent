# Design

Why the agent is shaped this way. Every section below is a decision and the failure it
prevents, because a decision reads as arbitrary — or as ceremony — until you know what
went wrong without it.

**What you can run today is the schema in `db/`.** The harness this document describes is
being ported out of a private system (Fortissimo OS) and is not in this repository yet.
Where a mechanism is described in the present tense, it describes the original and the
standard the port is held to. Nothing here has been run against a model *in this
repository*, and this file will not imply otherwise. The tables are the part that is
already here, so where a mechanism has a table behind it the schema comment in `db/` is
the primary source and this document is the reasoning across files.

Contents:

1. [The loop](#1-the-loop) — why a tool loop and not a chain or a graph
2. [The budget](#2-the-budget-checked-before-the-spend) — checked before the spend
3. [The tool contract](#3-the-tool-contract-allowlist-validation-evidence) — allowlist, validation, evidence
4. [Per-action consent](#4-per-action-consent) — approval re-runs a stored call
5. [Idempotency and preconditions](#5-idempotency-and-preconditions)
6. [Supersession](#6-supersession-subject_key-vs-write_key)
7. [Memory beneath the record](#7-memory-beneath-the-record)
8. [Evals](#8-evals)
9. [What is deliberately not here](#9-what-is-deliberately-not-here)
10. [Open edges](#10-open-edges)

---

## 1. The loop

The whole agent is four lines:

```
send (conversation + tools) to the model
  text back      -> done
  tool call back -> execute it, append the result, continue
  over budget    -> stop and say why
```

Everything else in `src/agent/` is engineering quality around those four lines: a budget
checked before spending, an allowlist in front of the tools, argument validation, evidence
on every result, and a trace of every step. The loop is small on purpose. If it grows, that
is usually a guard that has been written in the wrong place.

### Why not a chain

A chain fixes the order of operations when the code is written. The questions do not have
one order. "How much is outstanding?" is a single call. "Is Initech a client?" is a single
call that returns nothing and has to stop there rather than reaching for a second tool.
"Who is our contact at Halden Freight, and what have we billed that client?" cannot make its
second call until the first returns an id. A chain that serves all three is a chain with
branches in it, which is a graph.

### Why not a graph

A graph is the right shape when the set of paths is known, finite, and worth naming — a
pipeline with fixed retry points, a workflow with a human step always in the same place. It
buys determinism: you can read the topology and know what will run.

That is not this problem. Here the set of useful paths is the set of questions someone
might ask about their business, and nobody enumerated that. Worse, the branch decision —
*which tool answers this* — is precisely the judgment being delegated to the model. Encode
it as edges and you are re-encoding it by hand every time a new question shape appears, and
each of those is a code change with a deploy behind it. The topology becomes the product.

### What the loop costs, and what pays for it

The honest cost is that you cannot read the code and know what will run. That is paid for
by three things, and they are not optional extras:

- the **budget**, so an unknown number of steps is still a bounded number,
- the **trace**, so an unknown path is still a recorded path,
- the **evals**, so unknown behaviour is still asserted behaviour.

A tool loop without those three is worse than a graph, because at least with a graph you
would know what ran. Most of this document is those three.

### Details in the loop that exist because something broke

- **One loop, not two.** Progress events (`thinking`, `tool`, `tool_done`, `wall`) are a
  callback on the same loop rather than a second streaming implementation. Two
  implementations of this diverge, and the divergence is invisible until something reads
  across both — see the next bullet, which is what that looked like.
- **Tool registration lives in its own module**, not in the loop. It used to be a
  side-effect of importing the loop, which meant the approval path — which has no reason to
  import the loop — ran with only the read tools registered and failed every write it was
  asked to apply. It ran that way for weeks, because nothing that imported the loop could
  see the problem.
- **Announcing must never break the run.** A caller whose stream has closed, or whose
  handler throws, has a broken connection, not a broken agent. The work continues and the
  answer is still returned; only the narration is lost.
- **A refusal is a tool result, not an exception.** An unknown tool name, invalid
  arguments, a timeout: each comes back to the model as a result with an error status and a
  sentence it can act on. A harness that throws on a bad tool call teaches the model
  nothing and loses a run that was otherwise fine.
- **A per-tool timeout.** One slow query must not spend the run's whole wall clock; the
  timeout is reported as a failed result suggesting a narrower request, so the model can
  try something else.
- **Retry only for throttling.** A transient rate-limit response ending a run reads to the
  user as the agent being broken, so it is retried with backoff. A validation error is not
  retried at all: trying it again produces the same error more slowly.
- **The model's turn goes back verbatim.** Reconstructing the assistant message loses the
  tool-use ids and the next request is rejected.
- **Requests are sent a copy of the message array.** The loop appends as it goes; handing
  the live reference to every request makes every recorded request a description of the
  final state instead of what was sent.
- **Independent tool calls run together.** The model routinely asks for two lookups at
  once, and serialising them spends wall clock on waiting. Results are reassembled in the
  order the model asked for them, because it refers to them positionally.

### No orchestration framework, and a thin provider boundary

The loop is one file and one dependency-free control structure. Every guard in this document
is something a framework would have had to anticipate on your behalf: charging a tool's own
model tokens to the run's budget, evidence in the result envelope, a per-tool timeout
reported as a tool result, a write that returns a proposal instead of writing. When the
framework has not anticipated one of them, you are reading its internals anyway.

The model call itself sits behind a small adapter (`src/agent/providers/`) that posts to the
provider's messages endpoint and returns text blocks, tool-use blocks and token usage. The
original runs on Bedrock's Converse API; this port talks to the Anthropic API directly. The
adapter exists so the difference is a file rather than a rewrite of the loop — and because
two models disagreeing about the same records is something the eval suite should be able to
record rather than something you take on faith. Which model answered is recorded per run:
a regression after a model change and a regression after a prompt change are different
investigations, and a pass count cannot tell them apart.

---

## 2. The budget, checked before the spend

An agent is a loop that decides when to stop, so the failure mode is that it doesn't. Four
limits, in `Budget`:

| limit | what it catches |
|---|---|
| max steps | a loop — the model calling the same tool forever, or two tools alternating |
| max tokens | one enormous step: context growth, or a tool that returned half a table |
| max wall clock | something slow that is not spending tokens at all |
| max consecutive tool errors | the dependency is down, and every further step repeats a failing call |

Four rather than one because each catches a different thing. A step limit does not notice a
single step that costs 90k tokens. A token limit does not notice a run that is spending
thirty seconds per call and about to be killed by the platform. An error limit is the only
one that distinguishes "working slowly" from "not working".

### Before, not after

`check()` runs before the request that would spend, and returns either `null` or the name
of the wall. This is the whole point:

**A limit enforced after the fact is not a limit, it is an observation.** Check afterwards
and you have already paid for the step that broke the limit, and you are left deciding
whether to use a result you were not entitled to buy. For the wall-clock limit it is worse
than accounting: the process is running inside something with its own timeout, and if you
only notice at 95 seconds that you passed 90, the caller has already been cut off and the
answer and the trace are never written. The limit has to be evaluated while there is still
time to report.

Everything here fails closed. If the budget cannot be evaluated, the run stops. An agent
that keeps going while its accounting is broken is the expensive kind of bug.

### Counting honestly

- **Unknown usage is charged pessimistically.** A response that reports no token usage is
  not evidence that nothing was spent, so it is charged a deliberately high estimate rather
  than zero. Charging zero makes a broken usage field into an unbounded run.
- **A tool that calls a model is charged too.** A tool that drafts prose makes a second
  model call the loop never sees; uncounted, an expensive run reports as a cheap one. It
  charges tokens but *not* a step, because the step count is what bounds the loop and
  inflating it would stop the run early for the wrong reason. The trace attributes those
  tokens to the tool call as well, so a step that took twenty seconds is explainable
  instead of unexplained silence.

### Hitting a wall is an outcome, not an error

The run returns a `stop_reason` naming the wall, a plain sentence a person can read, and
whatever it had established by then. Silent truncation is the thing being avoided: an
answer that stops mid-thought and an answer that is complete look identical to a caller,
and only one of them should be believed.

`stop_reason` is a column on `agent_runs`, so "how often does it wall, and on what" is a
query rather than an anecdote.

---

## 3. The tool contract: allowlist, validation, evidence

The model proposes; the harness decides. A tool call arriving from the model is an
untrusted string until it has matched a registered name and its arguments have passed that
tool's own validator. Nothing else executes.

### The allowlist

The registry is the allowlist. A name that is not in it cannot run, whatever the model
asks for, and the refusal names the tools that do exist so the next step can recover. This
is not defence against a hostile model so much as against an ordinary one: a model that
half-remembers a tool name from its training data, or that invents the tool it wishes you
had, is a normal Tuesday.

### Validation, per tool, in words the model reads

Each tool validates its own arguments and throws with a message written for the model,
because the model is the thing that will read it and retry. Two judgments worth naming:

- **Clamp what is merely greedy.** A `limit` of 500 is clamped to the cap rather than
  refused. It is not an error worth a round trip — but it is also not a reason to read the
  whole table.
- **Refuse what is a misunderstanding.** `hours: 40` for one day is rejected outright. A
  40 in that field is a week typed into a day, and it lands in a billable total that nobody
  re-checks. `time_entries.hours` has a `CHECK (hours > 0 AND hours <= 24)` behind it as
  well, and the two are not redundant: the constraint is the thing that cannot be bypassed,
  and the tool's refusal is what puts a sentence in front of the model instead of a Postgres
  error string. Where a rule needs more context than a constraint can see — that an
  `own_venture` engagement can never be billed, which is two joins from the column — the
  tool owns it outright.

Validation runs again when a proposal is approved. The stored arguments go back through the
same execute path rather than around it, so a row edited by hand cannot smuggle anything
past the tool's own checks.

### Evidence: why a result carries rows

Every tool result is two things kept deliberately apart:

- **content** — prose for the model, bounded. A tool is a lookup, not a data dump.
- **evidence** — `{table, id, label}` for each row the content rests on.

An answer a reader cannot trace to rows is a claim. Evidence is what turns it into a
statement about records, and it buys three separate things:

1. **A person can check it.** "Outstanding is $18,400" is worth nothing on its own. With
   the invoice ids behind it, disagreeing with the agent is a query.
2. **An eval can assert on it mechanically.** "This answer rests on a row from `invoices`"
   is checkable. "This answer is good" is not. Section 8 depends entirely on this.
3. **It constrains what the agent can say.** A tool that found nothing returns no evidence,
   so there is nothing to point at — and the prompt rule that a number must come from a
   tool has something concrete behind it.

Evidence is deduplicated by `table:id` and stored on the run, so the answer and the rows it
rested on are one record.

### What a tool does when it finds nothing

It says so, in words, and often says what *does* exist. Two failures this prevents:

- An empty result returned as an empty string is how a model ends up calling the same tool
  three times hoping for a different answer.
- "No invoices match that filter" invites the conclusion that there are no invoices. So the
  miss reports the statuses that are on file, and says that a filter matching nothing is
  not the same as an empty business.

### Totals are computed in SQL

Money is summed in the database, never by the model adding up rows it was handed. A model
asked to total fifteen numbers will do it confidently and occasionally wrongly, and the
wrongness is invisible. The tool also reports how many rows the total covered and how many
it itemised, so a partial answer is visible as partial.

### Run context is passed, not global

Whether writes are allowed, who the operator is, and where to charge tokens are passed to
every tool as an argument. A module-level flag works right up until two runs share a
process, at which point a write tool reads another run's permission. `userId` in particular
is never taken from the model — it is passed in, and every read is scoped by it.

---

## 4. Per-action consent

This is the subtlest part of the system, so it gets the most room.

The write gate answers one question: *may the agent change things?* With writes off, a
write tool does not fail — it returns what it *would* have done, in words, as a normal tool
result. The same tool serves both modes, so the model needs no separate vocabulary for
proposing and doing.

What the gate cannot answer is the question that actually comes up: *may it do **this**?*

### The path not taken

The obvious way to act on a proposal is to turn writes on and ask again. It has two
defects, and the second one is the interesting one.

**It grants permission to a session, not to an action.** The next whole run may change
anything the model decides to change. What was approved was a sentence on a screen; what
was authorised is a run.

**It re-resolves the request from scratch.** Walk it through:

1. The operator says "log 3 hours against Dispatch for Tuesday."
2. The tool resolves `dispatch` against the projects table. One match: *Dispatch Rewrite*,
   for Halden Freight, at $185/hour. The card reads
   `Log 3.00h on 2026-08-04 against Dispatch Rewrite (Halden Freight) — platform work`.
3. The operator reads that and, an hour later, says yes.
4. Re-running the question resolves `dispatch` again. In that hour, *Dispatch Rewrite Phase
   2* was created — so the name now matches two projects. Or the project was renamed. Or
   `rate_cents` moved from 18500 to 15000.

Same words, different row, or the same row with a different consequence. The operator's
"yes" was about a row and about a number printed on a card, and re-resolving the question
preserves neither. Consent to a sentence is not consent to whatever that sentence turns out
to mean a minute later.

### What is stored instead

A proposal is a row (`agent_proposals`) holding:

- the **validated arguments**, exactly as the harness accepted them,
- the **resolved target** — table, id, label,
- the **write key**, computed at propose time from resolved ids (section 5),
- the **precondition**: the columns the card asserted and the values they had,
- a **summary**, which is the sentence the operator actually read. The card is the contract.

Approving re-runs *that call* through the same execute path. The model is not consulted
again.

Three properties follow, and each one is a way this goes wrong if it is left out:

- **The approved thing is the applied thing.** Arguments are stored, not re-derived, so the
  model cannot change its mind between the card and the write.
- **Approval is not a second chance to write.** The key was computed at propose time, so
  approving something that has already happened — from here, from a write-enabled run, or
  from a retry of either — replays the first result instead of doing it twice.
- **A stale proposal is refused, not applied.** The world is allowed to move while a card
  sits on the desk. When it does, the honest answer is to name what changed and ask again,
  because the operator agreed to a diff that no longer describes anything.

### What a stored call preserves, and what it does not

Worth being exact, because there is a hole a careless reading leaves open. The stored
arguments are the arguments the *tool* validated, and for a tool that takes a project by
name, one of them is still a name. So the tool does resolve that name again when the card is
approved — storing the call does not, by itself, freeze which row it lands on.

What freezes the row is the precondition, which pins the resolved id and the columns the
card depended on. The order at approval time is: is this mine, is it still pending, has it
aged out, and **does the pinned row still say what the card said** — and only past all four
does the stored call run. If the name has become ambiguous in the meantime, the tool's own
ambiguity refusal catches it and nothing is written.

The lesson generalises past this codebase: *the identity of the thing approved has to be
recorded somewhere, and a natural-language argument is not an identity.* Store the id, pin
the columns whose values the operator was shown, and check them immediately before the
write. Anything less and "yes" means "yes to whatever this resolves to next time".

### The desk

The mechanics around the card are all cases where the wrong report would be worse than the
wrong action:

- **Cards expire** (24 hours by default). A proposal you no longer remember reading is not
  one you can meaningfully approve.
- **Declining is always available, including after expiry.** Clearing the desk is not an
  action on the business.
- **An already-decided card reports which way it went** rather than pretending this press
  did something. A button pressed twice must not read as two approvals.
- **Ownership is in the query, not checked afterwards.** Someone else's proposal reads as
  absent rather than as forbidden.
- **The desk shows recently decided cards, not only pending ones.** "Did I approve that?"
  is the question the record exists to answer, and a list of open cards cannot answer it.
- **A failed read raises instead of returning empty.** An empty desk reads as "nothing is
  waiting on you", which is a statement about the business, and a broken query is not
  entitled to make it. That mistake shipped once: a join failed, the read treated the
  result as empty, and the desk went blank. A proposal nobody sees is a proposal nobody
  approves.
- **One pending card per write.** A partial unique index on `(user_id, write_key) WHERE
  status = 'pending'` means asking twice does not stack two separately approvable cards.
  Partial, so the history of decided cards survives: the same write refused on Monday and
  approved on Tuesday is two records of two decisions, which is the point.
- **An expired-but-pending card is retired before a new one is written.** It still holds
  the key that a fresh card would need, so left alone, asking again keeps returning the one
  card the operator is not allowed to act on.

---

## 5. Idempotency and preconditions

A read done twice is waste. "Log four hours against Halden Freight" done twice is a second
billable line against someone real. Three mechanisms — a key derived from the write's own
content, a ledger claimed before the write, and a precondition re-read immediately before it
— plus one rule about how the outcome is reported.

### The key

`writeKey(tool, userId, resolvedParts)` — a SHA-256 over the tool name, the operator, and
the resolved arguments in a canonical order, truncated. Two things about what goes into it:

- **Resolved ids, not the operator's words.** `"Dispatch Rewrite"`, `"dispatch rewrite"` and
  `"dispatch"` all resolve to one project id, and they are one act. Keying on the input
  string would make three acts out of one.
- **Anything that changes the consequence is part of the identity.** `billable` is in the
  key, because the same hours logged billable and non-billable are two different entries
  and must not collide.

### Claim before write

The ledger row is inserted *first*, then the write happens, then the row is updated with
the result. Not the other way round:

- **Claim-before-write** makes two concurrent attempts race on a primary key rather than on
  the write itself. The loser reads the winner's result.
- **Write-then-record** leaves the window that matters wide open — both writes land, and
  the ledger learns about it afterwards.

A unique violation on the claim is the normal, expected path, not an error: read the stored
result, return it, and say plainly that nothing was done a second time.

**A failed write releases its claim.** Otherwise one transient database error becomes a
permanent refusal to ever perform that act again, and the only way out is a manual delete
from a table nobody remembers.

### Reporting a no-op as a no-op

Setting a status to the value it already has changes nothing. That is not a failure, but
the tool must *say* so. "Marked inactive" when it was already inactive is a small lie, and
one small lie is enough to make everything else the agent reports unverifiable by feel.
Same rule for a silent correction: when a tool overrides a requested flag — a request to
bill time to the studio's own venture, which has no rate and no invoice path — it says out
loud that it overrode it. Quietly flipping a flag the caller asked for makes the rest of
the report suspect.

### Preconditions

The precondition is `{table, id, expect: {column: value}}` — the facts the card asserted,
re-read immediately before the write. Choosing what to pin is a judgment:

- **What the card said.** A card reading `active -> inactive` is a claim about the present
  tense. If the status has since become something else, applying the change would overwrite
  whatever happened in between.
- **What decides the consequence, even if the card never printed it.** A time entry's
  proposal pins the project's `rate_cents`. The card does not show the rate, but the rate is
  what the client is eventually billed, and a proposal read at one rate must not be applied
  at another.

Two rules in the checker:

- **The refusal names what moved.** "The client changed after this was proposed — status is
  now lead, not active." A bare "cannot apply" makes the system look broken; the sentence
  makes it look careful, and more usefully, tells the operator what to do next.
- **A check that cannot be made is not a check that passed.** If the row cannot be re-read
  — gone, or the query failed — the write is refused. This gate exists precisely for the
  case where the record is not what it was.

Comparison tolerates representation rather than bytes. The `pg` driver returns `NUMERIC` as
a string, so `3` and `"3.00"` are the same number and a column arriving as text is not drift.
A precondition that fires on formatting would refuse every approval and teach the operator
to stop reading the reason.

### What the ledger is not

It is not a transaction. It makes a repeat safe; it does not make a multi-row write atomic.
Every write tool here touches one row. A write spanning two tables needs the claim and the
write inside the same transaction, and none of these do that today — see
[open edges](#10-open-edges).

---

## 6. Supersession: `subject_key` vs `write_key`

Two identities on a proposal, because there are two different questions, and collapsing
them breaks one or the other.

The case that needs both is a tool that produces revisable content: ask it to draft
something, read the draft, ask for changes.

**`write_key` identifies the exact act, content included.** The second draft is genuinely a
different write. It must get a different key, or the ledger will recognise the approval as
something already done and replay draft one in place of draft two.

**`subject_key` identifies what the card is *about*, and is stable across revisions.** The
thing being drafted is the same thing whatever this version of the text says. Without it, the
first card stays on the desk, still pending, still approvable — and approving it applies the
draft that was rejected.

Neither key alone works:

- Key on content only, and every revision adds an approvable card.
- Key on subject only, and the ledger thinks the revision was already performed.

So a new card retires the pending cards with its subject before inserting itself.

**Retired cards are marked `superseded`, not `declined`.** Declining is a decision somebody
made. Being superseded is what happened to a card nobody decided about. Reporting the
second as the first tells the operator they rejected something they never saw again — a
false statement about their own actions, which is a worse class of wrong than a missing
feature.

`subject_key` is nullable and should be set only where a revision is a real possibility. A
status change has no drafts. A key invented for every write is a second identity to keep
consistent for no gain.

Which means the column can be legitimately unused: the two write tools in this extraction —
log a block of time, set a client's status — have nothing revisable about them, so both leave
it null and the supersession path never runs. It is in the schema because the mechanism is
the part worth reading, and because the alternative — discovering the need after shipping a
tool that drafts text — is how the rejected-draft bug happens in the first place.

---

## 7. Memory beneath the record

Two kinds of memory, deliberately not merged, because they fail differently.

**Conversation** is what makes "what about last month?" mean anything. It is bounded, it
lives for a thread, and getting it wrong costs a confused answer. Only questions and
answers are replayed — never the tool blocks, which are already in the trace and would
re-bill every intermediate result on every later turn. The window is trimmed from the end
backwards so the most recent exchange always survives; trimming from the front drops the
turn the follow-up refers to, which is the only turn that reliably matters. (The tables for
this are not in `db/` — see [section 9](#9-what-is-deliberately-not-here). The reasoning is
here because the two kinds of memory are only distinguishable next to each other.)

**Notes** are what make the agent worth more in a month than it is today. They outlive the
conversation, and getting one wrong costs every future answer until somebody notices.

### A note records what was said, not what is true

This is the whole safety argument, and it is worth being exact about.

> "We do not take fixed-bid work."

is a fact the agent has no standing to assert. If it was a passing remark it is wrong
forever.

> "You were told, 2026-08-08: we do not take fixed-bid work."

is true whether or not the policy still holds, degrades visibly as it ages, and can be
argued with.

So every note carries its source (`told` — the operator said so, which is the only
authoritative source about preference or intent — versus `observed`, the agent's own
conclusion, which is worth less) and its age, rendered on every line of the prompt block.
Age is not decoration: a note from yesterday and a note from fourteen months ago read
identically once they are prose, and the model has no other way to weigh them.

### A note never overrides a table

The injected block says it, and the system prompt says it: nothing in the notes overrides
what a tool returns, and where a note and a live record disagree, the record is right and
the note is stale — *say that*, rather than quietly picking one. The quiet pick is the
failure: two contradictory statements resolved invisibly, with the answer depending on
which one the model happened to weight.

There is an eval case for exactly this (`note-loses-to-record`), and it asserts that the
tool was actually called. An agent that answers from the note may get the right answer by
luck and still be broken.

### A note asserting a figure a table owns is refused outright

This is the one place the agent declines a direct instruction. Statuses, totals, hours and
ownership have a source of truth that changes without telling the agent. A remembered copy
is a stale copy that will one day contradict the live one, leaving two answers and no way
to choose — and the remembered one will be stated with total confidence, because a note
does not look uncertain once it is a sentence in a prompt.

The schema cannot enforce this; a CHECK constraint cannot read English. It lives in the
`remember` tool, and it has already been wrong once: the guard required a currency keyword
*before* the digits, so "they owe $4,500 right now" was caught and "`<client>` currently has
$12,000 outstanding" walked straight through. It was found because the eval suite's own
second run wrote that sentence into the operator's notes.

Which exposed the deeper thing: **notes sit outside the write gate on purpose.** The gate
protects business records, and that is how it is described to the operator — it can keep
notes, it will not change records. But it also means a run with writes off is *not*
read-only, and nothing said so. Hence a second switch that governs notes alone, and a
stateless mode the eval suite runs in so it exercises the whole memory path and persists none
of it.

### Nothing is overwritten

A correction supersedes: the old note keeps its row and points at the one that replaced it.
"What did the agent believe, and on what date" stays answerable, and a bad note leads back
to the run that wrote it instead of vanishing the moment it is corrected. A unique index
enforces one live note per subject per scope — two contradictory notes in one prompt are
worse than either alone, because now the model picks.

Notes are injected after the prompt cache breakpoint. They differ per operator and change
as the agent is told things, so in the cached prefix they would invalidate it on every run
and re-bill the instructions along with them.

---

## 8. Evals

### Mechanical assertions only

Every assertion is one of:

- which tools were called,
- which tools were **not** called,
- whether the answer rests on a row from a named table (this is what evidence is for),
- whether a phrase that could only be an invented fact appears,
- whether a write was left waiting for approval, or whether nothing was,
- how the run stopped.

A mechanical check gives the same answer twice and costs nothing to trust, which is what
makes it usable as a gate on every change rather than a demo that gets run before a
release.

### Why no LLM-as-judge

- **The judge shares the failure mode.** The behaviour worth catching is an answer that is
  fluent and wrong. A judge is fluent, and asking it whether the answer was good is asking
  the same kind of system the same kind of question.
- **A judge is non-deterministic and unversioned.** When the score moves you cannot say
  whether the agent changed, the prompt changed, or the judge changed. A regression you
  cannot attribute is not a regression test.
- **A judge costs money and minutes per case.** A suite that is expensive stops being run,
  and a suite that is not run is worth nothing regardless of how good its rubric was.
- **A rubric is arguable.** The point of a regression test is to be unarguable.

What a judge would be useful for — reading prose quality, catching tone — is not what this
suite is protecting.

### Assert on behaviour, not vocabulary

This has been got wrong four times in the private suite, and each time the wrong version
failed a *correct* agent:

- A case demanded the literal word "passed"; the agent answered "never became a client —
  declined by us", which is better, and failed.
- A case demanded a `log_time` call on an ambiguous request. Asking which project *before*
  calling the tool is better behaviour than calling it and being refused, so the assertion
  failed the better answer.
- A case asserted a proposal for a client that had since gone inactive, where the tool
  correctly returns no proposal for a no-op. The assertion was reading live, mutable data
  as though it were a fixture.
- A case asserted no em dash anywhere in the answer, when the guarantee is about the
  generated letter, not the agent's conversational prose around it. That guarantee is
  deterministic and belongs in a unit test.

So: `expectContains` is any-of, not all-of, because there are several honest ways to word a
refusal. What is forbidden is *asserting* a stale note, not *mentioning* it — the best
possible answer quotes the note precisely in order to say it is stale, and an eval that
punishes that is measuring phrasing. Where a guarantee is deterministic, it goes in a unit
test, where it can be asserted on the whole output rather than the truncated preview a
trace keeps.

### Roles over records

A case declares the *shape* of the world it needs, and the runner binds those shapes to
whatever the database actually holds before anything runs:

```
client_multi_project   a client with more than one project, so an ambiguous write must ask which
client_with_project    any client with at least one project, for plain lookup
passed_lead            took a call, never became a client — the distinction the schema exists for
inactive_client        so a stale note can lose to a live record
client_with_invoices   a client with invoices, so an answer about money has rows to rest on
single_project         a project name that is not a substring of another, so a write is unambiguous
absent_client          a name that must match nothing, so "I don't know" can be tested
```

In the private suite, fifteen of twenty-two cases named a real client outright. That
coupling cost three things:

- **It cannot be handed to anyone.** The suite runs against one database, and a stranger
  cloning a public repo has none of those records.
- **It is silently fragile.** A case needs not only the name but the shape — that this
  client has several projects, that this one was passed on. Those are live, mutable facts.
- **A failure means two different things.** "The agent got this wrong" and "the data this
  case needs is not there any more" arrive identically, and only one is worth fixing.

The roles are deliberately few: each is load-bearing for at least two cases, and a role
invented for one case is a fixture with extra steps. Roles that must agree with each other
are bound together — a two-hop case needs a contact *and the client that contact works at*,
because binding them independently asks about a person and a company with nothing between
them, and the case then fails for being unanswerable rather than for the tools failing to
compose. The absent name is verified absent rather than assumed; if a dataset happened to
contain it, that case would be testing the opposite of its purpose.

Each run prints what it bound, so a run is reproducible from its own output: if a case
behaved oddly, the binding says which records it was actually asked about.

### Skip over fail

A case whose roles cannot be bound is **skipped**, with a sentence saying what was missing.
Reporting absent data as a wrong answer is how a suite loses its authority — after the
third false failure, nobody reads the output.

Skips are recorded alongside passes and failures, because a case that has been skipping for
six weeks is a coverage gap that nobody is being told about. And in the flakiness query, a
skip is counted separately from a failure throughout: a case that ran once and skipped four
times is not unstable, it is under-fixtured, and folding the two together buries a real
flake under a list of missing data.

### The suite records itself

Scrollback can tell you that today is fine. It cannot tell you that something *changed*,
which is the question you actually want answered. One row per suite execution — model id,
commit, the role binding verbatim, the counts — and one row per case, with the failed
assertions in the runner's own words.

The query that matters is not the pass rate. It is **which case has both passed and failed
within the window**, on identical code. That has already paid for itself: a case passed at
22:11 and failed at 22:20, and the only reason anyone noticed was that the suite happened
to be run twice by hand that evening.

Three smaller decisions in the same area:

- **Eval runs are runs**, stored in `agent_runs` with `kind = 'eval'` so the trace survives
  for debugging, and excluded from health figures by default so twenty-two synthetic
  questions do not become a statement about the business. Before that column existed, the
  scheduled run was identifiable only by its question starting with `watch:` — deciding
  what a row *is* by matching text a caller chose is a guess that holds until somebody
  types that prefix.
- **A tight step limit** in the suite (six). An eval that allows twenty steps stops
  measuring whether the agent is efficient and starts measuring whether it was lucky.
- **Stateless runs.** No history, no notes read, nothing a later case can see. A suite that
  reads memory measures what earlier cases left behind; one that writes memory makes every
  result depend on the order the cases happened to run in. Notes a memory case needs are
  handed in, not written first.

The suite runs against a live model and a live database, because what is being measured is
whether the agent works on real data. So it costs money and takes minutes: it is a script,
not part of the unit tests. Deterministic guarantees belong in the unit tests, which run on
every commit precisely because they are free.

---

## 9. What is deliberately not here

Naming what is left out is more useful than claiming completeness, and each of these is a
decision rather than an omission.

**No multi-tenancy.** `user_id` is a plain uuid. There is no users table to point at, no
row-level security, and no policies. This is a single-operator system, and the multi-tenant
version built now would be scaffolding nobody uses. It is a simplification with a stated
exit: every index and unique constraint already carries `user_id`, so the change is mostly
additive. What must *not* be carried forward is trusting the application to remember the
scope — the partial unique index on pending proposals is the only thing standing between
"asked twice" and "two separately approvable cards", and it is keyed on a `user_id` the
application hands the database.

**No vector search, no RAG.** The questions this answers are lookups, joins and totals, and
SQL answers those exactly. Retrieval is weakest precisely where a client lookup lives — on
short proper nouns — and it cannot see an invoice or a time entry at all unless you decide
to embed them, at which point you are maintaining an index that goes stale against a table
that does not. This is not a claim that retrieval is useless. It is that it was not the
missing piece, and adding it would add a subsystem with its own failure modes to answer
questions that already have exact answers.

**No knowledge graph in this extraction.** The private original has three graph tools —
resolve a name to an entity, walk its neighbours, find a path between two — because
connections are a different question from similarity. They are not part of this repository.
One lesson from them is worth carrying anyway: a path search that excludes very common
nodes will report "no specific connection", and that is a statement about specificity, not
about relationship. Reporting it as "they share nothing" is a falsehood manufactured by a
design choice, and the first live run did exactly that.

**No autonomy beyond a single scheduled read-only pass.** The original has one unprompted
run, on a schedule, with writes off. It reads, and the most it can do is leave a card on the
desk; it cannot approve one, and it cannot act on its own findings. It is also expected to
stay quiet when nothing has changed — an assistant that reports every morning that nothing
happened trains you to stop reading it. Its runs are marked `kind = 'watch'` so they are
distinguishable from a person's by a column rather than by a text prefix. There is no
agent-triggering-agent, no queue of self-assigned work, and no run that can start another
run.

**No undo.** The guard is consent before the write, not reversal after it. Most of these
writes have no clean inverse — a deleted time entry that was already invoiced is not
restorable by deleting it again — so the honest design puts the whole weight on the approval
step and on the precondition re-check, rather than implying a rollback that would only
sometimes work.

**No conversation threads in this repository's schema.** `db/` stops at notes. Multi-turn
history exists in the original (two tables, a bounded window) and is described in section 7
because the reasoning matters, but the tables are not part of the extraction yet.

**No dollar figures stored.** Runs record tokens and duration. Prices change, and a stored
dollar amount is wrong the day they do, while a token count stays true.

**No auth, and no HTTP layer in `db/`.** The schema is a database, and it assumes whoever
connects to it is entitled to. That is a statement about scope, not a claim that it is safe
to expose.

---

## 10. Open edges

Known weaknesses. They are here because a design document that lists only its strengths is
a sales page.

**A card is settled by whether the tool ran, not by whether it wrote.** In the original, an
approval is recorded as `applied` whenever the stored call returns without throwing — and a
write tool that declines at apply time (say the project name has become ambiguous since the
card was written) returns a normal result saying nothing was logged. Nothing was written,
which is correct; the label on the card says `applied`, which is not. The tool needs to
report *wrote* or *declined* explicitly rather than having it inferred from the absence of
an exception.

**The ledger is not a transaction.** It makes a repeat safe. It does not make a multi-row
write atomic, and every write tool here touches exactly one row for that reason. A write
spanning two tables needs the ledger claim inside the same transaction as the write.

**Nothing checks that a card's summary and its precondition agree.** Which columns to pin is
a human judgment per tool, and a summary that asserts a column nobody pinned goes
unverified. The failure is quiet: the card looks careful and the check covers less than the
sentence claims.

**Notes are injected wholesale, up to a cap.** There is no relevance ranking; beyond a
couple of dozen global notes the prompt is the problem. Entity-scoped notes are the
intended answer, and they carry their own cost: there is no foreign key from a note to the
record it is about (there is no single entity table to point at), so deleting a client
leaves its notes behind pointing at nothing. The loader has to resolve an entity note by
reading the named row and must not inject one whose row is gone. A dangling note is an
accurate record of something once said; it is not a fact about a client that no longer
exists.

**A thin dataset silently narrows the suite.** Role binding means a sparse database skips
cases rather than failing them, which is the right behaviour and also means the skip count
is the number to read first. A run reporting `12/12 passed, 10 skipped` is not a healthy
run.

---

See [`incidents.md`](incidents.md) for what has already gone wrong, in full. The failures
are more informative than the feature list, which is why they are written down at all.
