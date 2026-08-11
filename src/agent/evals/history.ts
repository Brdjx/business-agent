/**
 * Reading the eval history back.
 *
 * A suite that records itself and is never read is a log file with a schema. The
 * point of persisting runs is to answer three questions that scrollback cannot:
 *
 *   **Which case is unstable?** A case that has both passed and failed on the same
 *   code is the most valuable thing a suite can say, and it is invisible in any
 *   single run. One case in this suite's lineage passed at 22:11 and failed at 22:20;
 *   it was caught by accident, because somebody happened to run the suite twice in
 *   one evening. This is the query that would have caught it on purpose.
 *
 *   **What changed, and against which commit and model?** A pass count is not a
 *   regression report. Two runs side by side, with their shas, are.
 *
 *   **What did this case actually do the last few times?** With the failed
 *   assertions in the runner's own words, and the question as it was actually asked
 *   — which differs between runs, because the roles bind to different records.
 *
 *     tsx --env-file=.env src/agent/evals/history.ts
 *     tsx --env-file=.env src/agent/evals/history.ts --case=money-outstanding
 *     tsx --env-file=.env src/agent/evals/history.ts --suite=a1b2c3d4
 *     tsx --env-file=.env src/agent/evals/history.ts --suites=50
 *
 * ── Stability is computed in Postgres ──
 *
 * `agent_eval_flaky()` in `db/003-eval-history.sql` owns the counting rule, and
 * this file calls it rather than re-deriving it: a skip is NOT a failure (failures
 * are `NOT passed AND NOT skipped` throughout), and a case that ran once and
 * skipped four times is under-fixtured rather than unstable. A second copy of that
 * rule in JavaScript would drift from the one in the schema, and the drift would be
 * invisible — both versions would still print a number.
 *
 * That is also why the per-case view calls the same function for its summary line
 * instead of counting the rows it already has in hand.
 *
 * ── What this file will not claim ──
 *
 * With fewer than two suites recorded it says that stability needs at least two
 * runs to mean anything. "Every case gave the same verdict every time" read off a
 * single sample is exactly the kind of reassuring, unfounded claim this whole suite
 * exists to stop the agent making, and it would be worst on the first run — when
 * somebody is deciding whether to trust the output at all.
 *
 * ── Notes from the port ──
 *
 * The private original used Supabase (`.from().select()`, `.rpc()`); this is plain
 * pg with `$1` placeholders. Three consequences worth naming, because each one is a
 * silent wrong answer rather than an error:
 *
 * TIMESTAMPTZ comes back as a `Date`, not an ISO string (`src/db.ts` overrides the
 * DATE parser only). The original sliced these as strings, which throws here.
 *
 * The BIGINT counts from `agent_eval_flaky` come back as STRINGS, so `skips ===
 * runs` compares text and `failures > 0` coerces. They are cast to `int` in the
 * SELECT below — a count of eval rows cannot overflow an int — so the comparisons
 * in this file are arithmetic.
 *
 * `.in('suite_id', […])` became a join against the same window the function uses.
 * The window is defined twice now, here and in `agent_eval_flaky`: most recent N
 * suites by `started_at DESC`, scoped to one operator. They have to agree, or the
 * per-case list and the stability line describe different sets of runs.
 *
 * ── Exit codes ──
 *
 *   0  the report was printed.
 *   1  part of the report could not be produced — the stability query failed. Not
 *      silent and not fatal: what is missing is the most valuable section, and a
 *      reader that exits 0 with the section absent looks like a suite with nothing
 *      to report.
 *   2  the invocation or the environment is wrong. Nothing was read.
 *
 * A window full of failing cases still exits 0. This is a report, not a gate: the
 * gate is the runner's own exit code on the suite it just ran. Wiring this into CI
 * as a check would fail the build for a flake recorded a fortnight ago and keep
 * failing it until the window rolled past.
 */

import { close } from '../../db';
import { CASES } from './cases';
/**
 * The reads, and the two readers for the JSONB columns, live in
 * `history-reads.ts` — because the web UI's evals surface needs the same five
 * queries and this file is a script that cannot be imported without running a
 * report. What is shared is the window, the counting rule and how a stored
 * column is read; the words below are this medium's own. See that file's header.
 */
import {
  ABSENT_ROLE_MEANS,
  caseOutcomes,
  DEFAULT_WINDOW,
  flakiness,
  looksLikeRef,
  MAX_WINDOW,
  MIN_REF,
  readBinding,
  readFailures,
  recentSuites,
  shortModel,
  suiteCases,
  suitesByRef,
  type CaseWithSuite,
  type FlakyRow,
  type SuiteRow,
} from './history-reads';

/* ─── exit codes ─── */

const EXIT_OK = 0;
/** The report printed, minus a section it could not read. */
const EXIT_INCOMPLETE = 1;
const EXIT_USAGE = 2;

/**
 * The spelling every usage line uses, not derived from `process.argv[1]`.
 *
 * `npm run eval:history`, `tsx src/agent/evals/history.ts` and a bundled
 * `node dist/history.js` would each make the same hint print a different sentence,
 * and a hint that is only correct for the way you happened to start the process is
 * worse than one spelling everybody can read past. (Same reasoning as `INVOKE` in
 * `src/cli.ts`.)
 */
const INVOKE = 'npx tsx --env-file=.env src/agent/evals/history.ts';
/** Spelled the way `run.ts` spells itself, so the two files' hints agree. */
const RUNNER = 'npx tsx --env-file=.env src/agent/evals/run.ts';

/* ─── output ─── */

/**
 * A write that throws must not lose the rest of the report.
 *
 * `history.ts | head -20` closes the pipe while this is still writing, and an EPIPE
 * from stdout would otherwise take the process down — the same guard `src/cli.ts`
 * uses, for the same reason. Piping into `head` is one of the likelier ways to read
 * a long window.
 */
function write(stream: NodeJS.WriteStream, text: string): void {
  try {
    stream.write(text);
  } catch {
    /* the reader has gone; there is nothing useful to do about it here */
  }
}

/** The report. */
const out = (line = ''): void => write(process.stdout, `${line}\n`);
/** Refusals and the reason a section is missing. */
const note = (line = ''): void => write(process.stderr, `${line}\n`);

/**
 * No colour, deliberately.
 *
 * The marks are words — `pass`, `FAIL`, `skip` — so the report keeps its meaning
 * when it is redirected to a file or piped through `grep FAIL`, which is how a
 * history gets read. A second copy of the CLI's styler would also be a second thing
 * to keep in step with it for no gain here.
 */
const MARK_PASS = 'pass';
const MARK_FAIL = 'FAIL';
const MARK_SKIP = 'skip';

const plural = (n: number): string => (n === 1 ? '' : 's');

/**
 * One line, flattened and marked when cut.
 *
 * Flattened because a `detail` with newlines in it breaks every alignment below;
 * marked because a truncated assertion read as the whole one is its own kind of
 * wrong report — "expected one of $33,300.00, $33,300" cut at the comma reads as an
 * assertion that only ever wanted the first.
 */
function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * An instant, in UTC, marked as such.
 *
 * UTC rather than the reader's zone: two suites are compared by their stamps, and a
 * history that renders differently on the laptop and on the box that ran it invites
 * exactly the wrong conclusion from a pair of timestamps nine minutes apart. The
 * `Z` is there so nobody reads 22:20 as their own evening.
 *
 * Accepts a string as well as a `Date`. TIMESTAMPTZ arrives as a `Date` from this
 * driver and DATE arrives as a string (`src/db.ts`), and a formatter that assumed
 * one of them throws on the other — this is two lines of tolerance against a change
 * in a type parser somewhere else.
 */
function when(at: Date | string | null): string {
  if (at === null) return '—';
  const d = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(d.getTime())) return String(at);
  return `${d.toISOString().slice(0, 16).replace('T', ' ')}Z`;
}

/** How long a suite took, or that it never finished. */
function took(from: Date | string, to: Date | string | null): string {
  if (to === null) return 'unfinished';
  const start = (from instanceof Date ? from : new Date(from)).getTime();
  const end = (to instanceof Date ? to : new Date(to)).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return '?';
  const s = Math.round((end - start) / 1000);
  if (s < 0) return '?';
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
}

/** Eight characters, the way a short sha is read. Enough to pass back to `--suite`. */
const shortId = (id: string): string => id.slice(0, 8);

/* ─── arguments ─── */

type View =
  | { kind: 'overview'; window: number }
  | { kind: 'case'; caseId: string; window: number }
  | { kind: 'suite'; ref: string }
  | { kind: 'help' };

const USAGE = `usage: ${INVOKE} [--suites=N]
       ${INVOKE} --case=<case-id> [--suites=N]
       ${INVOKE} --suite=<uuid-or-prefix>`;

const HELP = `${USAGE}

Read back what the eval suite recorded about itself. This only reads; the suite is
run by \`${RUNNER}\`.

  (no flags)     recent suites — when, commit, model, passed/failed, how long — and
                 then case stability across the window: which cases have produced
                 BOTH a pass and a failure, which are failing every time, and which
                 have never run because the data they need is absent
  --case=<id>    every outcome of one case, newest first, with the failed assertions
                 in the runner's words, the question as it was actually asked (it
                 differs between runs, because the roles bind to different records),
                 and the agent_runs id so the trace can be read
  --suite=<id>   one suite in full, including the role binding it ran against. A
                 full uuid or any unambiguous prefix of ${MIN_REF} characters or more
  --suites=N     widen the window. Counted in suites, not days: a window in time
                 says nothing when nobody ran the suite for a fortnight (default
                 ${DEFAULT_WINDOW}, max ${MAX_WINDOW})
  --help         this

Environment (nothing here loads .env by itself — pass --env-file to the runner):

  DATABASE_URL   where the recorded suites are
  USER_ID        the operator uuid the agent tables are scoped by

Exit codes: 0 printed. 1 a section could not be read — the stability query failed.
2 bad invocation or environment; nothing was read. A window full of failures still
exits 0: this is a report, and the gate is the runner's own exit code.`;

/** Split at the FIRST `=`, so a value containing one is not silently truncated. */
function flagValue(arg: string): { name: string; value: string } {
  const at = arg.indexOf('=');
  return at === -1
    ? { name: arg.slice(2), value: '' }
    : { name: arg.slice(2, at), value: arg.slice(at + 1) };
}

/**
 * Parse, and refuse rather than guess.
 *
 * Two refusals the private version did not make, both of which printed a confident
 * report about the wrong thing:
 *
 * A bare argument (`history.ts client-lookup`) was ignored and the default view
 * printed, so a mistyped invocation looked like a case with no history.
 *
 * `--case` and `--suite` together silently preferred the suite. They are different
 * views, and quietly answering the other question is how somebody concludes a case
 * has no history when they never asked about it.
 */
function parse(argv: string[]): View | { error: string } {
  let caseId: string | undefined;
  let suiteRef: string | undefined;
  let window = DEFAULT_WINDOW;
  let sawWindow = false;

  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') return { kind: 'help' };

    if (!arg.startsWith('--')) {
      return {
        error: arg.startsWith('-')
          ? `Unrecognised flag: ${arg}. Known flags: --case, --suite, --suites, --help.`
          : `Unexpected argument "${arg}". This takes flags only — did you mean ` +
            `--case=${arg}?\n${USAGE}`,
      };
    }

    const { name, value } = flagValue(arg);
    switch (name) {
      case 'case':
        // Trimmed, because `--case=" client-lookup"` from a quoted shell variable
        // would otherwise look up an id with a space in it and report no history for
        // a case that has plenty.
        if (!value.trim()) return { error: '--case needs a case id: --case=money-outstanding.' };
        caseId = value.trim();
        break;
      case 'suite':
        if (!value.trim()) return { error: '--suite needs a suite id or a prefix of one.' };
        suiteRef = value.trim();
        break;
      case 'suites': {
        if (!/^\d+$/.test(value)) {
          return {
            error:
              `--suites=${value} is not a whole number. It counts suites, and a window that ` +
              'cannot be parsed would reach Postgres as a broken LIMIT rather than as a typo.',
          };
        }
        const n = Number(value);
        if (n < 1 || n > MAX_WINDOW) {
          return {
            error: `--suites=${value} is out of range: 1 to ${MAX_WINDOW}. A window of 0 reads as ` +
              'an empty history, which is indistinguishable from never having run the suite.',
          };
        }
        window = n;
        sawWindow = true;
        break;
      }
      default:
        return {
          error: `Unrecognised flag: ${arg}. Known flags: --case, --suite, --suites, --help.`,
        };
    }
  }

  if (caseId && suiteRef) {
    return {
      error:
        '--case and --suite are two different views: one case across suites, or one suite ' +
        'across cases. Pick one rather than being shown the other.',
    };
  }

  if (suiteRef) {
    if (sawWindow) {
      return {
        error:
          '--suites widens a window of suites, and --suite asks for exactly one. Nothing would ' +
          'be widened, so the flag would read as having been honoured when it was ignored.',
      };
    }
    if (!looksLikeRef(suiteRef)) {
      return {
        error:
          `--suite=${suiteRef} is not a uuid or a prefix of one (hex and dashes, at least ` +
          `${MIN_REF} characters). The default view prints the first eight characters of every ` +
          'suite id, which is what this flag takes.',
      };
    }
    return { kind: 'suite', ref: suiteRef.toLowerCase() };
  }

  return caseId ? { kind: 'case', caseId, window } : { kind: 'overview', window };
}

/* ─── the environment ─── */

/** Any uuid version, as `src/cli.ts` accepts. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const HOW_TO_SUPPLY =
  'Nothing here loads .env by itself: copy .env.example to .env and pass it to the runner ' +
  `(${INVOKE}).`;

function readEnv(): { userId: string } | { error: string } {
  if (!process.env.DATABASE_URL?.trim()) {
    return {
      error: `DATABASE_URL is not set, so there is no history to read. ${HOW_TO_SUPPLY}`,
    };
  }

  const userId = process.env.USER_ID?.trim();
  if (!userId) {
    return {
      error:
        'USER_ID is not set, and the history is one operator\'s: every suite row is scoped by ' +
        `it. ${HOW_TO_SUPPLY}`,
    };
  }
  if (!UUID.test(userId)) {
    return {
      error:
        `USER_ID is "${userId}", which is not a uuid. agent_eval_suites.user_id is a uuid ` +
        'column, so this would come back as a Postgres syntax error and read like a broken ' +
        'schema rather than a wrong variable.',
    };
  }
  return { userId };
}

/* ─── the default view ─── */

async function overview(userId: string, window: number): Promise<number> {
  const suites = await recentSuites(userId, window);
  if (suites.length === 0) {
    out('');
    out('No eval history for this operator yet.');
    out('');
    out(`  Run the suite:  ${RUNNER}`);
    // The scoping trap, said out loud. A suite recorded under a different USER_ID is
    // indistinguishable from never having run one, and the two have different fixes.
    out(`  Reading as:     USER_ID=${userId}`);
    out('');
    out('  A suite recorded under a different USER_ID reads exactly like no history at all,');
    out('  so check that value before concluding the suite has never run.');
    out('');
    return EXIT_OK;
  }

  out('');
  out(`Eval history — last ${suites.length} suite${plural(suites.length)}, newest first`);
  out('');
  for (const s of suites) {
    const decided = s.passed + s.failed;
    // `0/0` for a suite that recorded nothing reads as "none of its cases passed",
    // which is a claim about the agent rather than about the suite dying early.
    const verdict =
      decided === 0 && s.skipped === 0
        ? 'no outcomes'
        : s.failed > 0
          ? `${s.passed}/${decided} ✗ ${s.failed}`
          : `${s.passed}/${decided}`;
    const skip = s.skipped ? `  ${s.skipped} skipped` : '';
    out(
      `  ${when(s.started_at)}  ${shortId(s.id)}  ${(s.git_sha?.slice(0, 8) ?? '········').padEnd(8)} ` +
        // Wide enough for `provider/model` as `persist.ts` writes it. An id longer
        // than the column pushes the rest of its row right rather than being cut:
        // this is the only place the model appears in the default view.
        `${shortModel(s.model_id).padEnd(28)} ${verdict.padEnd(12)} ` +
        `${took(s.started_at, s.finished_at).padStart(9)}${skip}`
    );

    // `total` counts every case the suite ATTEMPTED and is written when it opens, so
    // a shortfall means the suite did not finish. Worth saying rather than leaving as
    // arithmetic: an unfinished suite otherwise reads as a small suite that passed
    // everything, and its pass count reads as a clean run.
    const accounted = s.passed + s.failed + s.skipped;
    if (s.finished_at === null || accounted !== s.total) {
      const missing = s.total - accounted;
      out(
        `      ! this suite did not finish` +
          (missing > 0
            ? ` — ${missing} of ${s.total} case${plural(s.total)} never recorded an outcome`
            : s.finished_at === null
              ? ' — no finished_at was ever stamped'
              : ` — ${accounted} outcomes recorded against a declared total of ${s.total}`)
      );
    }
  }

  let rows: FlakyRow[];
  try {
    rows = await flakiness(userId, window);
  } catch (err) {
    // The suite list is already printed and is worth keeping. What is missing is the
    // section that answers the question this history exists for, so it is named on
    // stderr and the exit code says the report is incomplete.
    note('');
    note(
      `Could not read stability: ${err instanceof Error ? err.message : String(err)}\n` +
        'The suite list above is complete; the section that says which case has produced both ' +
        'verdicts is missing, and nothing below should be read as "everything is stable".'
    );
    out('');
    return EXIT_INCOMPLETE;
  }

  out('');
  out(`Case stability across ${suites.length} suite${plural(suites.length)}`);
  out('');

  const unstable = rows.filter((r) => r.flaky_since !== null);
  const failing = rows.filter((r) => r.flaky_since === null && r.failures > 0);
  const skipping = rows.filter((r) => r.runs > 0 && r.skips === r.runs);

  // Printed whenever there is one suite, and not only when nothing looked wrong. A
  // single failure in a single suite is a failure, but whether it is a FLAKE is a
  // question one sample cannot answer, and the caveat is what stops the reader
  // deciding it either way.
  if (suites.length < 2) {
    out('  Only one suite is recorded. Stability needs at least two runs to mean anything:');
    out('  nothing below distinguishes a case that always fails from one that failed once.');
    out('');
  }

  if (unstable.length === 0 && failing.length === 0 && suites.length >= 2) {
    out('  Every case that ran gave the same verdict every time.');
  }

  for (const r of unstable) {
    out(
      `  ✗ ${r.case_id.padEnd(46)} ${r.passes} pass  ${r.failures} fail` +
        '   — UNSTABLE, the same case produced both'
    );
    // The window is the only evidence there is, so this is the earliest outcome still
    // inside it and not the moment the flake began. Said plainly, because a date
    // printed beside "unstable since" would be read as the second.
    out(`      earliest outcome still in the window: ${when(r.flaky_since)}`);
  }
  for (const r of failing) {
    out(`  ✗ ${r.case_id.padEnd(46)} failing all ${r.failures} run${plural(r.failures)}`);
  }

  // A case that has skipped every time is a gap in coverage nobody is being told
  // about. It is not a failure, and it is reported where it cannot be read as one.
  if (skipping.length > 0) {
    out('');
    out('Never ran in this window — the data these need is absent');
    out('');
    for (const r of skipping) {
      out(`  · ${r.case_id.padEnd(46)} ${r.skips} skip${plural(r.skips)}, last ${when(r.last_seen)}`);
    }
    out('  Run `npm run db:check`: it names which role could not bind, and why.');
  }

  /**
   * The two coverage gaps `agent_eval_flaky` cannot see, because it can only count
   * rows that exist.
   *
   * A case in the cases file with no row in the window has never been attempted here
   * — added since the last suite, or the suite died before reaching it. A case id in
   * the window that the file no longer has was renamed or removed; its history is
   * frozen, and a rename starts a new one, so a rename looks like a regression to
   * zero coverage unless both lists are printed.
   */
  const recorded = new Set(rows.map((r) => r.case_id));
  const neverRecorded = CASES.filter((c) => !recorded.has(c.id)).map((c) => c.id);
  const knownIds = new Set(CASES.map((c) => c.id));
  const retired = rows.filter((r) => !knownIds.has(r.case_id)).map((r) => r.case_id);

  if (neverRecorded.length > 0) {
    out('');
    out(
      `In the cases file, absent from this window — ${neverRecorded.length} of ${CASES.length} ` +
        `case${plural(CASES.length)} recorded no outcome at all`
    );
    out('');
    for (const id of neverRecorded) out(`  · ${id}`);
    out('  Either no suite has run since they were added, or a suite stopped before them.');
  }

  if (retired.length > 0) {
    out('');
    out('In the history, no longer in the cases file — renamed or removed');
    out('');
    for (const id of retired) out(`  · ${id}`);
    out('  Their history is kept and will not grow. A renamed case starts a new one.');
  }

  out('');
  out(
    `${rows.length} case id${plural(rows.length)} recorded in the window. ` +
      'Detail: --case=<id>. One suite: --suite=<id>.'
  );
  out('');
  return EXIT_OK;
}

/* ─── one case over time ─── */

async function caseHistory(userId: string, caseId: string, window: number): Promise<number> {
  const rows: CaseWithSuite[] = await caseOutcomes(userId, caseId, window);

  if (rows.length === 0) {
    out('');
    out(`No history for "${caseId}" in the last ${window} suite${plural(window)}.`);
    out('');
    // "You typed the wrong id" and "this case has never been recorded" are different
    // findings, and printing the second for the first is the same class of confusion
    // the skip mechanism exists to end. The cases file is right here, so say which.
    if (!CASES.some((c) => c.id === caseId)) {
      const near = CASES.map((c) => c.id).filter(
        (id) => id.includes(caseId) || caseId.includes(id)
      );
      out('  No case with that id is in the cases file either, so this is probably a typo.');
      if (near.length > 0) out(`  Did you mean: ${near.join(', ')}`);
      else out(`  The file has: ${CASES.map((c) => c.id).join(', ')}`);
    } else {
      out('  The case is in the cases file, so it has not run inside this window.');
      out(`  Widen it with --suites=N, or run the suite: ${RUNNER}`);
    }
    out('');
    return EXIT_OK;
  }

  out('');
  out(`${caseId} — ${rows.length} run${plural(rows.length)} in the last ${window} suite${plural(window)}`);

  /**
   * The verdict summary comes from `agent_eval_flaky` rather than from counting the
   * rows already in hand, so "unstable" means here exactly what it means in the
   * default view. Counting them again would put a second copy of the rule — a skip
   * is not a failure — in this file, and two copies of a counting rule is one that
   * will eventually disagree with the schema without either of them erroring.
   */
  let code = EXIT_OK;
  try {
    const mine = (await flakiness(userId, window)).find((r) => r.case_id === caseId);
    if (mine) {
      out('');
      if (mine.flaky_since !== null) {
        out(
          `  UNSTABLE: ${mine.passes} pass, ${mine.failures} fail, ${mine.skips} skip in this ` +
            'window. The same case produced both verdicts.'
        );
        out(`  Earliest outcome still in the window: ${when(mine.flaky_since)}.`);
      } else {
        out(`  ${mine.passes} pass, ${mine.failures} fail, ${mine.skips} skip in this window.`);
      }
    }
  } catch (err) {
    // The per-run list below is the substance of this view and is already read, so
    // the failure is named and printing continues. The exit code still says the
    // report is incomplete: the verdict summary is the one line here that applies the
    // counting rule, and a reader cannot reconstruct it from the rows by eye.
    note(
      `Could not read the stability summary for this case: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    code = EXIT_INCOMPLETE;
  }

  out('');
  for (const r of rows) {
    const mark = r.skipped ? MARK_SKIP : r.passed ? MARK_PASS : MARK_FAIL;
    out(
      `  ${when(r.created_at)}  ${shortId(r.suite_id)}  ${(r.git_sha?.slice(0, 8) ?? '········').padEnd(8)} ` +
        `${mark}${r.duration_ms !== null ? `  ${r.duration_ms}ms` : ''}`
    );
    // The question, because the roles bound to different records on different days
    // and the same case is not the same question twice.
    if (r.question) out(`      asked: ${clip(r.question, 150)}`);
    if (r.note) out(`      ${clip(r.note, 200)}`);
    for (const line of failureLines(r.failures, '      ', 140)) out(line);
    // The trace, on every row and not only on failures: a pass with a suspicious
    // route through the tools is exactly the run somebody wants to open next.
    if (r.agent_run_id) out(`      trace: agent_runs/${r.agent_run_id}`);
  }
  out('');
  return code;
}

/* ─── one suite in full ─── */

/**
 * Resolve a full uuid or a prefix, refusing an ambiguous one with the matches.
 *
 * Same rule as `approve` in the CLI: a prefix is how a human passes back an id they
 * read off a report, and quietly picking one of two matches would show a suite
 * nobody asked for. `parse` has already restricted the ref to hex and dashes, which
 * is what keeps the LIKE pattern from carrying a `%` or `_` that would widen it.
 */
async function resolveSuite(
  userId: string,
  ref: string
): Promise<{ suite: SuiteRow } | { error: string }> {
  const matches = await suitesByRef(userId, ref);

  if (matches.length === 0) {
    return {
      error:
        `No suite whose id starts with ${ref}, for USER_ID=${userId}. The default view lists ` +
        'the suites this operator has recorded; a suite recorded under another USER_ID is not ' +
        'visible here.',
    };
  }
  if (matches.length > 1) {
    const listed = matches
      .map((s) => `  ${shortId(s.id)}  ${when(s.started_at)}  ${s.git_sha?.slice(0, 8) ?? '·'}`)
      .join('\n');
    return {
      error: `${ref} matches ${matches.length} suites. Refusing to pick one:\n${listed}`,
    };
  }
  // Length is exactly one here, both other cases having returned.
  return { suite: matches[0]! };
}

async function suiteDetail(userId: string, ref: string): Promise<number> {
  const found = await resolveSuite(userId, ref);
  if ('error' in found) {
    note(found.error);
    return EXIT_USAGE;
  }
  const s = found.suite;

  const rows = await suiteCases(s.id);

  out('');
  out(`Suite ${s.id}`);
  out(`  ran      ${when(s.started_at)}  (${took(s.started_at, s.finished_at)})`);
  out(`  commit   ${s.git_sha ?? 'unknown'}`);
  // The model id in full here, not shortened. This is the view somebody opens to
  // find out what actually answered, and a trimmed id is not something you can put
  // in a bug report.
  out(`  model    ${s.model_id ?? 'unknown'}`);
  out(
    `  result   ${s.passed} passed, ${s.failed} failed, ${s.skipped} skipped ` +
      `of ${s.total} attempted`
  );

  const accounted = s.passed + s.failed + s.skipped;
  if (s.finished_at === null) {
    out('  !        no finished_at was stamped: this suite crashed or was killed partway.');
  }
  if (accounted !== s.total) {
    out(
      `  !        ${s.total} case${plural(s.total)} attempted, ${accounted} recorded an outcome, ` +
        'so the counts above are not the whole suite.'
    );
  }
  if (rows.length !== accounted) {
    // The suite's own totals and the rows that exist disagreeing is a bookkeeping
    // failure in the runner — a case row that failed to write, or a total stamped
    // from a different count. Named rather than reconciled: reconciling it here would
    // hide it.
    out(
      `  !        outcomes counted by the suite: ${accounted}. Case rows stored: ` +
        `${rows.length}. One of the two writes did not land.`
    );
  }

  // The binding is the other half of the result. Without it, "this passed" does not
  // say what it passed against.
  out('');
  out('  Roles it was asked about');
  for (const line of bindingLines(s.roles)) out(line);

  out('');
  out('  Cases');
  if (rows.length === 0) {
    out('    (none recorded — the suite opened and wrote no case rows)');
  }
  for (const r of rows) {
    const mark = r.skipped ? MARK_SKIP : r.passed ? MARK_PASS : MARK_FAIL;
    out(`    ${mark}  ${r.case_id}${r.duration_ms !== null ? `  (${r.duration_ms}ms)` : ''}`);
    if (r.note) out(`          ${clip(r.note, 200)}`);
    for (const line of failureLines(r.failures, '          ', 120)) out(line);
    // Only where something is worth opening: a full column of trace ids under passing
    // cases buries the two rows somebody came here to read.
    if (!r.passed && !r.skipped && r.agent_run_id) {
      out(`          trace: agent_runs/${r.agent_run_id}`);
    }
  }
  out('');
  return EXIT_OK;
}

/* ─── rendering what was stored ─── */

/**
 * The failed assertions, in the runner's words.
 *
 * `readFailures` does the reading — it is defensive, because `failures` is JSONB and
 * a reader that throws on one malformed row hides every row after it, and the rows
 * after it are the history. This function only decides what a terminal does with
 * what came back: an indent, a clip, and a `?` rather than a `✗` on a shape that was
 * not recognised, so an unfamiliar row cannot be mistaken for an assertion.
 */
function failureLines(raw: unknown, indent: string, max: number): string[] {
  const { failures, unfamiliar } = readFailures(raw);
  if (unfamiliar !== null) {
    return [`${indent}? failures stored in an unfamiliar shape: ${clip(unfamiliar, max)}`];
  }
  return failures.map((f) => `${indent}✗ ${f.check} — ${clip(f.detail, max)}`);
}

/**
 * The stored binding, printed in the order `describeBinding` prints it.
 *
 * The ordering rule and the flattening are in `readBinding`, because both surfaces
 * need them: jsonb does not keep insertion order — it sorts keys by length and then
 * bytewise — so the nine known roles are put back into their documented order and
 * anything else the runner stored follows.
 *
 * Nothing is claimed here about a role that is ABSENT from the stored object, and
 * the sentence saying so is `ABSENT_ROLE_MEANS` rather than a phrasing of this
 * file's own. The same silence explained two ways in two places is how a reader
 * learns that neither explanation was thought about.
 */
function bindingLines(roles: unknown): string[] {
  const binding = readBinding(roles);

  if (binding.kind === 'none') return ['    (no binding recorded)'];
  if (binding.kind === 'unfamiliar') {
    return [`    (the stored binding is not an object: ${clip(binding.json, 200)})`];
  }
  if (binding.kind === 'empty') return ['    (the binding was recorded as empty)'];

  const lines = binding.rows.map((r) => `    ${r.role.padEnd(22)} ${r.value}`);
  if (binding.absent.length > 0) {
    lines.push(
      `    not in the stored binding: ${binding.absent.join(', ')}`,
      `    (${ABSENT_ROLE_MEANS})`
    );
  }
  return lines;
}

/* ─── entry ─── */

async function main(): Promise<number> {
  const view = parse(process.argv.slice(2));
  if ('error' in view) {
    note(view.error);
    return EXIT_USAGE;
  }
  if (view.kind === 'help') {
    out(HELP);
    return EXIT_OK;
  }

  // After parsing, so `--help` works in a directory with no .env in it.
  const env = readEnv();
  if ('error' in env) {
    note(env.error);
    return EXIT_USAGE;
  }

  if (view.kind === 'suite') return suiteDetail(env.userId, view.ref);
  if (view.kind === 'case') return caseHistory(env.userId, view.caseId, view.window);
  return overview(env.userId, view.window);
}

let code = EXIT_INCOMPLETE;
try {
  code = await main();
} catch (err) {
  // Everything below this reports a failure in a sentence: the pool names the
  // variable it wants, the parse names the flag. What reaches here is one of those
  // sentences or a genuine bug, and a stack trace printed for the first kind teaches
  // a reader to ignore stack traces.
  note(err instanceof Error ? err.message : String(err));
  code = EXIT_INCOMPLETE;
} finally {
  // The pool holds an open socket, which keeps the event loop alive: without this
  // the report prints and the process then sits there looking broken. The Supabase
  // original had nothing to release.
  await close();
}

/**
 * The code is set, not forced.
 *
 * `process.exit()` here would abort while the pool is still closing its handles —
 * on Windows that is `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` and an
 * exit code of 127, which replaces every code documented at the top of this file.
 * The same mistake is recorded at the end of `src/cli.ts`.
 */
process.exitCode = code;
