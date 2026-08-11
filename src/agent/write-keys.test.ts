/**
 * The ledger, with Postgres replaced by a queue of rows.
 *
 * Two things are being asserted, and both are about identity rather than about
 * shape. That two calls meaning the same act produce the same key and two that
 * differ in anything that matters do not — because a key that is too generous
 * suppresses a write somebody asked for, and one that is too specific lets a
 * retry bill a client twice. And that the claim goes in BEFORE the write, which is
 * an ordering no call site shows on its face.
 *
 * What is NOT covered: none of this SQL has been executed, and the concurrency it
 * exists for is not reproducible against a mock — two attempts racing on a primary
 * key needs a real Postgres. What is covered is that the code takes the conflict
 * path on 23505, that it reads the winner's result, and that a failed write gives
 * its claim back.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => ({
  calls: [] as Array<{ text: string; params: unknown[] }>,
  queue: [] as Array<unknown[] | { throws: unknown }>,
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

import { claim, once, record, release, writeKey } from './write-keys';
import type { ToolContext, ToolResult } from './tools';

const USER = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-000000000002';
const PROJECT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const RUN = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const CTX: ToolContext = { userId: USER, allowWrites: true, runId: RUN };

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
const stmts = () => h.calls.map((c) => norm(c.text));
const counted = (fragment: string) => stmts().filter((s) => s.includes(fragment)).length;
const indexOfText = (fragment: string) => stmts().findIndex((s) => s.includes(fragment));
const queue = (...replies: Array<unknown[] | { throws: unknown }>) => h.queue.push(...replies);

const duplicate = () =>
  Object.assign(new Error('duplicate key value violates unique constraint "agent_write_keys_pkey"'), {
    code: '23505',
  });

const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

beforeEach(() => {
  h.calls.length = 0;
  h.queue.length = 0;
  errors.mockClear();
});

/** The parts `log_time` keys on, in this schema's column names. */
const parts = (over: Record<string, unknown> = {}) => ({
  project_id: PROJECT,
  entry_date: '2026-08-04',
  hours: 3,
  note: 'dispatch rewrite, phase 2',
  billable: true,
  ...over,
});

describe('naming an act', () => {
  it('gives the same act the same key, whatever order the parts are written in', () => {
    const a = writeKey('log_time', USER, { project_id: PROJECT, hours: 3, billable: true });
    const b = writeKey('log_time', USER, { billable: true, project_id: PROJECT, hours: 3 });

    expect(a).toBe(b);
  });

  it('gives billable and non-billable hours different keys', () => {
    // The same hours logged billable and non-billable are two different entries.
    // Sharing a key would let the first silently stand in for the second — which
    // is how an own venture's time would get "already logged" for an entry that
    // was never written.
    expect(writeKey('log_time', USER, parts({ billable: true }))).not.toBe(
      writeKey('log_time', USER, parts({ billable: false }))
    );
  });

  it('separates the operators, the tools and every part that changes the entry', () => {
    const base = writeKey('log_time', USER, parts());

    expect(writeKey('log_time', OTHER, parts())).not.toBe(base);
    expect(writeKey('set_client_status', USER, parts())).not.toBe(base);
    expect(writeKey('log_time', USER, parts({ hours: 4 }))).not.toBe(base);
    expect(writeKey('log_time', USER, parts({ entry_date: '2026-08-05' }))).not.toBe(base);
    expect(writeKey('log_time', USER, parts({ note: 'something else' }))).not.toBe(base);
    expect(writeKey('log_time', USER, parts({ project_id: PROJECT.replace('b', 'a') }))).not.toBe(base);
  });

  it('does not confuse a nested part with an empty one', () => {
    // The one-line version of this function — a sorted replacer array passed to
    // JSON.stringify — applies the top-level key list at every depth, so both of
    // these serialise as {"scope":{}} and two different acts get one key.
    expect(writeKey('t', USER, { scope: { a: 1 } })).not.toBe(
      writeKey('t', USER, { scope: { b: 1 } })
    );
    expect(writeKey('t', USER, { scope: { a: 1 } })).not.toBe(writeKey('t', USER, { scope: {} }));
  });

  it('treats an absent part and an undefined one as one act, and null as another', () => {
    expect(writeKey('t', USER, { a: 1, b: undefined })).toBe(writeKey('t', USER, { a: 1 }));
    // A tool that decided "no rate" and a tool that never considered the rate are
    // not the same act.
    expect(writeKey('t', USER, { a: 1, b: null })).not.toBe(writeKey('t', USER, { a: 1 }));
  });

  it('refuses a part it cannot reproduce rather than coercing it', () => {
    // A Date would carry a time zone into the identity of a write, and a bigint
    // and its string form would key differently for no reason a reader could see.
    expect(() => writeKey('t', USER, { when: new Date() })).toThrow(/cannot be hashed/);
    expect(() => writeKey('t', USER, { cents: 10n })).toThrow(/cannot be hashed/);
    expect(() => writeKey('t', USER, { hours: Number.NaN })).toThrow(/cannot identify/);
  });
});

describe('claiming a key', () => {
  it('inserts the claim, with the run that made it', async () => {
    queue([]);

    const outcome = await claim('k1', USER, 'log_time', RUN);

    expect(outcome.claimed).toBe(true);
    expect(stmts()[0]).toContain('INSERT INTO agent_write_keys');
    // A reservation first and a receipt second: the result column is NOT NULL and
    // is filled in once the write has succeeded.
    expect(stmts()[0]).toContain(`'{}'::jsonb`);
    expect(h.calls[0].params).toEqual(['k1', USER, 'log_time', RUN]);
  });

  it("hands back the winner's result on a unique violation", async () => {
    queue({ throws: duplicate() }, [
      { result: { content: 'Logged 3.00h against Dispatch Rewrite.', evidence: [] } },
    ]);

    const outcome = await claim('k1', USER, 'log_time', RUN);

    // The expected path, not an error: read the stored result and report that
    // nothing was done a second time.
    expect(outcome.claimed).toBe(false);
    if (outcome.claimed === false) {
      expect(outcome.previous.content).toContain('Logged 3.00h');
    }
  });

  it('claims again when the winner released the key in between', async () => {
    // A failed write gives its claim back, so a conflict followed by no row means
    // the act is genuinely unclaimed. Reporting "already performed" there would be
    // inventing a fact about the business.
    queue({ throws: duplicate() }, [], []);

    const outcome = await claim('k1', USER, 'log_time', RUN);

    expect(outcome.claimed).toBe(true);
    expect(counted('INSERT INTO agent_write_keys')).toBe(2);
  });

  it('stops the write when the ledger cannot be written to at all', async () => {
    queue({ throws: new Error('read-only transaction') });

    // Performing an act with no record that it happened is the state this table
    // exists to prevent, so a ledger failure is not something to write through.
    await expect(claim('k1', USER, 'log_time', RUN)).rejects.toThrow('Could not reserve the write');
  });
});

describe('performing a write once', () => {
  const result: ToolResult = {
    content: 'Logged 3.00h on 2026-08-04 against Dispatch Rewrite.',
    evidence: [{ table: 'time_entries', id: 't1', label: '3.00h' }],
  };

  it('claims before it writes', async () => {
    queue([], []);
    let claimedFirst = false;

    const out = await once('k1', CTX, 'log_time', async () => {
      claimedFirst = stmts().some((s) => s.includes('INSERT INTO agent_write_keys'));
      return result;
    });

    // Claim-before-write, not write-then-record. Two concurrent attempts then race
    // on a primary key rather than on the write itself, and the loser reads the
    // winner's result; recording afterwards leaves both writes landing.
    expect(claimedFirst).toBe(true);
    expect(out.content).toBe(result.content);
    expect(indexOfText('UPDATE agent_write_keys')).toBeGreaterThan(
      indexOfText('INSERT INTO agent_write_keys')
    );
  });

  it('records only the content and the evidence', async () => {
    queue([], []);

    await once('k1', CTX, 'log_time', async () => result);

    const update = h.calls.find((c) => norm(c.text).includes('UPDATE agent_write_keys'));
    expect(update?.params[1]).toBe(
      JSON.stringify({ content: result.content, evidence: result.evidence })
    );
  });

  it('replays instead of repeating, and never calls the write', async () => {
    queue({ throws: duplicate() }, [{ result: { content: 'Logged 3.00h.', evidence: [] } }]);
    const performed = vi.fn(async () => result);

    const out = await once('k1', CTX, 'log_time', performed);

    expect(performed).not.toHaveBeenCalled();
    expect(out.content).toContain('already performed');
    expect(out.content).toContain('Nothing was done a second time');
  });

  it('will not claim a write it cannot confirm happened', async () => {
    // The hole named in db/002-agent.sql: a process killed between the claim and
    // the update leaves a row asserting a write nobody performed. Reporting that
    // as done would be a fabricated fact; this says what is actually known.
    queue({ throws: duplicate() }, [{ result: {} }]);

    const out = await once('k1', CTX, 'log_time', async () => result);

    expect(out.content).toContain('never recorded a result');
    expect(out.content).toContain('NOTHING was done a second time');
    expect(out.content).not.toContain('already performed');
  });

  it('releases the claim when the write fails', async () => {
    queue([]);

    await expect(
      once('k1', CTX, 'log_time', async () => {
        throw new Error('could not log the time');
      })
    ).rejects.toThrow('could not log the time');

    // Otherwise one transient database error becomes a permanent refusal to ever
    // perform that act again, and the only way out is a manual delete from a table
    // nobody remembers.
    expect(counted('DELETE FROM agent_write_keys')).toBe(1);
  });

  it('keeps the claim when only the recording failed', async () => {
    queue([], { throws: new Error('connection reset') });

    const out = await once('k1', CTX, 'log_time', async () => result);

    // The write already happened. Releasing here would leave the act unclaimed and
    // let a retry perform it a second time, which is the opposite of the point.
    expect(out.content).toBe(result.content);
    expect(counted('DELETE FROM agent_write_keys')).toBe(0);
    expect(errors).toHaveBeenCalled();
  });
});

describe('the ledger statements', () => {
  it('reads and deletes by the key alone', async () => {
    queue([]);
    await record('k1', { content: 'x', evidence: [] });
    queue([]);
    await release('k1');

    // The user is inside the hash, which is why the primary key is the key alone
    // and not a composite — see the comment on agent_write_keys.key.
    expect(stmts()[0]).toContain('UPDATE agent_write_keys SET result = $2::jsonb WHERE key = $1');
    expect(stmts()[1]).toContain('DELETE FROM agent_write_keys WHERE key = $1');
  });
});
