/**
 * The evals surface: what is measured, and which case has produced both a pass and
 * a failure.
 *
 * Three views, and the middle one is the reason the other two exist:
 *
 *   GET /evals                  recent suites, then case stability
 *   GET /evals/case/<case-id>   every outcome of one case, newest first
 *   GET /evals/suite/<id>       one suite in full, including the binding it ran against
 *
 * ── What a green run cannot tell you ──
 *
 * A pass count is not a regression report. A suite that passes seventeen cases today
 * says nothing about whether one of them passed at 22:11 and failed at 22:20 on
 * identical code — which is what actually happened in the private lineage this suite
 * came from, and was noticed only because somebody ran the suite twice in one
 * evening. So stability gets the room here, and it gets the accent, because it is the
 * one section a person could not have read off the runner's own output.
 *
 * The counting rule is not in this file. `agent_eval_flaky()` in
 * `db/003-eval-history.sql` owns it — a SKIP IS NEVER A FAILURE, because a case that
 * ran once and skipped four times is under-fixtured rather than unstable — and this
 * page calls it rather than counting the rows it already has in hand. Two copies of a
 * counting rule is one that will eventually disagree with the schema, and both copies
 * would still print a number while doing it. The five queries are shared with
 * `src/agent/evals/history.ts` through `history-reads.ts` for the same reason; see
 * that file's header for what is shared and what is not.
 *
 * ── What this page will not claim ──
 *
 * With fewer than two suites recorded it says that stability needs at least two runs
 * to mean anything, in the same words the CLI uses. "Every case gave the same verdict
 * every time" read off a single sample is exactly the reassuring, unfounded claim the
 * whole eval suite exists to stop being made, and it would be worst on the first run
 * — when somebody is deciding whether to trust any of this at all.
 *
 * When the stability query fails, the suites that were read are still rendered and
 * the missing section is named, in the accent, saying that nothing on the page may be
 * read as stability. The CLI has an exit code for this (1, the report is incomplete);
 * HTTP has no status that means "the page rendered and a section of it did not", and
 * a 500 would throw away the half that worked — so the sentence on the page is the
 * whole signal, and it is also written to stderr so the process log records it.
 *
 * ── Escaping ──
 *
 * Everything here goes through `escape.ts`. It matters more on this surface than it
 * looks: a case's `question` is generated from a role binding, so it carries client
 * names out of the business tables, and `failures[].detail` is a string the runner
 * built out of the model's answer. A client called `<script>…</script>` reaches this
 * page as a substring of an assertion detail on a site whose other pages have approve
 * buttons.
 */

import { CASES } from '../../agent/evals/cases';
import {
  ABSENT_ROLE_MEANS,
  boundedWindow,
  caseOutcomes,
  DEFAULT_WINDOW,
  flakiness,
  looksLikeRef,
  MIN_REF,
  readBinding,
  readFailures,
  recentSuites,
  shortModel,
  suiteCases,
  suitesByRef,
  type CaseRow,
  type CaseWithSuite,
  type FlakyRow,
  type SuiteRow,
} from '../../agent/evals/history-reads';
import { html, safeUrl, type Html } from '../escape';
import {
  ago,
  clip,
  def,
  defs,
  duration,
  empty,
  figure,
  layout,
  meta,
  shortId,
  utcStamp,
} from '../layout';
// Types only. `server.ts` starts listening when it is loaded, so importing a value
// from it here would start a second server as a side effect of rendering a page.
import type { Ctx, Reply } from '../server';

/* ─── how the suite is produced, spelled once ─── */

/** The spelling the README and package.json use. Every empty state on this surface
 * ends by naming it, because a page that reports an absence and no way to fill it is
 * a dead end. */
const RUNNER = 'npm run eval';

/** Windows a reader can widen to, in suites. Counted in suites rather than days
 * because a window in time says nothing when nobody ran the suite for a fortnight. */
const WINDOWS = [20, 50, 100] as const;

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/* ─── the overview ─── */

export async function evalsPage(ctx: Ctx): Promise<Reply> {
  const window = boundedWindow(ctx.url.searchParams.get('suites'));

  // Not wrapped in a try. A failed read here reaches the 500 page with its message,
  // which is the honest outcome: rendering an empty history instead would be a claim
  // that the suite has never run, and that claim is exactly what a broken query is
  // not entitled to make.
  const suites = await recentSuites(ctx.userId, window);

  if (suites.length === 0) {
    return {
      kind: 'html',
      body: layout({
        surface: 'evals',
        title: 'Evals',
        lede: 'What is measured, and which case has produced both a pass and a failure.',
        body: empty({
          label: 'no eval history',
          what: html`No suite has recorded itself for this operator. Reading as
            <span class="mono">${ctx.userId}</span> — and a suite recorded under a
            different <code>USER_ID</code> reads exactly like no history at all, so
            check that value before concluding the suite has never run.`,
          next: html`Run the suite: <code>${RUNNER}</code>. It writes one row per
            execution and one per case, which is everything this page reads.`,
        }),
      }),
    };
  }

  /**
   * Stability is read separately and its failure is survivable.
   *
   * The suite list above is already in hand and worth keeping. What would be missing
   * is the section this page exists for, so it is named on screen in the accent and
   * on stderr, rather than leaving a page that looks complete.
   */
  let stability: FlakyRow[] | null = null;
  let stabilityError: string | null = null;
  try {
    stability = await flakiness(ctx.userId, window);
  } catch (err) {
    stabilityError = messageOf(err);
    console.error(
      `[web] /evals: the stability query failed: ${stabilityError}. The suite list rendered; ` +
        'the section that says which case produced both verdicts did not.'
    );
  }

  return {
    kind: 'html',
    body: layout({
      surface: 'evals',
      title: 'Evals',
      // Wide: both tables are columns of figures, and 46rem cuts them.
      wide: true,
      lede: 'What is measured, and which case has produced both a pass and a failure.',
      body: html`${suitesSection(suites, window)}${
        stabilityError !== null
          ? stabilityUnreadable(stabilityError)
          : stabilitySection(stability ?? [], suites, window)
      }`,
    }),
  };
}

/* ─── recent suites ─── */

function suitesSection(suites: SuiteRow[], window: number): Html {
  const newest = suites[0];
  const oldest = suites[suites.length - 1];

  return html`
    <h2>Recent suites</h2>
    ${meta([
      `${figure(suites.length)} suite${suites.length === 1 ? '' : 's'}`,
      oldest && newest ? `${utcStamp(oldest.started_at)} to ${utcStamp(newest.started_at)}` : null,
      newest ? `newest ${ago(newest.started_at)}` : null,
    ])}
    <div class="scroll">
      <table>
        <thead>
          <tr>
            <th>started</th>
            <th>suite</th>
            <th>commit</th>
            <th>model</th>
            <th class="num">passed</th>
            <th class="num">failed</th>
            <th class="num">skipped</th>
            <th class="num">took</th>
          </tr>
        </thead>
        <tbody>
          ${suites.map((s) => suiteRow(s))}
        </tbody>
      </table>
    </div>
    ${
      // A full window is the signal that there may be older suites, the same way
      // src/cli.ts reports a truncated desk. There is deliberately no count(*) over
      // the same predicate to print a total nobody acts on.
      suites.length >= window
        ? html`<p class="meta">
            This window is full at ${figure(window)}, so there may be older suites it does
            not include. ${widen('/evals', window)}
          </p>`
        : html`<p class="meta">
            The window holds the last ${figure(window)} suites. ${widen('/evals', window)}
          </p>`
    }
  `;
}

function suiteRow(s: SuiteRow): Html {
  const short = unfinished(s);

  return html`<tr>
      <td>${utcStamp(s.started_at)}</td>
      <td>
        <a class="mono" href="${safeUrl(`/evals/suite/${encodeURIComponent(s.id)}`)}"
          >${shortId(s.id)}</a
        >
      </td>
      <td class="mono">${s.git_sha ? shortId(s.git_sha) : '—'}</td>
      <td class="mono">${shortModel(s.model_id)}</td>
      <td class="num">${figure(s.passed)}</td>
      <!-- The one figure in this table that gets the accent, and only when it is not
           zero: a column of coloured zeros trains the eye to skip the colour. -->
      <td class="num${s.failed > 0 ? ' seal' : ''}">${figure(s.failed)}</td>
      <!-- Never the accent. A skip is a missing fixture, not a failure. -->
      <td class="num">${figure(s.skipped)}</td>
      <td class="num">${took(s.started_at, s.finished_at)}</td>
    </tr>
    ${
      short === null
        ? ''
        : html`<tr>
            <td class="seal" colspan="8">${short}</td>
          </tr>`
    }`;
}

/**
 * Whether a suite finished, and what is missing if it did not.
 *
 * `total` counts every case the suite ATTEMPTED and is written when it opens, so a
 * shortfall means the suite died partway. Worth a sentence rather than left as
 * arithmetic across four columns: an unfinished suite otherwise reads as a small
 * suite that passed everything, and its pass count reads as a clean run.
 *
 * The rule is `total <> passed + failed + skipped`, which `db/003-eval-history.sql`
 * states where the columns are defined. The CLI applies the same rule in its own
 * words; this is the second reader of it, and a null finished_at is checked as well
 * because the schema deliberately provides the signal twice.
 */
function unfinished(s: SuiteRow): string | null {
  const accounted = s.passed + s.failed + s.skipped;
  if (s.finished_at !== null && accounted === s.total) return null;

  const missing = s.total - accounted;
  const why =
    missing > 0
      ? `${missing} of ${s.total} case${s.total === 1 ? '' : 's'} never recorded an outcome`
      : s.finished_at === null
        ? 'no finished_at was ever stamped'
        : `${accounted} outcomes recorded against a declared total of ${s.total}`;
  return `This suite did not finish — ${why}. The figures on this row are not the whole suite.`;
}

/** How long a suite took, or that it never finished. */
function took(from: Date | string, to: Date | string | null): string {
  if (to === null) return 'unfinished';
  const start = new Date(from).getTime();
  const end = new Date(to).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return '—';
  return duration(end - start);
}

/**
 * Links to a wider window, never a narrower one — the CLI's `--suites` widens, and
 * offering to hide suites is not something anybody wants from a history.
 *
 * Returns null rather than an empty fragment when the window is already the widest on
 * offer, so a caller writes the sentence around it or writes no sentence at all. An
 * empty fragment would leave "Widen the window — — or run the suite" on the page.
 */
function widen(path: string, current: number): Html | null {
  const wider = WINDOWS.filter((w) => w > current);
  if (wider.length === 0) return null;

  return html`Widen to
  ${wider.flatMap((w, i) => [
    i === 0 ? '' : ', ',
    html`<a href="${safeUrl(`${path}${path.includes('?') ? '&' : '?'}suites=${w}`)}"
      >${figure(w)}</a
    >`,
  ])}.`;
}

/* ─── case stability, which is the point ─── */

function stabilitySection(rows: FlakyRow[], suites: SuiteRow[], window: number): Html {
  const unstable = rows.filter((r) => r.flaky_since !== null);
  const failing = rows.filter((r) => r.flaky_since === null && r.failures > 0);
  const neverRan = rows.filter((r) => r.runs > 0 && r.skips === r.runs);

  const recorded = new Set(rows.map((r) => r.case_id));
  const knownIds = new Set(CASES.map((c) => c.id));
  const absentFromWindow = CASES.filter((c) => !recorded.has(c.id)).map((c) => c.id);
  const retired = rows.filter((r) => !knownIds.has(r.case_id)).map((r) => r.case_id);

  return html`
    <hr class="rule" />
    <h2>Case stability</h2>
    <p class="lede">
      A case that has both passed and failed on the same code is the most valuable
      thing a suite can say, and no single run can say it.
    </p>
    ${meta([
      `across ${figure(suites.length)} suite${suites.length === 1 ? '' : 's'}`,
      `${figure(rows.length)} case id${rows.length === 1 ? '' : 's'} recorded`,
      'a skip is never counted as a failure',
    ])}
    ${
      // Printed whenever there is one suite, and not only when nothing looked wrong.
      // A single failure in a single suite IS a failure; whether it is a flake is a
      // question one sample cannot answer, and this is what stops a reader deciding
      // it either way.
      suites.length < 2
        ? html`<div class="notice">
            <span class="label">not enough to judge</span>
            <p>
              Only one suite is recorded. Stability needs at least two runs to mean
              anything: nothing below distinguishes a case that always fails from one
              that failed once, and nothing below should be read as saying a case is
              stable.
            </p>
            <p class="meta">Run the suite again — <code>${RUNNER}</code> — and this section starts
              being able to answer the question.</p>
          </div>`
        : unstable.length === 0 && failing.length === 0
          ? html`<p>Every case that ran gave the same verdict every time.</p>`
          : ''
    }
    ${
      rows.length === 0
        ? html`<div class="notice">
            <span class="label">no case rows</span>
            <p>
              These suites recorded no case outcomes at all, so there is nothing to
              compare. A suite row with no case rows under it is a suite that opened
              and then failed before its first case.
            </p>
          </div>`
        : html`<div class="scroll">
            <table>
              <thead>
                <tr>
                  <th>case</th>
                  <th class="num">runs</th>
                  <th class="num">passed</th>
                  <th class="num">failed</th>
                  <th class="num">skipped</th>
                  <th>last outcome</th>
                  <th>state</th>
                </tr>
              </thead>
              <!-- In the order agent_eval_flaky returned them: unstable first, then
                   most-failing. Re-sorting here would mean copying the predicate that
                   function owns into this file. -->
              <tbody>
                ${rows.map((r) => flakyRow(r, window))}
              </tbody>
            </table>
          </div>`
    }
    ${
      neverRan.length > 0
        ? html`<div class="notice">
            <span class="label">never ran in this window</span>
            <p>
              ${figure(neverRan.length)} case${neverRan.length === 1 ? '' : 's'} skipped
              every time. That is a gap in coverage rather than a failure — the data
              those cases need is absent — and it is reported here, where it cannot be
              read as one.
            </p>
            <p class="meta">
              <code>npm run db:check</code> names which role could not bind, and why.
            </p>
          </div>`
        : ''
    }
    ${
      absentFromWindow.length > 0
        ? html`<h3>In the cases file, absent from this window</h3>
            <p class="meta">
              ${figure(absentFromWindow.length)} of ${figure(CASES.length)} cases recorded no
              outcome at all. Either no suite has run since they were added, or a suite
              stopped before reaching them. <code>agent_eval_flaky</code> cannot see these:
              it counts rows, and there are none.
            </p>
            <ul class="rows">
              ${absentFromWindow.map(
                (id) => html`<li>${caseLink(id, window)}${caseTests(id)}</li>`
              )}
            </ul>`
        : ''
    }
    ${
      retired.length > 0
        ? html`<h3>In the history, no longer in the cases file</h3>
            <p class="meta">
              Renamed or removed. Their history is kept and will not grow, and a renamed
              case starts a new one — so a rename looks like a regression to zero
              coverage unless both lists are printed.
            </p>
            <ul class="rows">
              ${retired.map((id) => html`<li>${caseLink(id, window)}</li>`)}
            </ul>`
        : ''
    }
  `;
}

function flakyRow(r: FlakyRow, window: number): Html {
  const isUnstable = r.flaky_since !== null;
  const skippedEvery = r.runs > 0 && r.skips === r.runs;

  // "failing" rather than "failing every run", though it is every run: a row with no
  // passes and no flaky_since has failed every time it was not skipped, and the two
  // columns beside the badge already say how many that was.
  const state = isUnstable
    ? html`<span class="badge is-seal">unstable</span>`
    : r.failures > 0
      ? html`<span class="badge is-seal">failing</span>`
      : // Deliberately not the accent, and deliberately not blank: a case nobody has
        // been told is skipping looks like a case that is fine.
        skippedEvery
        ? html`<span class="badge">never ran</span>`
        : html`<span class="quiet">—</span>`;

  return html`<tr>
      <td>${caseLink(r.case_id, window)}</td>
      <td class="num">${figure(r.runs)}</td>
      <td class="num">${figure(r.passes)}</td>
      <td class="num${r.failures > 0 ? ' seal' : ''}">${figure(r.failures)}</td>
      <td class="num">${figure(r.skips)}</td>
      <td>${utcStamp(r.last_seen)}</td>
      <td>${state}</td>
    </tr>
    ${
      isUnstable
        ? html`<tr>
            <td class="seal" colspan="7">
              The same case produced both verdicts. Earliest outcome still in the window:
              ${utcStamp(r.flaky_since)} — the window is the only evidence there is, so
              that is not the moment the flake began.
            </td>
          </tr>`
        : ''
    }`;
}

/**
 * A case id as a link to its own history.
 *
 * The window is carried across the link when it is not the default, because a reader
 * who widened to 100 suites and then clicked a case did not mean to be shown the last
 * 20. It is omitted when it IS the default, so an ordinary link is an ordinary path
 * rather than a query string nobody chose. `null` for a page that has no window of its
 * own — a suite view is one suite.
 */
function caseLink(caseId: string, window: number | null): Html {
  const query = window === null || window === DEFAULT_WINDOW ? '' : `?suites=${window}`;
  return html`<a
    class="mono"
    href="${safeUrl(`/evals/case/${encodeURIComponent(caseId)}${query}`)}"
    >${caseId}</a
  >`;
}

/** What would be broken if this case failed, from the cases file. Absent for a
 * retired id, and silent rather than apologetic about it. */
function caseTests(caseId: string): Html {
  const known = CASES.find((c) => c.id === caseId);
  return known ? html` <span class="quiet">${known.tests}</span>` : html``;
}

/** The section that could not be read, said where the section would have been. */
function stabilityUnreadable(message: string): Html {
  return html`
    <hr class="rule" />
    <h2>Case stability</h2>
    <div class="notice is-seal">
      <span class="label">this section could not be read</span>
      <p>The stability query failed: <span class="mono">${message}</span></p>
      <p>
        The suite list above is complete. What is missing is the section that says which
        case has produced both a pass and a failure, so nothing on this page should be
        read as "everything is stable".
      </p>
      <p class="meta">
        <code>agent_eval_flaky(uuid, int)</code> is defined in
        <span class="mono">db/003-eval-history.sql</span>, which is applied on the first
        boot of an empty database volume — so a database created before it existed does
        not have the function.
      </p>
    </div>
  `;
}

/* ─── one case over time ─── */

export async function evalCasePage(ctx: Ctx): Promise<Reply> {
  const caseId = (ctx.params.caseId ?? '').trim();
  const window = boundedWindow(ctx.url.searchParams.get('suites'));

  // No query for something that cannot be a case id. The router's pattern makes an
  // empty segment unreachable, but a read whose parameter is the empty string would
  // scan the case index to find nothing, and report the same absence more slowly.
  if (caseId === '') {
    return { kind: 'html', ...noCaseHistory(caseId, false, window) };
  }

  const rows = await caseOutcomes(ctx.userId, caseId, window);
  const known = CASES.find((c) => c.id === caseId);

  if (rows.length === 0) {
    return { kind: 'html', ...noCaseHistory(caseId, known !== undefined, window) };
  }

  /**
   * The verdict summary comes from `agent_eval_flaky` and not from counting the rows
   * already in hand, so "unstable" means here exactly what it means on the overview.
   * Counting them again would put a second copy of the rule — a skip is not a failure
   * — in this file, and two copies of a counting rule is one that will eventually
   * disagree with the schema without either of them erroring.
   */
  let mine: FlakyRow | null = null;
  let summaryError: string | null = null;
  try {
    mine = (await flakiness(ctx.userId, window)).find((r) => r.case_id === caseId) ?? null;
  } catch (err) {
    summaryError = messageOf(err);
    console.error(
      `[web] /evals/case: the stability summary failed: ${summaryError}. The outcomes rendered.`
    );
  }

  const wider = widen(`/evals/case/${encodeURIComponent(caseId)}`, window);

  return {
    kind: 'html',
    body: layout({
      surface: 'evals',
      title: `Case ${caseId}`,
      heading: caseId,
      lede: known
        ? known.tests
        : html`This id is in the recorded history but not in the cases file, so it was
            renamed or removed. What is below is complete and will not grow.`,
      body: html`
        ${meta([
          `${figure(rows.length)} outcome${rows.length === 1 ? '' : 's'}`,
          `in the last ${figure(window)} suites`,
          html`<a href="${safeUrl('/evals')}">all cases</a>`,
        ])}
        ${summaryError !== null
          ? html`<div class="notice is-seal">
              <span class="label">the stability summary could not be read</span>
              <p><span class="mono">${summaryError}</span></p>
              <p>
                The outcomes below are complete. The line that applies the counting rule —
                a skip is never a failure — is missing, and it cannot be reconstructed
                from the rows below by eye.
              </p>
            </div>`
          : mine
            ? caseStability(mine)
            : ''}
        <h2>Every outcome, newest first</h2>
        <p class="lede">
          The question is shown as it was actually asked. It differs between runs, because
          the cases name shapes rather than records and the roles bind to whatever the
          database held that day.
        </p>
        <ul class="rows">
          ${rows.map((r) => caseOutcomeRow(r))}
        </ul>
        ${wider !== null ? html`<p class="meta">${wider}</p>` : ''}
      `,
    }),
  };
}

function caseStability(r: FlakyRow): Html {
  return html`
    <div class="stats">
      <div class="stat"><span class="label">runs</span><b>${figure(r.runs)}</b></div>
      <div class="stat"><span class="label">passed</span><b>${figure(r.passes)}</b></div>
      <div class="stat${r.failures > 0 ? ' is-seal' : ''}">
        <span class="label">failed</span><b>${figure(r.failures)}</b>
      </div>
      <div class="stat">
        <span class="label">skipped</span><b>${figure(r.skips)}</b>
        <span class="of">never a failure</span>
      </div>
    </div>
    ${r.flaky_since !== null
      ? html`<div class="notice is-seal">
          <span class="label">unstable</span>
          <p>
            The same case produced both a pass and a failure inside this window. That is a
            finding about the case, not about one run of it.
          </p>
          <p class="meta">
            Earliest outcome still in the window: ${utcStamp(r.flaky_since)} — the window is
            the only evidence there is, so that is not the moment the flake began.
          </p>
        </div>`
      : ''}
  `;
}

function caseOutcomeRow(r: CaseWithSuite): Html {
  return html`<li>
    ${meta([
      outcomeBadge(r),
      utcStamp(r.created_at),
      html`suite
        <a class="mono" href="${safeUrl(`/evals/suite/${encodeURIComponent(r.suite_id)}`)}"
          >${shortId(r.suite_id)}</a
        >`,
      r.git_sha ? html`commit <span class="mono">${shortId(r.git_sha)}</span>` : null,
      r.duration_ms !== null ? duration(r.duration_ms) : null,
    ])}
    ${r.question
      ? html`<p class="label">asked</p>
          <p>${r.question}</p>`
      : html`<p class="meta">No question was recorded for this outcome.</p>`}
    ${r.note ? html`<p class="meta">${r.note}</p>` : ''}
    ${assertions(r.failures)}
    ${
      // On every row, not only on failures: a pass with a suspicious route through the
      // tools is exactly the run somebody wants to open next.
      r.agent_run_id
        ? html`<p class="meta">
            <a href="${safeUrl(`/runs/${encodeURIComponent(r.agent_run_id)}`)}">trace</a>
            <span class="mono id">${r.agent_run_id}</span>
          </p>`
        : html`<p class="meta">
            No trace: no run id was recorded for this outcome, or the run has since been
            deleted (the reference is <span class="mono">ON DELETE SET NULL</span>, so
            losing a trace does not lose the record that the case ran).
          </p>`
    }
  </li>`;
}

/** Nothing at all for this case, and which of the two reasons it is. */
function noCaseHistory(
  caseId: string,
  known: boolean,
  window: number
): { body: string; status?: number } {
  // "You typed the wrong id" and "this case has never been recorded" are different
  // findings, and showing the second for the first is the confusion the skip mechanism
  // exists to end. The cases file is right here, so say which.
  const near = CASES.map((c) => c.id).filter(
    (id) => caseId !== '' && (id.includes(caseId) || caseId.includes(id))
  );
  const wider = widen(`/evals/case/${encodeURIComponent(caseId)}`, window);

  const body = layout({
    surface: 'evals',
    title: known ? `Case ${caseId}` : 'No such case',
    heading: known ? caseId : 'No such case',
    body: known
      ? empty({
          label: 'no outcomes in this window',
          what: html`This case is in the cases file, so it has not run inside the last
            ${figure(window)} suites.`,
          next: html`${wider !== null ? html`${wider} Or run` : html`Run`} the suite:
            <code>${RUNNER}</code>.`,
        })
      : empty({
          label: 'not a case in this repository',
          what: html`Nothing has been recorded for
            <span class="mono">${clip(caseId, 80)}</span>, and no case with that id is in
            the cases file either, so this is probably a typo.`,
          next:
            near.length > 0
              ? html`Did you mean
                ${near.flatMap((id, i) => [i === 0 ? '' : ', ', caseLink(id, null)])}?`
              : html`The cases file has
                ${CASES.flatMap((c, i) => [i === 0 ? '' : ', ', caseLink(c.id, null)])}.`,
        }),
  });

  // 404 for an id this repository does not have, 200 for one it has that simply has
  // not run: the first is a page that will never exist, the second is a page waiting
  // on a suite.
  return known ? { body } : { body, status: 404 };
}

/* ─── one suite in full ─── */

export async function evalSuitePage(ctx: Ctx): Promise<Reply> {
  const ref = (ctx.params.ref ?? '').trim().toLowerCase();

  if (!looksLikeRef(ref)) {
    return {
      kind: 'html',
      status: 404,
      body: layout({
        surface: 'evals',
        title: 'Not a suite id',
        body: empty({
          label: '404',
          what: html`<span class="mono">${clip(ref, 80)}</span> is not a suite id or a prefix
            of one — hex and dashes, at least ${figure(MIN_REF)} characters. Refused
            without a query: a ref that cannot be a uuid prefix reaches Postgres as a
            pattern rather than as a mistake, and matches whatever it happens to match.`,
          next: html`The suites this operator has recorded are listed on
            <a href="${safeUrl('/evals')}">evals</a>, each linked by the first eight
            characters of its id.`,
        }),
      }),
    };
  }

  const matches = await suitesByRef(ctx.userId, ref);

  if (matches.length === 0) {
    return {
      kind: 'html',
      status: 404,
      body: layout({
        surface: 'evals',
        title: 'No such suite',
        body: empty({
          label: '404',
          what: html`No suite recorded by this operator has an id starting with
            <span class="mono">${clip(ref, 80)}</span>.`,
          next: html`A suite recorded under a different <code>USER_ID</code> is not visible
            here, which reads exactly like a suite that was never run. This process reads
            as <span class="mono">${ctx.userId}</span>.`,
        }),
      }),
    };
  }

  if (matches.length > 1) {
    return {
      kind: 'html',
      // 300 Multiple Choices, which is what this is. No Location header, because
      // choosing one is the thing being refused — the body is the answer.
      status: 300,
      body: layout({
        surface: 'evals',
        title: 'That prefix matches more than one suite',
        heading: 'More than one suite',
        lede: html`<span class="mono">${clip(ref, 40)}</span> matches
          ${figure(matches.length)} suites. Refusing to pick one: resolving a prefix by
          choosing a match would show a suite nobody asked for.`,
        body: html`<ul class="rows">
          ${matches.map(
            (s) => html`<li>
              ${meta([
                html`<a class="mono" href="${safeUrl(`/evals/suite/${encodeURIComponent(s.id)}`)}"
                  >${shortId(s.id)}</a
                >`,
                utcStamp(s.started_at),
                s.git_sha ? html`commit <span class="mono">${shortId(s.git_sha)}</span>` : null,
                shortModel(s.model_id),
              ])}
              <p class="meta"><span class="mono id">${s.id}</span></p>
            </li>`
          )}
        </ul>`,
      }),
    };
  }

  // Exactly one, both other cases having returned.
  const s = matches[0]!;
  const rows = await suiteCases(s.id);

  return {
    kind: 'html',
    body: layout({
      surface: 'evals',
      title: `Suite ${shortId(s.id)}`,
      heading: `Suite ${shortId(s.id)}`,
      wide: true,
      lede: 'One execution of the suite, and the records it was asked about.',
      body: html`
        ${defs([
          def('ran', `${utcStamp(s.started_at)} · ${ago(s.started_at)}`),
          def('took', took(s.started_at, s.finished_at)),
          def('commit', s.git_sha ?? 'not determined', { mono: true }),
          // In full, not shortened. This is the view somebody opens to find out what
          // actually answered, and a trimmed id is not something you can put in a bug
          // report.
          def('model', s.model_id ?? 'not recorded', { mono: true }),
          def(
            'result',
            `${figure(s.passed)} passed, ${figure(s.failed)} failed, ` +
              `${figure(s.skipped)} skipped of ${figure(s.total)} attempted`
          ),
          def('suite id', s.id, { mono: true }),
        ])}
        ${bookkeeping(s, rows.length)}
        <hr class="rule" />
        <h2>Roles it was asked about</h2>
        <p class="lede">
          The binding is the other half of the result. The cases name shapes rather than
          records, so without this, "this passed" does not say what it passed against.
        </p>
        ${binding(s.roles)}
        <hr class="rule" />
        <h2>Cases</h2>
        <p class="meta">In the order the suite ran them.</p>
        ${
          rows.length === 0
            ? html`<div class="notice is-seal">
                <span class="label">none recorded</span>
                <p>
                  The suite opened and wrote no case rows. Every write in the runner is
                  swallowed and logged on purpose — recording must never break the thing it
                  records — so a suite that could not write its cases still ran them.
                </p>
              </div>`
            : html`<ul class="rows">
                ${rows.map((r) => suiteCaseRow(r))}
              </ul>`
        }
      `,
    }),
  };
}

/**
 * The three ways a suite's own bookkeeping can disagree with itself.
 *
 * Named rather than reconciled. Reconciling them here would hide a write that did not
 * land, and the whole reason `total` is stamped when the suite opens is so that this
 * can be seen at all.
 */
function bookkeeping(s: SuiteRow, storedRows: number): Html {
  const accounted = s.passed + s.failed + s.skipped;
  const problems: string[] = [];

  if (s.finished_at === null) {
    problems.push('No finished_at was stamped: this suite crashed or was killed partway.');
  } else if (new Date(s.finished_at).getTime() < new Date(s.started_at).getTime()) {
    // Both stamps are the DATABASE's now(), so one of them cannot be right — and the
    // duration column shows an em-dash rather than a negative, which on its own reads
    // as a duration that was never recorded.
    problems.push(
      'finished_at is before started_at, so the two stamps cannot both be right and the ' +
        'duration above is not shown.'
    );
  }
  if (accounted !== s.total) {
    problems.push(
      `${s.total} case${s.total === 1 ? '' : 's'} attempted, ${accounted} recorded an ` +
        'outcome, so the counts above are not the whole suite.'
    );
  }
  if (storedRows !== accounted) {
    problems.push(
      `Outcomes counted by the suite: ${accounted}. Case rows stored: ${storedRows}. ` +
        'One of the two writes did not land.'
    );
  }

  if (problems.length === 0) return html``;

  return html`<div class="notice is-seal">
    <span class="label">this suite does not add up</span>
    ${problems.map((p) => html`<p>${p}</p>`)}
  </div>`;
}

/* ─── the binding, as it was stored ─── */

function binding(roles: unknown): Html {
  const stored = readBinding(roles);

  if (stored.kind === 'none') {
    return html`<div class="notice is-seal">
      <span class="label">no binding recorded</span>
      <p>
        The column is <span class="mono">NOT NULL DEFAULT '{}'::jsonb</span>, so a null
        here was not written by the runner. Nothing on this page says what these cases
        were asked about.
      </p>
    </div>`;
  }

  if (stored.kind === 'unfamiliar') {
    return html`<div class="notice is-seal">
      <span class="label">the stored binding is not an object</span>
      <p>Shown as it is stored, rather than read as a binding it is not:</p>
      <pre>${clip(stored.json, 2_000)}</pre>
    </div>`;
  }

  if (stored.kind === 'empty') {
    return html`<div class="notice is-seal">
      <span class="label">the binding was recorded as empty</span>
      <p>
        The runner stored <span class="mono">{}</span>. Nothing bound, so every case that
        declares a role would have skipped — which is a fixture problem and not a
        failure.
      </p>
    </div>`;
  }

  return html`
    <div class="scroll">
      <table>
        <thead>
          <tr>
            <th>role</th>
            <th>bound to</th>
          </tr>
        </thead>
        <!-- In the documented role order, then anything else the runner stored. jsonb
             does not keep insertion order — it sorts keys by length and then bytewise —
             so reading the object out as it arrives puts the roles in an order nobody
             chose. -->
        <tbody>
          ${stored.rows.map(
            (r) => html`<tr>
              <td class="mono">${r.role}</td>
              <td class="mono">${r.value}</td>
            </tr>`
          )}
        </tbody>
      </table>
    </div>
    ${
      stored.absent.length > 0
        ? // Not the accent. This is an absence the page refuses to interpret, not a
          // problem it has found.
          html`<div class="notice">
            <span class="label">not in the stored binding</span>
            <p class="mono">${stored.absent.join(', ')}</p>
            <p class="meta">${ABSENT_ROLE_MEANS}.</p>
          </div>`
        : ''
    }
  `;
}

/* ─── one case row, on a suite ─── */

function suiteCaseRow(r: CaseRow): Html {
  return html`<li>
    ${meta([
      outcomeBadge(r),
      caseLink(r.case_id, null),
      r.duration_ms !== null ? duration(r.duration_ms) : null,
    ])}
    ${r.note ? html`<p class="meta">${r.note}</p>` : ''}
    ${assertions(r.failures)}
    ${
      // Only where something is worth opening. A trace link under every passing case
      // buries the two rows somebody came here to read; the case's own view has the
      // trace of every outcome, including the passes.
      !r.passed && !r.skipped && r.agent_run_id
        ? html`<p class="meta">
            <a href="${safeUrl(`/runs/${encodeURIComponent(r.agent_run_id)}`)}">trace</a>
            <span class="mono id">${r.agent_run_id}</span>
          </p>`
        : ''
    }
  </li>`;
}

/**
 * The outcome as one word.
 *
 * A failure gets the accent; a pass and a skip get the same plain badge, and that is
 * deliberate. There is no success colour in this design — a green tick beside every
 * passing case trains the eye to skip the colour, and then it is not there on the row
 * where it mattered.
 */
function outcomeBadge(r: { passed: boolean; skipped: boolean }): Html {
  if (r.skipped) return html`<span class="badge">skipped</span>`;
  if (r.passed) return html`<span class="badge">passed</span>`;
  return html`<span class="badge is-seal">failed</span>`;
}

/**
 * The failed assertions, in the runner's own words.
 *
 * Not summarised and not counted: a count tells you something regressed, and this
 * tells you what. The shape is read by `readFailures`, which tolerates a row it does
 * not recognise — because a renderer that throws on one malformed row hides every row
 * after it, and the rows after it are the history.
 */
function assertions(raw: unknown): Html {
  const { failures, unfamiliar } = readFailures(raw);

  if (unfamiliar !== null) {
    return html`<div class="notice">
      <span class="label">failures stored in an unfamiliar shape</span>
      <p>
        Shown as stored rather than read as assertions. The column is written by the
        runner as <span class="mono">[{ check, detail }]</span>, so this row was written
        by something else.
      </p>
      <pre>${clip(unfamiliar, 2_000)}</pre>
    </div>`;
  }

  if (failures.length === 0) return html``;

  return html`<p class="label">
      failed assertion${failures.length === 1 ? '' : 's'}
    </p>
    <ul class="trace">
      ${failures.map(
        (f) => html`<li>
          <div class="head">
            <span class="n failed" aria-hidden="true">✗</span>
            <span class="mono failed">${f.check}</span>
          </div>
          <pre>${f.detail}</pre>
        </li>`
      )}
    </ul>`;
}
