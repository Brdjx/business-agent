/**
 * The ask surface: a question, the run as it happens, and the receipts.
 *
 * This is `src/cli.ts` with a browser in front of it, and the CLI's output is the
 * specification. What it prints — the answer, then the rows the answer rests on
 * with their ids, then one line per step with what each cost — is not behind a
 * flag there and is not behind a disclosure here. The whole claim of this
 * repository is that the accounting around the loop is the interesting part, and
 * hiding it until asked would be an odd way to make that case.
 *
 * So this page shows, in this order: the answer, any card the run left with the
 * fact that NOTHING HAS BEEN CHANGED said before the detail, the evidence, what
 * the run cost, how it stopped, and every step with its own duration. A run that
 * produced no evidence says so in the CLI's own words — "nothing above rests on a
 * record; treat it as a claim" — because that is the one thing a reader most needs
 * to know about the paragraph above it.
 *
 * ── Streaming, and why it is not an EventSource ──
 *
 * The loop answers once, after N round trips, so a page that only awaited it would
 * show a spinner for twenty seconds and then everything at once — throwing away
 * the part of the trace that is interesting precisely while you are waiting. The
 * loop already emits `RunEvent`s for exactly this (`onEvent`), and this file uses
 * that callback rather than a second streaming loop: there is one implementation of
 * the loop, and the last time something in `src/agent/` existed in two forms one of
 * them ran for weeks with the wrong tools registered and nothing could see it
 * (docs/incidents.md, entry 1).
 *
 * The wire format is Server-Sent Events. The client is `fetch`, not `EventSource`,
 * and that is a decision rather than an oversight: an `EventSource` can only issue
 * a GET, and a GET that runs the agent spends money and inserts rows into
 * `agent_proposals` — one prefetch, one crawler, one restored tab away from a run
 * nobody asked for. The route table refuses a GET for the writes on the approvals
 * surface for the same reason, and this is the same rule applied to the one route
 * that spends. So the run is a POST, and the response is an event stream that ~35
 * lines of vanilla JS reads.
 *
 * ── One renderer, on the server ──
 *
 * The frames carry HTML, not data. A client that rendered the events itself would
 * be a second renderer, diverging from the server-rendered no-JS path, and every
 * value in it would need escaping again in a language that makes that easy to
 * forget. Instead every fragment is built here by the same functions the no-JS path
 * uses, through `escape.ts`, and the browser's whole job is to put a string where it
 * belongs. That is what keeps the script small enough to read in one screen.
 *
 * ── Without JavaScript ──
 *
 * The form is an ordinary `<form method="post">` and the POST renders the finished
 * run server-side. A page that is blank without JS is a page that cannot be read in
 * a screenshot, and the streaming is an enhancement on top of a page that already
 * works.
 *
 * ── What this surface deliberately cannot do ──
 *
 * It never turns writes on. There is no field, no checkbox and no query parameter
 * that sets `allowWrites`, for the same reason `src/cli.ts` has no `--allow-writes`:
 * consent belongs to an action, not to a session (docs/design.md §4). The only code
 * that enables a write is `decideProposal`, applying one stored call a person read
 * first. A card shown here therefore links to the approval desk and carries no
 * approve button — a second place that applies writes is a second place to get the
 * refusal rendering wrong.
 *
 * And it registers the tools itself. `server.ts` deliberately does not do it at
 * boot: a registry filled by whoever happened to import something is how an
 * approval path ran for weeks with two tools in it (incident 1). If this call is
 * deleted, `allTools()` is empty and the check below says so in words rather than
 * the model answering from nothing and the run looking like a fast, cheap success.
 */

import type { ServerResponse } from 'node:http';

import { runAgent, type AgentRun, type RunEvent, type TraceStep } from '../../agent/loop';
import type { Proposal } from '../../agent/proposals';
import { providerFromEnv, type ProviderChoice } from '../../agent/providers';
import { allTools, type Precondition, type ProposalDraft } from '../../agent/tools';
import { ensureToolsRegistered } from '../../agent/registry';
import { persistRunAndProposals, type RecordedRun } from '../../agent/trace';
import { html, safeUrl, unsafeHtml, type Html } from '../escape';
import {
  clip,
  def,
  defs,
  duration,
  empty,
  evidenceList,
  figure,
  layout,
  shortId,
  until,
  utcStamp,
} from '../layout';
import type { Ctx, Handler, Reply } from '../server';

/**
 * The longest question accepted, and the same number `src/cli.ts` refuses at.
 *
 * It is the point where `persistRun` truncates `question` before storing it. A
 * question the record would keep as something shorter than what was asked is a run
 * nobody can reproduce, so it is refused here rather than quietly cut there. The
 * three copies of this bound — trace.ts keeps its own private, the CLI has one, this
 * is the third — have to agree, and are worth moving the day any of them changes.
 */
const MAX_QUESTION = 4_000;

/** From the README, because it is a question whose answer is checkable against the
 * seed's own arithmetic rather than one that merely sounds impressive. */
const PLACEHOLDER = 'how much is outstanding, and how much of it is overdue?';

/**
 * A comment frame, often enough that a silent connection is not mistaken for a
 * dead one.
 *
 * Nothing in this repository proxies the stream — it is one loopback hop — so this
 * is not load-bearing today. It is here because the failure it prevents is
 * invisible in development and total in front of a tunnel: an idle-timeout closes
 * the response mid-run, and the page reports a stream that stopped while the run
 * carries on spending.
 */
const HEARTBEAT_MS = 20_000;

/* ─── GET /: the box ─── */

/**
 * The question box, and nothing that costs anything.
 *
 * `?q=` prefills it, which is what makes "ask this again, with one word changed"
 * a link from a run that went wrong. It does NOT run: a GET that ran the agent
 * would spend tokens and insert proposal rows the first time a browser prefetched
 * it, which is the rule the route table already enforces for approve and reject.
 *
 * There is deliberately no query here either. This page renders with Postgres
 * down, and a card count fetched to decorate the form would make the one surface
 * that does not need the database fail with the ones that do.
 */
export const askPage: Handler = (ctx) => ({
  kind: 'html',
  body: page({ question: ctx.url.searchParams.get('q') ?? '' }),
});

/* ─── POST /ask: the run ─── */

/**
 * One route, two readers.
 *
 * The page's own script asks for `text/event-stream` and gets the run as it
 * happens; a plain form POST from a browser with no JavaScript asks for HTML and
 * gets the finished run. Negotiated on `Accept` rather than on a hidden field the
 * script sets, because the header is the thing that is actually true about what
 * the client can read, and both paths run the same loop through the same helper
 * below.
 */
export const askRun: Handler = async (ctx) => {
  const ready = readyToRun(ctx.form);

  if (wantsStream(ctx.req)) return streamRun(ctx, ready);

  if ('refusal' in ready) {
    return {
      kind: 'html',
      status: ready.refusal.status,
      // The typed question comes back with it. Being told a question is 4,300
      // characters long and then having to type it again is a worse answer than
      // no answer.
      body: page({
        question: rawQuestion(ctx.form),
        notice: refusalNotice(ready.refusal.label, ready.refusal.what),
      }),
    };
  }

  try {
    const { run, recorded } = await perform({ userId: ctx.userId, ...ready });
    return { kind: 'html', body: page({ question: ready.question, result: runReport(run, recorded) }) };
  } catch (err) {
    // `runAgent` rejects only for something the run could not name — a provider
    // that is down. Reported as the page rather than through the server's 500 so
    // the question survives, and logged with its stack because that is where a
    // dead endpoint is diagnosed.
    console.error('[web] the run failed:', err);
    return {
      kind: 'html',
      status: 500,
      body: page({
        question: ready.question,
        notice: refusalNotice(
          'the run failed',
          `${messageOf(err)} Nothing was changed by this — no tool in a run started here is ` +
            'permitted to write. The stack is on this process’s stderr.'
        ),
      }),
    };
  }
};

const wantsStream = (req: Ctx['req']): boolean =>
  (req.headers.accept ?? '').toLowerCase().includes('text/event-stream');

/* ─── what has to be true before a model is called ─── */

interface Ready {
  question: string;
  choice: ProviderChoice;
}

interface Refusal {
  /** The 11px label on the notice. Says which of the three refusals this is. */
  label: string;
  what: string;
  /** 400 when the request was wrong, 500 when this deployment is. Both are
   * rendered the same way; only the log and the status tell them apart. */
  status: 400 | 500;
}

/**
 * The question, the model, and the allowlist — checked before anything is spent.
 *
 * Ordering is the whole point of doing this here rather than letting each layer
 * fail where it will: the model call is the expensive part of a run, and finding
 * out about a missing variable after paying for it is the version of this that
 * annoys somebody into not trying again.
 *
 * Registering the tools is one of the three things this does, and it is not a
 * tidy-up. See the note at the top of the file: this module is the entry point
 * that will reach `executeTool`, and `server.ts` does not register for it.
 */
function readyToRun(form: URLSearchParams): Ready | { refusal: Refusal } {
  const question = rawQuestion(form).trim();

  if (!question) {
    return {
      refusal: {
        label: 'nothing was asked',
        status: 400,
        what:
          'The box was empty, so nothing was sent to a model and nothing was spent. Ask ' +
          'something about the clients, projects, invoices or hours in the seeded business.',
      },
    };
  }
  if (question.length > MAX_QUESTION) {
    return {
      refusal: {
        label: 'too long to record',
        status: 400,
        what:
          `That question is ${figure(question.length)} characters, and ${figure(MAX_QUESTION)} is the ` +
          'most that can be recorded without being truncated. Ask a shorter one rather than having ' +
          'the record disagree with what was asked.',
      },
    };
  }

  let choice: ProviderChoice;
  try {
    choice = providerFromEnv();
  } catch (err) {
    // `providers/index.ts` owns every environment variable the model layer reads
    // and names the missing one in a sentence. Passed through verbatim: a second
    // vocabulary for the same fault would eventually be the stale one.
    return { refusal: { label: 'no model to ask', status: 500, what: messageOf(err) } };
  }

  ensureToolsRegistered();
  if (allTools().length === 0) {
    // Checked rather than assumed, because the failure it catches is silent from
    // here: with an empty registry the model is sent no tools, answers from
    // nothing, and the run looks like a fast cheap success.
    return {
      refusal: {
        label: 'no tools registered',
        status: 500,
        what:
          'There would be nothing to read the business with, and the model would answer from ' +
          'nothing. This is a wiring fault in the harness rather than anything to fix in .env.',
      },
    };
  }

  return { question, choice };
}

/**
 * The question exactly as it was typed, untrimmed and uncut.
 *
 * Not bounded here even though the refusal above is about length: the sentence has
 * to report the real number, and a value clipped on the way in would make it report
 * the clip. The router caps the whole body at 64KB, which is the bound that
 * actually protects anything.
 */
const rawQuestion = (form: URLSearchParams): string => form.get('q') ?? '';

/**
 * Run it, then record it.
 *
 * `allowWrites` is not passed, and there is no argument here that could set it. A
 * write tool in this run resolves its target, decides everything it would decide,
 * and returns a card.
 *
 * `persistRunAndProposals` is one call because the ORDER is a guarantee:
 * `agent_proposals.run_id` is a foreign key into `agent_runs`, so the run is
 * written first and the cards after, and `trace.ts` owns that rather than this
 * file doing it in two steps. It never throws — a run that answered correctly and
 * then failed while filing its paperwork has turned an observability problem into
 * an outage — so a null `runId` here means the trace was lost, not the answer.
 */
async function perform(opts: {
  userId: string;
  question: string;
  choice: ProviderChoice;
  signal?: AbortSignal;
  onEvent?: (event: RunEvent) => void;
}): Promise<{ run: AgentRun; recorded: RecordedRun }> {
  const run = await runAgent({
    question: opts.question,
    userId: opts.userId,
    provider: opts.choice.provider,
    model: opts.choice.model,
    signal: opts.signal,
    onEvent: opts.onEvent,
  });

  const recorded = await persistRunAndProposals(opts.userId, opts.question, run, { kind: 'operator' });
  return { run, recorded };
}

/* ─── the stream ─── */

/** What a frame can carry: a narration line to append, or the finished report to
 * put in place of whatever is there. Both are markup this file rendered. */
type Frame = { line: string } | { report: string };

/**
 * The run, as it happens.
 *
 * Every outcome — including a refusal decided before the loop ran — arrives as a
 * frame with a 200 on the response, and that asymmetry with the no-JS path is
 * deliberate rather than sloppy. By the time a client is reading an event stream
 * the page has already been delivered; what the run did, or refused to do, is
 * content on that page and not a property of the transport. The cost is that a
 * misconfigured deployment logs `POST /ask 200` here where the no-JS path logs a
 * 500, so every refusal on this path is also written to stderr.
 */
async function streamRun(ctx: Ctx, ready: Ready | { refusal: Refusal }): Promise<Reply> {
  const { res } = ctx;

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    // No content-security-policy: this is not a document, and a header that
    // cannot apply to what it is sent with is noise a reader has to check.
  });
  // Immediately, so the browser hands the body to the reader rather than waiting
  // for enough bytes to be worth delivering.
  comment(res, 'the run has started');

  /**
   * A closed tab stops the run.
   *
   * The loop turns a signal into the `aborted` stop reason, so an abandoned run
   * still records what it had established instead of spending the rest of its
   * budget for nobody. The listener is on `res` and NOT on `req`: the router has
   * already read the request body to parse the form, so `req` has ended and its
   * own 'close' has been emitted — a listener attached here would never fire, and
   * a cancel path that silently never fires is worse than none.
   */
  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });

  const beat = setInterval(() => comment(res, 'still running'), HEARTBEAT_MS);
  const startedAt = Date.now();

  try {
    if ('refusal' in ready) {
      console.error(`[web] ask refused before the run: ${ready.refusal.what}`);
      // The status the no-JS path would have used is deliberately dropped here
      // rather than smuggled into the page — see the note above. The log line
      // above is what keeps this refusal findable.
      send(res, { report: String(refusalNotice(ready.refusal.label, ready.refusal.what)) });
      return { kind: 'handled' };
    }

    const { run, recorded } = await perform({
      userId: ctx.userId,
      ...ready,
      signal: controller.signal,
      onEvent: (event) => {
        const markup = narrationLine(event, startedAt);
        if (markup) send(res, { line: String(markup) });
      },
    });

    send(res, { report: String(runReport(run, recorded)) });
  } catch (err) {
    console.error('[web] the streamed run failed:', err);
    send(res, {
      report: String(
        refusalNotice(
          'the run failed',
          `${messageOf(err)} Nothing was changed. The stack is on this process’s stderr.`
        )
      ),
    });
  } finally {
    clearInterval(beat);
    if (!res.writableEnded) res.end();
  }

  return { kind: 'handled' };
}

/**
 * One frame.
 *
 * `JSON.stringify` is what makes this safe as a frame as well as convenient: SSE
 * separates frames with a blank line, so a newline inside the payload would end
 * the frame early, and every newline in the markup comes back out of here as `\n`.
 */
const send = (res: ServerResponse, frame: Frame): void => write(res, `data: ${JSON.stringify(frame)}\n\n`);

/** A comment frame: ignored by the reader, and proof to anything in between that
 * the connection is alive. */
const comment = (res: ServerResponse, why: string): void => write(res, `: ${why}\n\n`);

/**
 * A write that fails must not take the run down.
 *
 * The reader closing mid-run is the ordinary case, not an error — the same rule
 * `src/cli.ts` applies to a closed stdout, and the same one the loop applies to a
 * progress callback that throws. The run continues, the trace is still written,
 * and only the narration is lost.
 */
function write(res: ServerResponse, text: string): void {
  if (res.writableEnded || res.destroyed) return;
  try {
    res.write(text);
  } catch {
    /* the reader has gone; there is nothing useful to do about it here */
  }
}

/* ─── the page ─── */

interface PageParts {
  /** Prefills the box. Present on every render, so a follow-up question starts
   * from the last one rather than from an empty page. */
  question: string;
  notice?: Html;
  result?: Html;
}

function page(parts: PageParts): string {
  return layout({
    surface: 'ask',
    title: 'Ask',
    lede:
      'One question against the business records. A question that would change something does ' +
      'not change it: the change comes back as a card, and approving it is a separate act.',
    body: html`${parts.notice ?? ''}${form(parts.question)}
${unsafeHtml(NOSCRIPT, 'a literal in ask.ts, with nothing interpolated into it')}
<div class="stream" id="stream" role="log" aria-live="polite" hidden></div>
<div id="report" aria-live="polite">${parts.result ?? (parts.notice ? '' : nothingAskedYet())}</div>
${unsafeHtml(
      `<script>${SCRIPT}</script>`,
      'the literal SCRIPT constant below, wrapped in its element; nothing from a request reaches it'
    )}`,
  });
}

function form(question: string): Html {
  // `maxlength` matches what the server refuses, so the ordinary case is the
  // browser declining to accept the 4,001st character rather than a round trip
  // that ends in a refusal. `required` is the same argument for an empty box.
  // Neither is trusted: `readyToRun` checks both, because an attribute is a
  // courtesy to a person and not a constraint on a request.
  return html`<form id="ask" method="post" action="/ask">
  <div class="field">
    <label class="label" for="q">your question</label>
    <textarea id="q" name="q" rows="3" required maxlength="${MAX_QUESTION}" placeholder="${PLACEHOLDER}">${question}</textarea>
  </div>
  <div class="actions">
    <!-- Not .is-seal. The seal on a button means the button acts on the business,
         and asking a question does not: every tool a run started here can reach
         either reads, or describes a write and leaves a card. -->
    <button class="btn" id="go" type="submit">Ask</button>
    <span class="meta">read-only — a write comes back as a proposal</span>
  </div>
</form>`;
}

/**
 * What is here before anything has been asked.
 *
 * `empty` requires the sentence saying what would put something here, and on this
 * surface that sentence is also the only place a first-time reader is told what a
 * run will show them.
 */
const nothingAskedYet = (): Html =>
  empty({
    label: 'nothing has been asked yet',
    what:
      'A run shows every step as it happens — which tool, what arguments, how long, and whether ' +
      'it failed — then the answer, the rows the answer rests on with their ids, what the run ' +
      'cost, and how it stopped.',
    next:
      'Ask something above. It costs tokens and a few seconds; it cannot change a record, and a ' +
      'write it decides on comes back as a card for you to approve.',
  });

/** Said in a `<noscript>` rather than left to be discovered: the form works, and
 * what is lost is watching rather than the result. */
const NOSCRIPT = `<noscript><div class="notice"><span class="label">without javascript</span><p>The form still works. The run happens when you submit, and the whole result arrives at once — every step is in the trace at the bottom of it. What is lost is watching the steps as they happen, because the page cannot be updated until the run is over.</p></div></noscript>`;

/**
 * Something that did not happen, said in the accent.
 *
 * Takes the two strings rather than a `Refusal`, because the third field of one is
 * an HTTP status and this is markup: a helper that accepted a status it could not
 * use would invite the two callers that have no status to invent one.
 */
const refusalNotice = (label: string, what: string): Html =>
  html`<div class="notice is-seal"><span class="label">${label}</span><p>${what}</p></div>`;

/* ─── the report ─── */

/**
 * The finished run, and the order is the argument.
 *
 * The answer first, because that is what was asked for. Then, before any of the
 * accounting, whatever is waiting on a person: a change that has not happened
 * outranks the cost of the run that suggested it, and the failure being designed
 * against is an operator skimming a confident paragraph about hours being logged
 * and never reaching the line that says they were not. Then the evidence, then
 * what it cost and how it stopped, then every step.
 *
 * Exported for `ask.test.ts`. It carries most of the sentences this surface exists
 * for, and asserting them through an HTTP round trip would be a test of the
 * router.
 */
export function runReport(run: AgentRun, recorded: RecordedRun): Html {
  const walled = run.stopReason !== 'answered';

  return html`<div class="rule"></div>
<h2>The answer</h2>
${answerBlock(run)}
${
  walled
    ? html`<div class="notice is-seal"><span class="label">stopped — ${run.stopReason}</span><p>${
        run.stopDetail
      }</p><p>A wall is a reported outcome and not a silent truncation, which means the answer above is
      what the run had established when it stopped rather than a finished one.</p></div>`
    : ''
}
${proposedBlock(run.proposals, recorded.proposals)}
<h2>Evidence</h2>
<p class="meta">The records the answer rests on. With the ids, disagreeing with the agent is a query.</p>
${evidenceList(run.evidence)}
<h2>What it cost</h2>
${costBlock(run)}
${defs([
  def('stop reason', html`<span class="badge${walled ? ' is-seal' : ''}">${run.stopReason}</span> ${run.stopDetail}`),
  // Which model answered is part of reading a run: a regression after a model
  // change and a regression after a prompt change are different investigations.
  def('model', `${run.provider}/${run.model}`, { mono: true }),
  def('recorded', recordedRow(recorded.runId)),
])}
<h2>The trace</h2>
${traceBlock(run)}`;
}

/**
 * The answer, with the model's own line breaks kept.
 *
 * `white-space: pre-wrap` inline rather than a class, because it is a property of
 * this one block and not a house style: the answers this agent gives routinely
 * contain a list of invoices one per line, and a renderer that reflowed them would
 * change what was said. It does not line up padded columns — this is a
 * proportional font — and that is the accepted half of the trade.
 *
 * The fallback is not decoration. A run that walled has its stop sentence as its
 * answer, but a model turn can also come back with tool calls and no text at all,
 * and printing nothing there would read as the agent having refused to answer
 * rather than as a turn with no prose in it.
 */
function answerBlock(run: AgentRun): Html {
  const answer = run.answer.trim();
  if (!answer) return html`<p class="meta">no answer text — ${run.stopDetail}</p>`;
  return html`<div style="white-space: pre-wrap">${answer}</div>`;
}

/**
 * Steps, tokens, duration, and the mode the run was in.
 *
 * `writesAllowed` is REPORTED and not asserted. Nothing on this surface can set
 * it, so the seal branch below is unreachable from here today — and the page still
 * reads the flag off the run rather than printing "read-only" as a fact about the
 * UI, because the run is the thing that knows.
 */
function costBlock(run: AgentRun): Html {
  return html`<div class="stats">
  <div class="stat"><span class="label">steps</span><b>${figure(run.steps)}</b><span class="of">model turns</span></div>
  <div class="stat"><span class="label">tokens</span><b>${figure(run.tokens)}</b><span class="of">input and output, charged before the spend</span></div>
  <div class="stat"><span class="label">duration</span><b>${duration(run.ms)}</b><span class="of">wall clock</span></div>
  <div class="stat${run.writesAllowed ? ' is-seal' : ''}"><span class="label">writes</span><b>${
    run.writesAllowed ? 'allowed' : 'read-only'
  }</b><span class="of">${
    run.writesAllowed
      ? 'this run could change records'
      : 'no tool in this run was permitted to change anything'
  }</span></div>
</div>`;
}

/**
 * Where the run went, or why it did not.
 *
 * The SQL is printed for the same reason the footer says the database is the
 * record: the id makes this checkable, and a select statement is the shortest
 * possible instruction for checking it.
 */
function recordedRow(runId: string | null): Html {
  if (!runId) {
    // `persistRun` returns null rather than throwing, on purpose, and logs why.
    return html`not recorded — the reason is on this process’s stderr, and the answer stands
      regardless. A card the run left is still on the desk: the trace is a debugging aid, and a
      card is a question waiting on a person.`;
  }
  return html`<a href="${safeUrl(`/runs/${runId}`)}">this run’s record</a>
    <span class="id">${runId}</span>
    <pre class="quiet">select stop_reason, steps, tokens, trace from agent_runs where id = '${runId}';</pre>`;
}

/* ─── the cards a run left ─── */

/**
 * What was proposed, said in the words that matter — nothing — before any detail.
 *
 * The heading is the truth even when every card failed to record, which is the
 * case the second sentence is for: "0 changes are waiting for your approval" has
 * no useful reading, and it would be the last thing anybody read before moving on.
 *
 * There is no approve button here. Deciding a card is one surface, reached by the
 * link, because a second page that applies writes is a second page that has to get
 * the refusals — stale, expired, already decided — right.
 */
function proposedBlock(drafts: ProposalDraft[], cards: Proposal[]): Html {
  if (drafts.length === 0 && cards.length === 0) return html``;

  // Counted by DISTINCT write key, not by draft: two drafts of one act collapse
  // into one card by design, because asking twice is not consenting twice, and
  // reporting that as a lost proposal would teach the reader to distrust a working
  // desk.
  const lost = new Set(drafts.map((d) => d.writeKey)).size - cards.length;

  return html`<div class="notice is-seal">
  <span class="label">proposed — nothing has been changed</span>
  <p>${
    cards.length > 0
      ? html`${
          cards.length === 1 ? 'One change is waiting' : `${figure(cards.length)} changes are waiting`
        } for your approval. The agent resolved the record, decided everything it would do, and then
        did not do it.`
      : html`The agent described a change and did not make it, and no card could be written, so
        there is nothing to approve.`
  }</p>
</div>
<ul class="rows">${pair(cards, drafts).map(({ card, draft }) => cardRow(card, draft))}</ul>
<p class="meta">The asserts line is re-read immediately before anything is written. If one of those
facts has moved, approving refuses and names what moved rather than applying a diff that no longer
describes the record.</p>
${
  lost > 0
    ? html`<p class="seal">${figure(lost)} proposal(s) could not be written to the desk and cannot be
        approved. The reason is on this process’s stderr; the answer stands regardless.</p>`
    : ''
}`;
}

function cardRow(card: Proposal, draft: ProposalDraft | undefined): Html {
  const where =
    card.target_table && card.target_label
      ? `${card.target_table}/${card.target_label}`
      : '(no row recorded on the card)';

  return html`<li>
  <p><span class="mono">${card.tool_name}</span> <span class="id">${card.id}</span></p>
  <p>${card.summary}</p>
  ${defs([
    def('row', html`<span class="mono">${where}</span> <span class="id">${card.target_id}</span>`),
    def(
      'asserts',
      draft
        ? asserts(draft.precondition)
        : html`<span class="quiet">not shown — this card could not be matched to the draft that
            wrote it</span>`
    ),
    def('expires', `${utcStamp(card.expires_at)} (${until(card.expires_at)})`),
  ])}
  <div class="actions">
    <a class="btn" href="/approvals">Decide it on the approval desk</a>
    <span class="meta">nothing is applied from this page</span>
  </div>
</li>`;
}

/**
 * The facts the card asserts, as one line.
 *
 * An empty `expect` is not nothing: the card still pinned the row's existence, so
 * it says so rather than printing an empty list, which would read as a card that
 * checks nothing before writing. `unset` for null, because a person reading a card
 * is not reading SQL — the same word `proposals.ts` uses in its refusal sentences,
 * and the two have to agree or one fact reads two ways.
 */
function asserts(pre: Precondition): string {
  const entries = Object.entries(pre?.expect ?? {});
  if (entries.length === 0) return `${pre?.table}/${shortId(pre?.id)} still exists`;
  return entries
    .map(([column, value]) => `${column} = ${value === null || value === undefined ? 'unset' : String(value)}`)
    .join('; ');
}

/**
 * Which draft produced which card.
 *
 * `Proposal` does not carry the precondition — the desk's read does not select it
 * — and the asserts line is the part of a card that matters most, so it comes off
 * the draft that made it.
 *
 * Paired on tool name and summary, consuming each draft once, rather than by
 * index. `recordProposals` returns one card per draft that LANDED and collapses
 * drafts sharing a write key, so the two lists are legitimately different lengths,
 * and pairing by position would print one card's pinned facts under another's
 * sentence — a wrong card, which is the one thing this whole path exists to
 * prevent. Consuming matters for the same reason at one remove: two cards with the
 * same sentence must not both claim the first draft's pinned facts. A card that
 * cannot be paired renders without the asserts line, which is the honest version
 * of not knowing.
 *
 * `src/cli.ts` pairs the same way for the same reason. It is duplicated rather
 * than shared because that file is an entry point that runs a command on import,
 * so importing it from here would run the CLI.
 */
function pair(cards: Proposal[], drafts: ProposalDraft[]): Array<{ card: Proposal; draft?: ProposalDraft }> {
  const unclaimed = [...drafts];
  return cards.map((card) => {
    const at = unclaimed.findIndex((d) => d.toolName === card.tool_name && d.summary === card.summary);
    const draft = at >= 0 ? unclaimed.splice(at, 1)[0] : undefined;
    return { card, draft };
  });
}

/* ─── the trace ─── */

/**
 * Every step, in order, with its own duration.
 *
 * The bar is the step's share of the run's wall clock. Bars can sum to more than
 * the run took, because independent tool calls in one turn are dispatched
 * together — `at +1.2s` is what says two of them overlapped, and it is text
 * rather than an offset on the bar because the stylesheet draws a length and not
 * a waterfall.
 */
function traceBlock(run: AgentRun): Html {
  if (run.trace.length === 0) {
    return html`<p class="meta">No steps were recorded, which means the run stopped before it
      called anything — the stop reason above is the whole of what happened.</p>`;
  }

  const total = Math.max(run.ms, 1);

  return html`<ol class="trace">${run.trace.map((step) => {
    const failed = step.kind === 'tool' && step.ok === false;
    // Clamped here rather than in CSS, because a page that can hand a stylesheet
    // a width over 100% is a page that can push a row off its own column.
    const share = Math.max(0, Math.min(100, Math.round((step.ms / total) * 100)));

    return html`<li>
    <div class="head">
      <span class="n">${step.step}.</span>
      <span class="mono">${step.kind === 'model' ? 'model' : (step.toolName ?? '(an unnamed tool)')}</span>
      <span class="num">${duration(step.ms)}</span>
      ${step.offsetMs === undefined ? '' : html`<span class="n">at +${duration(step.offsetMs)}</span>`}
      ${tokensOf(step)}
      ${failed ? html`<span class="failed">failed</span>` : ''}
      ${step.stop ? html`<span class="quiet">[${step.stop}]</span>` : ''}
    </div>
    ${
      // Verbatim, exactly as the model sent them and before validation, so a
      // refusal can be read next to what caused it.
      step.toolArgs === undefined ? '' : html`<pre>args ${compact(step.toolArgs, 400)}</pre>`
    }
    ${
      // Already cut to 500 characters by the loop. This is what the trace stores,
      // not everything the tool returned.
      step.output ? html`<pre>${step.output}</pre>` : ''
    }
    <span class="bar${failed ? ' is-seal' : ''}"><i style="--w:${share}%"></i></span>
  </li>`;
  })}</ol>`;
}

/**
 * What a step spent.
 *
 * A model step that reports no usage is charged pessimistically by the budget, so
 * saying which it is matters: "0 tokens" beside a run total of 6,506 would let a
 * reader conclude the step was free.
 */
function tokensOf(step: TraceStep): Html {
  if (step.kind === 'model') {
    const reported = (step.inputTokens ?? 0) + (step.outputTokens ?? 0);
    return reported > 0
      ? html`<span class="num">${figure(step.inputTokens ?? 0)} in / ${figure(step.outputTokens ?? 0)} out</span>`
      : html`<span class="quiet">usage not reported</span>`;
  }
  // Absent on a tool that only read the database, which is all of them in this
  // phase. A tool that calls a model of its own is charged here.
  return step.tokens ? html`<span class="num">${figure(step.tokens)} tok</span>` : html``;
}

/* ─── narration ─── */

/**
 * One event, as one line of the stream.
 *
 * The elapsed stamp is the useful part while waiting: a step that has been running
 * for nine seconds and one that just started look identical without it, and "which
 * of these is slow" is the first question anybody asks.
 *
 * The markup is deliberately a single line with no newlines in it. `.stream` is
 * `white-space: pre-wrap`, so a newline inside the fragment prints as a blank line
 * in the box.
 *
 * One departure from `src/cli.ts`'s narrator, and it is a departure on purpose: a
 * model turn with no text still gets a line here, carrying what it cost. On a
 * terminal the narration is transient and an empty line reads as the model saying
 * nothing; here the stream is the record of the run as it happened, and a step that
 * spent 1,900 tokens and said nothing is exactly the step worth seeing.
 *
 * Returns null for an event with nothing to say, so an empty frame is never sent.
 * Exported for `ask.test.ts`.
 */
export function narrationLine(event: RunEvent, startedAt: number): Html | null {
  const at = `+${((Date.now() - startedAt) / 1000).toFixed(1)}s`;

  switch (event.kind) {
    case 'thinking':
      return html`<div><span class="n">${at}</span> <span class="quiet">step ${event.step} — thinking</span></div>`;

    case 'thought': {
      const cost = `${duration(event.ms)}, ${figure(event.tokens)} tokens`;
      const said = event.text.trim() ? ` — ${clip(event.text, 160)}` : '';
      return html`<div><span class="n">${at}</span> <span class="quiet">step ${event.step} — ${cost}${said}</span></div>`;
    }

    case 'tool':
      return html`<div><span class="n">${at}</span> → <span class="mono">${event.name}</span> ${compact(event.args)}</div>`;

    case 'tool_done': {
      const cost = event.tokens > 0 ? ` ${figure(event.tokens)}tok` : '';
      const line = `${event.name} ${duration(event.ms)}${cost} — ${clip(event.preview, 140)}`;
      return event.ok
        ? html`<div><span class="n">${at}</span> ✓ ${line}</div>`
        : html`<div class="seal"><span class="n">${at}</span> ✗ ${line}</div>`;
    }

    case 'wall':
      // Announced the moment it is decided rather than only appearing in the
      // report: whoever is watching has been waiting, and is owed the reason
      // immediately.
      return html`<div class="seal"><span class="n">${at}</span> ! ${event.reason} — ${event.detail}</div>`;

    default: {
      // Unreachable today, and kept anyway. The loop owns this vocabulary and may
      // grow it; a kind this file has not been taught still gets a line, because
      // silence during a step that is happening is the exact thing the narration
      // exists to prevent. The cast is what makes that possible — the cases above
      // are exhaustive, so `event` is `never` here.
      const other = event as RunEvent;
      return html`<div><span class="n">${at}</span> <span class="quiet">${other.kind}</span></div>`;
    }
  }
}

/** Arguments as one short line. They came from the model, so nothing here can
 * assume they are printable — or serialisable. */
function compact(args: unknown, max = 80): string {
  let text: string;
  try {
    text = JSON.stringify(args) ?? String(args);
  } catch {
    text = '(unprintable arguments)';
  }
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/* ─── the browser's half ─── */

/**
 * The whole of the client-side code.
 *
 * `String.raw` so that `\n\n` reaches the browser as an escape sequence in the
 * JavaScript source rather than as two real newlines inside a string literal,
 * which is a syntax error and one that only appears in a browser.
 *
 * It does four things: stop the form navigating, POST it asking for a stream, put
 * each frame's markup where the frame says, and re-enable the button. The markup
 * was rendered and escaped on the server — see the note at the top of the file
 * about there being one renderer — so there is nothing here that builds HTML out
 * of a value.
 *
 * The one case it has to reason about is a response that is not a stream, which is
 * how a version of this file that refused before opening the stream would fail. It
 * says so rather than showing a blank page.
 */
const SCRIPT = String.raw`
(function () {
  var form = document.getElementById('ask');
  var box = document.getElementById('stream');
  var out = document.getElementById('report');
  var go = document.getElementById('go');
  if (!form || !box || !out || !go || !window.fetch || !window.TextDecoderStream) return;

  form.addEventListener('submit', async function (event) {
    event.preventDefault();
    box.hidden = false;
    box.textContent = '';
    out.textContent = '';
    go.disabled = true;
    try {
      var res = await fetch(form.action, {
        method: 'POST',
        headers: { accept: 'text/event-stream', 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(new FormData(form)),
      });
      if (!res.body || (res.headers.get('content-type') || '').indexOf('text/event-stream') !== 0) {
        out.textContent = 'The server answered with a page (' + res.status + ') rather than a stream. ' +
          'Reload and ask again with JavaScript off to read what it said.';
        return;
      }
      var reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      var buffer = '';
      for (;;) {
        var chunk = await reader.read();
        if (chunk.done) break;
        buffer += chunk.value;
        var cut;
        while ((cut = buffer.indexOf('\n\n')) !== -1) {
          var block = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);
          for (var line of block.split('\n')) {
            if (line.slice(0, 5) !== 'data:') continue; // ':' alone is the keep-alive
            var frame = JSON.parse(line.slice(5));
            if (frame.line) {
              box.insertAdjacentHTML('beforeend', frame.line);
              box.scrollTop = box.scrollHeight;
            }
            if (frame.report) out.innerHTML = frame.report;
          }
        }
      }
    } catch (err) {
      out.textContent = 'The stream stopped: ' + err + '. The run may have finished anyway — ' +
        'the runs page has the record.';
    } finally {
      go.disabled = false;
    }
  });
})();
`;
