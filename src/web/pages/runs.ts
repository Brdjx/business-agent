/**
 * The runs surface: what the agent has actually done, what it cost, and one
 * run in full.
 *
 * Three handlers, mounted by `server.ts`:
 *
 *   GET  /runs                 the 30-day figures, the filters, the history
 *   GET  /runs/<id>            one run, with THE TRACE as the centrepiece
 *   POST /runs/<id>/verdict    mark it good or wrong, with one line saying why
 *
 * ── Why a trace view is the point of this page ──
 *
 * Every run since the first has written a trace and nothing has ever read one
 * back. An agent is non-deterministic by construction, so "is it better than it
 * was" is not a question anybody can answer from an answer — it is answered by
 * looking at what the thing actually did, repeatedly: which tools it reached
 * for, which of them failed, how often it hit a wall, where the time went.
 *
 * The single most useful thing in the private original's trace view is the
 * proportional bar on each step. A column of `284ms 1240ms 12088ms 310ms`
 * requires arithmetic before it says anything; the same figures drawn to scale
 * say "that one" from across the room. So each step carries a rule the length of
 * its own duration, and the scale is stated above the list — a bar without its
 * scale is a picture rather than a measurement.
 *
 * ── Why the verdict is a form on this page ──
 *
 * `evals/` tests the failures somebody imagined. The failures worth testing are
 * the ones that already happened, and those exist only here, in the runs. A run
 * marked wrong with one sentence saying why is the raw material for a case
 * nobody could have invented in advance. Two values and a note, deliberately: a
 * five-point scale invites arguing with yourself about a three versus a four,
 * and then nothing gets judged at all.
 *
 * It is also the one form in this UI that changes nothing about the business,
 * and it says so. `.btn.is-seal` is reserved for a button that acts on the
 * records — approve — so neither verdict button wears it.
 *
 * ── Eval runs, said out loud ──
 *
 * `listRuns` and `runHealth` exclude `kind = 'eval'`, and `only: 'eval'`
 * excludes everything else. That exclusion is stated on the page rather than
 * left in the SQL: one `npm run eval` writes seventeen synthetic runs, which is
 * more than an operator produces in a week, and a figure that silently included
 * them would be a claim about the test suite wearing the clothes of a claim
 * about the business.
 *
 * ── What this page will not do ──
 *
 * Nothing here is escaped by hand. The question, the answer, every tool
 * argument and every evidence label go through `html` from `escape.ts`: the
 * answer and the arguments were written by a model that had just read a
 * database somebody else fills in, and the trace is a JSONB column whose shape
 * nothing enforces at read time. So the trace is also read defensively — a
 * renderer that throws on one malformed step takes the whole page with it, and
 * the page is how anybody would find out the step is malformed.
 */

import { html, safeUrl, unsafeHtml, type Html } from '../escape';
import {
  ago,
  clip,
  def,
  defs,
  duration,
  empty,
  evidenceList,
  figure,
  layout,
  meta,
  shortId,
  utcStamp,
} from '../layout';
import {
  getRun,
  isRunFilter,
  isRunId,
  listRuns,
  RUN_FILTERS,
  runHealth,
  setVerdict,
  toolStats,
  type RunDetail,
  type RunFilter,
  type RunHealth,
  type RunSummary,
  type ToolStat,
  type Verdict,
} from '../../agent/runs';
// Types only. `server.ts` starts listening when it is loaded, so importing a
// VALUE from it here would start a second server as a side effect of rendering a
// page. `import type` is erased entirely, which is what makes the seam safe.
import type { Ctx, Reply } from '../server';

/* ─── the window, and the page size ─── */

/**
 * The window every figure at the top describes.
 *
 * Fixed rather than taken from the query string. `runHealth` will accept and
 * clamp a `days`, but a page whose figures move depending on a parameter in the
 * URL invites two people quoting different numbers at each other from the same
 * screen. Thirty days is what the CLI's own history commands use.
 */
const WINDOW_DAYS = 30;

/**
 * How many runs one page shows.
 *
 * Held here as well as being `listRuns`'s default because the page needs the
 * number for its own arithmetic: a full page is the only signal that there is
 * another one. `listRuns` deliberately returns no total — a `count(*)` over the
 * same predicate would double the work of every render to print a figure nobody
 * acts on — so "there may be more" is inferred from `rows.length === PAGE`, the
 * same way `src/cli.ts` reports a truncated desk.
 */
const PAGE = 30;

/**
 * The furthest a page may skip, matching the bound inside `listRuns`.
 *
 * Duplicated on purpose rather than exported from there: this side needs the
 * clamped number to build its own prev/next links, and a link built from an
 * unclamped offset would point at a page the query refuses to fetch.
 */
const MAX_OFFSET = 100_000;

/* ─── the filters ─── */

/**
 * What each filter is called on screen, and what it means.
 *
 * A `Record<RunFilter, …>` rather than a list of its own, so that a filter added
 * to `RUN_FILTERS` in `src/agent/runs.ts` fails to typecheck here until it has a
 * label and a sentence. The alternative is a fifth filter that exists in the SQL
 * and never appears in the UI, which is the quiet half of a feature.
 */
const VIEWS: Record<RunFilter, { label: string; empty: { what: string; next: string } }> = {
  walled: {
    label: 'hit a wall',
    empty: {
      what:
        'No run in this history stopped early. Every one of them reached an answer rather than ' +
        'running out of budget.',
      next:
        'A run that exhausts its steps, its tokens or its wall clock — or that somebody ' +
        'interrupts — lands here with the name of the wall it hit and whatever it had ' +
        'established by then.',
    },
  },
  wrong: {
    label: 'marked wrong',
    empty: {
      what:
        'No run has been marked wrong. That is not the same as every run having been right: ' +
        'most runs are never judged at all, and an unjudged run is counted as neither.',
      next:
        'Open a run and mark it wrong with one line saying why. That line is what an eval case ' +
        'gets written from, and it describes a failure nobody had to imagine.',
    },
  },
  unjudged: {
    label: 'not yet looked at',
    empty: {
      what: 'Every run in this window has a verdict on it.',
      next: 'The next run arrives here, because a run is unjudged until somebody says otherwise.',
    },
  },
  eval: {
    label: 'the eval suite',
    empty: {
      what: 'The suite has recorded no runs against this database.',
      next:
        '`npm run eval` records one run per case — seventeen of them — and every one is excluded ' +
        'from the figures above and from the rest of this history.',
    },
  },
};

/** The unfiltered view, which is not one of the four. */
const EVERYTHING = {
  label: 'everything',
  empty: {
    what:
      'The agent has not recorded a run in this window. This is an answer rather than a ' +
      'silence: a failed read raises and shows the error, so an empty history means the query ' +
      'ran and found nothing.',
    next:
      'Ask something on the ask surface. Every run records its question, its answer, the rows ' +
      'it rests on and each step it took, unless it was run with --no-record.',
  },
};

/**
 * An href, checked and escaped exactly once.
 *
 * `safeUrl` whitelists the shape — a root-relative path, a fragment, or `#` —
 * AND escapes what it returns, because it is an attribute value. Which means
 * interpolating its result through `html` escapes it a second time: this page's
 * older/newer links carry two query parameters, and
 * `/runs?only=walled&offset=60` came back as `…&amp;amp;offset=60`, a link to a
 * parameter nothing reads. It was found by a test asserting the link, which is
 * the only place it would have been found — the double entity is invisible on
 * screen and the page it leads to looks like page one.
 *
 * So the value is handed over as markup, with the reason stated the way
 * `unsafeHtml` requires. The claim being made is checkable in one line: `safeUrl`
 * has already replaced all five characters, so this cannot close the attribute it
 * sits in, and it has already refused anything that could name another origin.
 *
 * `layout.ts` has the same pattern in its nav and is correct today only because
 * none of the four surface paths contains an ampersand.
 */
const href = (path: string): Html =>
  unsafeHtml(safeUrl(path), 'safeUrl already escaped this; html would escape the ampersand twice');

/** A link back to this page with the filter and the offset it should carry.
 * Built with URLSearchParams so a value can never turn into markup, and handed to
 * `href` above at the point it becomes an attribute. */
function listHref(only: RunFilter | null, offset = 0): string {
  const query = new URLSearchParams();
  if (only !== null) query.set('only', only);
  if (offset > 0) query.set('offset', String(offset));
  const rest = query.toString();
  return rest === '' ? '/runs' : `/runs?${rest}`;
}

/**
 * An offset from the query string.
 *
 * `Number('abc')` is NaN and NaN clamps to NaN, so a typo in a URL would
 * otherwise become an arithmetic error in a prev/next link. Absent is 0, which
 * is what somebody typing `?offset=` meant.
 */
function offsetFrom(raw: string | null): number {
  const n = raw === null || raw.trim() === '' ? 0 : Number(raw);
  if (!Number.isFinite(n)) return 0;
  return Math.min(Math.max(Math.trunc(n), 0), MAX_OFFSET);
}

/* ─── /runs ─── */

export async function runsPage(ctx: Ctx): Promise<Reply> {
  const raw = ctx.url.searchParams.get('only');
  const asked = raw === null || raw.trim() === '' ? null : raw.trim();

  // Refused here rather than passed to `listRuns`, which would throw and land on
  // the 500 page. A mistyped filter is not a server failure, and "no runs match"
  // would be worse still: an empty list reads as a claim that the agent has
  // never run.
  if (asked !== null && !isRunFilter(asked)) {
    return {
      kind: 'html',
      status: 400,
      body: layout({
        surface: 'runs',
        title: 'Runs',
        lede: 'That is not one of the filters, so nothing was queried.',
        body: empty({
          label: 'no such filter',
          what: html`<code>only=${clip(asked, 40)}</code> is not a filter this history has. The
            ones it has are ${RUN_FILTERS.join(', ')}, or none of them for everything a person
            and the watch produced.`,
          next: html`<a href="${href('/runs')}">Start from everything</a> and narrow from the
            row of filters at the top.`,
        }),
      }),
    };
  }

  const only: RunFilter | null = asked;
  const offset = offsetFrom(ctx.url.searchParams.get('offset'));

  // The aggregates are allowed to fail without taking the history with them, and
  // the list is not.
  //
  // Two different jobs. A missing list IS the page, and `listRuns` raises rather
  // than returning `[]` precisely so that a broken query cannot make the silent
  // claim that nothing has happened — so it propagates to the 500 page, message
  // and all. The figures are a summary of the same rows: if the CTE or a
  // percentile fails, saying so above an intact history is strictly better than
  // a 500 that hides the history, and better than a zero, because "no runs in
  // thirty days" and "the aggregate query failed" are different facts.
  const failed = (err: unknown): { error: string } => ({
    error: err instanceof Error ? err.message : String(err),
  });
  const [rows, health, tools] = await Promise.all([
    listRuns(ctx.userId, { limit: PAGE, offset, only }),
    runHealth(ctx.userId, WINDOW_DAYS).catch(failed),
    toolStats(ctx.userId, WINDOW_DAYS).catch(failed),
  ]);

  const view = only === null ? EVERYTHING : VIEWS[only];

  return {
    kind: 'html',
    body: layout({
      surface: 'runs',
      title: 'Runs',
      wide: true,
      lede: 'What the agent has actually done, and what it cost.',
      body: html`${'error' in health ? aggregateFailed(health.error) : healthBlock(health)}
        ${filters(only)}
        ${only === 'eval' ? evalNotice() : ''}
        ${
          rows.length === 0
            ? empty({ label: 'no runs here', what: view.empty.what, next: view.empty.next })
            : html`${historyTable(rows)}${paging(only, offset, rows.length)}`
        }
        ${toolSection(tools)}`,
    }),
  };
}

/* ─── the figures ─── */

function healthBlock(h: RunHealth): Html {
  // A rate rather than only a count, because 12 failures means nothing without
  // the calls under it — and "no calls" is said in words rather than as 0%,
  // which would read as a perfect record.
  const failRate =
    h.tool_calls > 0 ? `${((h.tool_failures / h.tool_calls) * 100).toFixed(1)}% of them` : 'no calls made';

  return html`<section>
    <p class="label">the last ${h.days} days, excluding eval runs</p>
    <div class="stats">
      ${stat('runs', figure(h.runs), `${figure(h.answered)} reached an answer`)}
      ${stat('hit a wall', figure(h.walled), `of ${figure(h.runs)}`, { seal: h.walled > 0 })}
      ${stat('median', h.p50_ms === null ? '—' : duration(h.p50_ms), 'per run, end to end')}
      ${stat('p95', h.p95_ms === null ? '—' : duration(h.p95_ms), 'the slow tail')}
      ${stat('tool calls', figure(h.tool_calls), `over ${figure(h.runs)} run(s)`)}
      ${stat('tool failures', figure(h.tool_failures), failRate, { seal: h.tool_failures > 0 })}
      ${stat('tokens', figure(h.total_tokens), 'input and output')}
      ${stat('writes allowed', figure(h.with_writes), 'should be none', {
        seal: h.with_writes > 0,
      })}
      ${stat('marked wrong', figure(h.wrong), `of ${figure(h.judged)} judged`, {
        seal: h.wrong > 0,
      })}
    </div>
    <p class="meta">
      Eval runs are excluded from every figure above and from the list below. One
      <code>npm run eval</code> records seventeen synthetic runs, which is more than an operator
      produces in a week: counted in, these would be figures about the test suite wearing the
      clothes of figures about the business. They are under
      <a href="${href(listHref('eval'))}">the eval suite</a>, and asking for that kind
      excludes every other.
    </p>
    <p class="meta">
      <b>writes allowed</b> should stay at none. Nothing in this repository runs the loop with
      writes on: a write tool in an ordinary run returns what it would do and does nothing, and
      <code>decideProposal</code> applies one stored call after a person approves it without
      recording a run of its own. A figure above zero here is worth chasing down.
    </p>
    <p class="meta">
      ${figure(h.judged)} run(s) have a verdict. An unjudged run is counted as neither right nor
      wrong, which is why <b>marked wrong</b> is reported against the judged count and not
      against the total.
    </p>
  </section>`;
}

function stat(label: string, value: unknown, of: string, opts: { seal?: boolean } = {}): Html {
  return html`<div class="stat${opts.seal === true ? ' is-seal' : ''}">
    <span class="label">${label}</span>
    <b>${value}</b>
    <span class="of">${of}</span>
  </div>`;
}

/**
 * The figures could not be read, said in place of them.
 *
 * Never a zero. A page that prints 0 runs because a percentile threw has told
 * the reader something false about the business, and this is the one screen
 * whose whole job is to be checkable.
 */
function aggregateFailed(message: string): Html {
  return html`<div class="notice is-seal">
    <span class="label">the figures for the last ${WINDOW_DAYS} days could not be read</span>
    <p>${message}</p>
    <p>
      No figure is shown rather than a zero: "no runs in ${WINDOW_DAYS} days" and "the aggregate
      query failed" are different facts, and only one of them is about the business. The history
      below is a separate query and is unaffected.
    </p>
  </div>`;
}

/**
 * Per tool, over the same window. The tool called two hundred times is the one
 * whose failure rate is worth an afternoon, which is why this arrives most-used
 * first — and a tool that fails often is usually a tool whose description is
 * wrong rather than a model that is stupid.
 *
 * A failed read is reported rather than rendered as an absent section. The two
 * queries behind the figures on this page fail independently, and a section that
 * quietly disappears is indistinguishable from a window in which no tool was
 * ever called.
 */
function toolSection(tools: ToolStat[] | { error: string }): Html {
  if ('error' in tools) {
    return html`<div class="notice is-seal">
      <span class="label">the per-tool figures could not be read</span>
      <p>${tools.error}</p>
      <p>Said rather than left as a missing section, which would read as a window in which no
        tool was ever called.</p>
    </div>`;
  }

  if (tools.length === 0) return html``;

  return html`<section>
    <h2>Per tool</h2>
    <p class="meta">
      The same ${WINDOW_DAYS} days and the same exclusion, most-used first. A refused argument
      comes back as a failed tool result rather than as a thrown error, so a failure here is
      often the model being corrected by a validator.
    </p>
    <div class="scroll">
      <table>
        <thead>
          <tr>
            <th>tool</th>
            <th class="num">calls</th>
            <th class="num">failed</th>
            <th class="num">median</th>
            <th class="num">slowest</th>
          </tr>
        </thead>
        <tbody>
          ${tools.map(
            (t) => html`<tr>
              <td><span class="mono">${t.tool_name}</span></td>
              <td class="num">${figure(t.calls)}</td>
              <td class="num">
                ${t.failures > 0 ? html`<span class="seal">${figure(t.failures)}</span>` : '0'}
              </td>
              <td class="num">${t.p50_ms === null ? '—' : duration(t.p50_ms)}</td>
              <td class="num">${t.max_ms === null ? '—' : duration(t.max_ms)}</td>
            </tr>`
          )}
        </tbody>
      </table>
    </div>
  </section>`;
}

/* ─── the filters, and what the eval view does not change ─── */

function filters(active: RunFilter | null): Html {
  const item = (only: RunFilter | null, label: string): Html => {
    const to = href(listHref(only));
    // The current view is a bordered control and the rest are quiet links, which
    // is the only distinction the stylesheet already has for this. aria-current
    // is on the same element, so what is styled and what is announced are the
    // same fact.
    return only === active
      ? html`<a class="btn" href="${to}" aria-current="page">${label}</a>`
      : html`<a class="btn is-quiet" href="${to}">${label}</a>`;
  };

  return html`<div class="rule"></div>
    <p class="label">show</p>
    <div class="actions">
      ${item(null, EVERYTHING.label)}${RUN_FILTERS.map((only) => item(only, VIEWS[only].label))}
    </div>`;
}

function evalNotice(): Html {
  return html`<div class="notice">
    <span class="label">the figures above are unchanged</span>
    <p>
      They exclude eval runs whatever this list is filtered to, so they still describe real work
      and count none of the rows below. This list is the suite's runs and nothing else: asking
      for a kind excludes the rest, rather than merely letting it through.
    </p>
    <p>
      A case that has both passed and failed is the question worth asking of these, and it is not
      one a single run can answer — <a href="${href('/evals')}">the evals surface</a> is where
      per-case stability lives.
    </p>
  </div>`;
}

/* ─── the history ─── */

function historyTable(rows: RunSummary[]): Html {
  return html`<div class="scroll">
    <table>
      <caption class="sr-only">
        Runs, newest first: the run id, when it was asked, the question and the start of its
        answer, how it stopped, which tools it called, and what it cost.
      </caption>
      <thead>
        <tr>
          <th>run</th>
          <th>asked</th>
          <th>question</th>
          <th>stopped</th>
          <th>tools</th>
          <th class="num">steps</th>
          <th class="num">evidence</th>
          <th class="num">tokens</th>
          <th class="num">time</th>
          <th>verdict</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map(historyRow)}
      </tbody>
    </table>
  </div>`;
}

function historyRow(r: RunSummary): Html {
  const walled = r.stop_reason !== 'answered';
  // Defensive because it comes from `array_agg` over a JSONB column: the
  // coalesce in the query should make it an array always, and a renderer that
  // assumes so is one schema surprise away from taking the page down.
  const tools = Array.isArray(r.tools) ? r.tools : [];
  const preview = clip(r.answer_preview, 120);

  return html`<tr>
    <td>
      <a class="mono" href="${href(`/runs/${r.id}`)}">${shortId(r.id)}</a>
    </td>
    <td>
      ${ago(r.created_at)}
      ${r.kind !== 'operator' ? html`<span class="quiet">${r.kind}</span>` : ''}
    </td>
    <td>
      <div>${clip(r.question, 120)}</div>
      <div class="quiet">${preview === '' ? 'no answer text' : preview}</div>
      ${
        r.verdict_note
          ? html`<div class="quiet">note: ${clip(r.verdict_note, 120)}</div>`
          : ''
      }
    </td>
    <td>
      ${
        walled
          ? html`<span class="badge is-seal">${r.stop_reason}</span>`
          : // No success colour, deliberately. A green tick on every answered run
            // trains the eye to skip the colour, and then it is not there on the
            // run where it mattered.
            html`<span class="quiet">answered</span>`
      }
    </td>
    <td>
      ${
        tools.length === 0
          ? html`<span class="quiet">none</span>`
          : // Repeats kept, in call order: three find_client calls in a row is a
            // model going in circles, and collapsing them hides exactly that.
            html`<span class="mono">${clip(tools.join(', '), 44)}</span>`
      }
      ${r.tool_failures > 0 ? html`<span class="seal">${figure(r.tool_failures)} failed</span>` : ''}
    </td>
    <td class="num">${figure(r.steps)}</td>
    <td class="num">${figure(r.evidence_count)}</td>
    <td class="num">${figure(r.tokens)}</td>
    <td class="num">${duration(r.duration_ms)}</td>
    <td>${verdictBadge(r.verdict)}</td>
  </tr>`;
}

function verdictBadge(verdict: Verdict | null): Html {
  if (verdict === 'wrong') return html`<span class="badge is-seal">wrong</span>`;
  if (verdict === 'good') return html`<span class="badge">good</span>`;
  return html`<span class="quiet">—</span>`;
}

/**
 * Where this page is in the history, and how to leave it.
 *
 * A full page is the signal that there is another one, because the read returns
 * no total. Said in words rather than left to a disabled arrow: "showing 31–60"
 * with no next link would read as the end of the history when it is the end of
 * one query.
 */
function paging(only: RunFilter | null, offset: number, count: number): Html {
  const full = count === PAGE;
  const first = offset + 1;

  return html`<div class="actions">
    ${
      offset > 0
        ? html`<a class="btn is-quiet" href="${href(listHref(only, Math.max(0, offset - PAGE)))}"
            >← newer</a
          >`
        : ''
    }
    ${
      full
        ? html`<a class="btn is-quiet" href="${href(listHref(only, offset + PAGE))}">older →</a>`
        : ''
    }
    <span class="meta">
      ${figure(first)}–${figure(offset + count)}${full
        ? ', and this page is full — there are probably more'
        : ', which is the end of this history'}
    </span>
  </div>`;
}

/* ─── /runs/<id> ─── */

export async function runPage(ctx: Ctx): Promise<Reply> {
  const id = (ctx.params.id ?? '').trim();
  const run = await getRun(ctx.userId, id);

  if (run === null) return notARun(id);

  const trace = readTrace(run.trace);
  const toolSteps = trace.filter((s) => s.kind === 'tool');
  const failures = toolSteps.filter((s) => s.ok === false).length;

  return {
    kind: 'html',
    body: layout({
      surface: 'runs',
      title: 'Run',
      heading: 'Run',
      lede: lede(run),
      body: html`${meta([
          html`<span class="mono">${run.id}</span>`,
          `asked ${utcStamp(run.created_at)} (${ago(run.created_at)})`,
          run.kind,
          run.writes_allowed ? html`<span class="seal">writes allowed</span>` : 'read-only',
        ])}
        ${run.kind === 'eval' ? evalRunNotice() : ''}
        ${run.writes_allowed ? writesAllowedNotice() : readOnlyNotice()}
        ${run.stop_reason === 'answered' ? '' : wallNotice(run.stop_reason)}

        <h2>Question</h2>
        <p>${run.question}</p>

        <h2>Answer</h2>
        ${answerBlock(run)}

        <h2>Evidence</h2>
        <p class="meta">
          The records the answer was allowed to rest on. The id is the point: with it,
          disagreeing with the agent is a query rather than an argument.
        </p>
        ${evidenceList(run.evidence)}

        <h2>Trace</h2>
        ${traceBlock(run, trace, toolSteps.length, failures)}

        <h2>Verdict</h2>
        ${verdictBlock(run)}

        <div class="rule"></div>
        <p class="meta">
          Every figure on this page came out of one row. Disagreeing with it is a query:
        </p>
        <pre>select stop_reason, steps, tokens, trace from agent_runs where id = '${run.id}';</pre>`,
    }),
  };
}

/** An id that named nothing, and an id that could not name anything, in the same
 * words. `/runs/potato` and a uuid nobody has are the same answer to the reader,
 * and `getRun` returns null for both without querying for the first. */
function notARun(id: string): Reply {
  return {
    kind: 'html',
    status: 404,
    body: layout({
      surface: 'runs',
      title: 'No such run',
      heading: 'No such run',
      body: empty({
        label: '404',
        what: isRunId(id)
          ? html`No run here has the id <span class="mono">${clip(id, 40)}</span>. A run that
              belongs to another operator reads the same way, deliberately: absent tells a
              stranger nothing, where forbidden would confirm that the row exists.`
          : html`<span class="mono">${clip(id, 40)}</span> cannot be a run id — they are uuids —
              so nothing was queried for it.`,
        next: html`<a href="${href('/runs')}">The history</a> lists what has been recorded,
          newest first.`,
      }),
    }),
  };
}

/** One sentence at the top: how it stopped, and what it was allowed to do. */
function lede(run: RunDetail): string {
  const how =
    run.stop_reason === 'answered'
      ? `Answered in ${duration(run.duration_ms)}`
      : `Stopped at ${run.stop_reason} after ${duration(run.duration_ms)}`;
  const mode = run.writes_allowed
    ? 'and this run was allowed to write.'
    : 'and it was not allowed to change anything.';
  return `${how}, over ${run.steps} step(s) and ${figure(run.tokens)} tokens, ${mode}`;
}

/**
 * What did NOT happen, on a page that would otherwise only report what did.
 *
 * Not the seal: a read-only run is the ordinary case and the whole design, and
 * an accent on every one of them would be an accent that means nothing by the
 * time it appears on the exception.
 */
function readOnlyNotice(): Html {
  return html`<div class="notice">
    <span class="label">nothing in the business changed</span>
    <p>
      This run was not permitted to write. A write tool reached in this mode resolves its target,
      decides everything it would do, and then returns what it would have done — so anything it
      wanted is a card on <a href="${href('/approvals')}">the approvals desk</a> waiting for a
      person, and not a row that moved.
    </p>
  </div>`;
}

/** The exception, and it gets the accent for that reason. */
function writesAllowedNotice(): Html {
  return html`<div class="notice is-seal">
    <span class="label">writes were allowed for this run</span>
    <p>
      This is the mode the design refuses for an ordinary question: a run with writes on has
      permission to change whatever the model decides next, rather than permission for one act a
      person read first. It does not mean anything was written — a tool that finds the value
      already set has nothing to do — but it is worth knowing which runs had the door open, and
      nothing in this repository opens it.
    </p>
  </div>`;
}

/** An eval run reached by its id, which is the one way to reach one. */
function evalRunNotice(): Html {
  return html`<div class="notice">
    <span class="label">this is a run of the eval suite</span>
    <p>
      It is counted in none of the figures on <a href="${href('/runs')}">the history</a> and
      appears in that list only under the eval filter. Reaching it by id works anyway: a failed
      case links straight here, and "no such run" would read as a trace that had been pruned.
    </p>
  </div>`;
}

/**
 * The wall, named, with what it means for the answer above it.
 *
 * `agent_runs` stores the reason and not the sentence — `stop_detail` is not a
 * column — so these sentences are written from the reason. A wall this file has
 * not been taught still gets a line, because the budget owns the vocabulary and
 * may grow it, and a run whose outcome renders as nothing would be the worst
 * possible reading of "stopped for a reason nobody recorded".
 */
const WALLS: Record<string, string> = {
  step_limit:
    'It used every model step the budget allows without reaching an answer. Whatever is under ' +
    'Answer is the last turn’s text, not a conclusion.',
  token_limit: 'It reached the token ceiling for one run before it was finished.',
  time_limit:
    'It ran out of wall clock. The limit is checked before each model call rather than after, so ' +
    'there was still time to write this trace — which is the point of checking early.',
  tool_error_limit:
    'Consecutive tool calls failed, so it stopped rather than spending more on a call that was ' +
    'not working. The failed steps are marked in the trace.',
  aborted: 'Somebody interrupted it. It still reported what it had established, and still recorded this.',
};

function wallNotice(reason: string): Html {
  return html`<div class="notice is-seal">
    <span class="label">stopped at a wall: ${reason}</span>
    <p>
      ${WALLS[reason] ??
      'This run stopped for a reason this page has not been taught. The budget owns that ' +
        'vocabulary, so a new wall is a code change rather than a migration — the name above is ' +
        'what was recorded.'}
    </p>
    <p>
      A wall is a reported outcome and never a silent truncation. The trace below is what it had
      done by the time it hit one.
    </p>
  </div>`;
}

/**
 * The answer, in a monospaced block.
 *
 * Not prose styling, and the reason is in the answers themselves: the model
 * lines invoices and totals up in columns, and a proportional font takes that
 * alignment away. This is the same text `src/cli.ts` prints, rendered so that it
 * reads the same way.
 */
function answerBlock(run: RunDetail): Html {
  const answer = (run.answer ?? '').trim();
  if (answer === '') {
    return html`<p class="meta">
      No answer text. A model turn can come back with tool calls and no prose at all, so this is
      not the agent refusing to answer — how it stopped is
      <span class="mono">${run.stop_reason}</span>.
    </p>`;
  }
  return html`<pre>${answer}</pre>`;
}

/* ─── the trace ─── */

/**
 * One step, read out of JSONB rather than trusted.
 *
 * `trace` is written by `persistRun` and by nothing else, so in practice it
 * holds `TraceStep[]` — but it is a JSONB column, a renderer is the only thing
 * that would ever notice a malformed step, and a renderer that throws takes the
 * page with it. So every field is read through a guard and the type says what
 * survived rather than what was hoped for.
 */
interface Step {
  n: number | null;
  kind: 'model' | 'tool' | 'other';
  toolName: string | null;
  hasArgs: boolean;
  args: unknown;
  output: string | null;
  ok: boolean | null;
  ms: number | null;
  tokens: number | null;
  stop: string | null;
  offsetMs: number | null;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : Number.NaN;
  return Number.isFinite(n) ? n : null;
};

function readTrace(trace: unknown): Step[] {
  if (!Array.isArray(trace)) return [];

  return trace.map((entry) => {
    const s = (entry ?? {}) as Record<string, unknown>;
    const kind = s.kind === 'model' || s.kind === 'tool' ? s.kind : 'other';
    // Input and output tokens on a model step, `tokens` on a tool that called a
    // model of its own. Added rather than shown separately: the useful figure
    // beside a duration is what the step cost.
    const model = (num(s.inputTokens) ?? 0) + (num(s.outputTokens) ?? 0);
    return {
      n: num(s.step),
      kind,
      toolName: str(s.toolName),
      hasArgs: s.toolArgs !== undefined,
      args: s.toolArgs,
      output: str(s.output),
      ok: typeof s.ok === 'boolean' ? s.ok : null,
      ms: num(s.ms),
      tokens: kind === 'model' ? (model > 0 ? model : null) : num(s.tokens),
      stop: str(s.stop),
      offsetMs: num(s.offsetMs),
    };
  });
}

/**
 * The smallest bar a step with a real duration may draw.
 *
 * A 2ms step beside a 12s one is 0.02% of the width, which rounds to nothing —
 * and a bar that renders as nothing reads as a bar that failed to render. Under
 * one percent of the track cannot be mistaken for a large share, so the floor
 * costs no honesty and buys the difference between "fast" and "broken".
 */
const MIN_BAR = 0.6;

function traceBlock(run: RunDetail, steps: Step[], toolCalls: number, failures: number): Html {
  if (steps.length === 0) {
    return empty({
      label: 'no trace',
      what:
        'This run recorded no steps. Every run writes its trace, so an empty one is either a run ' +
        'that stopped before its first model call or a fault in the recording.',
      next: 'The row is still there: the query at the bottom of this page prints it.',
    });
  }

  /**
   * A timeline, not a bar chart.
   *
   * An earlier version scaled each bar to the SLOWEST step, on the reasoning that
   * against the run's total every step in a six-step run is a stub. That argument
   * is sound about width and it throws away the more useful axis: position. Every
   * step records `offsetMs` — when it started, relative to the run — and the loop
   * runs a round's tool calls TOGETHER, so two bars beginning at the same offset
   * are the only way to see concurrency at a glance. The gaps between bars are the
   * harness, which is otherwise a number in prose that nobody subtracts.
   *
   * The width objection is real and is answered by the floor rather than by the
   * scale: a 300ms call inside a 12s run is 2.5% and would vanish, so MIN_BAR
   * keeps it a visible mark. What is lost is comparing two fast steps to each
   * other by eye; their durations are printed beside them, which is the precise
   * way to do that anyway.
   *
   * Guarded against a zero-length run so nothing divides by nothing.
   */
  const span = Math.max(
    run.duration_ms ?? 0,
    ...steps.map((s) => (s.offsetMs ?? 0) + (s.ms ?? 0)),
    1
  );
  const slowest = steps.reduce((max, s) => Math.max(max, s.ms ?? 0), 0);
  const summed = steps.reduce((total, s) => total + (s.ms ?? 0), 0);

  return html`<p class="meta">
      ${figure(steps.length)} step(s), ${figure(toolCalls)} of them tool calls${
        failures > 0 ? html`, <span class="seal">${figure(failures)} failed</span>` : ''
      }. Each bar sits where the step ran across ${duration(span)} of wall clock, so bars that
      start together were tool calls the loop made together, and the gaps are the harness. The
      slowest step was ${duration(slowest)}; the steps sum to ${duration(summed)} of
      ${duration(run.duration_ms)} on the clock.
    </p>
    <p class="meta">
      Arguments are shown as the model sent them, before validation, so a refusal can be read
      next to what caused it. Output is what the trace stores — the loop truncates it, because a
      trace is for debugging and not a second copy of the data.
    </p>
    <ol class="trace">
      ${steps.map((s) => traceStep(s, span))}
    </ol>`;
}

function traceStep(s: Step, span: number): Html {
  const failed = s.ok === false;
  // Where it ran, and for how long, both as a percentage of the run's span. A step
  // with no recorded offset falls back to the left edge rather than being hidden:
  // an unpositioned bar is still a duration, and dropping it would lose the step.
  const left = s.offsetMs === null ? 0 : Math.min(100, (s.offsetMs / span) * 100);
  const width =
    s.ms !== null && s.ms > 0
      ? Math.min(100 - left, Math.max(MIN_BAR, (s.ms / span) * 100))
      : 0;

  return html`<li>
    <p class="head">
      <span class="n">${s.n === null ? '·' : `${s.n}.`}</span>
      ${
        s.kind === 'tool'
          ? html`<span class="mono">${s.toolName ?? '(a tool step with no name)'}</span>`
          : html`<span class="mono">${s.kind === 'model' ? 'model' : `(${s.kind})`}</span>`
      }
      <span class="num">${s.ms === null ? '—' : duration(s.ms)}</span>
      ${
        failed
          ? // The one thing on a step that needs the eye. `.trace .failed` is the
            // seal, and the bar below takes it too.
            html`<span class="failed">FAILED</span>`
          : ''
      }
      ${
        s.tokens === null
          ? // Said rather than printed as 0. A provider that reports no usage is
            // charged pessimistically by the budget, so "0tok" beside a run total
            // of 6,506 would read as a step that was free.
            s.kind === 'model'
            ? html`<span class="quiet">usage not reported</span>`
            : ''
          : html`<span class="num quiet">${figure(s.tokens)} tok</span>`
      }
      ${s.stop ? html`<span class="quiet">[${s.stop}]</span>` : ''}
      ${s.offsetMs === null ? '' : html`<span class="quiet">+${duration(s.offsetMs)}</span>`}
    </p>
    <span class="bar${failed ? ' is-seal' : ''}"
      ><i style="--l:${left.toFixed(1)}%;--w:${width.toFixed(1)}%"></i
    ></span>
    ${s.hasArgs ? html`<pre>args ${compact(s.args)}</pre>` : ''}
    ${s.output ? html`<pre>${s.output}</pre>` : ''}
  </li>`;
}

/**
 * Arguments as one line.
 *
 * They came from the model, so nothing here can assume they are printable, and
 * `JSON.stringify` throws on a circular reference and returns undefined for
 * `undefined`. The fallback wording is `src/cli.ts`'s, because the same value
 * read two ways in two places is how a reader learns that neither is careful.
 */
function compact(args: unknown, max = 600): string {
  let text: string;
  try {
    text = JSON.stringify(args) ?? String(args);
  } catch {
    return '(unprintable arguments)';
  }
  return clip(text, max);
}

/* ─── the verdict ─── */

function verdictBlock(run: RunDetail): Html {
  return html`<p class="meta">
      The suite in <code>evals/</code> tests the failures somebody imagined. The failures worth
      testing are the ones that already happened, and they exist only here — so a run marked
      wrong with one line saying why is the raw material for a case nobody could have invented.
      Two values and a note, because a five-point scale invites arguing with yourself about a
      three versus a four until nothing gets judged at all.
    </p>
    ${
      run.verdict === null
        ? html`<p class="meta">
            Not judged. That is the honest majority and it is counted as neither right nor wrong.
          </p>`
        : defs([
            def('verdict', verdictBadge(run.verdict)),
            run.verdict_note ? def('why', run.verdict_note) : null,
            def('marked', `${utcStamp(run.verdict_at)} (${ago(run.verdict_at)})`),
          ])
    }

    <form class="field" method="post" action="${href(`/runs/${run.id}/verdict`)}">
      <label for="note">why, in one line — this is what an eval case gets written from</label>
      <input
        type="text"
        id="note"
        name="note"
        maxlength="2000"
        value="${run.verdict_note ?? ''}"
        placeholder="it reported a total that swallowed a void invoice"
      />
      <div class="actions">
        <!-- Two submit buttons in one form, differing only in the value they
             send. Neither wears .is-seal: that is reserved for a button that
             acts on the business records, and this writes a word onto a run. -->
        <button class="btn" type="submit" name="verdict" value="good">mark good</button>
        <button class="btn" type="submit" name="verdict" value="wrong">mark wrong</button>
        ${
          run.verdict === null
            ? ''
            : // `none` rather than an empty value, so that un-judging is a thing
              // the request SAYS rather than something inferred from a missing
              // field. A misclick has to be undoable or the figures slowly stop
              // meaning anything.
              html`<button class="btn is-quiet" type="submit" name="verdict" value="none">
                un-judge it
              </button>`
        }
      </div>
      <p class="meta">
        This changes nothing in the business. It writes one word and one sentence onto this run,
        and taking the verdict off clears the sentence with it — a note explaining why a run was
        wrong, left on a run no longer marked wrong, is a contradiction the next reader resolves
        by believing the note.
      </p>
    </form>`;
}

/* ─── POST /runs/<id>/verdict ─── */

export async function runVerdict(ctx: Ctx): Promise<Reply> {
  const id = (ctx.params.id ?? '').trim();
  const asked = ctx.form.get('verdict');
  const note = ctx.form.get('note');

  if (!isRunId(id)) {
    return refused(
      400,
      html`<span class="mono">${clip(id, 40)}</span> cannot be a run id, so no verdict was
        recorded. A write that cannot name its target fails rather than reporting that it changed
        nothing.`,
      html`<a href="${href('/runs')}">The history</a> links every run by its id.`
    );
  }

  // Missing and unrecognised are told apart. A POST with no field is a form that
  // was submitted without a button — nothing to record — and a value that is not
  // one of the three is a caller inventing vocabulary, which is worth naming
  // rather than rounding to the nearest verdict.
  if (asked === null) {
    return refused(
      400,
      'That request carried no verdict, so nothing was recorded.',
      html`Open <a href="${href(`/runs/${id}`)}">the run</a> and use one of the buttons under
        Verdict.`
    );
  }

  let verdict: Verdict | null;
  if (asked === 'good' || asked === 'wrong') verdict = asked;
  else if (asked === 'none') verdict = null;
  else {
    return refused(
      400,
      html`<span class="mono">${clip(asked, 40)}</span> is not a verdict. It is
        <span class="mono">good</span>, <span class="mono">wrong</span>, or
        <span class="mono">none</span> to take the mark off. Nothing was recorded.`,
      html`Open <a href="${href(`/runs/${id}`)}">the run</a> and use one of the buttons under
        Verdict.`
    );
  }

  try {
    await setVerdict({ userId: ctx.userId, id, verdict, note });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // `setVerdict` throws a sentence for a run that is not there, which is a 404
    // rather than a failure: the same reading as a run that belongs to somebody
    // else. Anything else it throws is a refusal about the values, which is a
    // 400 with the sentence it wrote.
    const missing = message === 'No such run.';
    return refused(
      missing ? 404 : 400,
      message,
      html`<a href="${href('/runs')}">The history</a> lists the runs this operator has
        recorded.`
    );
  }

  // 303 back to the run, so a reload cannot re-post the verdict and the back
  // button lands on a GET. The id has already been checked as a uuid, which is
  // also what makes it safe in a Location header.
  return { kind: 'redirect', to: `/runs/${id}` };
}

/** A refusal, as a page, with the nav still on it. Every one of these is a
 * request that changed nothing, and each says so. */
function refused(status: number, what: string | Html, next: string | Html): Reply {
  return {
    kind: 'html',
    status,
    body: layout({
      surface: 'runs',
      title: 'Not recorded',
      heading: 'Not recorded',
      lede: 'No verdict was written.',
      body: empty({ label: `${status}`, what, next }),
    }),
  };
}
