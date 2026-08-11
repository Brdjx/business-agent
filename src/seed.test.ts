/**
 * The dataset swap: what it refuses, and in what ORDER it does the rest.
 *
 * ── Why the order is the thing being tested ──
 *
 * Every statement this script sends is destructive or trivial, and the destructive one
 * is a TRUNCATE of five tables. What makes it safe is not any single statement but their
 * sequence: BEGIN before the TRUNCATE, the seed after it, COMMIT last, ROLLBACK on any
 * failure. Get that order wrong and every visible symptom is the same — the report still
 * prints, the counts are still right on the happy path — while the promise the script
 * makes ("a seed that fails halfway leaves the previous data") has quietly become false.
 * A test that only checked the happy path would pass on a version that truncated OUTSIDE
 * the transaction and emptied a business on every bad file.
 *
 * So most of what follows asserts on positions in a list of statements, on statements
 * that must NOT appear, and on the exit code. Three of them are about something not
 * happening: an unknown flag must not reach the database, a missing schema must not be
 * truncated over, and the agent's own history must never be touched without being asked.
 *
 * ── What is NOT covered ──
 *
 * No SQL is executed. The fake below answers from JavaScript, so a column that does not
 * exist, a syntax error, or `to_regclass` misspelled would pass every assertion here.
 * That is the same limit the rest of this repository's suite has (see the header of
 * `src/agent/evals/roles.test.ts`), and the compose database plus `npm run db:check` are
 * what close it from the other side.
 *
 * `nodeDeps()` is also not covered: the real file reads and the real pg client are the
 * two things a fake cannot stand in for, and they are three lines each for that reason.
 */

import { describe, it, expect } from 'vitest';

import {
  AGENT_HISTORY_TABLES,
  BUSINESS_TABLES,
  EVAL_HISTORY_TABLES,
  INVOICE_SEQUENCE,
  main,
  parseArgs,
  psqlMetaCommandsIn,
  transactionControlIn,
  type Deps,
  type Session,
} from './seed';

/* ─── the fake database ─── */

interface SequenceRow {
  next_value: string;
  highest_used: string | null;
  collides: boolean;
}

interface World {
  /** Which relations `to_regclass` finds. Defaults to all of them. */
  present?: Partial<Record<string, boolean>>;
  /** Row counts, read by table name for both the business and the agent queries. */
  counts?: Record<string, number>;
  sequence?: SequenceRow;
  /** A statement containing this fragment fails with `error`. */
  failOn?: string;
  error?: unknown;
  /** ROLLBACK itself fails. The original message must still be the one reported. */
  rollbackFails?: boolean;
  files?: Record<string, string>;
  /** What is in seeds/. Null means the directory is not there. */
  seeds?: string[] | null;
  env?: Record<string, string | undefined>;
  /** Connecting fails, the way an unstarted container does. */
  connectFails?: string;
}

interface Result {
  code: number;
  out: string;
  err: string;
  statements: string[];
  connected: boolean;
  ended: boolean;
}

const DEFAULT_SEQUENCE: SequenceRow = {
  next_value: '1012',
  highest_used: '1011',
  collides: false,
};

/**
 * A seed shaped like the ones in `seeds/`: relative dates, hand-written invoice numbers,
 * a closing setval, and a DO block whose BEGIN and END are the reason the
 * transaction-control scan has to understand dollar quoting.
 */
const SEED = `
-- A complete second business.
INSERT INTO clients (name, status, engagement_kind) VALUES
  ('Marrowgate Logistics', 'active', 'client');

INSERT INTO invoices (client_id, number, status, amount_cents, issued_at, due_date)
SELECT id, 'INV-2001', 'open', 480000,
       CURRENT_DATE - 60, CURRENT_DATE - 30
  FROM clients WHERE name = 'Marrowgate Logistics';

SELECT setval('invoice_number_seq', 2001, true);

DO $seed$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM clients WHERE engagement_kind = 'client') THEN
    RAISE EXCEPTION 'seed: nothing here is a client';
  END IF;
END
$seed$;
`.trim();

async function run(argv: string[], world: World = {}): Promise<Result> {
  const statements: string[] = [];
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  let connected = false;
  let ended = false;

  const counts = world.counts ?? {
    clients: 4,
    contacts: 2,
    projects: 3,
    invoices: 6,
    time_entries: 11,
    agent_runs: 12,
    agent_proposals: 4,
    agent_write_keys: 9,
    agent_memory: 7,
  };

  const session: Session = {
    async query(text) {
      statements.push(text);

      if (world.failOn && text.includes(world.failOn)) {
        throw world.error ?? new Error('boom');
      }
      if (world.rollbackFails && text === 'ROLLBACK') {
        throw new Error('Connection terminated unexpectedly');
      }

      const n = text.toLowerCase();

      if (n.includes('to_regclass')) {
        const row: Record<string, boolean> = {};
        for (const name of [
          ...BUSINESS_TABLES,
          INVOICE_SEQUENCE,
          ...AGENT_HISTORY_TABLES,
        ]) {
          row[name] = world.present?.[name] ?? true;
        }
        return [row];
      }

      if (n.includes('count(*)')) {
        // Answered from the aliases the statement actually asks for, so a query that
        // counted the wrong tables would return the wrong keys rather than being tidied
        // up by the fake.
        const row: Record<string, number> = {};
        for (const match of text.matchAll(/AS (\w+)/g)) row[match[1]] = counts[match[1]] ?? 0;
        return [row];
      }

      if (n.includes('as next_value')) {
        return [{ ...(world.sequence ?? DEFAULT_SEQUENCE) }];
      }

      if (/^(begin|commit|rollback)$/i.test(text.trim())) return [];
      if (/^truncate|^alter sequence|^delete from/i.test(text.trim())) return [];

      // The seed file itself, sent verbatim — matched against the file contents with a
      // leading BOM allowed for, since stripping one is the single alteration the script
      // makes. Anything else is a statement this file does not know about, and it is
      // thrown rather than answered with no rows: "no rows" is a plausible answer that
      // would let a new query slip in untested (the same guard as the fake in
      // roles.test.ts).
      const seeds = Object.values(world.files ?? { 'seeds/complete.sql': SEED });
      if (seeds.some((t) => t === text || t.replace(/^﻿/, '') === text)) return [];

      throw new Error(`The fake does not recognise this statement. Teach it:\n${text}`);
    },
    async end() {
      ended = true;
    },
  };

  const deps: Deps = {
    env: world.env ?? { DATABASE_URL: 'postgres://business_agent@localhost:5432/business_agent' },
    out: (t) => outChunks.push(t),
    err: (t) => errChunks.push(t),
    io: {
      async readSeed(path) {
        const files = world.files ?? { 'seeds/complete.sql': SEED };
        const text = files[path];
        return text === undefined
          ? { ok: false, why: `ENOENT: no such file or directory, open '${path}'` }
          : { ok: true, text };
      },
      async listSeeds() {
        return world.seeds === undefined ? ['complete.sql', 'sparse.sql'] : world.seeds;
      },
    },
    async connect() {
      if (world.connectFails) throw new Error(world.connectFails);
      connected = true;
      return session;
    },
  };

  const code = await main(argv, deps);
  return {
    code,
    out: outChunks.join('\n'),
    err: errChunks.join('\n'),
    statements,
    connected,
    ended,
  };
}

/** Where a statement matching this appears in the order they were sent. */
const at = (statements: string[], pattern: RegExp): number =>
  statements.findIndex((s) => pattern.test(s));

/* ─── refusals, and what they cost ─── */

describe('refusing before anything is touched', () => {
  it('says what is in seeds/ when the file is not there', async () => {
    const r = await run(['seeds/spasre.sql']);

    // A typo must not silently do nothing, and it must not send the reader to `ls`.
    expect(r.code).toBe(2);
    expect(r.err).toContain('seeds/spasre.sql');
    expect(r.err).toContain('ENOENT');
    expect(r.err).toContain('seeds/complete.sql');
    expect(r.err).toContain('seeds/sparse.sql');
    // Nothing was opened, so nothing could have been emptied.
    expect(r.connected).toBe(false);
    expect(r.statements).toEqual([]);
  });

  it('says the directory is missing rather than listing nothing', async () => {
    const r = await run(['seeds/complete.sql'], { seeds: null, files: {} });
    expect(r.code).toBe(2);
    expect(r.err).toContain('no seeds/ directory');
    expect(r.connected).toBe(false);
  });

  it('distinguishes an empty seeds/ from an absent one', async () => {
    const r = await run(['seeds/complete.sql'], { seeds: [], files: {} });
    expect(r.err).toContain('holds no .sql file');
  });

  it('refuses with no file at all, and lists the choices', async () => {
    const r = await run([]);
    expect(r.code).toBe(2);
    expect(r.err).toContain('No seed file given');
    expect(r.err).toContain('seeds/sparse.sql');
    expect(r.connected).toBe(false);
  });

  it('refuses an unknown flag instead of ignoring it', async () => {
    // The failure this prevents: --reset-agents accepted as "no flag given", a swap that
    // reports the history as deliberately kept, and someone who asked for it cleared
    // reading that as done.
    const r = await run(['seeds/complete.sql', '--reset-agents']);
    expect(r.code).toBe(2);
    expect(r.err).toContain('--reset-agents');
    expect(r.connected).toBe(false);
  });

  it('refuses two datasets rather than picking one', async () => {
    const r = await run(['seeds/complete.sql', 'seeds/sparse.sql']);
    expect(r.code).toBe(2);
    expect(r.err).toContain('seeds/complete.sql');
    expect(r.err).toContain('seeds/sparse.sql');
    expect(r.connected).toBe(false);
  });

  it('refuses an empty file, which would empty the business and report success', async () => {
    const r = await run(['seeds/blank.sql'], { files: { 'seeds/blank.sql': '   \n\n' } });
    expect(r.code).toBe(2);
    expect(r.err).toContain('is empty');
    expect(r.connected).toBe(false);
  });

  it('refuses without DATABASE_URL, and says why a default would be worse', async () => {
    const r = await run(['seeds/complete.sql'], { env: {} });
    expect(r.code).toBe(2);
    expect(r.err).toContain('DATABASE_URL');
    // The specific danger: pg with no connection string connects to localhost as the OS
    // user, and a TRUNCATE that succeeds against the wrong database is not undoable.
    expect(r.err).toMatch(/localhost/);
    expect(r.err).toContain('npm run db:up');
    expect(r.connected).toBe(false);
  });

  it('refuses when the schema is not there, naming what is missing', async () => {
    const r = await run(['seeds/complete.sql'], { present: { projects: false, invoices: false } });

    expect(r.code).toBe(2);
    expect(r.err).toContain('projects, invoices');
    expect(r.err).toContain('npm run db:up');
    // A stack trace about a missing relation is a worse answer than a sentence — and the
    // truncate must not have run first.
    expect(at(r.statements, /^TRUNCATE/)).toBe(-1);
    expect(at(r.statements, /^BEGIN$/)).toBe(-1);
    // Connected, so the connection has to be given back.
    expect(r.ended).toBe(true);
  });

  it('refuses when the invoice sequence alone is missing', async () => {
    // The sequence is the one object that is neither a table nor optional: ALTER SEQUENCE
    // would fail inside the transaction and roll back an otherwise correct seed.
    const r = await run(['seeds/complete.sql'], { present: { invoice_number_seq: false } });
    expect(r.code).toBe(2);
    expect(r.err).toContain(INVOICE_SEQUENCE);
    expect(at(r.statements, /^BEGIN$/)).toBe(-1);
  });

  it('refuses in a sentence when the schema cannot even be read', async () => {
    // Connected and then refused: a role without rights, or a connection string pointing
    // at a database that exists and is not this one. This runs before BEGIN, so the
    // guarantee to state is that nothing was touched at all.
    const r = await run(['seeds/complete.sql'], {
      failOn: 'to_regclass',
      error: new Error('permission denied for schema public'),
    });

    expect(r.code).toBe(2);
    expect(r.err).toContain('permission denied for schema public');
    expect(r.err).toContain('Nothing was attempted');
    expect(at(r.statements, /^BEGIN$/)).toBe(-1);
    expect(r.ended).toBe(true);
  });

  it('refuses when it cannot connect, and says what starts the database', async () => {
    const r = await run(['seeds/complete.sql'], { connectFails: 'ECONNREFUSED 127.0.0.1:5432' });
    expect(r.code).toBe(2);
    expect(r.err).toContain('ECONNREFUSED');
    expect(r.err).toContain('npm run db:up');
  });

  it('exits non-zero on every refusal, because this gates a suite run', async () => {
    const refusals: Array<[string, () => Promise<Result>]> = [
      ['missing file', () => run(['seeds/nope.sql'])],
      ['no file', () => run([])],
      ['unknown flag', () => run(['seeds/complete.sql', '--wat'])],
      ['two files', () => run(['a.sql', 'b.sql'], { files: { 'a.sql': SEED, 'b.sql': SEED } })],
      ['no DATABASE_URL', () => run(['seeds/complete.sql'], { env: {} })],
      ['no schema', () => run(['seeds/complete.sql'], { present: { clients: false } })],
      ['cannot connect', () => run(['seeds/complete.sql'], { connectFails: 'down' })],
    ];
    for (const [name, invoke] of refusals) {
      const r = await invoke();
      expect(r.code, `${name} exited 0`).not.toBe(0);
    }
  });

  it('prints usage for --help and exits 0', async () => {
    const r = await run(['--help']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('--reset-agent');
    expect(r.connected).toBe(false);
  });
});

/* ─── the order the swap happens in ─── */

describe('applying a dataset', () => {
  it('empties, resets the sequence and applies the file, all inside one transaction', async () => {
    const r = await run(['seeds/complete.sql']);
    const s = r.statements;

    expect(r.code).toBe(0);

    const begin = at(s, /^BEGIN$/);
    const truncate = at(s, /^TRUNCATE/);
    const sequence = at(s, /^ALTER SEQUENCE/);
    const seed = s.indexOf(SEED);
    const commit = at(s, /^COMMIT$/);

    // Every one of these positions is load-bearing. TRUNCATE before BEGIN empties the
    // business on any bad file; the seed before the TRUNCATE deletes what it just
    // inserted; a COMMIT that is not last commits half of it.
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(truncate).toBeGreaterThan(begin);
    expect(sequence).toBeGreaterThan(truncate);
    expect(seed).toBeGreaterThan(sequence);
    expect(commit).toBe(s.length - 1);
    expect(at(s, /^ROLLBACK$/)).toBe(-1);
  });

  it('names all five business tables in one TRUNCATE, with CASCADE', async () => {
    const r = await run(['seeds/complete.sql']);
    const truncate = r.statements.filter((x) => /^TRUNCATE/.test(x));

    // One statement, so the dependency order between clients, projects and the two that
    // reference them is Postgres's problem rather than a hand-written ordering that fails
    // on invoices — whose foreign key is ON DELETE RESTRICT.
    expect(truncate).toHaveLength(1);
    for (const table of BUSINESS_TABLES) expect(truncate[0]).toContain(table);
    expect(truncate[0]).toContain('CASCADE');
    expect(truncate[0]).toContain('RESTART IDENTITY');
  });

  it('restarts the sequence with ALTER, not setval, and hardcodes no start value', async () => {
    const r = await run(['seeds/complete.sql']);
    const alter = r.statements.find((x) => /^ALTER SEQUENCE/.test(x)) ?? '';

    expect(alter).toContain(INVOICE_SEQUENCE);
    expect(alter).toContain('RESTART');
    // setval is documented as NOT undone by a ROLLBACK, so a failed apply would leave the
    // sequence low while the previous dataset's INV-1001 was still there — and the next
    // invoice the application created would collide on a write that did nothing wrong.
    expect(alter.toLowerCase()).not.toContain('setval');
    // No value: the sequence returns to its own START, so this cannot drift from the
    // START WITH in db/001-business.sql.
    expect(alter).not.toMatch(/\d/);
  });

  it('sends the file unaltered, so its own assertions still mean what they say', async () => {
    const r = await run(['seeds/complete.sql']);
    // Byte-identical, dollar quoting and setval included. A seed rewritten on the way in
    // is a seed whose DO block is asserting about something else.
    expect(r.statements).toContain(SEED);
  });

  it('strips a UTF-8 BOM before sending, and nothing else', async () => {
    const withBom = `﻿${SEED}`;
    const r = await run(['seeds/bom.sql'], { files: { 'seeds/bom.sql': withBom } });

    expect(r.code).toBe(0);
    // A BOM reaches Postgres as a syntax error on the FIRST statement, which sends the
    // reader to a line that is correct.
    expect(r.statements).toContain(SEED);
    expect(r.statements).not.toContain(withBom);
  });

  it('closes the connection, so the process does not sit there looking like a hang', async () => {
    const r = await run(['seeds/complete.sql']);
    expect(r.ended).toBe(true);
  });
});

/* ─── the failure that matters most ─── */

describe('a seed that fails halfway', () => {
  /** A `RAISE EXCEPTION` from a seed's own assertions, as node-postgres presents one. */
  const raised = Object.assign(new Error('seed: nothing here is a client'), {
    code: 'P0001',
    where: 'PL/pgSQL function inline_code_block line 4 at RAISE',
  });

  it('rolls back, reports Postgres verbatim, and exits non-zero', async () => {
    const r = await run(['seeds/complete.sql'], { failOn: 'RAISE EXCEPTION', error: raised });

    expect(r.code).toBe(1);
    // The sentence the seed author wrote is the entire useful content of the event, so it
    // is reproduced rather than paraphrased.
    expect(r.err).toContain('seed: nothing here is a client');
    expect(r.err).toContain('P0001');
    expect(r.err).toContain('inline_code_block line 4');
    expect(at(r.statements, /^ROLLBACK$/)).toBeGreaterThan(-1);
    expect(at(r.statements, /^COMMIT$/)).toBe(-1);
  });

  it('says that the previous dataset is still there, because the TRUNCATE rolled back too', async () => {
    const r = await run(['seeds/complete.sql'], { failOn: 'RAISE EXCEPTION', error: raised });
    // Without this sentence the reader's next move is to check whether they have just
    // emptied their database.
    expect(r.err).toMatch(/nothing was changed/i);
    expect(r.out).not.toContain('applied');
  });

  it('turns a syntax error position into a line and column of the seed file', async () => {
    const position = String(SEED.indexOf('setval') + 1);
    const r = await run(['seeds/complete.sql'], {
      failOn: 'INSERT INTO clients',
      error: Object.assign(new Error('syntax error at or near "setval"'), {
        code: '42601',
        position,
      }),
    });

    // The whole file is sent as one statement, so an offset into the statement is an
    // offset into the file — and a line number is what a reader can act on.
    const line = SEED.slice(0, SEED.indexOf('setval')).split('\n').length;
    expect(r.err).toContain(`line ${line}`);
    expect(r.err).toContain('seeds/complete.sql');
  });

  it('reports the original message even when the ROLLBACK itself fails', async () => {
    const r = await run(['seeds/complete.sql'], {
      failOn: 'RAISE EXCEPTION',
      error: raised,
      rollbackFails: true,
    });

    expect(r.code).toBe(1);
    // The rollback's own failure must not replace the message that explains what went
    // wrong: one of the two sentences is actionable and the other is noise.
    expect(r.err).toContain('seed: nothing here is a client');
    expect(r.err).toContain('the ROLLBACK itself failed');
    expect(r.ended).toBe(true);
  });

  it('does not clear the agent history when the seed it was paired with failed', async () => {
    const r = await run(['seeds/complete.sql', '--reset-agent'], {
      failOn: 'RAISE EXCEPTION',
      error: raised,
    });

    // Both or neither. Clearing the history and then failing to apply the dataset would
    // leave the OLD data with no record of the runs made against it: the worst of both,
    // and nothing brings it back.
    expect(r.code).toBe(1);
    expect(at(r.statements, /^COMMIT$/)).toBe(-1);
    expect(at(r.statements, /^ROLLBACK$/)).toBeGreaterThan(-1);
  });
});

/* ─── saying what landed ─── */

describe('the report', () => {
  it('gives a count per business table, including the zeros', async () => {
    const r = await run(['seeds/sparse.sql'], {
      files: { 'seeds/sparse.sql': SEED },
      counts: { clients: 3, contacts: 0, projects: 1, invoices: 2, time_entries: 0 },
    });

    for (const table of BUSINESS_TABLES) expect(r.out).toContain(table);
    expect(r.out).toMatch(/clients\s+3/);
    expect(r.out).toMatch(/contacts\s+0/);
    // Named rather than left to be spotted in a column of numbers: an empty table is the
    // point of a deliberately sparse dataset and a mistake in a complete one, and the
    // reader is the only one who can tell which.
    expect(r.out).toMatch(/empty\s+contacts, time_entries/);
  });

  it('says where the invoice sequence was left, against what the dataset used', async () => {
    const r = await run(['seeds/complete.sql']);
    expect(r.out).toContain(INVOICE_SEQUENCE);
    expect(r.out).toContain('1012');
    expect(r.out).toContain('1011');
  });

  it('warns when the seed forgot its setval, with the statement that fixes it', async () => {
    const r = await run(['seeds/complete.sql'], {
      sequence: { next_value: '1001', highest_used: '2001', collides: true },
    });

    // Not a refusal: the dataset is correct and the fix is one statement, so rolling a
    // good seed back over it would cost more than it saves. But the failure it leads to
    // arrives much later, on an innocent write, so it is said loudly.
    expect(r.code).toBe(0);
    expect(r.err).toContain("setval('invoice_number_seq', 2001, true)");
    expect(r.err).toContain('unique index');
  });

  it('points at db:check, which says which cases would skip against this data', async () => {
    const r = await run(['seeds/complete.sql']);
    expect(r.out).toContain('npm run db:check');
  });
});

/* ─── the agent's own history ─── */

describe('the agent history, which a dataset swap makes untrue', () => {
  it('is left alone by default, and the report says so and why', async () => {
    const r = await run(['seeds/complete.sql']);

    expect(r.out).toMatch(/NOT touched/);
    for (const table of AGENT_HISTORY_TABLES) expect(r.out).toContain(table);
    // The counts, because "some rows" and "thirty-two rows" are different problems.
    expect(r.out).toMatch(/agent_runs\s+12/);
    // The sentence that matters: nothing broke, and that is exactly why it needs saying.
    expect(r.out).toContain('jsonb');
    expect(r.out).toMatch(/untrue/);
    expect(r.out).toContain('--reset-agent');

    // And nothing was written to them.
    expect(r.statements.filter((s) => /^DELETE FROM/i.test(s))).toEqual([]);
    expect(r.statements.filter((s) => /TRUNCATE/i.test(s) && /agent_/.test(s))).toEqual([]);
  });

  it('says there is nothing to be untrue when the history is empty', async () => {
    const r = await run(['seeds/complete.sql'], {
      counts: { clients: 1, agent_runs: 0, agent_proposals: 0, agent_write_keys: 0, agent_memory: 0 },
    });
    expect(r.out).toMatch(/nothing recorded points at the dataset/);
  });

  it('clears it only when asked, in one transaction with the seed', async () => {
    const r = await run(['seeds/complete.sql', '--reset-agent']);
    const deletes = r.statements.filter((s) => /^DELETE FROM/i.test(s));

    expect(r.code).toBe(0);
    // Children first. Every foreign key between these is ON DELETE SET NULL today, so
    // the order is cosmetic — until one becomes RESTRICT, when a swap that deleted
    // parents first would fail mid-transaction and roll back a correct seed.
    expect(deletes).toEqual([
      'DELETE FROM agent_memory',
      'DELETE FROM agent_write_keys',
      'DELETE FROM agent_proposals',
      'DELETE FROM agent_runs',
    ]);
    const commit = at(r.statements, /^COMMIT$/);
    for (const statement of deletes) {
      expect(r.statements.indexOf(statement)).toBeLessThan(commit);
    }
    expect(r.out).toContain('--reset-agent');
    expect(r.out).toMatch(/32 row\(s\)/);
  });

  it('keeps the eval history either way, and says that it did', async () => {
    // Which case passed and which failed is still true of the runs that produced it, and
    // it is the record the whole eval history exists for. DELETE rather than TRUNCATE is
    // what makes keeping it possible: TRUNCATE agent_runs would need CASCADE and would
    // empty agent_eval_runs while leaving the suites that reference them behind.
    for (const argv of [['seeds/complete.sql'], ['seeds/complete.sql', '--reset-agent']]) {
      const r = await run(argv);
      for (const table of EVAL_HISTORY_TABLES) {
        expect(r.statements.filter((s) => s.includes(table))).toEqual([]);
      }
    }
    const cleared = await run(['seeds/complete.sql', '--reset-agent']);
    expect(cleared.out).toContain('agent_eval_suites');
  });

  it('does not fail on a database that has no agent tables at all', async () => {
    // A database carrying only db/001-business.sql is a legitimate thing to point this
    // at. `--reset-agent` there must say there is nothing to clear, not fail on a missing
    // relation and roll back a correct seed.
    const absent = {
      agent_runs: false,
      agent_proposals: false,
      agent_write_keys: false,
      agent_memory: false,
    };

    const kept = await run(['seeds/complete.sql'], { present: absent });
    expect(kept.code).toBe(0);
    expect(kept.out).toMatch(/there is none here/);

    const cleared = await run(['seeds/complete.sql', '--reset-agent'], { present: absent });
    expect(cleared.code).toBe(0);
    expect(cleared.statements.filter((s) => /^DELETE FROM/i.test(s))).toEqual([]);
  });
});

/* ─── the seed file's own transaction control ─── */

describe('transaction control inside a seed file', () => {
  it('is refused before anything is truncated', async () => {
    const withCommit = `${SEED}\nCOMMIT;\nINSERT INTO clients (name) VALUES ('Late Arrival');`;
    const r = await run(['seeds/bad.sql'], { files: { 'seeds/bad.sql': withCommit } });

    expect(r.code).toBe(2);
    expect(r.err).toContain('COMMIT');
    // The line, so the reader does not have to search a 700-line file.
    expect(r.err).toMatch(/line \d+/);
    // Refused before the connection, because the alternative is finding out once the
    // previous dataset is already gone.
    expect(r.connected).toBe(false);
  });

  it('does not mistake a plpgsql block for it', async () => {
    // Every seed in this repository ends with a DO block whose BEGIN and END sit at the
    // start of a line. A scanner blind to dollar quoting refuses all of them.
    expect(transactionControlIn(SEED)).toEqual([]);
  });

  it('sees through nested dollar tags and quoted identifiers', async () => {
    const nested = `DO $outer$ BEGIN PERFORM 1; END $outer$;\nSELECT 1 AS "commit";`;
    expect(transactionControlIn(nested)).toEqual([]);
  });

  it('ignores the words in comments and in string literals', async () => {
    const innocent = [
      '-- COMMIT is deliberately absent from this file.',
      '/* rollback; begin; */',
      "INSERT INTO clients (name, notes) VALUES ('Ashmoor', 'They commit; we begin.');",
    ].join('\n');
    expect(transactionControlIn(innocent)).toEqual([]);
  });

  it('refuses a psql meta-command, and says it is not needed anyway', async () => {
    // `scripts/assert-roles.sql` opens with this line, and it is the file most likely to
    // be open next to a new seed. Sent over the wire it is a syntax error at or near a
    // backslash, which reads as the seed being broken.
    const r = await run(['seeds/psql.sql'], {
      files: { 'seeds/psql.sql': `\\set ON_ERROR_STOP on\n${SEED}` },
    });

    expect(r.code).toBe(2);
    expect(r.err).toContain('\\set');
    expect(r.err).toContain('line 1');
    expect(r.err).toContain('one transaction');
    expect(r.connected).toBe(false);
  });

  it('does not mistake a backslash inside a note for one', async () => {
    expect(
      psqlMetaCommandsIn("INSERT INTO clients (name, notes) VALUES ('Ashmoor',\n'\\set is psql');")
    ).toEqual([]);
    expect(psqlMetaCommandsIn(SEED)).toEqual([]);
  });

  it('names each one it finds, with its line', async () => {
    const bad = ['INSERT INTO clients (name) VALUES (\'A\');', 'BEGIN;', 'ROLLBACK;'].join('\n');
    const found = transactionControlIn(bad);
    expect(found.map((f) => f.statement.toLowerCase())).toEqual(['begin', 'rollback']);
    expect(found.map((f) => f.line)).toEqual([2, 3]);
  });
});

/* ─── argv ─── */

describe('parseArgs', () => {
  it('takes one path and the one flag, in either order', () => {
    expect(parseArgs(['seeds/x.sql'])).toEqual({
      file: 'seeds/x.sql',
      resetAgent: false,
      help: false,
    });
    expect(parseArgs(['--reset-agent', 'seeds/x.sql'])).toMatchObject({
      file: 'seeds/x.sql',
      resetAgent: true,
    });
  });

  it('skips a bare --, which npm users double up', () => {
    expect(parseArgs(['--', 'seeds/x.sql'])).toMatchObject({ file: 'seeds/x.sql' });
  });

  it('refuses rather than guessing', () => {
    expect(parseArgs(['--reset-agents', 'seeds/x.sql']).refuse).toContain('--reset-agents');
    expect(parseArgs(['a.sql', 'b.sql']).refuse).toContain('b.sql');
  });
});
