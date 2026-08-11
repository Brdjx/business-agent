/**
 * The record of a run, with Postgres replaced by a queue of rows.
 *
 * One thing here is asserted nowhere else, and it is the reason the file exists:
 * the run row is written BEFORE the cards that point at it.
 * `agent_proposals.run_id` is a foreign key into `agent_runs`, and
 * `recordProposals` swallows what it cannot write — correctly, because a lost card
 * is better than a lost answer — so the wrong order produces a run that reads as
 * fully recorded with the write the operator was supposed to decide about missing,
 * and nothing anywhere says so. That failure is silent by construction, which is
 * exactly the kind this repository writes tests for.
 *
 * `./proposals` is mocked rather than driven. What `recordProposals` does with a
 * draft has twenty-eight tests of its own next door; what is being checked here is
 * WHEN it is called and with which run id.
 *
 * What this file does NOT cover: none of this SQL has been executed. The mock
 * returns whatever it was queued, so a wrong column name in the insert would pass
 * every assertion below, and `persistRun`'s statement has no test in this
 * repository at all.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

/** `vi.hoisted`, because `vi.mock`'s factory is lifted above the imports. */
const h = vi.hoisted(() => ({
  calls: [] as Array<{ text: string; params: unknown[] }>,
  queue: [] as Array<unknown[] | { throws: unknown }>,
  /**
   * Every call to `recordProposals`, with the number of statements the database
   * had already seen at that moment. That count is the ordering assertion: one
   * means the run was inserted first, zero means the cards went first and the
   * foreign key would have rejected them.
   */
  recorded: [] as Array<{
    userId: string;
    runId: string | null;
    drafts: unknown[];
    dbCallsBefore: number;
  }>,
}));

vi.mock('../db', () => {
  const next = (text: string, params: unknown[]) => {
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

vi.mock('./proposals', () => ({
  recordProposals: async (userId: string, runId: string | null, drafts: unknown[]) => {
    h.recorded.push({ userId, runId, drafts, dbCallsBefore: h.calls.length });
    return drafts.map((_draft, i) => ({ id: `card-${i}`, status: 'pending' }));
  },
}));

import { persistRun, persistRunAndProposals } from './trace';
import type { AgentRun } from './loop';
import type { ProposalDraft } from './tools';

const USER = '00000000-0000-4000-8000-000000000001';
const RUN = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const PRE_ALLOCATED = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

const queue = (...replies: Array<unknown[] | { throws: unknown }>) => h.queue.push(...replies);

const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

beforeEach(() => {
  h.calls.length = 0;
  h.queue.length = 0;
  h.recorded.length = 0;
  errors.mockClear();
});

const draft = (over: Partial<ProposalDraft> = {}): ProposalDraft => ({
  toolName: 'log_time',
  args: { project_name: 'Dispatch', entry_date: '2026-08-04', hours: 3 },
  summary: 'Log 3.00h on 2026-08-04 against Dispatch Rewrite',
  writeKey: 'writekey-log-3h',
  target: { table: 'projects', id: 'p1', label: 'Dispatch Rewrite' },
  precondition: { table: 'projects', id: 'p1', expect: { rate_cents: '18500' } },
  evidence: [{ table: 'projects', id: 'p1', label: 'Dispatch Rewrite' }],
  ...over,
});

const agentRun = (over: Partial<AgentRun> = {}): AgentRun => ({
  answer: 'Halden Freight owes $16,500 on INV-1008.',
  writesAllowed: false,
  stopReason: 'answered',
  stopDetail: 'Answered.',
  steps: 2,
  tokens: 300,
  ms: 1_200,
  evidence: [{ table: 'invoices', id: 'i8', label: 'INV-1008' }],
  proposals: [],
  trace: [{ step: 1, kind: 'model', ms: 900, output: 'looking that up' }],
  model: 'test-model-1',
  provider: 'fake',
  ...over,
});

describe('recording a run and the cards it left', () => {
  it('writes the run first, then the cards, with the id the insert returned', async () => {
    queue([{ id: RUN }]);

    const out = await persistRunAndProposals(USER, 'log 3 hours against dispatch', agentRun({ proposals: [draft()] }));

    expect(out.runId).toBe(RUN);
    expect(out.proposals).toHaveLength(1);

    expect(h.recorded).toHaveLength(1);
    // The ordering assertion. One statement had already run — the insert into
    // agent_runs — so the row the card points at existed before the card did.
    expect(h.recorded[0].dbCallsBefore).toBe(1);
    expect(h.calls[0].text).toContain('INSERT INTO agent_runs');
    expect(h.recorded[0].runId).toBe(RUN);
    expect(h.recorded[0].userId).toBe(USER);
  });

  it('records the cards with no run id when the trace could not be written', async () => {
    queue({ throws: new Error('relation "agent_runs" does not exist') });

    const out = await persistRunAndProposals(
      USER,
      'log 3 hours against dispatch',
      agentRun({ proposals: [draft()] }),
      // Pre-allocated, and deliberately NOT what gets passed on. An id names a
      // row that exists only if the insert succeeded; carrying it forward after a
      // failure attaches a card to a run that is not there, and the foreign key
      // then rejects the card — losing the operator's decision to a failure in a
      // debugging aid.
      { runId: PRE_ALLOCATED }
    );

    expect(out.runId).toBeNull();
    expect(h.recorded).toHaveLength(1);
    expect(h.recorded[0].runId).toBeNull();
    // The card still reached the desk. The trace is for debugging; the card is a
    // question waiting on a person, and the desk's read left-joins the run for
    // exactly this row.
    expect(out.proposals).toHaveLength(1);
    // Swallowed, and logged. Silence would make a missing trace indistinguishable
    // from a run nobody recorded.
    expect(errors).toHaveBeenCalled();
  });

  it('does not touch the proposals table on a run that proposed nothing', async () => {
    queue([{ id: RUN }]);

    const out = await persistRunAndProposals(USER, 'how much is outstanding?', agentRun());

    expect(out).toEqual({ runId: RUN, proposals: [] });
    // Not called with an empty list: a question that changes nothing writes
    // nothing to the table that records changes.
    expect(h.recorded).toEqual([]);
    expect(h.calls).toHaveLength(1);
  });

  it('records the run on its own when that is all the caller asked for', async () => {
    queue([{ id: RUN }]);

    // The narrower entry point still exists, and a caller that reaches for it on a
    // run with cards on it writes the reasoning and drops the decision. That is
    // why the comment on `persistRun` says so, and why this asserts the
    // difference rather than leaving both functions looking interchangeable.
    const runId = await persistRun(USER, 'how much is outstanding?', agentRun({ proposals: [draft()] }));

    expect(runId).toBe(RUN);
    expect(h.recorded).toEqual([]);
  });
});
