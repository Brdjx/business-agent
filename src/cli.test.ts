/**
 * What the command line PRINTS, and what it refuses to do.
 *
 * This file exists because the output is the argument. The claim the repository
 * makes about writes is that a person can see a change described, see that it has
 * not happened, and then approve it — and every part of that claim is a sentence
 * on a terminal. A regression here does not fail a query or throw: it prints a
 * confident paragraph about hours being logged, over a card that was never
 * written, and nobody notices until they go looking in the table.
 *
 * So the assertions are about words and about exit codes. Three of them are about
 * something NOT happening, which is the half that is easy to lose: an ambiguous
 * prefix must not decide either card, a missing id must not reach the database,
 * and a proposal that failed to record must not be quietly absent from a block
 * whose heading says how many are waiting.
 *
 * ── How this drives the CLI ──
 *
 * `src/cli.ts` is a script: it runs on import and sets `process.exitCode`. So each
 * case sets `process.argv`, resets the module registry, imports it, and reads back
 * what was written to the two streams. `process.exitCode` is restored afterwards,
 * because a leftover non-zero code on the worker would make a passing suite report
 * a failure.
 *
 * The loop and the provider are replaced, so this suite spends no tokens; the
 * database is a queue of rows. Everything between — `trace.ts`, `proposals.ts`,
 * the write-key ledger — is the real code, because the ordering it enforces is
 * part of what these cases are about.
 *
 * Which is also the limit of what it proves. No SQL is executed anywhere in this
 * repository's suite, so a wrong column name or a statement Postgres rejects would
 * pass everything below.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/** `vi.hoisted`, because `vi.mock`'s factories are lifted above the imports. */
const h = vi.hoisted(() => ({
  /** Every statement the code sent, in order, with its parameters. */
  calls: [] as Array<{ text: string; params: unknown[] }>,
  /** What the next query returns, or the error it fails with. An unqueued query
   * returns no rows. */
  queue: [] as Array<unknown[] | { throws: unknown }>,
  /** What `runAgent` resolves to for the `ask` cases. */
  run: {} as Record<string, unknown>,
  /** The question the loop was actually handed. */
  asked: undefined as string | undefined,
}));

vi.mock('./db', () => {
  const next = (text: string, params: unknown[]): unknown[] => {
    h.calls.push({ text, params });
    const reply = h.queue.shift();
    if (reply && !Array.isArray(reply)) throw reply.throws;
    return reply ?? [];
  };
  return {
    sql: async (text: string, params: unknown[] = []) => next(text, params),
    one: async (text: string, params: unknown[] = []) => next(text, params)[0] ?? null,
    close: async () => {},
  };
});

vi.mock('./agent/loop', () => ({
  runAgent: async (opts: { question: string }) => {
    h.asked = opts.question;
    return h.run;
  },
}));

vi.mock('./agent/providers', () => ({
  providerFromEnv: () => ({ provider: { id: 'fake' }, model: 'fake-model' }),
}));

// `trace.ts` is deliberately NOT mocked. It owns the order the two tables are
// written in — the run first, the cards after, because `agent_proposals.run_id`
// points at `agent_runs` — and mocking it would leave this file asserting that
// the CLI prints a card while proving nothing about whether one could be written.

/* ─── ids, as the columns hold them ─── */

const USER = '00000000-0000-4000-8000-000000000001';
const CARD = '9f3c1a2b-4d5e-4f70-8123-456789abcdef';
const CARD_2 = '9f3c99aa-4d5e-4f70-8123-456789abcdef';
const OLDER = '4b7d0000-0000-4000-8000-000000000009';
const PROJECT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const RUN = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const HOUR = 3_600_000;
const hoursAgo = (n: number) => new Date(Date.now() - n * HOUR);
const hoursAhead = (n: number) => new Date(Date.now() + n * HOUR);

const SUMMARY =
  'Log 3.00h on 2026-08-04 against Dispatch Rewrite (Halden Freight) — platform work.';

/** A row of `agent_proposals`, as the desk's read returns it. */
function card(over: Record<string, unknown> = {}) {
  return {
    id: CARD,
    tool_name: 'log_time',
    summary: SUMMARY,
    target_table: 'projects',
    target_id: PROJECT,
    target_label: 'Dispatch Rewrite',
    status: 'pending',
    result: null,
    created_at: hoursAgo(4),
    decided_at: null,
    expires_at: hoursAhead(20),
    run_id: RUN,
    subject_key: null,
    origin: 'log 3 hours on dispatch for tuesday',
    ...over,
  };
}

/** The extra columns `decideProposal` selects on top of the card. */
const decidable = (over: Record<string, unknown> = {}) => ({
  ...card(over),
  args: { project: 'dispatch', entry_date: '2026-08-04', hours: '3.00' },
  write_key: 'deadbeefdeadbeefdeadbeefdeadbeef',
  precondition: { table: 'clients', id: PROJECT, expect: { status: 'active' } },
});

/** A draft as a write tool would return it on the propose path. */
const draft = (over: Record<string, unknown> = {}) => ({
  toolName: 'log_time',
  args: { project: 'dispatch', entry_date: '2026-08-04', hours: '3.00' },
  summary: SUMMARY,
  writeKey: 'deadbeefdeadbeefdeadbeefdeadbeef',
  target: { table: 'projects', id: PROJECT, label: 'Dispatch Rewrite' },
  precondition: { table: 'projects', id: PROJECT, expect: { rate_cents: '18500' } },
  evidence: [{ table: 'projects', id: PROJECT, label: 'Dispatch Rewrite' }],
  ...over,
});

const answered = (proposals: unknown[]) => ({
  answer: 'Nothing has been logged. The entry is waiting for your approval.',
  writesAllowed: false,
  stopReason: 'answered',
  stopDetail: 'the model answered',
  steps: 2,
  tokens: 900,
  ms: 1200,
  evidence: [{ table: 'projects', id: PROJECT, label: 'Dispatch Rewrite' }],
  trace: [],
  model: 'fake-model',
  provider: 'fake',
  proposals,
});

/* ─── driving it ─── */

interface Output {
  /** The answer and the receipts. */
  out: string;
  /** The narration, the refusals, the reasons. */
  err: string;
  code: number | undefined;
}

async function cli(...argv: string[]): Promise<Output> {
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    outChunks.push(String(chunk));
    return true;
  });
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    errChunks.push(String(chunk));
    return true;
  });

  const argvWas = process.argv;
  process.argv = ['node', 'cli.ts', ...argv];
  process.exitCode = undefined;
  vi.resetModules();
  try {
    await import('./cli');
  } finally {
    const code = process.exitCode;
    process.argv = argvWas;
    // Restored, so a case that exercises exit 1 does not hand the worker a
    // non-zero code and fail the whole file on its way out.
    process.exitCode = undefined;
    stdout.mockRestore();
    stderr.mockRestore();
    return { out: outChunks.join(''), err: errChunks.join(''), code };
  }
}

const queue = (...replies: Array<unknown[] | { throws: unknown }>) => h.queue.push(...replies);

/** What `persistRun`'s `INSERT ... RETURNING id` gives back. Queued first by every
 * `ask` case, because the run row has to exist before a card can point at it. */
const RUN_ROW = [{ id: RUN }];
const statements = () => h.calls.map((c) => c.text.replace(/\s+/g, ' ').trim());
const sawStatement = (fragment: string) => statements().some((s) => s.includes(fragment));

/** The statement `decideProposal` starts with. Nothing else in this file selects
 * a card by id, so its absence means no decision was reached. */
const DECIDE_LOOKUP = 'FROM agent_proposals p WHERE p.id = $1';
const SETTLE = 'UPDATE agent_proposals SET status = $2';

let logged: ReturnType<typeof vi.spyOn>;
let errored: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  h.calls.length = 0;
  h.queue.length = 0;
  h.run = answered([]);
  process.env.DATABASE_URL = 'postgres://fake/fake';
  process.env.USER_ID = USER;
  // `recordProposals` logs what it could not write, and one case below asserts on
  // the CLI's own report of that. Silenced so the suite's output is the suite's.
  logged = vi.spyOn(console, 'log').mockImplementation(() => {});
  errored = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  logged.mockRestore();
  errored.mockRestore();
});

/* ─── the invocation ─── */

describe('the invocation', () => {
  it('names both kinds of thing it accepts when given nothing', async () => {
    const { err, code } = await cli();
    expect(err).toContain('Nothing was asked');
    expect(err).toContain('proposals');
    expect(err).toContain('approve <id>');
    expect(code).toBe(2);
  });

  it('says what approve needs, and reads nothing to find out', async () => {
    const { err, code } = await cli('approve');
    expect(err).toContain('needs the id of the proposal to apply');
    expect(code).toBe(2);
    // Exit 2 promises that nothing was attempted. A lookup here would already
    // have contacted the database to discover an argument was missing.
    expect(h.calls).toHaveLength(0);
  });

  it('refuses a one-character prefix as a position rather than an id', async () => {
    const { err, code } = await cli('approve', '1');
    expect(err).toContain('too short');
    expect(err).toContain('position');
    expect(code).toBe(2);
    expect(h.calls).toHaveLength(0);
  });

  it('joins unquoted words into one question rather than asking the first one', async () => {
    const { code } = await cli('how', 'much', 'is', 'outstanding?');
    // A forgotten quote is five arguments in a shell, and asking "how" would
    // produce a fluent answer to a question nobody asked.
    expect(h.asked).toBe('how much is outstanding?');
    expect(code).toBe(0);
  });

  it('reads the first word as a subcommand only when it is exactly one', async () => {
    await cli('proposal', 'for', 'halden');
    // `proposal` is not `proposals`, so this is a question. The alternative — a
    // prefix match on the subcommand names — would silently swallow it.
    expect(h.asked).toBe('proposal for halden');
  });
});

/* ─── ask: the card ─── */

describe('a run that proposes', () => {
  it('says nothing has changed, and prints the row, the assertion and the id', async () => {
    h.run = answered([draft()]);
    // The run row, then the expiry sweep, then the insert.
    queue(RUN_ROW, [], [card()]);
    const { out, code } = await cli('ask', 'log 3 hours on dispatch for tuesday');

    expect(out).toContain('NOTHING HAS BEEN CHANGED');
    // The sentence the operator is deciding about, the row it resolved to, the
    // fact it asserts about that row, and the id. All four, or the card is not
    // enough to decide from.
    expect(out).toContain(SUMMARY);
    expect(out).toContain('projects/Dispatch Rewrite');
    expect(out).toContain('rate_cents = 18500');
    expect(out).toContain(CARD);
    expect(out).toContain(`approve ${CARD.slice(0, 8)}`);
    // Answered, and a card is not a failure.
    expect(code).toBe(0);
  });

  it('reports a proposal that could not be recorded instead of dropping it', async () => {
    h.run = answered([draft(), draft({ writeKey: 'f00d', summary: 'Set Halden Freight inactive.' })]);
    // The run row, the sweep, one insert that returns a row, one that returns nothing.
    queue(RUN_ROW, [], [card()], []);
    const { out } = await cli('ask', 'log time and deactivate halden');

    expect(out).toContain('1 proposal(s) could not be written to the desk');
    // And the one that landed is still approvable: a failure to record the second
    // must not lose the first.
    expect(out).toContain(CARD);
  });

  it('does not invent a lost proposal when two drafts are one act', async () => {
    // Same write key twice — the model asked for the same thing in one turn.
    // `recordProposals` collapses them, and one card for two drafts is correct.
    h.run = answered([draft(), draft()]);
    queue(RUN_ROW, [], [card()]);
    const { out } = await cli('ask', 'log 3 hours on dispatch, twice');

    expect(out).toContain('One change is waiting');
    expect(out).not.toContain('could not be written to the desk');
  });

  it('still says nothing changed when no card could be written at all', async () => {
    h.run = answered([draft()]);
    // The run row, the sweep, and an insert that comes back with nothing.
    queue(RUN_ROW, [], []);
    const { out } = await cli('ask', 'log 3 hours on dispatch for tuesday');

    expect(out).toContain('NOTHING HAS BEEN CHANGED');
    expect(out).toContain('1 proposal(s) could not be written to the desk');
    // Not "0 changes are waiting for your approval", which is the sentence a
    // count-driven heading produces and nobody can act on.
    expect(out).not.toContain('0 changes are waiting');
  });

  it('writes no card when the run proposed nothing', async () => {
    h.run = answered([]);
    queue(RUN_ROW);
    const { out } = await cli('ask', 'how much is outstanding?');
    expect(out).not.toContain('NOTHING HAS BEEN CHANGED');
    expect(sawStatement('INSERT INTO agent_proposals')).toBe(false);
  });
});

/* ─── proposals: the desk ─── */

describe('the desk', () => {
  it('lists the pending queue oldest first, with the question that produced it', async () => {
    queue([card({ id: CARD_2, created_at: hoursAgo(1) }), card({ id: OLDER, created_at: hoursAgo(9) })], []);
    const { out, code } = await cli('proposals');

    // The read returns newest first; the desk turns that around, because the
    // oldest card is the one closest to ageing out.
    expect(out.indexOf(OLDER.slice(0, 8))).toBeGreaterThan(-1);
    expect(out.indexOf(OLDER.slice(0, 8))).toBeLessThan(out.indexOf(CARD_2.slice(0, 8)));
    expect(out).toContain('9h ago');
    expect(out).toContain('log 3 hours on dispatch for tuesday');
    expect(code).toBe(0);
  });

  it('says an aged-out card that is still pending will refuse rather than apply', async () => {
    // Expired cards are retired by the sweep that runs when the agent next
    // proposes, so the desk is where one gets seen. "expires already expired" is
    // not a sentence, and an operator who approves it deserves to know first.
    queue([card({ expires_at: hoursAgo(1) })], []);
    const { out } = await cli('proposals');
    expect(out).toContain('aged out');
    expect(out).toContain('rejecting still clears it');
  });

  it('says a card whose run was never recorded has no question on file', async () => {
    queue([card({ origin: null })], []);
    const { out } = await cli('proposals');
    expect(out).toContain('not on file');
  });

  it('says the desk is clear rather than printing an empty heading', async () => {
    const { out, code } = await cli('proposals');
    expect(out).toContain('nothing is waiting');
    expect(code).toBe(0);
  });

  it('reports a failed read instead of an empty desk', async () => {
    // `listProposals` raises rather than coalescing an error to an empty list, and
    // this file must not undo that at the last step: "nothing is waiting on you"
    // is a statement about the business, and a broken query is not entitled to
    // make it (docs/incidents.md, entry 3).
    queue({ throws: new Error('relation "agent_runs" does not exist') });
    const { err, out, code } = await cli('proposals');

    expect(err).toContain('agent_runs');
    expect(err).toContain('an empty desk is a claim that nothing is waiting');
    expect(out).not.toContain('nothing is waiting.');
    expect(code).toBe(1);
  });
});

/* ─── approve and reject: one card ─── */

describe('deciding one card', () => {
  it('expands an unambiguous prefix to the full id', async () => {
    queue([card({ status: 'applied', decided_at: hoursAgo(2), result: 'Logged 3.00h.' })], [], [
      decidable({ status: 'applied', decided_at: hoursAgo(2), result: 'Logged 3.00h.' }),
    ]);
    const { out } = await cli('approve', '9f3c1a2b');

    const lookup = h.calls.find((c) => c.text.replace(/\s+/g, ' ').includes(DECIDE_LOOKUP));
    expect(lookup?.params[0]).toBe(CARD);
    // An already-decided card reports which way it went rather than pretending
    // this press did something.
    expect(out).toContain('already applied');
  });

  it('refuses an ambiguous prefix by listing the matches, and decides neither', async () => {
    queue([card(), card({ id: CARD_2 })], []);
    const { err, code } = await cli('approve', '9f3c');

    expect(err).toContain('matches 2 proposals');
    expect(err).toContain(CARD.slice(0, 8));
    expect(err).toContain(CARD_2.slice(0, 8));
    expect(code).toBe(2);
    // The important half: nothing was decided and nothing was settled.
    expect(sawStatement(DECIDE_LOOKUP)).toBe(false);
    expect(sawStatement(SETTLE)).toBe(false);
  });

  it('names what moved when the record changed under the card, and exits non-zero', async () => {
    queue([decidable()], [{ status: 'prospect' }], []);
    const { out, code } = await cli('approve', CARD);

    // Verbatim from decideProposal. The CLI must not reword a refusal: two
    // vocabularies for one event means one of them is eventually the stale one.
    expect(out).toContain('the client changed after this was proposed');
    expect(out).toContain('status is now prospect, not active');
    expect(out).toContain('not applied — stale');
    expect(code).toBe(1);
  });

  it('declines without touching the record, and exits zero', async () => {
    queue([decidable()], []);
    const { out, code } = await cli('reject', CARD);

    expect(out).toContain('declined');
    expect(out).toContain('Nothing was changed');
    expect(code).toBe(0);
    // A decline settles the card and re-reads nothing: clearing the desk is not
    // an action on the business.
    expect(sawStatement('FROM "clients"')).toBe(false);
  });

  it('exits non-zero when an approval finds the card already declined', async () => {
    queue([decidable({ status: 'declined', decided_at: hoursAgo(3) })]);
    const { out, code } = await cli('approve', CARD);

    expect(out).toContain('not applied — declined');
    // The operator asked for it to be applied and it was not. A decision having
    // been reached is not the same as the one they asked for.
    expect(code).toBe(1);
  });

  it('says a card that is not there is not there, without a stack trace', async () => {
    const { err, code } = await cli('approve', CARD);
    expect(err).toContain('No such proposal.');
    // The sentence, not a stack trace into a module the reader has never opened.
    expect(err).not.toContain('cli.ts:');
    expect(code).toBe(1);
  });
});
