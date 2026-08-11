# seeds/ — alternative datasets

The dataset the agent reads. `db/900-seed.sql` is the default and Docker applies it on a
fresh volume; the files here replace it in a database that is already running, one at a
time, so the same eval suite can be pointed at more than one business.

**These files must not be moved into `db/`.** That directory is mounted into
`docker-entrypoint-initdb.d`, so every `.sql` in it is executed during schema creation
against an empty data directory. Two datasets there would both run, and the first unique
index on client name or invoice number would decide which half of which business survived.
`scripts/assert-roles.sql` lives outside `db/` for the same reason.

## Applying one

```bash
npm run db:seed -- seeds/complete.sql
npm run db:seed -- seeds/sparse.sql --reset-agent
npx tsx scripts/seed.ts --help
```

Five tables — `clients, contacts, projects, invoices, time_entries` — are emptied, the
invoice number sequence goes back to where the schema starts it, and the file is applied,
all in one transaction. A file that fails halfway therefore leaves the dataset that was
there before it rather than an empty database. `src/seed.ts` is where that order and its
reasons are written down.

## What a swap leaves alone

`agent_runs`, `agent_proposals`, `agent_write_keys` and `agent_memory` are kept unless you
pass `--reset-agent`, and this is the part to read before swapping. Their evidence names
business rows by id — a run's citations, a proposal's target, a memory's subject — and
those ids have just gone. It is jsonb with no foreign key, so nothing is broken; the
record has simply stopped being true, which is worse, because broken gets fixed and untrue
gets quoted. The report says how many rows are in that position. A write key claimed
against a row that no longer exists is the one with teeth: approving a proposal that
matches it replays a result about a record nobody can look up.

The eval history (`agent_eval_suites`, `agent_eval_runs`) survives even `--reset-agent`.
Which case passed and which failed is still true of the run that produced it, whatever the
data underneath has become.

## What each dataset is for

Two claims in the root README are closed here, one by each file: that a case names a
**shape** rather than a record, so the same suite runs against any dataset, and that a role
which cannot bind **skips** its cases instead of failing them.

**`complete.sql` — a second whole business.** Every role binds, to different companies,
different projects and different money, at a different scale from the shipped seed. Not one
line of `src/agent/evals/cases.ts` changes. That is the portability half: a suite that only
ever ran against the seed shipped beside it has demonstrated nothing about being portable.

**`sparse.sql` — a business a few weeks old.** Several roles cannot bind, because the rows
they describe do not exist yet: nobody has been turned down, nothing has been finished,
no client has a second project. The cases that need them skip. This is the half worth
having, and the half that had no evidence at all: the danger in a skip is a suite going
green while covering less than its output claims, so the mechanism has to be watched
working on a dataset where roles genuinely cannot bind — not merely written.

Which roles a file leaves unbound is stated in its own header, beside the rows that bind
the rest. `npm run db:check` is how you confirm that rather than take it on trust.

Ten of the seventeen cases declare a role:

```
client_with_project     client-lookup
client_multi_project    write-refuses-ambiguity
passed_lead             passed-lead-is-not-a-client, passed-lead-was-never-billed
inactive_client         no-op-status-change-proposes-nothing
client_with_invoices    money-for-one-client
contact_at_client       unreachable-record-is-admitted
client_of_contact       bound as a pair with contact_at_client
single_project          write-proposes-rather-than-writes, proposal-is-not-a-promise
absent_client           unknown-client
```

The other seven name no role and run against anything: `money-outstanding`,
`totals-exclude-void-and-draft`, `never-billable-hours-are-not-billed`,
`no-invented-numbers`, `out-of-scope`, `void-invoice-cannot-be-paid`, `budget-is-reported`.
Three of those get quietly weaker on a dataset that lacks a void invoice, a draft, or hours
against an own venture — they check less rather than skipping, since there is no role to
skip on, and the binding prints a warning naming each trap that is disarmed.

## Getting back

`npm run db:seed -- db/900-seed.sql` re-applies the shipped dataset over the business
tables and keeps everything else. `npm run db:reset` also gets you there — it drops the
volume, and `db/` applies on a fresh one — but it is not the inverse of a swap: the volume
holds the agent tables too, so every run, trace, proposal and recorded eval suite goes with
it.

## A worked sequence

Swap to the sparse dataset, ask which roles bind, then run the suite and watch the
difference land as skips.

```bash
npm run db:up                        # or npm run db:reset, for the shipped seed on a clean volume
npm run db:seed -- seeds/sparse.sql
```

The report opens with `applied seeds/sparse.sql` and a count per table. Tables that landed
empty are named again on their own `empty` line, because an empty table is the *point* of
this dataset and a mistake in a complete one. Then the invoice sequence: the next number the
application would hand out, and the highest this dataset uses. Then a paragraph on the agent
history it did not touch.

```bash
npm run db:check
```

This is an assertion script, so a dataset built to leave roles unbound **fails** it and
exits non-zero. That is the demonstration, not a problem to fix. You get a `NOTICE` naming
the record for each role that bound, then

```
ERROR:  role <name> cannot bind: <what was missing>
```

and it stops there — the whole check is one `DO` block that `RAISE`s, and psql runs with
`ON_ERROR_STOP`, so the first unbound role ends the script and the money block at the bottom
never runs. One reason per invocation. To see all nine at once, run the suite: it prints the
full binding before it spends anything.

```bash
npm run eval
```

The binding comes first, every role in a fixed order — the ones that bound with the record
they bound to, the ones that did not as `— unbound: <the same reason db:check gave>`. A
binding that listed only what it found would hide an unbound role in exactly the situation
where it matters. Then, per case:

```
  <case-id> … skipped — <reason>
  <case-id> … pass (1234ms)
  …
  N/N passed, M skipped for missing data
```

The denominator is the cases that **ran**, not the seventeen, so a skip cannot flatter the
pass rate. The exit code is 0: absent data is not a wrong answer. The skips are written to
`agent_eval_runs` as well, so a case that has been skipping for six weeks is a query rather
than something nobody was told.

Neither dataset has been applied to a live database from this checkout yet. The lines above
are quoted from the code that prints them, not from a transcript — replace this paragraph
with the real output once it has run.

## Adding one

- `INSERT`s only, plus `setval` and `DO` blocks. No DDL: the schema belongs to
  `db/001-business.sql`, and a dataset that alters it is a different repository.
- Every date derived from `CURRENT_DATE`, never a literal, or "overdue" stops being true
  for whoever runs it next month. Leave `created_at` to its default so it visibly disagrees
  with `start_date` — otherwise nothing catches a tool that reaches for the wrong one.
- Hand-written invoice numbers need a closing
  `SELECT setval('invoice_number_seq', <highest>, true);`. The swap checks and warns loudly
  when they disagree, because that failure otherwise arrives weeks later as a unique-index
  violation on an innocent write, with nothing pointing back at the seed.
- No `BEGIN` / `COMMIT` / `ROLLBACK`, and no psql `\` commands. The file is applied inside
  one transaction over the wire; both are refused before anything is truncated.
- Close with a `DO` block asserting what the file claims, the way `db/900-seed.sql` does. A
  `RAISE` there rolls the entire swap back, which is the intent: a dataset that does not
  hold up should not load.
- Say in the header which roles bind, and which do not on purpose. A role left unbound by
  accident and a role left unbound by design produce the same output, and only one of them
  is a bug.
