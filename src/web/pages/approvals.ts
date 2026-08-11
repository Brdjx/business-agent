/**
 * The approval desk — the one screen this UI exists for.
 *
 * Everything else here reports what happened. This is the only surface where a
 * person does something, and what they do is authorise a change to a real
 * business record. So the rule the whole file is written to: it must say what has
 * NOT happened at least as loudly as what would.
 *
 * ── What is on a card, and why each line is there ──
 *
 * The card is the contract (docs/design.md §4). What the operator reads is what
 * gets applied, so every part of the claim is on the page rather than a summary
 * of it:
 *
 *   the summary — the sentence the tool wrote, unclipped and unreworded. This is
 *   the thing being consented to.
 *
 *   the row — table, label and the resolved id. "Set Halden Freight inactive" is
 *   ambiguous the moment two clients have similar names; the id is not.
 *
 *   the asserts line — the precondition, which is the line that matters most and
 *   the one a reader is most likely to mistake for decoration. So the sentence
 *   explaining it sits directly underneath: these facts are re-read immediately
 *   before anything is written, and approving REFUSES and names what moved if one
 *   of them has. Without that sentence the line is a row of column names; with
 *   it, it is the mechanism.
 *
 *   the question that produced it — a card the operator asked for and one the
 *   scheduled watch left while nobody was looking are different things to find
 *   waiting, and only the second needs explaining.
 *
 *   its age and its expiry — the oldest card is the one closest to ageing out and
 *   the one most likely to have been forgotten, which is why the list is oldest
 *   first, the reverse of the read's order.
 *
 * ── This page decides nothing ──
 *
 * `decideProposal` owns consent: ownership, whether the card is still pending,
 * whether it has aged out, and whether the pinned row still says what the card
 * said — in that order, and only past all four does the stored call run. This
 * module posts an id to it and renders what comes back. It never compares a
 * pinned value against the record, and `changedSincePropose` is deliberately not
 * exported for it to try. A precondition checked in a page module is a
 * precondition checked somewhere other than immediately before the write, which
 * is the failure the architecture is arranged to prevent.
 *
 * The one thing this page does read out of the precondition is its SHAPE, through
 * `readPin` — the same function the checker classifies with. Shared rather than
 * re-derived, because the alternative is a page saying "these will be re-read"
 * over a precondition the approval path is in fact going to refuse.
 *
 * ── The refusal is quoted, never reworded ──
 *
 * A refusal comes back as a `DecisionOutcome` with a status and a sentence, not
 * as an exception, because it is a result the operator is owed: the record moved
 * and here is what moved, the card aged out, it was already decided the other
 * way. That sentence is printed verbatim. Rewording it here would give the
 * operator a second vocabulary for the same event, and one of the two would
 * eventually be the stale one — `src/cli.ts` prints it verbatim for the same
 * reason, and the two surfaces have to agree.
 *
 * ── Why the POST renders instead of redirecting ──
 *
 * `server.ts` prefers a redirect after a write, and the reason is good: a reload
 * then cannot re-post. This route renders the desk directly anyway, because the
 * outcome sentence only exists in the return value. Carrying it through a
 * redirect would mean either putting model-adjacent prose in a query string —
 * where a crafted link could then show anybody a fabricated "applied" banner — or
 * reading the settled row back, which loses the one case that matters most: a
 * card that was ALREADY decided is not settled again, so its stored `result` is
 * the first decision's sentence and not "this press did nothing".
 *
 * What a reload costs is therefore stated on the page rather than engineered
 * away, and it is small: the card is no longer pending, so re-posting reports
 * which way it went, and the write key was claimed at apply time, so the act
 * itself cannot happen a second time.
 *
 * ── The empty desk is an answer ──
 *
 * "Nothing is waiting" is a claim about the business, and a page is only entitled
 * to make it when the read succeeded. `listProposals` raises rather than
 * returning an empty desk — that exact bug shipped in the private original, where
 * a broken join read as "or empty" and the desk went blank — and there is
 * deliberately no `catch` on the GET path here to undo it. A failed read becomes
 * the 500 page, which names the error.
 *
 * The POST path is the one place it IS caught, for the opposite reason: by then a
 * decision may have been applied, and a 500 whose own text says "a failed read
 * has changed nothing" would be a false report about a write that did happen. So
 * the outcome is rendered and the desk beneath it is replaced by the reason it
 * could not be read.
 */

import {
  decideProposal,
  listProposals,
  readPin,
  type Decision,
  type DecisionOutcome,
  type Proposal,
  type ProposalDesk,
  type ProposalStatus,
} from '../../agent/proposals';
import { html, safeUrl, type Html } from '../escape';
import {
  ago,
  clip,
  def,
  defs,
  empty,
  evidenceList,
  layout,
  meta,
  shortId,
  until,
  utcStamp,
} from '../layout';
import type { Ctx, Reply } from '../server';

/**
 * How much of the desk is shown.
 *
 * The same numbers `src/cli.ts` uses, and larger than `proposals.ts`'s own
 * default for pending, because this is the whole view: a card the desk does not
 * render is a card nobody decides. Both counts are compared against what came
 * back and a full page says so — a list silently cut at its limit is how "nothing
 * else is waiting" gets believed.
 */
const DESK_PENDING = 50;
const DESK_RECENT = 10;

/**
 * Any uuid version, as `proposals.ts` accepts one.
 *
 * Used for one thing only: choosing between 400 and 404 when a decision throws.
 * It is not a second gate — `decideProposal` refuses a malformed id itself, and
 * its sentence is what the page prints.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The two sentences `decideProposal` throws, recognised so that everything else
 * is not mistaken for them.
 *
 * It throws only for the caller having named something that is not a card: an id
 * that cannot be one, and no such row. Anything else reaching the catch came out
 * of the driver, and a database that is down must not be reported as a card that
 * does not exist — so those are re-thrown to the 500 page.
 *
 * Matching two literal strings is a real coupling and it is the cheapest honest
 * way to tell the cases apart. It fails safely: if `proposals.ts` rewords either
 * sentence, a missing card becomes a 500 page showing that same sentence, rather
 * than a 404 page showing the wrong one.
 */
const NOT_A_CARD = /^No such proposal\.$|is not a proposal id\.$/;

/** Statuses worth the accent. There is deliberately no success colour in this
 * design — a mark beside every applied card trains the eye to skip it — so the
 * seal is spent on the three outcomes where what the operator wanted did not
 * happen. `declined` is a decision somebody made and `superseded` is bookkeeping;
 * neither is news. */
const NEEDS_ATTENTION: ReadonlySet<ProposalStatus> = new Set<ProposalStatus>([
  'stale',
  'expired',
  'failed',
]);

/** What a press turned into. `refused` is the throw — no such card — and not one
 * of the four refusals, which arrive as an outcome with a sentence. */
type Result =
  | { kind: 'decided'; id: string; decision: Decision; outcome: DecisionOutcome }
  | { kind: 'refused'; id: string; why: string };

/* ─── the two handlers ─── */

/**
 * The desk.
 *
 * No `catch`. `listProposals` raises rather than returning an empty desk, and
 * this page must not undo that: an empty list here is a statement that nothing is
 * waiting on you, and a failed query is not entitled to make it
 * (docs/incidents.md, entry 3). The server's 500 page prints the sentence.
 */
export async function approvalsPage(ctx: Ctx): Promise<Reply> {
  const desk = await listProposals(ctx.userId, { pending: DESK_PENDING, recent: DESK_RECENT });
  return { kind: 'html', body: page({ desk, result: null, unreadable: null }) };
}

/**
 * One card, approved or rejected.
 *
 * `ensureToolsRegistered()` is deliberately NOT called here. `decideProposal`
 * calls it itself, and a page that helpfully called it first would hide exactly
 * the fault that shipped: an approval path whose registry was filled by whoever
 * happened to import the loop, so approving a write had never once worked in
 * production (docs/incidents.md, entry 1). If this file registered the tools,
 * deleting that call from `proposals.ts` would make no difference here.
 *
 * There is also no prefix resolution, unlike the CLI's `approve 9f3c1a2b`. A
 * prefix exists there because typing a whole uuid by hand is how a person
 * approves the wrong thing; a button posts the id it was rendered with, so there
 * is nothing to resolve and nothing to be ambiguous about.
 */
export async function approvalsDecide(ctx: Ctx): Promise<Reply> {
  const id = (ctx.params.id ?? '').trim();
  const asked = ctx.params.decision;

  // The router's pattern admits only these two words, so this is unreachable
  // today. It is written out rather than defaulted, because the obvious default —
  // treat anything that is not `approve` as a rejection — would record a decision
  // the operator never made, and telling somebody they rejected something is a
  // false statement about their own actions.
  if (asked !== 'approve' && asked !== 'reject') {
    return settled(
      ctx.userId,
      {
        kind: 'refused',
        id,
        why:
          `"${String(asked)}" is not a decision. A card is approved or rejected, and nothing ` +
          'was done to this one.',
      },
      400
    );
  }

  // `reject` in the url, `decline` in the record. The record's word is the one
  // that describes the state a card ends in, and the CLI accepts both spellings
  // for the same reason: somebody who read `declined` on the desk and typed it
  // back should not be told there is no such thing.
  const decision: Decision = asked === 'approve' ? 'approve' : 'decline';

  let outcome: DecisionOutcome;
  try {
    outcome = await decideProposal({ userId: ctx.userId, id, decision });
  } catch (err) {
    const why = messageOf(err);
    if (!NOT_A_CARD.test(why)) throw err;
    // 404 for a card that is not there, 400 for an id that cannot be one. Both
    // print `decideProposal`'s own sentence: a card belonging to somebody else
    // reads as absent rather than as forbidden, and this page must not be the
    // thing that tells a stranger the difference.
    return settled(ctx.userId, { kind: 'refused', id, why }, UUID.test(id) ? 404 : 400);
  }

  return settled(ctx.userId, { kind: 'decided', id, decision, outcome }, 200);
}

/**
 * The desk again, with what just happened above it.
 *
 * Re-read AFTER the decision, so the card that was just decided has left the
 * pending list and is in the decided one. A page that redisplayed the desk as it
 * was would still be offering approve and reject for a card that is settled.
 */
async function settled(userId: string, result: Result, status: number): Promise<Reply> {
  let desk: ProposalDesk | null = null;
  let unreadable: string | null = null;

  try {
    desk = await listProposals(userId, { pending: DESK_PENDING, recent: DESK_RECENT });
  } catch (err) {
    // Caught here and nowhere else. A decision may already have been applied, and
    // letting this reach the 500 page would report a failed read — whose own text
    // says nothing has changed — over a write that did happen.
    unreadable = messageOf(err);
  }

  return { kind: 'html', status, body: page({ desk, result, unreadable }) };
}

/* ─── the page ─── */

function page(opts: {
  desk: ProposalDesk | null;
  result: Result | null;
  unreadable: string | null;
}): string {
  const { desk, result, unreadable } = opts;

  // One of the two is always there: `settled` catches the read into `unreadable`,
  // and the GET path lets a failure raise instead. Written as an explicit fallback
  // rather than a `!` so that a third caller getting it wrong renders a sentence
  // rather than throwing inside the layout.
  const below =
    desk !== null
      ? deskBody(desk)
      : html`<div class="notice is-seal">
          <span class="label">the desk could not be read</span>
          <p>
            ${unreadable ??
            'The reason was not recorded, which is a fault in this page rather than in the desk.'}
          </p>
          <p class="meta">
            Reported rather than rendered as an empty desk, which would read as nothing being left
            to decide. Whatever is above this happened; what is below it is unknown.
          </p>
        </div>`;

  return layout({
    surface: 'approvals',
    title: 'Approvals',
    lede:
      'Writes the agent described and did not perform. Each one is approved on its own: ' +
      'consent belongs to an action, not to a session.',
    body: html`${result ? outcomeBlock(result, desk) : ''}${below}`,
  });
}

function deskBody(desk: ProposalDesk): Html {
  // Oldest first, the reverse of the read's order: the oldest card is the closest
  // to ageing out and the most likely to have been forgotten, so it goes where the
  // eye lands first.
  const pending = [...desk.pending].reverse();

  return html`<h2>Pending</h2>
    ${
      pending.length === 0
        ? empty({
            label: 'nothing is waiting',
            what:
              'No change is waiting for a decision. This is an answer rather than a silence: a ' +
              'failed read raises and this page reports the error, so an empty desk means the ' +
              'query succeeded and found nothing.',
            next: html`Ask something on <a href="${safeUrl('/')}">the ask surface</a>. A question
              that would change a record does not change it — it comes back as a card here, and
              applying it is a second, separate act.`,
          })
        : html`${waiting(pending.length)}
            <ul class="rows">
              ${pending.map(pendingCard)}
            </ul>
            ${
              pending.length === DESK_PENDING
                ? html`<p class="meta">
                    The oldest ${DESK_PENDING} of more than ${DESK_PENDING}. Decide some of these
                    to see the rest — this page will not claim a desk is empty because it stopped
                    counting.
                  </p>`
                : ''
            }`
    }

    <hr class="rule">

    <h2>Recently decided</h2>
    <p class="meta">
      Shown even when it is empty. “Did I approve that?” is the question the record exists to
      answer, and a desk of open cards cannot answer it.
    </p>
    ${
      desk.recent.length === 0
        ? empty({
            label: 'nothing has been decided yet',
            what:
              'No card has been approved, rejected, superseded, or left to age out without a ' +
              'decision.',
            next:
              'Deciding a card above puts it here with the sentence the tool returned — the ' +
              'applied result, or the reason it was refused.',
          })
        : html`<ul class="rows">
              ${desk.recent.map(decidedCard)}
            </ul>
            ${
              desk.recent.length === DESK_RECENT
                ? html`<p class="meta">
                    The last ${DESK_RECENT}. Older decisions are in
                    <span class="mono">agent_proposals</span>, which keeps every one of them: the
                    same write refused on Monday and approved on Tuesday is two records of two
                    decisions.
                  </p>`
                : ''
            }`
    }`;
}

/**
 * What the pending block says before any of the detail.
 *
 * The heading is `src/cli.ts`'s, in the words that matter — nothing — and it comes
 * first. The failure being designed against is an operator skimming a confident
 * paragraph about hours being logged and never reaching the line that says they
 * were not.
 */
function waiting(count: number): Html {
  return html`<div class="notice is-seal">
    <span class="label">nothing has been changed</span>
    <p>
      ${count === 1 ? 'One change is' : `${count} changes are`} waiting for your approval. The
      agent resolved the record, decided everything it would do, and then did not do it.
    </p>
    <p class="meta">
      Approving re-runs the stored call — the same tool, the same arguments, re-checked against
      the row the card pinned. The question is not asked again: an hour later the same words can
      resolve to a different row, or to the same row at a different rate.
    </p>
  </div>`;
}

/* ─── one pending card ─── */

function pendingCard(card: Proposal): Html {
  return html`<li>
    ${meta([
      html`<span class="mono">${shortId(card.id)}</span>`,
      html`<span class="mono">${card.tool_name}</span>`,
      ago(card.created_at),
      expiryNote(card.expires_at),
    ])}
    <p>${card.summary}</p>
    ${defs([
      def('row', rowValue(card)),
      def('asserts', assertsValue(card.precondition)),
      def('asked', askedValue(card)),
      def(
        'expires',
        html`${utcStamp(card.expires_at)} <span class="quiet">(${until(card.expires_at)})</span>`
      ),
      // Only when there is a run to point at. `run_id` is nullable and ON DELETE
      // SET NULL — a card whose trace was pruned, or whose run was never recorded,
      // is still a card — and a link to /runs/null would be a dead end that looks
      // like a bug in the trace rather than an absent one.
      card.run_id
        ? def(
            'from run',
            html`<a class="mono" href="${safeUrl(`/runs/${encodeURIComponent(card.run_id)}`)}">${shortId(card.run_id)}</a>`
          )
        : null,
    ])}
    <div class="actions">
      ${decideForm(card, 'approve')} ${decideForm(card, 'reject')}
    </div>
  </li>`;
}

/**
 * One button, one POST, one card.
 *
 * A form and not a link. A GET that applies a write is one prefetch, one crawler
 * or one `<img src>` away from being made by something nobody clicked, and there
 * is no GET spelling of either of these routes.
 *
 * The seal on approve is the whole of its meaning in this design: this button acts
 * on the business. Reject changes nothing about a record, so it is an ordinary
 * button.
 *
 * The id is percent-encoded on the way into the path even though a uuid needs
 * none. It comes out of a column, `safeUrl` checks the shape and not the
 * contents, and the router percent-decodes what it matches.
 *
 * The `sr-only` span is there because a desk of four cards has eight buttons and
 * two visible labels: what a screen reader announces has to say which card the
 * button belongs to, and the layout is what says that on screen.
 */
function decideForm(card: Proposal, decision: 'approve' | 'reject'): Html {
  const action = safeUrl(`/approvals/${encodeURIComponent(card.id)}/${decision}`);
  return html`<form method="post" action="${action}">
    <button type="submit" class="btn${decision === 'approve' ? ' is-seal' : ''}">
      ${decision === 'approve' ? 'Approve' : 'Reject'}
      <span class="sr-only">${card.tool_name} ${shortId(card.id)}</span>
    </button>
  </form>`;
}

/** The row the card resolved to, with its id. "Set Halden Freight inactive" is
 * ambiguous the moment two clients have similar names; the id is not. */
function rowValue(card: Proposal): Html {
  if (!card.target_table || !card.target_label) {
    return html`<span class="quiet">no row is recorded on this card</span>`;
  }
  return html`<span class="mono">${card.target_table}/${card.target_label}</span>${
    card.target_id ? html` <span class="id">${card.target_id}</span>` : ''
  }`;
}

/**
 * The question whose run left this card.
 *
 * Clipped, because a question can be four thousand characters and this is a line
 * on a card; the marker at the cut is `clip`'s, so a truncated question cannot be
 * read as the whole one. The absent case is `src/cli.ts`'s sentence: a card is
 * written even when the run was not recorded, and having no question to show is
 * not the same as there being no reason for the card.
 */
function askedValue(card: Proposal): Html {
  if (!card.origin) {
    return html`<span class="quiet">not on file — the run that proposed this was not recorded, so there is no question to show</span>`;
  }
  return html`“${clip(card.origin, 300)}”`;
}

/**
 * The asserts line, and the sentence that makes it mean something.
 *
 * Three cases, classified by `readPin` — the approval path's own function — so
 * that the sentence about what approving would do cannot disagree with what it
 * will do. The formatting of `expect` is this file's, and matches the CLI's.
 *
 * Nothing here compares a pinned value against the record. That comparison
 * happens once, in `decideProposal`, immediately before the write, and a copy of
 * it on a page rendered thirty seconds earlier would be worse than useless: it
 * would look like a check.
 */
function assertsValue(raw: unknown): Html {
  // Absent is not empty, and this branch is the difference between the two. Only
  // the pending read selects `precondition`; a card that arrived from any other
  // read has `undefined` here, and `readPin` would classify that as "pinned
  // nothing" — a confident, false statement about a card that pins two columns.
  // The column is NOT NULL with a `{}` default, so a value that is genuinely
  // empty is `{}` and is reported as such below.
  if (raw === undefined) {
    return html`<span class="seal">not read — this card was loaded without its precondition</span>
      <p class="meta">
        The facts it asserts cannot be shown, which is a fault in this page rather than in the
        card. Approving still checks them: the approval path re-reads the column itself. What is
        missing is your chance to read them first, so this is not a card to approve blind.
      </p>`;
  }

  const pin = readPin(raw);

  if (pin.kind === 'unusable') {
    return html`<span class="seal">could not be read — ${pin.why}</span>
      <p class="meta">
        A check that cannot be MADE is not a check that passed. The approval path refuses a
        precondition it cannot read, so approving this reports what could not be checked and
        changes nothing.
      </p>`;
  }

  if (pin.kind === 'none') {
    return html`<span class="seal">nothing is pinned</span>
      <p class="meta">
        This card asserts no facts about a row, so there is nothing for the approval path to
        re-read: approving runs the stored call as it stands. Every write tool in this repository
        pins its row and the columns the card depended on, so an empty precondition is worth
        understanding before approving it.
      </p>`;
  }

  const entries = Object.entries(pin.pre.expect);
  // An empty `expect` is not nothing: the card still pinned the row's existence,
  // so it says so rather than printing an empty list, which would read as a card
  // that checks nothing before writing.
  const facts =
    entries.length === 0
      ? `${pin.pre.table}/${shortId(pin.pre.id)} still exists`
      : entries.map(([column, value]) => `${column} = ${shown(value)}`).join('; ');

  return html`<span class="mono">${facts}</span>
    <p class="meta">
      Re-read immediately before anything is written. If one of these has moved — or cannot be
      re-read — approving refuses and names what changed, rather than applying a diff that no
      longer describes the record.
    </p>`;
}

/**
 * A pinned value as the card should read it.
 *
 * NULL is "unset", because a person reading a card is not reading SQL — the same
 * choice `proposals.ts` makes in its refusal sentences and `src/cli.ts` makes on
 * its cards. All three have to agree or the same fact reads three ways.
 *
 * An object is printed as JSON rather than through `String`, which would render
 * it as `[object Object]`. It comes from a JSONB column, so it can be anything.
 */
function shown(value: unknown): string {
  if (value === null || value === undefined) return 'unset';
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value) ?? '(unprintable value)';
    } catch {
      return '(unprintable value)';
    }
  }
  return String(value);
}

/**
 * What the desk says about a pending card's expiry.
 *
 * A pending card CAN be past it: expired cards are retired by the sweep that runs
 * when the agent next proposes something, not by a clock, so the desk is where one
 * gets seen. "Expires already expired" is not a sentence, so it says what will
 * happen instead — which is the part the operator can act on.
 *
 * The three branches mirror `proposals.ts`'s own comparison, deliberately and at
 * the cost of a duplication worth naming: a stamp nobody can parse is treated as
 * past there, so a card with one is refused and this page says so; a NULL is
 * treated as NOT past there, so this page must not claim the approval would be
 * refused. `expires_at` is NOT NULL, so a null is a fault in the row rather than a
 * state, and it is marked as one.
 */
function expiryNote(at: Date | string | null | undefined): Html {
  if (at === null || at === undefined) {
    return html`<span class="seal">no expiry is recorded on this card</span>`;
  }
  const t = new Date(at).getTime();
  if (Number.isNaN(t) || t <= Date.now()) {
    return html`<span class="seal">aged out — approving will refuse, rejecting still clears it</span>`;
  }
  return html`expires ${until(at)}`;
}

/* ─── one decided card ─── */

/**
 * A consequence, not a queue entry.
 *
 * The status and the sentence the tool returned are both here, because the
 * sentence is the useful half: "the client is no longer active" is what a stale
 * card is FOR. Not clipped — a refusal names what moved, and cutting it off is
 * cutting off the reason.
 */
function decidedCard(card: Proposal): Html {
  const attention = NEEDS_ATTENTION.has(card.status);

  return html`<li>
    ${meta([
      html`<span class="badge${attention ? ' is-seal' : ''}">${card.status}</span>`,
      html`<span class="mono">${shortId(card.id)}</span>`,
      html`<span class="mono">${card.tool_name}</span>`,
      ago(card.decided_at),
    ])}
    <p>${card.summary}</p>
    ${
      card.result
        ? html`<p class="meta">${card.result}</p>`
        : html`<p class="meta quiet">
            No result was recorded, which should not be possible for a settled card: every path
            that settles one writes the sentence it settled with.
          </p>`
    }
  </li>`;
}

/* ─── what just happened ─── */

/**
 * The outcome of the press, at the top of the page.
 *
 * `landed` compares what the operator ASKED for against what the card now is, in
 * that direction on purpose: approving a card that had already been DECLINED comes
 * back with status `declined` and a true sentence, and reporting that as a success
 * because a decision was reached would be agreeing with the wrong half of it.
 *
 * The message is `decideProposal`'s, verbatim and unsummarised.
 */
function outcomeBlock(result: Result, desk: ProposalDesk | null): Html {
  // What was decided, read back out of the record rather than remembered from the
  // request: after the POST the card has left the pending list, and an outcome with
  // no card beside it makes the operator go looking for what they just agreed to.
  const card = desk?.recent.find((c) => c.id === result.id) ?? null;

  if (result.kind === 'refused') {
    return html`<div class="notice is-seal">
      <span class="label">nothing was decided</span>
      <p>${result.why}</p>
      <p class="meta">
        The sentence is <span class="mono">decideProposal</span>’s. A card that belongs to
        somebody else reads as absent rather than as forbidden, so “no such proposal” is also
        what a card that is not yours says.
      </p>
    </div>`;
  }

  const { outcome, decision } = result;
  const wanted: ProposalStatus = decision === 'approve' ? 'applied' : 'declined';
  const landed = outcome.status === wanted;

  return html`<div class="notice${landed ? '' : ' is-seal'}">
    <span class="label">${landed ? outcome.status : `not ${wanted} — ${outcome.status}`}</span>
    ${lines(outcome.message)}
    ${
      card
        ? html`<p class="meta">
            The card: ${card.summary} <span class="mono">${shortId(card.id)}</span>
          </p>`
        : ''
    }
    ${
      outcome.evidence.length > 0
        ? html`<p class="label">evidence</p>
            ${evidenceList(outcome.evidence)}`
        : ''
    }
    ${
      landed && decision === 'approve'
        ? html`<p class="meta">
              <span class="mono">applied</span> means the stored call ran and returned the
              sentence above. It does not by itself mean a row changed: a write tool that
              declines at apply time — a project name that has become ambiguous since the card
              was written — returns a normal result saying nothing was logged, and is still
              recorded as applied. The label follows whether the call ran, which is a known open
              edge (docs/design.md §10).
            </p>
            <p class="meta">
              The write key for this act is claimed, so approving it again replays this result
              rather than doing it a second time.
            </p>`
        : ''
    }
    <p class="meta">
      Reloading this page re-posts the decision. The card is no longer pending, so it would
      report which way it went rather than deciding again.
    </p>
    <p class="meta">
      <span class="mono">select status, result, decided_at from agent_proposals where id = '${result.id}';</span>
    </p>
  </div>`;
}

/**
 * A message with newlines in it, as paragraphs.
 *
 * `decideProposal`'s sentences are single lines today and a tool's result is not
 * guaranteed to be: `result.content` is prose a write tool wrote. Rendering it as
 * one blob would run two sentences together, and `white-space: pre-wrap` would
 * make the rest of the block a different shape from every other paragraph on the
 * page.
 */
function lines(text: string): Html {
  const kept = text.split('\n').filter((line) => line.trim() !== '');
  if (kept.length === 0) {
    // A tool that settled a card with an empty string. Said out loud, because an
    // outcome heading with nothing under it reads as a page that failed to render.
    return html`<p class="quiet">
      The decision was recorded with no sentence explaining it, which is a fault in whatever
      wrote it rather than something you did.
    </p>`;
  }
  return html`${kept.map((line) => html`<p>${line}</p>`)}`;
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));
