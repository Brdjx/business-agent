/**
 * The approval desk.
 *
 * These assertions are about the WORDS on the page and about what the page does
 * not do, because that is where this screen's value is. A test that checked the
 * markup rendered would pass while the desk showed a card with no asserts line,
 * reworded a refusal into something friendlier, or printed an empty desk over a
 * failed read — and each of those is the mechanism this repository is about
 * quietly going missing.
 *
 * Four things are pinned here on purpose:
 *
 * **The refusal is quoted.** `decideProposal` returns the sentence that says which
 * refusal happened — the record moved and what moved, the card aged out, it was
 * already decided — and the page must print it verbatim. A second vocabulary for
 * the same event is how one of the two ends up stale.
 *
 * **The asserts line comes with its sentence.** Without it the line is a row of
 * column names, and a reader who does not know that those facts are re-read
 * immediately before the write has no reason to care about them.
 *
 * **Nothing on this page checks a precondition.** The db module is mocked to throw
 * if it is touched at all, so a page that grew a query of its own fails here. The
 * classification of a stored precondition is `readPin`'s — the approval path's own
 * function, deliberately left un-mocked below — and the comparison against the
 * record is `decideProposal`'s alone.
 *
 * **A failed read is not an empty desk.** `listProposals` raises, and the GET path
 * lets it: the 500 page names the error. The POST path catches it, because by then
 * a write may have happened and a page claiming nothing changed would be a false
 * report.
 *
 * What is NOT covered: nothing here renders in a browser, so this says nothing
 * about whether the desk is legible, and the SQL behind `listProposals` is not
 * executed by any of it.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { DecisionOutcome, Proposal, ProposalDesk } from '../../agent/proposals';
import type { Ctx, Reply } from '../server';

/** `vi.hoisted`, because `vi.mock`'s factory is lifted above the imports. */
const h = vi.hoisted(() => ({
  desk: { pending: [], recent: [] } as ProposalDesk,
  deskError: null as unknown,
  decided: [] as Array<{ userId: string; id: string; decision: string }>,
  outcome: null as DecisionOutcome | null,
  decideError: null as unknown,
}));

/**
 * The page must not query.
 *
 * Every read it needs belongs to a module that owns the table. A mock that throws
 * is how "this page has no SQL of its own" stays true after somebody adds a
 * column they want to show.
 */
vi.mock('../../db', () => {
  const refuse = () => {
    throw new Error('the approvals page must not query the database itself');
  };
  return { sql: refuse, one: refuse, close: async () => {} };
});

/**
 * Only the two entry points are replaced. `readPin` is the real one, because the
 * page classifying a precondition differently from the code that enforces it is
 * the specific bug worth failing on.
 */
vi.mock('../../agent/proposals', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../agent/proposals')>();
  return {
    ...actual,
    listProposals: async (): Promise<ProposalDesk> => {
      if (h.deskError) throw h.deskError;
      return h.desk;
    },
    decideProposal: async (opts: {
      userId: string;
      id: string;
      decision: string;
    }): Promise<DecisionOutcome> => {
      h.decided.push({ userId: opts.userId, id: opts.id, decision: opts.decision });
      if (h.decideError) throw h.decideError;
      if (!h.outcome) throw new Error('the test queued no outcome');
      return h.outcome;
    },
  };
});

import { approvalsDecide, approvalsPage } from './approvals';

/* ─── ids, as the columns hold them ─── */

const USER = '00000000-0000-4000-8000-000000000001';
const CARD = '9f3c1a2b-4c5d-4e6f-8a9b-0c1d2e3f4a5b';
const CARD_2 = '22222222-2222-4222-8222-222222222222';
const CLIENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const RUN = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const HOUR = 3_600_000;

/* ─── fixtures ─── */

function pending(over: Partial<Proposal> = {}): Proposal {
  return {
    id: CARD,
    tool_name: 'set_client_status',
    summary: 'Set Halden Freight from active to inactive',
    target_table: 'clients',
    target_id: CLIENT,
    target_label: 'Halden Freight',
    status: 'pending',
    result: null,
    created_at: new Date(Date.now() - 4 * HOUR),
    decided_at: null,
    expires_at: new Date(Date.now() + 20 * HOUR),
    run_id: RUN,
    subject_key: null,
    origin: 'should we mark Halden Freight inactive?',
    precondition: {
      table: 'clients',
      id: CLIENT,
      expect: { status: 'active', engagement_kind: 'client' },
    },
    ...over,
  };
}

function decided(over: Partial<Proposal> = {}): Proposal {
  return {
    ...pending(),
    status: 'applied',
    result: 'Halden Freight is now inactive.',
    decided_at: new Date(Date.now() - 3 * 60_000),
    ...over,
  };
}

const ctx = (over: Partial<Ctx> = {}): Ctx =>
  ({
    // Neither is touched by this page: it returns a Reply and lets the server
    // write it.
    req: {} as never,
    res: {} as never,
    url: new URL('http://localhost/approvals'),
    userId: USER,
    params: {},
    form: new URLSearchParams(),
    ...over,
  }) as Ctx;

/** The rendered document, with a sentence rather than a type error when a handler
 * returned something else. */
function body(reply: Reply): string {
  if (reply.kind !== 'html') throw new Error(`expected an html reply, got "${reply.kind}"`);
  return reply.body;
}

const press = (id: string, decision: string): Promise<Reply> =>
  approvalsDecide(ctx({ params: { id, decision } }));

beforeEach(() => {
  h.desk = { pending: [], recent: [] };
  h.deskError = null;
  h.decided.length = 0;
  h.outcome = null;
  h.decideError = null;
});

/* ═══ the pending card ═══ */

describe('a card waiting for a decision', () => {
  it('carries every part of the claim', async () => {
    h.desk = { pending: [pending()], recent: [] };
    const out = body(await approvalsPage(ctx()));

    // The sentence being consented to, unclipped and unreworded.
    expect(out).toContain('Set Halden Freight from active to inactive');
    // The row, and the id — "Halden Freight" is ambiguous the moment two clients
    // have similar names.
    expect(out).toContain('clients/Halden Freight');
    expect(out).toContain(CLIENT);
    // The facts it asserts, in the same shape the CLI prints them.
    expect(out).toContain('status = active; engagement_kind = client');
    // The question that produced it, and the run it came from.
    expect(out).toContain('should we mark Halden Freight inactive?');
    expect(out).toContain(`href="/runs/${RUN}"`);
    // Its age and its expiry.
    expect(out).toContain('4h ago');
    expect(out).toContain('expires in 20h');
  });

  it('says the asserts line is re-read before the write, next to the line', async () => {
    h.desk = { pending: [pending()], recent: [] };
    const out = body(await approvalsPage(ctx()));

    // Without this sentence the line above reads as decoration.
    expect(out).toContain('Re-read immediately before anything is written');
    expect(out).toContain('approving refuses and names what changed');
  });

  it('says that nothing has been changed, before any of the detail', async () => {
    h.desk = { pending: [pending()], recent: [] };
    const out = body(await approvalsPage(ctx()));

    expect(out).toContain('nothing has been changed');
    expect(out).toContain('One change is waiting for your approval');
    // And the notice comes before the card it is about: an operator who skims a
    // confident paragraph must not reach the disclaimer last.
    expect(out.indexOf('nothing has been changed')).toBeLessThan(
      out.indexOf('Set Halden Freight from active to inactive')
    );
  });

  it('offers approve and reject as POSTs, and offers no GET spelling of either', async () => {
    h.desk = { pending: [pending()], recent: [] };
    const out = body(await approvalsPage(ctx()));

    expect(out).toContain(`<form method="post" action="/approvals/${CARD}/approve">`);
    expect(out).toContain(`<form method="post" action="/approvals/${CARD}/reject">`);
    // A GET that applies a write is one prefetch away from being made by
    // something nobody clicked, so no link anywhere on the page points at a
    // decision.
    expect(out).not.toMatch(/href="[^"]*\/(approve|reject)"/);
    // The seal means "this button acts on the business", and it is on approve only.
    expect(out).toMatch(/class="btn is-seal">\s*Approve/);
    expect(out).toMatch(/class="btn">\s*Reject/);
  });

  it('puts the oldest card first, because it is the one closest to ageing out', async () => {
    // The read hands back newest first; the desk reverses it.
    h.desk = {
      pending: [
        pending({ id: CARD_2, summary: 'newer card' }),
        pending({ id: CARD, summary: 'older card' }),
      ],
      recent: [],
    };
    const out = body(await approvalsPage(ctx()));
    expect(out.indexOf('older card')).toBeLessThan(out.indexOf('newer card'));
    expect(out).toContain('2 changes are waiting');
  });

  it('escapes a summary a language model wrote', async () => {
    // The summary, the label and the question all end up in markup, and the first
    // was written by a model that had just read a database somebody else fills in.
    h.desk = {
      pending: [
        pending({
          summary: '<script>alert(1)</script>',
          target_label: '"><b>Halden</b>',
          origin: "it's <em>fine</em>",
        }),
      ],
      recent: [],
    };
    const out = body(await approvalsPage(ctx()));

    expect(out).not.toContain('<script>alert(1)');
    expect(out).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(out).not.toContain('<b>Halden</b>');
    expect(out).toContain('&#39;');
  });

  it('says what will happen to a card that has already aged out', async () => {
    // A pending card can be past its expiry: expired cards are retired by the
    // sweep that runs when the agent next proposes, not by a clock.
    h.desk = { pending: [pending({ expires_at: new Date(Date.now() - HOUR) })], recent: [] };
    const out = body(await approvalsPage(ctx()));
    expect(out).toContain('aged out — approving will refuse, rejecting still clears it');
  });

  it('says a card with no question on file has no question on file', async () => {
    h.desk = { pending: [pending({ origin: null, run_id: null })], recent: [] };
    const out = body(await approvalsPage(ctx()));
    expect(out).toContain('the run that proposed this was not recorded');
    // No link to a run that is not there: /runs/null is a dead end that reads as
    // a broken trace rather than an absent one.
    expect(out).not.toContain('href="/runs/');
  });
});

/* ═══ the asserts line, in the cases that are not a happy row ═══ */

describe('the facts a card asserts', () => {
  it('marks a precondition the approval path could not read', async () => {
    h.desk = { pending: [pending({ precondition: 'not an object' })], recent: [] };
    const out = body(await approvalsPage(ctx()));

    expect(out).toContain('could not be read');
    // readPin's own sentence, so the page and the checker cannot disagree about
    // what is wrong with it.
    expect(out).toContain('the stored precondition is not an object');
    // And what that means for the button below it.
    expect(out).toContain('A check that cannot be MADE is not a check that passed');
  });

  it('marks a card that pinned nothing at all', async () => {
    // `{}` is the column default: nothing to compare, so approving proceeds
    // without that check. Worth seeing before pressing the button.
    h.desk = { pending: [pending({ precondition: {} })], recent: [] };
    const out = body(await approvalsPage(ctx()));

    expect(out).toContain('nothing is pinned');
    // Not the whole clause: the markup wraps, so a contiguous match would be
    // asserting where the line breaks in the source rather than what it says.
    expect(out).toContain('nothing for the approval path to');
    // Not the sentence that promises a re-read, which would be false here.
    expect(out).not.toContain('Re-read immediately before anything is written');
  });

  it('tells a card loaded without its precondition apart from one that pinned nothing', async () => {
    // Only the pending read selects the column. A card from any other read has
    // `undefined` here, and reporting that as "nothing is pinned" would be a
    // confident false statement about a card that pins two columns.
    const { precondition: _dropped, ...withoutIt } = pending();
    h.desk = { pending: [withoutIt as Proposal], recent: [] };
    const out = body(await approvalsPage(ctx()));

    expect(out).toContain('this card was loaded without its precondition');
    expect(out).toContain('not a card to approve blind');
    expect(out).not.toContain('nothing is pinned');
  });

  it('reports a row-only precondition as the existence check it is', async () => {
    h.desk = {
      pending: [pending({ precondition: { table: 'clients', id: CLIENT, expect: {} } })],
      recent: [],
    };
    const out = body(await approvalsPage(ctx()));
    // An empty `expect` is not nothing: the card pinned the row's existence.
    expect(out).toContain('clients/aaaaaaaa still exists');
  });

  it('says "unset" for a pinned null, the way the refusal does', async () => {
    h.desk = {
      pending: [
        pending({ precondition: { table: 'clients', id: CLIENT, expect: { notes: null } } }),
      ],
      recent: [],
    };
    expect(body(await approvalsPage(ctx()))).toContain('notes = unset');
  });
});

/* ═══ the empty desk ═══ */

describe('an empty desk', () => {
  it('says nothing is waiting, and what would put something there', async () => {
    const out = body(await approvalsPage(ctx()));

    expect(out).toContain('nothing is waiting');
    // An answer rather than a silence.
    expect(out).toContain('an answer rather than a silence');
    expect(out).toContain('comes back as a card here');
    // The decided half is shown even when it is empty: "did I approve that?" is
    // the question the record exists to answer.
    expect(out).toContain('nothing has been decided yet');
  });

  it('does not render an empty desk when the read failed', async () => {
    h.deskError = new Error('Could not read the proposals: relation does not exist.');
    // No catch on this path. An empty list reads as "nothing is waiting on you",
    // which a broken query is not entitled to claim, so the server's 500 page
    // names the error instead.
    await expect(approvalsPage(ctx())).rejects.toThrow(/Could not read the proposals/);
  });
});

/* ═══ deciding ═══ */

describe('pressing approve or reject', () => {
  it('sends the operator, the card and the decision the record uses', async () => {
    h.outcome = { status: 'applied', message: 'Halden Freight is now inactive.', evidence: [] };
    await press(CARD, 'approve');
    expect(h.decided).toEqual([{ userId: USER, id: CARD, decision: 'approve' }]);

    h.outcome = { status: 'declined', message: 'Declined. Nothing was changed.', evidence: [] };
    await press(CARD, 'reject');
    // `reject` in the url, `decline` in the record: the record's word is the one
    // that describes the state a card ends in.
    expect(h.decided[1]).toEqual({ userId: USER, id: CARD, decision: 'decline' });
  });

  it('shows the applied result, and what applied does not mean', async () => {
    h.outcome = {
      status: 'applied',
      message: 'Halden Freight is now inactive.',
      evidence: [{ table: 'clients', id: CLIENT, label: 'Halden Freight' }],
    };
    h.desk = { pending: [], recent: [decided()] };
    const out = body(await press(CARD, 'approve'));

    expect(out).toContain('Halden Freight is now inactive.');
    // The evidence with its id, because that is what makes the claim checkable.
    expect(out).toContain(CLIENT);
    // The open edge, said out loud: the label follows whether the call RAN.
    expect(out).toContain('does not by itself mean a row changed');
    expect(out).toContain('The write key for this act is claimed');
  });

  it('quotes a refusal in the words decideProposal used', async () => {
    const moved =
      'Not applied: the client changed after this was proposed — status is now prospect, not ' +
      'active. Ask again so the proposal describes what is there now.';
    h.outcome = { status: 'stale', message: moved, evidence: [] };
    const out = body(await press(CARD, 'approve'));

    // Verbatim. Rewording it here would give the operator a second vocabulary for
    // the same event, and one of the two would eventually be the stale one.
    expect(out).toContain('status is now prospect, not active');
    expect(out).toContain('Ask again so the proposal describes what is there now');
    // And the heading says the thing the operator asked for did not happen.
    expect(out).toContain('not applied — stale');
    expect(out).toContain('notice is-seal');
  });

  it('reports a card that had already been decided as not having been decided again', async () => {
    h.outcome = {
      status: 'declined',
      message: 'This was already declined on 2026-08-10 14:30. Declined. Nothing was changed.',
      evidence: [],
    };
    const out = body(await press(CARD, 'approve'));

    // A button pressed twice must not read as two approvals.
    expect(out).toContain('not applied — declined');
    expect(out).toContain('This was already declined on 2026-08-10 14:30');
    expect(out).not.toContain('does not by itself mean a row changed');
  });

  it('reports an expired card as the refusal it is', async () => {
    const aged =
      'This proposal has aged out and was not applied. Ask again if it is still wanted — the ' +
      'records may have changed since it was written.';
    h.outcome = { status: 'expired', message: aged, evidence: [] };
    const out = body(await press(CARD, 'approve'));
    expect(out).toContain('not applied — expired');
    expect(out).toContain('has aged out and was not applied');
  });

  it('treats a decline as having landed, including for an expired card', async () => {
    // Clearing the desk is not an action on the business, so declining is always
    // available and is not a refusal.
    h.outcome = { status: 'declined', message: 'Declined. Nothing was changed.', evidence: [] };
    const out = body(await press(CARD, 'reject'));
    expect(out).toContain('Declined. Nothing was changed.');
    expect(out).not.toContain('not declined');
  });

  it('re-reads the desk after deciding, so a settled card keeps no buttons', async () => {
    h.outcome = { status: 'applied', message: 'done', evidence: [] };
    h.desk = { pending: [], recent: [decided()] };
    const out = body(await press(CARD, 'approve'));
    expect(out).not.toContain(`action="/approvals/${CARD}/approve"`);
    expect(out).toContain('nothing is waiting');
  });

  it('says what happened even when the desk cannot be read afterwards', async () => {
    // The decision may already have been applied. A 500 whose own text says a
    // failed read has changed nothing would be a false report about a write that
    // did happen.
    h.outcome = { status: 'applied', message: 'Halden Freight is now inactive.', evidence: [] };
    h.deskError = new Error('Could not read the proposals: the connection was closed.');
    const out = body(await press(CARD, 'approve'));

    expect(out).toContain('Halden Freight is now inactive.');
    expect(out).toContain('the desk could not be read');
    expect(out).toContain('the connection was closed');
    expect(out).not.toContain('nothing is waiting');
  });
});

describe('a press at something that is not a card', () => {
  it('renders no-such-proposal as a 404 with the desk under it', async () => {
    h.decideError = new Error('No such proposal.');
    const reply = await press(CARD, 'approve');

    expect(reply).toMatchObject({ kind: 'html', status: 404 });
    const out = body(reply);
    expect(out).toContain('nothing was decided');
    expect(out).toContain('No such proposal.');
    // A card belonging to somebody else reads as absent rather than as forbidden,
    // and the page says so rather than confirming the row exists.
    expect(out).toContain('reads as absent rather than as forbidden');
    // Still a desk, because the operator pressed a button and is owed the state
    // they are looking at.
    expect(out).toContain('nothing is waiting');
  });

  it('renders an id that cannot be one as a 400', async () => {
    h.decideError = new Error('"potato" is not a proposal id.');
    const reply = await press('potato', 'approve');
    expect(reply).toMatchObject({ kind: 'html', status: 400 });
    expect(body(reply)).toContain('is not a proposal id.');
  });

  it('refuses a decision that is neither word without reaching the desk logic', async () => {
    const reply = await press(CARD, 'maybe');
    expect(reply).toMatchObject({ kind: 'html', status: 400 });
    // Not defaulted to a rejection: telling somebody they rejected something is a
    // false statement about their own actions.
    expect(body(reply)).toContain('is not a decision');
    expect(h.decided).toHaveLength(0);
  });

  it('does not report a database failure as a card that is not there', async () => {
    h.decideError = new Error('connect ECONNREFUSED 127.0.0.1:5432');
    // Anything that is not one of decideProposal's two sentences came out of the
    // driver, and a database that is down is a 500 rather than a missing card.
    await expect(press(CARD, 'approve')).rejects.toThrow(/ECONNREFUSED/);
  });
});

/* ═══ what was decided ═══ */

describe('recently decided', () => {
  it('shows the outcome and the sentence the tool returned', async () => {
    h.desk = { pending: [], recent: [decided()] };
    const out = body(await approvalsPage(ctx()));

    expect(out).toContain('>applied<');
    expect(out).toContain('Halden Freight is now inactive.');
    expect(out).toContain('3m ago');
    // The consequence, not just the queue: what was proposed is here too.
    expect(out).toContain('Set Halden Freight from active to inactive');
  });

  it('spends the accent on the outcomes where what was wanted did not happen', async () => {
    h.desk = {
      pending: [],
      recent: [
        decided({ status: 'stale', result: 'the client changed after this was proposed' }),
        decided({ id: CARD_2, status: 'declined', result: 'Declined. Nothing was changed.' }),
      ],
    };
    const out = body(await approvalsPage(ctx()));

    // A refusal is news; a decision somebody made is not. There is deliberately
    // no success colour in this design, so `applied` and `declined` are unmarked.
    expect(out).toContain('<span class="badge is-seal">stale</span>');
    expect(out).toContain('<span class="badge">declined</span>');
  });

  it('says when the list is only the last page of decisions', async () => {
    h.desk = {
      pending: [],
      recent: Array.from({ length: 10 }, (_unused, i) => decided({ id: `${i}`.repeat(8) })),
    };
    const out = body(await approvalsPage(ctx()));
    expect(out).toContain('Older decisions are in');
    expect(out).toContain('agent_proposals');
  });
});
