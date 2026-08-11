# business-agent

An agentic assistant over one small consulting business's records — clients, contacts,
projects, invoices, time entries. It answers questions by calling tools that read the
database, attaches the rows each answer rests on, and never changes anything on its own:
a write comes back as a proposal that a person approves one at a time. It exists because
"agent" has come to mean a loop with a model in it, and the loop is the easy part. What
decides whether one can be trusted with a business's records is the accounting around it
— a budget checked before it spends, an allowlist in front of the tools, evidence on
every result, a trace you can read afterwards, and consent that attaches to an action
rather than to a session. This repository is the synthetic-data extraction of a private
production system (Fortissimo OS), made public so those parts can be read.

**Everything described below runs.** The database, the seeded business, an agent you can
ask questions, the full write path — propose, review, approve — and the eval suite that
measures it: **17 of 17 cases pass** against the synthetic seed, and each run records
itself so a regression is a query rather than a memory.

```
$ npm run ask "how much is outstanding, and how much of it is overdue?"

+2.8s   → invoice_summary {}
+3.1s   ✓ invoice_summary 284ms — 11 invoice(s) on file.

Outstanding: $33,300.00 across 3 open invoices.
Overdue: $24,300.00 across 2 invoices:
  INV-1008 (Halden Freight)         — $16,500.00 — due 2026-07-02, 40 days overdue
  INV-1009 (Calderwood Diagnostics) —  $7,800.00 — due 2026-07-17, 25 days overdue

evidence
  invoices/INV-1008  de9bcc24-a04f-456f-8a18-791097d91193
  invoices/INV-1009  ac9f2695-2e5b-4d53-bacf-06a32fb2cdb5
  invoices/INV-1010  ec0a881e-7c5e-4572-8623-cc2160415401

answered: 2 step(s), 6,506 tokens, 6558ms, read-only
```

The seed's own arithmetic says $33,300, so that number is checkable rather than
impressive. A total written as `status <> 'paid'` returns $40,800 instead, because it
swallows a void invoice that was reissued and a draft — both seeded specifically to catch
it. The evidence lines are what let you tell those apart without trusting the prose.

---

## What makes it an agent, not a chatbot

Each of these is a claim that can be checked against code, rather than a property to be
taken on faith.

**A fail-closed budget, checked before the spend.** *(in)* Four limits — model
steps, total tokens, wall clock, consecutive tool errors — evaluated *before* the call
that would spend, because a limit you notice afterwards has already been exceeded. If
the budget cannot be evaluated, the run stops; an agent that keeps going when its
accounting is broken is the expensive kind of bug. Hitting a wall is a reported outcome,
never a silent truncation: the caller gets the name of the wall it hit and the trace
shows what it had done by then.

**A tool allowlist with argument validation.** *(in)* A tool call arriving from the
model is an untrusted string until it has matched a registered name and its arguments
have passed that tool's own validator. Nothing else executes. A refusal comes back as a
tool *result*, not a thrown error, so the model can correct itself instead of the run
dying on a bad argument.

**Evidence on every tool result.** *(in)* Each result carries `{table, id, label}`
for the rows it came from, so an answer can be traced back to records rather than
believed. That is also what makes a mechanical eval possible: "this answer rests on a
row from `invoices`" is checkable, where "this answer is good" is not.

**A persisted trace.** *(in)* Question, every step in order, which tool, what
arguments, what came back, how long, what it cost, and which wall it hit. Without one you
cannot debug an agent — the model made six calls, one was wrong, and by the time you read
the answer every intermediate step is gone. Writing the trace must never fail the run: an
agent that answered correctly and then died recording itself has turned an observability
problem into an outage.

**Per-action consent: a write is a proposal.** *(in)* With writes off, a write tool
returns what it *would* do and does nothing. The other half of that is a way to say yes to
*that specific thing*. A proposal is a row holding the validated arguments, the record they
resolved to, the write key the write will claim, and the facts that were true when it was
shown. Approving it re-runs that call — not the question that produced it. The alternative,
enabling writes and asking again, grants the next whole run permission to change whatever
the model decides, and re-resolves the request from scratch: a different project can match,
a status can have moved. Consent to a sentence is not consent to whatever that sentence
turns out to mean a minute later.

**An idempotency ledger.** *(in)* Each write derives a key from its own content and
claims it; a second attempt with the same key returns the first result instead of writing
again. A model can call the same tool twice and a retried step can replay a call that
already succeeded. For a read that is wasteful. For "log four hours against this client"
it is a double charge against someone real.

**A precondition re-check that names what changed.** *(in)* A proposal card saying
"active → inactive" is a claim about the present tense. Before the write, the asserted
columns are read again; if one has moved, the answer is no, and the refusal says what
moved — "the client is no longer active" — because a bare refusal makes the system look
broken. A check that cannot be run is not a check that passed: if the row cannot be
re-read, the write is refused rather than made blind.

The tables these rules write into are in `db/`, and the schema comments say why each
column exists.

**Two provider adapters, both `in`.** The default posts to the Anthropic API with plain
`fetch` — no SDK, so the dependency list stays honest and the adapter doubles as readable
documentation of the wire format. The second speaks Bedrock's Converse API, which is what
the private original runs on and what this port was actually verified against. It exists
for a reason beyond convenience: a boundary with one implementation behind it is an
assumption, not an abstraction, and you only find out where it should have been once
something else has been fitted through it. The AWS SDK is an optional dependency loaded by
dynamic import, and CI installs without it to keep that true.

Which model answered is recorded per run, because a regression after a model change and a
regression after a prompt change are different investigations.

---

## How it is measured

**Evals are mechanical.** *(in)* Nothing is scored by asking a model whether an
answer was good. An assertion is one of: which tools were called; which were *not*; whether
the answer rests on a row from a named table; whether a phrase that could only be an
invented fact appears; whether a write was left waiting for approval; how the run stopped.
Each gives the same answer twice and costs nothing to trust, which is what makes it usable
as a regression test on every change instead of a demo.

A judge fails in the direction that matters. The failure mode worth catching is an answer
that is fluent and wrong, and an LLM judge shares the fluency. Assertions are also written
against behaviour rather than vocabulary: an early case demanded the literal word "passed"
and failed a correct answer that said "never became a client — declined by us". An eval that
scores phrasing measures the prompt.

### Cases name shapes, not records

This is the part worth copying. In the private suite, fifteen of twenty-two cases named a
real client outright — "what is the status of `<client>`", "is `<company>` a client" — and
one named a real person. That coupling cost three things:

- **It cannot be handed to anyone.** The suite only runs against one database, and a
  stranger cloning a public repo has none of those records.
- **It is silently fragile.** A case needs not only the name but the *shape* — that this
  client has several projects, that this one is a lead that was passed on. Those are live,
  mutable facts. One case asserted a proposal for a client that had since gone inactive, so
  the assertion could never hold, and it read as the agent failing.
- **A failure means two different things.** "The agent got this wrong" and "the data this
  case needs is not there any more" arrive identically, and only one is worth fixing.

So a case declares the roles it needs, and the runner binds those roles to whatever the
database actually holds before anything runs:

```
client_multi_project   a client with more than one project, so an ambiguous write must ask which
passed_lead            took a call, never became a client — the distinction the schema exists for
client_with_invoices   reachable only by walking the graph; invoices have no embeddings
absent_client          a name that must match nothing, so "I don't know" can be tested
```

Same cases file, any dataset: a real database, or the synthetic seed in this repository.
The roles are deliberately few — every one is load-bearing for at least two cases, and a
role invented for one case is a fixture with extra steps.

**A role that cannot be bound skips its cases, with a sentence saying what was missing.**
A skip is honest where a failure would be a lie, and reporting absent data as a wrong
answer is how a suite loses its authority. Skips are recorded too: a case that has been
skipping for six weeks is a coverage gap nobody is being told about.

Each run prints what it bound, so a run is reproducible from its own output — if a case
behaved oddly, the binding says which records it was actually asked about. Each run also
records itself, because the question worth asking is not the pass count but *which case has
both passed and failed*. That has already paid for itself once: a case passed at 22:11 and
failed at 22:20 on identical code, and the only reason anyone noticed was that the suite
happened to be run twice by hand in one evening.

---

## Getting started

What follows is everything that works today. Needs Docker, and **Node 24** — the current
Active LTS, which is what `engines` asks for and what CI tests, alongside the current
release so that whatever breaks in the next LTS is found before it becomes the default.

```bash
git clone https://github.com/Brdjx/business-agent.git
cd business-agent
cp .env.example .env    # the dev defaults already point at the compose database
npm run db:up           # docker compose up -d --wait
```

`--wait` blocks on the container healthcheck, which deliberately runs over TCP rather
than the unix socket: during first boot the Postgres entrypoint runs a socket-only server
while it applies the files in `db/`, so a socket check reports ready while the seed is
still inserting. A zero exit here means the schema *and* the seed have applied.

Then look at the business:

```bash
docker compose exec db psql -U business_agent -d business_agent
```

```sql
\dt

select engagement_kind, status, count(*)
from clients
group by 1, 2
order by 1, 2;
```

Editing anything in `db/` after that first boot does nothing — the entrypoint only runs
those scripts against an empty data directory, so a restart brings back the old schema.
`npm run db:reset` (`down -v` then up) is what reapplies them. `npm run db:down` stops the
container and keeps the data.

Then ask it something:

```bash
npm run ask "how much is outstanding, and how much of it is overdue?"
```

That needs a model. Set `ANTHROPIC_API_KEY` and leave `PROVIDER=anthropic`, or set
`PROVIDER=bedrock` and use the AWS credential chain. `npm test` and `npm run typecheck`
need neither — the unit tests mock the provider and the database, because a suite that
spends money on every commit stops being run.

`npm run db:check` asserts that every eval role can bind against the database, and names
the role and the reason when one cannot.

### Asking it to change something

A write never happens because you asked. It comes back as a proposal:

```bash
$ npm run ask "Log 3 hours against Ledgerlight Internal Tooling for today, a cleanup pass. It's billable."

proposed — NOTHING HAS BEEN CHANGED
  log_time  a64900db
    Log 3.00h on 2026-08-11 against Ledgerlight Internal Tooling
      (Ledgerlight — own_venture: the studio's own, never billable) — cleanup pass [not billable]
    row      projects/Ledgerlight Internal Tooling  71c2bda4-...
    asserts  name = Ledgerlight Internal Tooling; rate_cents = unset; client_id = 6435c346-...
    approve  npm run ask -- approve a64900db
```

Two things happened there. It refused to bill an own venture even though the request said
billable, and it said so rather than flipping the flag quietly. And nothing was written —
the row count is unchanged until you approve.

```bash
$ tsx src/cli.ts proposals        # the pending queue, with the question that produced each
$ tsx src/cli.ts approve a64900db # applies it; short ids work, like a git sha
$ tsx src/cli.ts reject a64900db
```

The `asserts` line is re-read immediately before the write. If one of those facts has
moved, approving refuses and says which:

```
not applied — stale
  Not applied: the invoice changed after this was proposed — amount_cents is now 950000,
  not 900000. Ask again so the proposal describes what is there now.
```

Approving the same proposal twice replays the first result instead of writing again — the
write key is derived from the content of the act and claimed before the write, so a retry
races on a primary key rather than on the row.

---

## Status

| Part | State |
|---|---|
| Postgres schema — plain `postgres:17`, no extensions, no RLS | **in** |
| Synthetic seeded business: clients, contacts, projects, invoices, time entries | **in** |
| Repo furniture: compose file, `.env.example`, npm scripts, MIT | **in** |
| Harness: the loop, the budget, the trace | **in** |
| Tools: allowlist, argument validation, evidence | **in** |
| Read tools, every total computed in SQL, evidence on each result | **in** |
| Two provider adapters: Anthropic over `fetch`, and Bedrock | **in** |
| Writes: proposals, write-key ledger, precondition re-check | **in** |
| Eval runner: role binding, mechanical assertions, recorded suites | **in** |
| A CLI to ask it something: `npm run ask "..."` | **in** |

**In** means the file is here and readable. It does not mean it has been run against a
live model in this repository. Where that has not happened, this README will not say it
has.

---

## More

- [`docs/design.md`](docs/design.md) — why the pieces are shaped the way they are.
- [`docs/incidents.md`](docs/incidents.md) — what has already gone wrong. Kept because
  the failures are more informative than the feature list, and because a decision reads as
  arbitrary until you know what it prevents.

Extracted from Fortissimo OS, a private one-person studio system. No client data is here:
every record under `db/` is synthetic, and the operator's uuid is obviously fake on purpose
so that it reads as fixture data in a log line rather than inviting the assumption that it
came from somewhere.

MIT.
