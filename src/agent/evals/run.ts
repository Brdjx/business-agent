/**
 * The eval runner.
 *
 * ── Deliberately not a judge ──
 *
 * Every assertion here is mechanical: which tools were called, which were not,
 * which tables the evidence came from, whether a forbidden phrase appears,
 * whether a write was left waiting for approval, how the run stopped. A
 * mechanical check gives the same answer twice and costs nothing to trust, which
 * is what makes it usable as a gate on every change instead of a demo run before
 * a release. Nothing in this file asks a model whether an answer was good — see
 * the header of `cases.ts` and §8 of `docs/design.md` for why a judge fails in
 * the direction that matters.
 *
 * It runs against the live model and the live database, because the thing being
 * measured is whether the agent works on real records. So it costs money and
 * takes minutes: it is a script, not part of `npm test`.
 *
 *   npm run eval
 *   npm run eval -- --case=money-outstanding
 *   npm run eval -- --verbose
 *   npm run eval -- --no-record
 *
 *   npm run eval:history          # read the recorded suites back
 *
 * Nothing in this repo loads a .env file by itself — there is no dotenv
 * dependency — so the variables below have to be in the environment, or passed
 * with `npx tsx --env-file=.env src/agent/evals/run.ts` directly.
 *
 * Env: DATABASE_URL, USER_ID, and whatever the provider needs (PROVIDER, MODEL,
 * ANTHROPIC_API_KEY). Exactly the same set the CLI reads, and read through the
 * same `providerFromEnv`, so a suite cannot be measuring a different model from
 * the one a person is asking.
 *
 * ── What it writes, and what it must never write ──
 *
 * The suite writes to the agent's own bookkeeping — `agent_runs` with
 * `kind = 'eval'`, `agent_eval_suites`, `agent_eval_runs`, and the cards a write
 * case leaves on the desk, which are retired again at the end. It writes NOTHING
 * to the business records: no client, no invoice, no time entry. Two things keep
 * that true, and they are separate on purpose.
 *
 * `allowWrites` is `c.allowWrites === true`, so it is false for every case that
 * does not say otherwise, and no case in `cases.ts` says otherwise — the five
 * cases about writing set it to `false` explicitly, which is the point of them. A
 * case that ever did turn it on is announced in the output before it runs, because
 * that run can change a record and a reader of a green suite is entitled to know.
 *
 * And nothing here approves anything. `decideProposal` is not imported, so there
 * is no code path from this file to a write being applied. A suite that approved
 * its own proposals would be measuring the consent mechanism by bypassing it, and
 * it would do so against the same records a person bills from.
 *
 * ── Recording ──
 *
 * Each run records itself, so "this case regressed" is a query rather than a
 * memory: the suite (model, commit, the role binding verbatim), and per case the
 * question as asked, the verdict, the failed assertions in these words, and the
 * `agent_runs` id so the trace survives. Read it back with `agent_eval_flaky()`
 * in `db/003-eval-history.sql` — the question worth asking is not the pass rate,
 * it is which case has both passed and failed inside the window.
 *
 * None of that recording may break the suite. `persist.ts` swallows and logs
 * every write and degrades to not recording, because a suite that failed on its
 * own bookkeeping would look exactly like the agent regressing.
 */

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { runAgent } from '../loop';
import { providerFromEnv, type ProviderChoice } from '../providers';
import { ensureToolsRegistered } from '../registry';
import { allTools } from '../tools';
import { persistRunAndProposals, summarizeTrace } from '../trace';
import { CASES, toolNamesReferenced, type EvalCase } from './cases';
import { bindRoles, describeBinding, type Binding, type Bound } from './roles';
import { closeSuite, openSuite, recordCase, NOT_RECORDING, type SuiteHandle } from './persist';
import { isProviderUnavailable } from '../providers/types';
import { close, sql } from '../../db';

/* ─── exit codes, the same three the CLI uses ─── */

const EXIT_OK = 0;
/** At least one case failed. Non-zero so this can gate anything later without
 * extra plumbing — and a skip is NOT this: absent data is not a wrong answer. */
const EXIT_FAILED = 1;
/** The suite could not run, as distinct from running and failing. */
const EXIT_UNREACHABLE = 3;
/** The invocation or the environment is wrong. Nothing was spent. */
const EXIT_USAGE = 2;

/**
 * Model calls per case.
 *
 * Kept tight on purpose. An eval that allows twenty steps stops measuring
 * whether the agent is efficient and starts measuring whether it is lucky: with
 * enough steps a model that called the wrong tool three times still arrives
 * somewhere, and the case that was meant to catch the wrong routing passes.
 *
 * Six against the loop's default of eight (`DEFAULT_LIMITS`), so every case here
 * is answered in fewer steps than an operator's question is allowed. The one case
 * that expects to hit a wall — `budget-is-reported` — asserts only that the wall
 * was named, so the number below can move without rewriting it.
 */
const STEP_LIMIT = 6;

/**
 * Any uuid version, matching `src/cli.ts`.
 *
 * Duplicated rather than exported from there: the CLI's copy is about the
 * operator's own invocation, and a shared regex would put this file's refusal
 * message in a module that has no reason to know the suite exists.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const USAGE = `usage: npx tsx --env-file=.env src/agent/evals/run.ts [--case=<id>] [--verbose] [--no-record]`;

/* ─── output ─── */

/**
 * A write that throws must not lose the rest of the report — `… | head -5`
 * closes the pipe while this is still printing, and an EPIPE from stdout would
 * otherwise take the process down between two case results.
 */
function write(stream: NodeJS.WriteStream, text: string): void {
  try {
    stream.write(text);
  } catch {
    /* the reader has gone; there is nothing useful to do about it here */
  }
}

const out = (line = ''): void => write(process.stdout, `${line}\n`);
const note = (line = ''): void => write(process.stderr, `${line}\n`);
const indent = (s: string): string =>
  s
    .split('\n')
    .map((l) => `      ${l}`)
    .join('\n');

/* ─── arguments ─── */

interface Options {
  /** One case by id. The rest are not run and not recorded — a single-case
   * invocation is for debugging that case, not a suite with sixteen skips. */
  only?: string;
  /** Print the trace summary for passes as well as failures. */
  verbose: boolean;
  record: boolean;
}

/**
 * Parse, and refuse rather than guess.
 *
 * An unrecognised argument is an error instead of being ignored, and the reason
 * is asymmetric: a typo'd `--verbse` that does nothing is merely disappointing,
 * while a typo'd `--no-recrd` silently records a run somebody asked not to
 * record. Refusing both costs one line.
 */
function parse(argv: string[]): Options | { error: string } {
  const opts: Options = { verbose: false, record: true };

  for (const arg of argv) {
    if (arg === '--verbose') {
      opts.verbose = true;
    } else if (arg === '--no-record') {
      opts.record = false;
    } else if (arg.startsWith('--case=')) {
      const id = arg.slice('--case='.length).trim();
      if (!id) {
        return {
          error: '--case= was given with no case id. Known ids: ' + CASES.map((c) => c.id).join(', '),
        };
      }
      opts.only = id;
    } else {
      return {
        error: `Unrecognised argument: ${arg}. Known: --case=<id>, --verbose, --no-record.`,
      };
    }
  }

  return opts;
}

/* ─── which commit ─── */

/**
 * The commit the suite ran against.
 *
 * Best effort by design: a suite that refused to run outside a git checkout would
 * be worse than one recording an unknown commit. Every failure path here returns
 * undefined and the suite carries on.
 *
 * Three details that are not incidental:
 *
 * `execFileSync`, so nothing is handed to a shell. There is no user input in the
 * arguments, and that is a property worth keeping structurally rather than by
 * inspection.
 *
 * `cwd` is THIS file's directory, not the process's. Otherwise the recorded sha
 * belongs to whatever repository the shell happened to be sitting in, which is
 * a wrong record rather than a missing one.
 *
 * A dirty tree is marked. `2f1a9c3` recorded for a working copy with uncommitted
 * changes is a claim that the suite ran against that commit, and it did not —
 * which is exactly the confusion the column exists to prevent when somebody
 * later compares two runs. `git status --porcelain` printing anything at all is
 * enough to say so.
 */
function gitSha(): string | undefined {
  const here = fileURLToPath(new URL('.', import.meta.url));
  const git = (args: string[]): string =>
    execFileSync('git', args, {
      cwd: here,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      // A hung git must not hold the suite up, and a console window must not
      // flash on Windows for a fact this cheap.
      timeout: 5_000,
      windowsHide: true,
    }).trim();

  try {
    const sha = git(['rev-parse', '--short', 'HEAD']);
    if (!sha) return undefined;
    try {
      return git(['status', '--porcelain']) ? `${sha}+dirty` : sha;
    } catch {
      // The sha is known and the cleanliness is not. Reporting the sha alone
      // would assert the tree was clean, so say which half is missing.
      return `${sha}+unknown-tree`;
    }
  } catch {
    return undefined;
  }
}

/* ─── one case ─── */

interface Failure {
  check: string;
  detail: string;
}

interface CaseOutcome {
  failures: Failure[];
  /** The trace summary, printed on every failure and on a pass under --verbose. */
  summary: string;
  ms: number;
  tokens: number;
  /** As actually asked, after the roles were substituted. */
  question: string;
  runId: string | null;
}

/** A list, or a function of the bound roles that produces one. */
const resolve = (v: string[] | ((r: Bound) => string[]) | undefined, roles: Bound): string[] =>
  typeof v === 'function' ? v(roles) : (v ?? []);

async function runCase(
  c: EvalCase,
  roles: Bound,
  env: { userId: string; choice: ProviderChoice; record: boolean }
): Promise<CaseOutcome> {
  const started = Date.now();
  const question = c.question(roles);

  const run = await runAgent({
    question,
    userId: env.userId,
    provider: env.choice.provider,
    model: env.choice.model,
    // False unless the case says otherwise, and no case does. See the header:
    // the write cases set this to false explicitly, which is what makes them
    // tests of the propose path rather than of the write path.
    allowWrites: c.allowWrites === true,
    limits: { maxSteps: STEP_LIMIT },
    // There is no `stateless` flag to pass and no notes to suppress, and that is
    // structural rather than an omission: this phase of the loop loads no
    // conversation history and no durable notes at all (see the header of
    // `loop.ts`). §8 of the design doc lists stateless runs as a decision the
    // suite makes; here there is nothing for a later case to read of what an
    // earlier one left, so there is nothing to switch off. When memory lands,
    // this is where it has to be switched off — a suite that reads memory
    // measures what earlier cases left behind, and one that writes it makes
    // every result depend on the order the cases happened to run in.
  });

  /**
   * Recorded as `kind = 'eval'`, which keeps seventeen synthetic runs per
   * execution out of the operator's history and out of every health figure while
   * still storing the trace. A case that fails is only debuggable if the run
   * behind it survived.
   *
   * `persistRunAndProposals` rather than `persistRun`, so a write case's card is
   * actually written to `agent_proposals`. That is the difference between
   * "the agent produced a draft" and what `write-proposes-rather-than-writes`
   * claims to test — a card that can be approved on its own. It is also what
   * makes the retirement at the end of the suite necessary, and the trade is
   * argued there.
   *
   * With `--no-record` neither is written. The cards are dropped along with the
   * trace deliberately: a card whose run was not recorded has a null `run_id`,
   * nothing can attribute it to the suite afterwards, and it would sit on the
   * operator's desk forever. The assertions below read `run.proposals`, which is
   * in memory, so a case's verdict is identical either way.
   */
  const recorded = env.record
    ? await persistRunAndProposals(env.userId, question, run, { kind: 'eval' })
    : { runId: null, proposals: [] };

  const failures: Failure[] = [];
  const toolsCalled = run.trace.flatMap((s) =>
    s.kind === 'tool' && s.toolName ? [s.toolName] : []
  );
  const answer = run.answer.toLowerCase();

  // A call is a call whether or not it succeeded, for both directions. A
  // forbidden tool that errored was still reached for, and a required tool that
  // failed was still the route the model chose — what happens next in that case is
  // caught by the evidence and contains assertions, which have nothing behind them
  // when the call returned nothing.
  for (const t of c.expectTools ?? []) {
    if (!toolsCalled.includes(t)) {
      failures.push({
        check: `calls ${t}`,
        detail: `called: ${toolsCalled.join(', ') || 'nothing'}`,
      });
    }
  }

  for (const t of c.forbidTools ?? []) {
    if (toolsCalled.includes(t)) {
      failures.push({ check: `does not call ${t}`, detail: 'but it did' });
    }
  }

  // ANY-of, not all-of: there are several honest ways to word a refusal, and an
  // eval that demands one phrasing measures the prompt rather than the behaviour.
  // An empty list is not asserted at all — that is how a case degrades when the
  // figure it would have looked for does not exist in this dataset (a zero total,
  // a disarmed trap) instead of failing for want of a fixture.
  const contains = resolve(c.expectContains, roles);
  if (contains.length > 0 && !contains.some((f) => answer.includes(f.toLowerCase()))) {
    failures.push({
      check: `mentions one of: ${contains.join(' | ')}`,
      // Enough of the answer to see what it said instead. The whole answer is in
      // the trace and in `agent_runs`; this is the line somebody reads first.
      detail: `answer: ${run.answer.slice(0, 160)}`,
    });
  }

  // All forbidden. Every phrase in a case's list survives its own negation — see
  // the rule in the header of `cases.ts`, which is the fifth version of that
  // mistake.
  for (const f of resolve(c.expectAbsent, roles)) {
    if (answer.includes(f.toLowerCase())) {
      failures.push({ check: `never says "${f}"`, detail: 'but it did' });
    }
  }

  for (const table of c.expectEvidenceFrom ?? []) {
    if (!run.evidence.some((e) => e.table === table)) {
      failures.push({
        check: `rests on a ${table} record`,
        detail: `evidence: ${run.evidence.map((e) => e.table).join(', ') || 'none'}`,
      });
    }
  }

  // The DRAFTS the run produced, not the cards that were recorded. A card that
  // failed to write is a bookkeeping failure, and failing the case for it would
  // report a database problem as the agent regressing — the same rule `persist.ts`
  // follows. What the case is about is whether the agent left a write for a person
  // to decide rather than performing it.
  if (c.expectProposes) {
    const proposed = run.proposals.map((p) => p.toolName);
    if (!proposed.includes(c.expectProposes)) {
      failures.push({
        check: `leaves a ${c.expectProposes} proposal to approve`,
        detail: `proposed: ${proposed.join(', ') || 'nothing'}`,
      });
    }
  }

  if (c.expectNoProposal && run.proposals.length > 0) {
    failures.push({
      check: 'leaves nothing waiting for approval',
      detail: `proposed: ${run.proposals.map((p) => p.summary).join('; ')}`,
    });
  }

  const expectStop = c.expectStop ?? 'answered';
  if (expectStop === 'any') {
    // The point of `budget-is-reported` is that the run stopped for a reason
    // somebody can READ, whichever wall it was. There is nothing to check about
    // the reason's value: `StopReason` is a closed union in code, so a wall
    // outside the vocabulary cannot reach here. What can regress is the reporting
    // — a run that stopped and said nothing, or one whose answer is empty because
    // it was cut off before it wrote a word. Both are asserted, and both are
    // guaranteed by the loop today (`answer = answer || detail`), so this is a
    // guard against that changing rather than something that can fail now. Said
    // out loud rather than implied, because a check that cannot fail should not be
    // mistaken for one that has passed.
    if (!run.stopDetail.trim()) {
      failures.push({ check: 'stops for a stated reason', detail: 'no sentence was given' });
    }
    if (!run.answer.trim()) {
      failures.push({
        check: 'says something, even after a wall',
        detail: `stopped as ${run.stopReason} with an empty answer`,
      });
    }
  } else if (run.stopReason !== expectStop) {
    failures.push({
      check: `stops as ${expectStop}`,
      detail: `stopped as ${run.stopReason} — ${run.stopDetail}`,
    });
  }

  return {
    failures,
    summary: summarizeTrace(run),
    ms: Date.now() - started,
    tokens: run.tokens,
    question,
    runId: recorded.runId,
  };
}

/* ─── clearing the desk the suite littered ─── */

const RETIRED =
  'Retired by the eval suite. This card was proposed by a synthetic eval run rather than ' +
  'asked for by the operator, and nothing was changed.';

/**
 * Retire every pending card that an eval run left behind.
 *
 * ── Why this is needed at all ──
 *
 * This is a single-operator database with ONE approval desk. Two cases assert that
 * a write was left waiting on it, and each leaves a real row on
 * `agent_proposals` — deliberately, because "a card that can be approved on its
 * own" is what those cases claim to test and a draft that is never written is not
 * that. Three further cases assert that NOTHING was left waiting, and an agent
 * that gets one of them wrong leaves a card too, which is the run where the desk
 * most needs clearing afterwards.
 *
 * So a green suite hands the operator two synthetic cards asking to log a couple
 * of hours against a project, mixed in with the ones a person actually asked for,
 * and a failing suite can hand over more. A desk nobody trusts is a desk nobody
 * reads, and then a real card waits behind the noise.
 *
 * It matters for a second reason that is easy to miss: the partial unique index
 * on `(user_id, write_key) WHERE status = 'pending'` means the NEXT suite's
 * identical draft collides with this one's card, and `recordProposals` hands back
 * the card that already exists instead of writing a new one. Left alone, the
 * write cases stop exercising the insert after the first run of the day.
 *
 * ── Expired, not deleted ──
 *
 * `status = 'expired'` with a note in `result`, which is what `expirePending` in
 * `proposals.ts` already does for a card that aged out — the same shape of event,
 * so the desk reads it in the vocabulary it already has. Three reasons for
 * updating rather than deleting:
 *
 * The row is evidence. A case asserting that a card was left behind is debuggable
 * a week later only if the card is still there to look at.
 *
 * `agent_proposals` keeps decided cards ON PURPOSE — "did I approve that?" is the
 * question the table exists to answer — so a DELETE against it would be the only
 * code in this repository that destroys a consent record, written in a script
 * that runs unattended.
 *
 * And the failure modes are not symmetrical. A wrong `WHERE` on this UPDATE marks
 * an operator's card expired: visible on the desk, reversible with one statement.
 * The same mistake on a DELETE is not recoverable.
 *
 * `expired` rather than `declined` because nobody decided these. Declining is a
 * judgment a person made, and reporting a swept synthetic card as one would tell
 * the operator they rejected something they never saw — the same distinction
 * `db/002-agent.sql` draws when it explains why `superseded` is not `declined`.
 *
 * ── What it will not touch ──
 *
 * Only cards whose `run_id` names an `agent_runs` row with `kind = 'eval'`
 * belonging to this operator. A card with a NULL `run_id` is left alone, and that
 * is a hole with its reason: a null means the run's trace was never written, so
 * the card cannot be attributed to the suite at all, and the alternative —
 * matching on tool name and summary — would eventually retire a card the operator
 * was waiting on. An unattributable synthetic card left on the desk is a nuisance;
 * an operator's card retired by a script is the thing this whole design refuses.
 * The suite closes most of that hole from the other side: with `--no-record` no
 * cards are written, and otherwise the run is inserted before its cards are.
 *
 * Cards from EARLIER suites are swept too, not just this run's. An eval card left
 * by a suite that crashed before it got here is precisely the one nobody else will
 * ever retire.
 */
async function retireEvalProposals(userId: string): Promise<string> {
  try {
    const rows = await sql<{ id: string; tool_name: string }>(
      `UPDATE agent_proposals p
          SET status = 'expired', result = $2, decided_at = now()
        WHERE p.user_id = $1
          AND p.status = 'pending'
          AND EXISTS (
            SELECT 1
              FROM agent_runs r
             WHERE r.id = p.run_id
               AND r.user_id = p.user_id
               AND r.kind = 'eval'
          )
        RETURNING p.id, p.tool_name`,
      [userId, RETIRED]
    );

    if (rows.length === 0) return 'the desk is clear: no pending card belongs to an eval run';
    const tools = [...new Set(rows.map((r) => r.tool_name))].sort().join(', ');
    return `retired ${rows.length} synthetic card(s) from the desk (${tools})`;
  } catch (err) {
    // Swallowed like the rest of the bookkeeping, and for the same reason: the
    // exit code has to mean "a case failed", not "the cleanup did". But loudly,
    // and with the statement to run by hand, because unlike the history this one
    // leaves something on a person's desk.
    return (
      `COULD NOT clear the desk (${messageOf(err)}). Synthetic cards may still be pending. ` +
      "By hand: update agent_proposals p set status = 'expired', decided_at = now() where " +
      `p.user_id = '${userId}' and p.status = 'pending' and exists (select 1 from agent_runs r ` +
      "where r.id = p.run_id and r.kind = 'eval');"
    );
  }
}

/* ─── the suite ─── */

async function main(): Promise<number> {
  const opts = parse(process.argv.slice(2));
  if ('error' in opts) {
    note(opts.error);
    note(USAGE);
    return EXIT_USAGE;
  }

  const userId = process.env.USER_ID?.trim();
  if (!userId) {
    note(
      'USER_ID is not set, so these runs have nobody to belong to. The business tables have no ' +
        'user_id column at all, but agent_runs and agent_eval_suites do, and that is where the ' +
        'suite records itself. Nothing here loads .env by itself: pass it to the runner ' +
        '(npx tsx --env-file=.env …).'
    );
    return EXIT_USAGE;
  }
  if (!UUID.test(userId)) {
    note(
      `USER_ID is "${userId}", which is not a uuid. Every table the suite writes to has a uuid ` +
        'user_id, and both writers swallow their errors by design — so the suite would run, cost ' +
        'money, print its results, and record none of them, with a line on stderr per case to ' +
        'say why.'
    );
    return EXIT_USAGE;
  }

  const cases = opts.only ? CASES.filter((c) => c.id === opts.only) : CASES;
  if (cases.length === 0) {
    note(`No case matches "${opts.only}". Known ids:`);
    for (const c of CASES) note(`  ${c.id}`);
    return EXIT_USAGE;
  }

  // Before anything is spent. The three things this throws for — no key, no
  // MODEL, a PROVIDER that is not one of ours — are the environment being wrong,
  // which is exit 2 with nothing attempted rather than a failed suite.
  let choice: ProviderChoice;
  try {
    choice = providerFromEnv();
  } catch (err) {
    note(messageOf(err));
    return EXIT_USAGE;
  }

  // The registry is the allowlist and it starts empty. Called here because this
  // is an entry point that will reach `executeTool` — not left to whatever this
  // file happens to import, which is incident 1 exactly (docs/incidents.md).
  ensureToolsRegistered();
  const registered = new Set(allTools().map((t) => t.name));
  if (registered.size === 0) {
    note(
      'No tools are registered, so the model would be sent nothing to read the business with ' +
        'and would answer every question from nothing. Each case would fail, and a wall of ' +
        'failures reads as the agent regressing rather than as a wiring fault in the harness. ' +
        'Refusing before the first model call costs nothing and cannot be misread.'
    );
    return EXIT_USAGE;
  }

  /**
   * Every tool name any case mentions has to exist.
   *
   * A typo in `expectTools` fails its case loudly and gets fixed on the first
   * run. A typo in `forbidTools` matches nothing, forbids nothing, and passes
   * forever — the silent hole `toolNamesReferenced()` was exported to close.
   * Checked for the WHOLE file even when `--case=` selected one, because the hole
   * is in the file rather than in the case being debugged.
   */
  const unknown = toolNamesReferenced().filter((n) => !registered.has(n));
  if (unknown.length > 0) {
    note(
      `The cases name ${unknown.length} tool(s) that are not registered: ${unknown.join(', ')}. ` +
        'A name in forbidTools that matches no tool forbids nothing and passes forever, so the ' +
        'suite refuses to run rather than reporting a pass it did not check. Registered: ' +
        [...registered].sort().join(', ')
    );
    return EXIT_USAGE;
  }

  /**
   * Bind the roles before anything runs, and print what they bound to.
   *
   * The cases name shapes rather than records — "a client with several projects",
   * "a lead that was passed on" — so the same file runs against the synthetic
   * seed and against a real database. Printing the binding is what makes a run
   * reproducible from its own output: if a case behaved oddly, this says which
   * records it was asked about and which figures its assertions were built from.
   *
   * NOT caught. A failed query here is a database problem, and `roles.ts` refuses
   * to degrade it into nine unbound roles precisely so that it cannot be reported
   * as "0 passed, 17 skipped" and exit successfully. The outer catch prints the
   * sentence.
   */
  const binding: Binding = await bindRoles();
  out();
  out('Roles bound from the live data:');
  out(describeBinding(binding));

  const sha = gitSha();

  /**
   * Open the suite BEFORE the first case, so a crash halfway leaves a row with
   * no `finished_at` rather than no row at all. A suite that only recorded itself
   * on success could not tell you about the run that died.
   */
  const suite: SuiteHandle = opts.record
    ? await openSuite(userId, {
        modelId: choice.model,
        provider: choice.provider.id,
        gitSha: sha,
        roles: binding.roles,
        total: cases.length,
      })
    : NOT_RECORDING;

  out();
  out(
    `Agent evals — ${cases.length} case(s), ${choice.provider.id}/${choice.model}, ` +
      `commit ${sha ?? 'unknown'}, ${STEP_LIMIT} steps per case` +
      (opts.record ? '' : ', NOT recording')
  );
  out();

  let passed = 0;
  let skipped = 0;
  let tokens = 0;
  const failedIds: string[] = [];
  /** Cases the suite could not reach the provider for: neither pass, fail, nor
   *  a missing fixture. Kept apart so the exit code and the summary can both
   *  say which of the three happened. */
  const unreachableIds: string[] = [];

  // Sequential, not concurrent. Seventeen runs at once would race each other on
  // the provider's rate limit and on the one approval desk, and a case that failed
  // because another case was mid-flight is the least debuggable kind of failure a
  // suite can produce. The suite is slow; that is the price of measuring a live
  // model rather than a mock.
  for (const c of cases) {
    // A case whose world is absent is SKIPPED, not failed. "The agent got this
    // wrong" and "the data this case needs is not here" are different findings,
    // and reporting the second as the first is how a suite loses its authority.
    const unbound = (c.needs ?? []).filter((role) => !binding.roles[role]);
    if (unbound.length > 0) {
      skipped++;
      const why = unbound
        .map((role) => binding.missing.find((m) => m.role === role)?.because ?? String(role))
        .join('; ');
      out(`  ${c.id} … skipped — ${why}`);
      // Recorded too. A case that has been skipping for six weeks is a gap in
      // coverage nobody is being told about, and it only becomes visible if the
      // skips sit in the history beside the passes.
      await recordCase(suite, { caseId: c.id, passed: false, skipped: true, note: why });
      continue;
    }

    if (c.allowWrites === true) {
      // No case in `cases.ts` does this. Announced rather than refused: the field
      // is part of `EvalCase` and a runner that ignored it would make the field a
      // lie. What must not happen is a reader taking a green suite as evidence
      // that nothing was written.
      note(
        `  ! ${c.id} declares allowWrites — this case may CHANGE the business records, and a ` +
          'pass here is not evidence that the suite is read-only.'
      );
    }

    write(process.stdout, `  ${c.id} … `);
    try {
      const r = await runCase(c, binding.roles, { userId, choice, record: opts.record });
      tokens += r.tokens;

      if (r.failures.length === 0) {
        passed++;
        out(`pass (${r.ms}ms)`);
        if (opts.verbose) out(indent(r.summary));
      } else {
        failedIds.push(c.id);
        out(`FAIL (${r.ms}ms)`);
        out(`      ${c.tests}`);
        out(`      asked: ${r.question}`);
        for (const f of r.failures) out(`      x ${f.check} — ${f.detail}`);
        // A failure without its trace is a puzzle. Always shown, never behind
        // --verbose: the whole point of the trace is the run that went wrong.
        out(indent(r.summary));
      }

      await recordCase(suite, {
        caseId: c.id,
        question: r.question,
        passed: r.failures.length === 0,
        failures: r.failures,
        durationMs: r.ms,
        agentRunId: r.runId,
      });
    } catch (err) {
      const message = messageOf(err);

      /**
       * There are three outcomes here, not two, and the third one cost a suite
       * its meaning before it was noticed.
       *
       * A case can fail because the agent was wrong. It can skip because the data
       * it needs is absent. And it can tell you NOTHING, because the provider
       * could not be reached — which on the first live run of this suite happened
       * twice in seventeen cases and was printed as `ERROR`, counted in `failed`,
       * and summarised as "15/17 passed". Two of those two failures were a dropped
       * socket.
       *
       * Counting it as a failure is wrong in three separate ways. The exit code
       * says the agent regressed when nothing was learned about the agent. The
       * summary invites someone to go looking for a defect that is not there. And
       * because agent_eval_flaky counts anything not-passed-and-not-skipped as a
       * failure, a case with one real pass and one dropped connection is reported
       * as UNSTABLE — so a network blip makes the agent look nondeterministic,
       * which is precisely the finding the history exists to produce honestly.
       *
       * The provider classifies it, not this file: only the adapter can tell "the
       * endpoint refused this" from "the connection died on the way". Matching
       * error strings here would duplicate that judgment and drift from it.
       *
       * Recorded as a skip so it stays out of the failure count, with a note
       * prefix that keeps it distinguishable from a data-absence skip.
       */
      if (isProviderUnavailable(err)) {
        unreachableIds.push(c.id);
        out('UNREACHABLE');
        out(`      ${message}`);
        out('      This says nothing about the agent. The suite could not reach the provider.');
        await recordCase(suite, {
          caseId: c.id,
          passed: false,
          skipped: true,
          note: `unreachable: ${message}`,
        });
        continue;
      }

      // Anything else IS a failure with no assertions behind it — a question that
      // could not be built, a tool that threw where it should have refused, a
      // service that answered badly to the end. The message is the only thing
      // that will explain it later.
      failedIds.push(c.id);
      out('ERROR');
      out(`      ${message}`);
      await recordCase(suite, { caseId: c.id, passed: false, note: message });
    }
  }

  // Neither a skip nor a run: a case the provider could not be reached for did
  // not happen, so counting it in the denominator would report a pass rate over
  // cases that never executed.
  const ran = cases.length - skipped - unreachableIds.length;
  await closeSuite(suite, { passed, failed: failedIds.length, skipped });

  // After the suite, and after the totals are stamped: the cards are part of what
  // the suite did, and clearing them must not be the thing that prevents the
  // history being written. Skipped entirely when nothing was recorded, because
  // then no card was written either.
  const desk = opts.record
    ? await retireEvalProposals(userId)
    : 'nothing was recorded, so no card was written to the desk';

  out();
  out(
    `${passed}/${ran} passed` +
      (skipped > 0 ? `, ${skipped} skipped for missing data` : '') +
      (unreachableIds.length > 0 ? `, ${unreachableIds.length} unreachable` : '') +
      `, ${tokens.toLocaleString()} tokens`
  );
  if (failedIds.length > 0) out(`failed: ${failedIds.join(', ')}`);
  if (unreachableIds.length > 0) {
    // Said separately and in these words on purpose. "failed" next to a case id
    // sends someone to read the agent's code; this sends them to the network.
    out(
      `could not reach the provider for: ${unreachableIds.join(', ')} — ` +
        'these were not run and say nothing about the agent'
    );
  }
  if (binding.warnings.length > 0) {
    // Repeated at the bottom because the binding is printed before seventeen runs
    // have scrolled past it, and a disarmed trap is the reason a pass can mean
    // less than it looks like it means.
    out(
      `${binding.warnings.length} binding warning(s) above: some assertion(s) checked less than ` +
        'they were written to check.'
    );
  }
  out(desk);
  if (suite.id) {
    out(`recorded as suite ${suite.id}`);
    out(
      `  select case_id, passed, skipped, failures from agent_eval_runs where suite_id = '${suite.id}';`
    );
    // Written out with the operator's own uuid in it so it can be pasted rather
    // than edited. The interesting query is not this suite's pass count — it is
    // which case has produced BOTH outcomes across the last twenty suites, which
    // is the flake the history exists to surface.
    out(`  select * from agent_eval_flaky('${userId}');`);
  }

  // Non-zero on failure so this can gate anything later without extra plumbing.
  // A skip is not a failure and does not affect the code: absent data is not a
  // wrong answer, and a gate that failed on it would be one nobody could keep
  // green honestly.
  // A suite with unreachable cases is not green: it did not run. But it is not
  // EXIT_FAILED either, which a gate reads as "the agent regressed". Distinct code
  // so a CI step can retry an outage and escalate a real failure.
  if (failedIds.length > 0) return EXIT_FAILED;
  if (unreachableIds.length > 0) return EXIT_UNREACHABLE;
  return EXIT_OK;
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Read from argv rather than from the parsed options, because this catch is
 * reachable BEFORE anything has been parsed — and the same is true in
 * `src/cli.ts`, which does it for the same reason.
 */
const showStack = process.argv.includes('--verbose');

let code = EXIT_FAILED;
try {
  code = await main();
} catch (err) {
  // Everything below this is expected to fail with a sentence: the provider names
  // the variable, `db.ts` names the connection string, `roles.ts` says which check
  // could not be made. Printing a stack trace under every one of those teaches a
  // reader to ignore stack traces, and the first line of the trace repeats the
  // sentence anyway — so it goes behind --verbose.
  note(messageOf(err));
  if (showStack && err instanceof Error && err.stack) note(err.stack);
  else if (!showStack) note('run again with --verbose for the stack trace');
  code = EXIT_FAILED;
} finally {
  // The pool holds an open socket, which keeps the event loop alive: without this
  // the suite prints its results and then sits there looking as though it were
  // still running.
  await close();
}

/**
 * The exit code is set, not forced.
 *
 * `process.exit(code)` here — which is what the private runner does — aborts the
 * process on Windows with `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`
 * when the pool and the provider's HTTP agent are still closing their handles,
 * replacing the real code with 127 and printing a C assertion under the results.
 * A suite that gates on its exit code cannot afford that, and it would look like
 * a failure in the agent rather than in the shutdown. `src/cli.ts` records the
 * same finding at the bottom of the file.
 */
process.exitCode = code;
