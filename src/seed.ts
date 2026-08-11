/**
 * Swapping the dataset underneath the agent.
 *
 *   npx tsx scripts/seed.ts seeds/<name>.sql
 *   npx tsx scripts/seed.ts seeds/<name>.sql --reset-agent
 *
 * ── Why this is a script and not a line in the README ──
 *
 * `db/` is mounted into docker-entrypoint-initdb.d, so everything in it runs once,
 * against an empty data directory, as part of schema creation. That makes the shipped
 * seed easy — and makes a SECOND dataset impossible to load that way: two files in
 * `db/` would both run, and the first unique index on client name or invoice number
 * would decide which half of which business survived. The alternative datasets
 * therefore live in `seeds/` and are applied by hand, which means something has to own
 * the order the swap happens in. This file is that something.
 *
 * The order is the whole content of the job:
 *
 *   1. refuse a file that is not there, and say what IS in `seeds/`
 *   2. empty the five business tables in ONE statement
 *   3. put the invoice number sequence back where the schema starts it
 *   4. apply the file, all of it or none of it
 *   5. say what landed, and what did NOT get cleaned up with it
 *   6. refuse rather than crash when the environment is not ready
 *
 * ── One connection, one transaction ──
 *
 * `src/db.ts` is deliberately not used here, and the reason is not tidiness. It is a
 * POOL: two queries can land on two different connections, and a BEGIN issued on one
 * of them does not wrap work done on the other — so a "transaction" built on it would
 * silently be no transaction at all, which is precisely the guarantee this file
 * exists to make. Its 10-second `statement_timeout` is also sized for one of the
 * agent's tool calls, where a seed with a DO block over every row is a different kind
 * of statement, and a timeout halfway through applying a correct file would roll it
 * back and read as the file being broken.
 *
 * So: one client, one transaction, a longer timeout, and TRUNCATE inside the
 * transaction rather than before it. TRUNCATE is transactional in Postgres, which is
 * what makes "a seed that fails halfway leaves the previous data" true rather than
 * aspirational — the failure mode being avoided is a rolled-back seed on top of an
 * emptied database, i.e. no dataset at all.
 *
 * ── What this file cannot know ──
 *
 * Nothing in this repository's unit suite executes SQL: `src/seed.test.ts` answers
 * every statement below from JavaScript. So a column that does not exist, a syntax
 * error, a FILTER clause Postgres rejects — all of them pass the tests here. The
 * statements are written to be read against `db/001-business.sql`, and a live database
 * is the only thing that checks them. `npm run db:check` afterwards is the other half:
 * it says which eval roles bind against whatever just landed, and therefore which
 * cases would silently skip.
 *
 * ── Identifiers ──
 *
 * Every table and sequence name in every statement below comes from the constants at
 * the top of this file. Nothing from argv, and nothing from the seed file, is ever
 * concatenated into SQL: the file is sent as one statement, unaltered, which is the
 * only way its own DO-block assertions can mean what they say.
 */

/* ─── what a dataset swap is allowed to touch ─── */

/**
 * The business, and the whole business.
 *
 * Named in this order in the TRUNCATE, in the refusals and in the report, so a reader
 * comparing three outputs is comparing the same list. The order does NOT express a
 * dependency — that is the point of naming them all in one statement (see
 * TRUNCATE_BUSINESS).
 */
export const BUSINESS_TABLES = [
  'clients',
  'contacts',
  'projects',
  'invoices',
  'time_entries',
] as const;

/**
 * The sequence behind `invoices.number`'s DEFAULT.
 *
 * Created standalone in `db/001-business.sql` (`CREATE SEQUENCE invoice_number_seq`)
 * and referenced from a DEFAULT expression, rather than being a serial or an identity
 * column. That distinction is why step 3 exists at all — see RESET_SEQUENCE.
 */
export const INVOICE_SEQUENCE = 'invoice_number_seq';

/**
 * The agent's own record of what it did, in the order the report prints it.
 *
 * These are NOT touched by a seed swap unless `--reset-agent` says so. `db/002-agent.sql`
 * has no foreign key into the business tables — deliberately, so pruning traces cannot
 * cascade into an invoice — which means nothing here breaks when the rows those traces
 * cite disappear. It just stops being true, and an untrue record of what an agent did
 * with someone's business is worse than a broken one: broken gets fixed, untrue gets
 * quoted.
 */
export const AGENT_HISTORY_TABLES = [
  'agent_runs',
  'agent_proposals',
  'agent_write_keys',
  'agent_memory',
] as const;

/**
 * The order `--reset-agent` deletes in: children first.
 *
 * Every foreign key between these is ON DELETE SET NULL today, so the order is
 * currently cosmetic. It is written down anyway because the day one of them becomes
 * RESTRICT, a swap that deleted parents first would fail mid-transaction and roll back
 * a correct seed — and the failure would name a constraint rather than the ordering
 * mistake that caused it.
 */
const AGENT_DELETE_ORDER = [
  'agent_memory',
  'agent_write_keys',
  'agent_proposals',
  'agent_runs',
] as const;

/**
 * Kept even by `--reset-agent`, and this is a decision rather than an oversight.
 *
 * `agent_eval_suites` / `agent_eval_runs` hold which case passed and which failed,
 * over time. That record survives a dataset swap intact: a case that has both passed
 * and failed is the question the eval history exists to answer, and no amount of
 * changing the underlying records makes yesterday's failure not have happened. Only
 * the `roles` binding stored alongside it goes stale, and that is a description of
 * what the case was asked about — still the truth about that run.
 *
 * This is also why the clear is DELETE and not TRUNCATE. `agent_eval_runs.agent_run_id`
 * references `agent_runs`, so `TRUNCATE agent_runs` demands CASCADE and would then
 * empty `agent_eval_runs` while leaving `agent_eval_suites` behind — recorded suites
 * with no cases in them, which is a worse record than either keeping or dropping both.
 * DELETE honours the ON DELETE SET NULL the schema chose: the trace is gone, the case
 * result stands.
 */
export const EVAL_HISTORY_TABLES = ['agent_eval_suites', 'agent_eval_runs'] as const;

/** Where the alternative datasets live. Relative to the repository root. */
export const SEEDS_DIR = 'seeds';

/* ─── the statements ─── */

/**
 * One statement, five tables, and CASCADE.
 *
 * One statement because the dependency order is then Postgres's problem: with all five
 * named together it does not matter that `contacts.client_id`, `projects.client_id` and
 * `invoices.client_id` point at `clients`, or that `time_entries.project_id` points at
 * `projects`. Five separate TRUNCATEs would have to be ordered by hand, and
 * `invoices.client_id` is ON DELETE RESTRICT, so getting it wrong fails on the money
 * table — the one whose data a reader would least like to see half-deleted.
 *
 * CASCADE, because TRUNCATE refuses when a table OUTSIDE the list references one inside
 * it. Nothing does today: the agent tables hold their evidence as jsonb with no foreign
 * key. It is written here so that adding, say, invoice line items later does not turn a
 * dataset swap into "cannot truncate a table referenced in a foreign key constraint"
 * and a puzzle about ordering. The cost is worth knowing: CASCADE also empties a table
 * it was not asked to name. For a table hanging off `clients` that is the right answer
 * — it holds detail about clients that no longer exist — but it happens without being
 * listed in the report below, which only counts these five.
 *
 * RESTART IDENTITY changes nothing at all today, and is here for what changes later.
 * Every primary key in `db/001-business.sql` is a UUID with a `gen_random_uuid()`
 * default, so no truncated table owns a sequence. If a serial or identity column is
 * ever added, its numbering should restart with the data rather than counting on from a
 * dataset that is gone. It also does NOT reset the invoice sequence, which is the next
 * statement's whole reason for existing.
 */
export const TRUNCATE_BUSINESS =
  `TRUNCATE TABLE ${BUSINESS_TABLES.join(', ')} RESTART IDENTITY CASCADE`;

/**
 * The invoice numbers, back to where the schema starts them.
 *
 * RESTART IDENTITY above cannot do this. It resets sequences a truncated table's column
 * OWNS — a serial, or an identity column — and `invoice_number_seq` is a standalone
 * `CREATE SEQUENCE` merely mentioned in `invoices.number`'s DEFAULT. So it survives the
 * TRUNCATE holding whatever the last seed left it at: `db/900-seed.sql` hand-writes
 * INV-1001 … INV-1011 and closes with `setval(…, 1011, true)`, and every seed here is
 * expected to do the same for its own numbers. Without this statement, loading a
 * dataset whose numbers run lower leaves the sequence high, and reseeding the SAME file
 * twice is fine only by luck.
 *
 * `RESTART` with no value rather than `RESTART WITH 1001`: the sequence goes back to its
 * own START value, so this line cannot drift from the `START WITH` in
 * `db/001-business.sql`. A literal here would be a second copy of a number that lives
 * somewhere else.
 *
 * ALTER SEQUENCE rather than `setval()`, because this runs inside the transaction and
 * `setval` is documented as NOT undone by a ROLLBACK. If a failed apply left the
 * sequence at 1001 while the previous dataset's INV-1001 was still in the table, the
 * next invoice anyone created through the application would collide on the unique index
 * — a write that did nothing wrong, failing because of an unrelated seed that failed
 * hours earlier. Postgres documents ALTER SEQUENCE … RESTART as transactional, which is
 * why it is the form used; that claim has not been exercised by anything in this repo,
 * and if it turned out to be wrong the symptom is the collision just described.
 */
export const RESET_SEQUENCE = `ALTER SEQUENCE ${INVOICE_SEQUENCE} RESTART`;

/**
 * Does this database have a business in it yet?
 *
 * Asked before anything is opened, because the alternative answer to "you have not run
 * `npm run db:up`" is a stack trace about relation "clients" not existing, and a
 * sentence is a better answer than a stack trace. `to_regclass` returns NULL for a name
 * that does not resolve rather than raising, and it resolves through `search_path` —
 * the same way the unqualified INSERTs in a seed file will — so this checks the tables
 * the seed is actually about to write to, not the ones in a schema it may not be using.
 *
 * The agent tables are asked about in the same round trip and are optional: a database
 * carrying only `db/001-business.sql` is a legitimate thing to point this at, and
 * `--reset-agent` there should say there is nothing to clear rather than failing on a
 * missing relation and rolling back a correct seed.
 */
export const PRESENCE_QUERY = `SELECT ${[
  ...BUSINESS_TABLES,
  INVOICE_SEQUENCE,
  ...AGENT_HISTORY_TABLES,
]
  .map((name) => `to_regclass('${name}') IS NOT NULL AS ${name}`)
  .join(',\n       ')}`;

/**
 * A count per table, in one round trip.
 *
 * `::int` because `count(*)` is BIGINT and this driver hands BIGINT back as a string
 * (see the note in `src/db.ts`) — and a row count is not money, so there is nothing
 * here that needs the precision a string was protecting. `'0' + '3'` printing as `03`
 * in a report nobody re-reads is the failure being avoided.
 */
export function countsQuery(tables: readonly string[]): string {
  return `SELECT ${tables.map((t) => `(SELECT count(*) FROM ${t})::int AS ${t}`).join(',\n       ')}`;
}

/**
 * Will the next invoice number the schema hands out collide with one this seed wrote?
 *
 * The hazard step 3 is about, checked instead of assumed. A seed writes its numbers by
 * hand and then calls `setval`; a seed that forgets the `setval` loads perfectly, passes
 * its own assertions, and then breaks the first invoice anyone creates through the
 * application — a unique-index violation on a write that did nothing wrong, hours or
 * weeks later, with nothing pointing back at the seed.
 *
 * Deliberately format-agnostic. It compares the sequence's next value against the
 * highest run of digits at the END of any existing invoice number, rather than
 * reconstructing `'INV-' || lpad(…, 4, '0')` from the DEFAULT in
 * `db/001-business.sql`. Copying that expression here would mean a seed using its own
 * prefix was checked against a string the application never generates, and the copy
 * could silently disagree with the schema. `::numeric` rather than `::bigint` so a long
 * digit run in someone's number cannot overflow and abort the transaction over a
 * reporting query.
 */
export const SEQUENCE_CHECK_QUERY = `
SELECT (CASE WHEN s.is_called THEN s.last_value + 1 ELSE s.last_value END)::text AS next_value,
       h.highest::text                                                          AS highest_used,
       (h.highest IS NOT NULL
        AND h.highest >= (CASE WHEN s.is_called THEN s.last_value + 1 ELSE s.last_value END))
                                                                                AS collides
  FROM ${INVOICE_SEQUENCE} s
  CROSS JOIN (
    SELECT max((substring(number from '(\\d+)$'))::numeric) AS highest FROM invoices
  ) h`.trim();

/* ─── exit codes ─── */

/**
 * The same three the CLI uses, for the same reasons (see the header of `src/cli.ts`).
 * A gate reads the number, and "the seed did not apply" and "you have not started the
 * database" are different things to be told.
 */
const EXIT_OK = 0;
/** The seed was rejected by Postgres and rolled back. Nothing was changed. */
const EXIT_NOT_APPLIED = 1;
/** The invocation or the environment is wrong. Nothing was attempted. */
const EXIT_USAGE = 2;

/* ─── the seams ─── */

/** Reading a seed file: the text, or the reason there is none. */
export type ReadResult = { ok: true; text: string } | { ok: false; why: string };

export interface SeedIo {
  readSeed(path: string): Promise<ReadResult>;
  /** The `.sql` files in `seeds/`, sorted. Null when the directory itself is absent. */
  listSeeds(dir: string): Promise<string[] | null>;
}

/**
 * One connection, for the length of one swap.
 *
 * No parameters: nothing in this file interpolates a value into a statement, so there
 * is nothing to bind. `rows` is returned rather than a driver result so the fake in the
 * test file does not have to imitate one.
 */
export interface Session {
  query(text: string): Promise<Array<Record<string, unknown>>>;
  end(): Promise<void>;
}

export interface Deps {
  io: SeedIo;
  connect(url: string, onNotice: (message: string) => void): Promise<Session>;
  env: Record<string, string | undefined>;
  /** The report. */
  out(text: string): void;
  /** Narration, refusals, Postgres's own words, and warnings. */
  err(text: string): void;
}

/* ─── argv ─── */

export interface Invocation {
  file?: string;
  resetAgent: boolean;
  help: boolean;
  /** Set when the invocation itself is wrong, and nothing should be attempted. */
  refuse?: string;
}

/**
 * Parse argv strictly.
 *
 * An unrecognised flag is a refusal rather than something ignored, and the reason is
 * `--reset-agent` specifically: mistyped as `--reset-agents` and quietly dropped, the
 * swap succeeds, the report says the history was left alone, and the person who asked
 * for it cleared reads that as having got what they asked for. A second positional
 * argument is refused for the same class of reason — two seed files named and one
 * silently applied is the swap doing something nobody asked for.
 *
 * A bare `--` is skipped: `npm run db:seed -- seeds/x.sql` already consumes one, and
 * doubling it up is a common and harmless habit.
 */
export function parseArgs(argv: readonly string[]): Invocation {
  const call: Invocation = { resetAgent: false, help: false };

  for (const arg of argv) {
    if (arg === '--') continue;
    if (arg === '--help' || arg === '-h') {
      call.help = true;
    } else if (arg === '--reset-agent') {
      call.resetAgent = true;
    } else if (arg.startsWith('-')) {
      return {
        ...call,
        refuse:
          `Unknown option ${arg}. The only options are --reset-agent and --help, and an ` +
          'unrecognised one is refused rather than ignored: --reset-agent quietly dropped ' +
          'would report the agent history as deliberately kept.',
      };
    } else if (call.file === undefined) {
      call.file = arg;
    } else {
      return {
        ...call,
        refuse:
          `Two datasets named (${call.file} and ${arg}), and only one can be applied. ` +
          'Which one is not a guess worth making.',
      };
    }
  }

  return call;
}

/* ─── reading the file before trusting it ─── */

/**
 * A UTF-8 BOM is not SQL.
 *
 * Windows editors write one by default, and Postgres reports the result as a syntax
 * error at or near an invisible character — on the FIRST statement of the file, which
 * sends the reader looking at a line that is correct.
 */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Blank out everything Postgres would not read as code, preserving newlines.
 *
 * Line comments, nested block comments, single-quoted strings, quoted identifiers and
 * dollar-quoted bodies become spaces, so that a scan over the result finds keywords
 * that are really keywords. One character out for one character in, newlines included:
 * both scans below report line numbers from the blanked copy, and they are only the
 * file's line numbers because nothing here changes a length.
 *
 * Dollar quoting is the case that matters: every DO block in a seed contains BEGIN and
 * END at the start of a line, and a scanner that could not see `$seed$ … $seed$` would
 * report the seed's own assertions as transaction control and refuse a correct file.
 */
export function blankNonCode(sql: string): string {
  const out: string[] = [];
  const keep = (from: number, to: number): void => {
    for (let k = from; k < to; k++) out.push(sql[k] === '\n' ? '\n' : ' ');
  };

  let i = 0;
  while (i < sql.length) {
    const two = sql.slice(i, i + 2);

    if (two === '--') {
      const end = sql.indexOf('\n', i);
      const stop = end === -1 ? sql.length : end;
      keep(i, stop);
      i = stop;
      continue;
    }

    if (two === '/*') {
      // Nested, because Postgres nests block comments where SQL-92 does not.
      let depth = 0;
      let j = i;
      while (j < sql.length) {
        if (sql.slice(j, j + 2) === '/*') {
          depth++;
          j += 2;
        } else if (sql.slice(j, j + 2) === '*/') {
          depth--;
          j += 2;
          if (depth === 0) break;
        } else {
          j++;
        }
      }
      keep(i, j);
      i = j;
      continue;
    }

    if (sql[i] === "'" || sql[i] === '"') {
      const quote = sql[i];
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === quote) {
          // Doubled quote: an escaped one, so the literal continues.
          if (sql[j + 1] === quote) j += 2;
          else {
            j++;
            break;
          }
        } else {
          j++;
        }
      }
      keep(i, j);
      i = j;
      continue;
    }

    if (sql[i] === '$') {
      const tag = /^\$[A-Za-z_][A-Za-z_0-9]*\$|^\$\$/.exec(sql.slice(i));
      if (tag) {
        const close = sql.indexOf(tag[0], i + tag[0].length);
        const j = close === -1 ? sql.length : close + tag[0].length;
        keep(i, j);
        i = j;
        continue;
      }
    }

    out.push(sql[i]);
    i++;
  }

  return out.join('');
}

/** Where an offset into the text falls, for a reader with the file open. */
export function locate(text: string, offset: number): { line: number; column: number } {
  const upto = text.slice(0, Math.max(0, offset));
  const lines = upto.split('\n');
  return { line: lines.length, column: (lines[lines.length - 1] ?? '').length + 1 };
}

/**
 * Transaction control inside the seed file, which would break the promise this script
 * makes about it.
 *
 * The file is applied inside one BEGIN … COMMIT so that a failure halfway leaves the
 * previous dataset. A stray COMMIT in the file ends that transaction early: everything
 * before it is durable, everything after it runs outside a transaction, and a later
 * failure leaves exactly the half-of-two-datasets state the wrapper exists to prevent —
 * silently, because the seed's own error is reported and the rollback that did nothing
 * is not.
 *
 * Refused before anything is truncated, since the alternative is finding out once the
 * previous data is already gone. `END` is included because Postgres accepts it as a
 * synonym for COMMIT; it is safe to look for only because a plpgsql block's END has
 * been blanked out by `blankNonCode` first.
 */
export function transactionControlIn(sql: string): Array<{ line: number; statement: string }> {
  const code = blankNonCode(sql);
  const found: Array<{ line: number; statement: string }> = [];
  const pattern =
    /(^|;)\s*(begin\s+transaction|begin\s+work|begin|start\s+transaction|commit|end|rollback|savepoint)\b/gi;

  for (const match of code.matchAll(pattern)) {
    // The offset of the KEYWORD, not of the match. The match begins at the `;` that ended
    // the previous statement and swallows the newline after it, so an offset taken from
    // match.index reports the line above the one the reader has to edit.
    const at = (match.index ?? 0) + match[0].length - match[2].length;
    found.push({ line: locate(code, at).line, statement: match[2].replace(/\s+/g, ' ') });
  }
  return found;
}

/**
 * psql's own commands, which this script cannot run.
 *
 * `scripts/assert-roles.sql` opens with `\set ON_ERROR_STOP on`, and it is the file a
 * seed author here is most likely to have open next to theirs. Those backslash commands
 * are psql's, not Postgres's: sent over the wire they come back as `syntax error at or
 * near "\"`, which reads as a broken seed rather than as a line that belongs to a
 * different program.
 *
 * ON_ERROR_STOP is also unnecessary here, and saying so is the useful half of the
 * refusal: the whole file is applied inside one transaction, so the first error already
 * abandons everything after it.
 *
 * A second pass of `blankNonCode` rather than sharing one with the scan above. The files
 * are kilobytes and this runs once, so the duplicated work buys two functions that can
 * each be read and tested on their own.
 */
export function psqlMetaCommandsIn(sql: string): Array<{ line: number; command: string }> {
  const code = blankNonCode(sql);
  const found: Array<{ line: number; command: string }> = [];
  for (const match of code.matchAll(/(^|\n)[ \t]*(\\[a-zA-Z?!+]+)/g)) {
    const at = (match.index ?? 0) + match[0].length - match[2].length;
    found.push({ line: locate(code, at).line, command: match[2] });
  }
  return found;
}

/* ─── Postgres's own words ─── */

/** The fields node-postgres copies off an ErrorResponse that are worth printing. */
interface PgErrorish {
  message?: unknown;
  code?: unknown;
  detail?: unknown;
  hint?: unknown;
  where?: unknown;
  position?: unknown;
}

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value : undefined;

/**
 * Report a failed apply in Postgres's words, not in a paraphrase.
 *
 * The most likely failure is a `RAISE EXCEPTION` from the seed's own DO block — "seed:
 * no row has engagement_kind=passed, so passed_lead cannot bind" — and that sentence is
 * the entire useful content of the event. Anything this file wrote instead of it would
 * be a worse version of it. `detail`, `hint` and `where` are printed when present
 * because `where` is what says which line of which plpgsql block raised; `position` is
 * turned into a line and column of the seed file, since the whole file was sent as one
 * statement and an offset into it is an offset into the file. A RAISE usually carries
 * `where` and no `position`, and a syntax error the other way round.
 */
export function describeFailure(err: unknown, seedPath: string, seedText: string): string[] {
  const e = (err ?? {}) as PgErrorish;
  const lines: string[] = [];

  lines.push(`Postgres refused ${seedPath}, and the transaction was rolled back.`);
  lines.push('');
  lines.push(`  ${text(e.message) ?? String(err)}`);

  const code = text(e.code);
  if (code) lines.push(`  code    ${code}`);
  const detail = text(e.detail);
  if (detail) lines.push(`  detail  ${detail}`);
  const hint = text(e.hint);
  if (hint) lines.push(`  hint    ${hint}`);
  const where = text(e.where);
  if (where) lines.push(`  where   ${where.replace(/\n/g, '\n          ')}`);

  const position = Number(text(e.position) ?? NaN);
  if (Number.isFinite(position) && position > 0) {
    const at = locate(seedText, position - 1);
    lines.push(`  at      ${seedPath} line ${at.line}, column ${at.column}`);
  }

  lines.push('');
  lines.push('  Nothing was changed. The TRUNCATE was inside the same transaction, so whatever');
  lines.push('  dataset was loaded before this one is still loaded.');
  return lines;
}

/* ─── printing ─── */

/**
 * Two spaces, then a column wide enough for the longest thing put in it —
 * `invoice_number_seq`, at eighteen characters. Wider than that on purpose: padEnd on a
 * string already at the width adds nothing, and the label would run into the value.
 */
const label = (s: string): string => `  ${s.padEnd(20)}`;

/** A count line per table, so a zero is visible rather than absent. */
function countLines(counts: Record<string, number>, tables: readonly string[]): string[] {
  return tables.map((t) => `${label(t)}${String(counts[t] ?? 0).padStart(6)}`);
}

function usage(): string {
  return [
    'Apply an alternative dataset from seeds/ over the business tables.',
    '',
    '  npx tsx scripts/seed.ts seeds/<name>.sql [--reset-agent]',
    '',
    '  --reset-agent   also clear agent_runs, agent_proposals, agent_write_keys and',
    '                  agent_memory. Without it they are kept, and any evidence they',
    '                  recorded goes on naming business rows that no longer exist.',
    '                  The eval history (which case passed, which failed) is kept',
    '                  either way.',
    '  --help          this.',
    '',
    'Needs DATABASE_URL and a database that already has the schema (npm run db:up).',
    'The five business tables are emptied and the file is applied in one transaction,',
    'so a file that fails halfway leaves the dataset that was there before it.',
    '',
    '`npm run db:seed -- seeds/<name>.sql` is the same thing with .env loaded, and',
    '`npm run db:seed -- db/900-seed.sql` puts the shipped dataset back without',
    'dropping the volume.',
  ].join('\n');
}

/** What is available to apply, for a refusal that saves the reader a directory listing. */
function availableSeeds(names: string[] | null): string[] {
  if (names === null) {
    return [
      `There is no ${SEEDS_DIR}/ directory here. Alternative datasets live in it;`,
      'paths are read relative to the repository root, which is where the npm scripts run.',
    ];
  }
  if (names.length === 0) {
    return [`${SEEDS_DIR}/ exists but holds no .sql file.`];
  }
  return [`In ${SEEDS_DIR}/:`, ...names.map((n) => `  ${SEEDS_DIR}/${n}`)];
}

/* ─── the swap ─── */

/**
 * Returns an exit code rather than calling `process.exit`, so the test can drive it and
 * so a caller can decide what to do about a refusal. Exit non-zero on every refusal:
 * this is a thing that gets put in front of a suite run in CI.
 */
export async function main(argv: readonly string[], deps: Deps): Promise<number> {
  const { io, out, err } = deps;

  const call = parseArgs(argv);
  if (call.help) {
    out(usage());
    return EXIT_OK;
  }
  if (call.refuse) {
    err(`${call.refuse}\n\n${usage()}`);
    return EXIT_USAGE;
  }

  /* ---------- 1. the file, before anything else ---------- */
  //
  // Checked before DATABASE_URL, because the path is the thing the reader just typed and
  // a typo in it is the likeliest mistake by a wide margin. Someone whose environment is
  // also wrong hears about the file first and about the environment on the next attempt.
  if (call.file === undefined) {
    err(['No seed file given.', '', ...availableSeeds(await io.listSeeds(SEEDS_DIR)), '', usage()].join('\n'));
    return EXIT_USAGE;
  }

  const read = await io.readSeed(call.file);
  if (!read.ok) {
    err(
      [
        `Cannot read ${call.file}: ${read.why}`,
        '',
        ...availableSeeds(await io.listSeeds(SEEDS_DIR)),
      ].join('\n')
    );
    return EXIT_USAGE;
  }

  const seed = stripBom(read.text);
  if (seed.trim() === '') {
    // An empty file is a valid query that inserts nothing, so without this the swap
    // would truncate the business, apply nothing, report five zeros, and exit 0.
    err(`${call.file} is empty. Applying it would empty the business and report success.`);
    return EXIT_USAGE;
  }

  const meta = psqlMetaCommandsIn(seed);
  if (meta.length > 0) {
    err(
      [
        `${call.file} contains psql meta-commands, and this script is not psql:`,
        ...meta.map((m) => `  line ${m.line}: ${m.command}`),
        '',
        'The file is sent to Postgres over the wire, so a backslash command arrives as a',
        'syntax error at or near "\\" and reads as a broken seed. If it is ON_ERROR_STOP,',
        'it is not needed: the whole file is applied in one transaction, so the first error',
        'already abandons everything after it.',
      ].join('\n')
    );
    return EXIT_USAGE;
  }

  const control = transactionControlIn(seed);
  if (control.length > 0) {
    err(
      [
        `${call.file} contains its own transaction control, which this script cannot honour:`,
        ...control.map((c) => `  line ${c.line}: ${c.statement.toUpperCase()}`),
        '',
        'The file is applied inside one BEGIN … COMMIT so that a failure halfway leaves the',
        'previous dataset. A COMMIT or ROLLBACK inside it ends that transaction early, and a',
        'later failure then leaves half of one dataset on top of half of another. Remove the',
        'transaction control; the seed does not need it.',
      ].join('\n')
    );
    return EXIT_USAGE;
  }

  /* ---------- 6a. the environment ---------- */
  const url = deps.env.DATABASE_URL;
  if (!url) {
    err(
      [
        'DATABASE_URL is not set, so there is nothing to connect to.',
        '',
        'Refusing to fall back to pg\'s defaults: with no connection string it reads',
        'PGHOST/PGUSER or connects to localhost:5432 as your OS user, and a TRUNCATE that',
        'succeeds against the wrong database is not a mistake anyone gets to undo.',
        '',
        'Copy .env.example to .env and run `npm run db:up`. Nothing in this repository loads',
        '.env by itself, so the file has to be handed to the runner: `npm run db:seed --',
        `${SEEDS_DIR}/<name>.sql\` does that, and the bare npx form needs the flag —`,
        `tsx --env-file=.env scripts/seed.ts ${SEEDS_DIR}/<name>.sql.`,
      ].join('\n')
    );
    return EXIT_USAGE;
  }

  let db: Session;
  try {
    // Notices as they arrive rather than at the end: a seed that RAISEs NOTICE is
    // narrating itself, and a swap that appears to hang is easier to read with the last
    // thing the seed said on the screen.
    db = await deps.connect(url, (message) => err(`  ${message}`));
  } catch (e) {
    err(
      [
        `Could not connect: ${e instanceof Error ? e.message : String(e)}`,
        '',
        'If the compose database is not running, `npm run db:up` starts it and waits for the',
        'healthcheck. Nothing was attempted.',
      ].join('\n')
    );
    return EXIT_USAGE;
  }

  try {
    /* ---------- 6b. is there a business here to replace ---------- */
    let present: Record<string, unknown>;
    try {
      present = (await db.query(PRESENCE_QUERY))[0] ?? {};
    } catch (e) {
      // Connected and then refused: a role without rights on the schema, a connection
      // string pointing at a database that exists but is not this one. Postgres's own
      // message is the useful part, and a stack trace here would be a stack trace about
      // a question rather than about the answer.
      err(
        [
          `Could not read the schema: ${e instanceof Error ? e.message : String(e)}`,
          '',
          'Nothing was attempted. This ran before the transaction opened, so no table has',
          'been touched.',
        ].join('\n')
      );
      return EXIT_USAGE;
    }

    const missing = [...BUSINESS_TABLES, INVOICE_SEQUENCE].filter((name) => present[name] !== true);
    if (missing.length > 0) {
      err(
        [
          `This database does not have the schema yet — missing: ${missing.join(', ')}.`,
          '',
          'Run `npm run db:up` (or `npm run db:reset` to rebuild from db/) and try again. A',
          'seed applied over half a schema fails somewhere in the middle and reports a',
          'missing relation, which reads as a broken seed file rather than an empty database.',
        ].join('\n')
      );
      return EXIT_USAGE;
    }

    const agentPresent = AGENT_HISTORY_TABLES.filter((name) => present[name] === true);
    const agentAbsent = AGENT_HISTORY_TABLES.filter((name) => present[name] !== true);

    err(`applying ${call.file}`);

    /* ---------- 2, 3, 4: all of it or none of it ---------- */
    let history: Record<string, number> = {};
    let landed: Record<string, number> = {};
    let sequence: Record<string, unknown> = {};

    await db.query('BEGIN');
    try {
      // Counted before the truncate so the report can say how many rows are about to be
      // left pointing at nothing — or, with --reset-agent, how many were cleared.
      if (agentPresent.length > 0) {
        history = ((await db.query(countsQuery(agentPresent)))[0] ?? {}) as Record<string, number>;
      }

      await db.query(TRUNCATE_BUSINESS);
      await db.query(RESET_SEQUENCE);

      // The file, unaltered, as one statement batch. pg sends a multi-statement string
      // over the simple query protocol, which is what lets a seed's dollar-quoted DO
      // blocks and its setval arrive exactly as written.
      await db.query(seed);

      landed = ((await db.query(countsQuery(BUSINESS_TABLES)))[0] ?? {}) as Record<string, number>;
      sequence = (await db.query(SEQUENCE_CHECK_QUERY))[0] ?? {};

      // Inside the same transaction, deliberately. Clearing the history first and then
      // failing to apply the seed would leave the old dataset with no record of the runs
      // that were made against it: the worst of both, and unrecoverable.
      if (call.resetAgent) {
        for (const table of AGENT_DELETE_ORDER) {
          if (agentPresent.includes(table)) await db.query(`DELETE FROM ${table}`);
        }
      }

      await db.query('COMMIT');
    } catch (e) {
      // The rollback is what makes the promise true, so its own failure must not replace
      // the message that explains what went wrong — that sentence is the useful part.
      try {
        await db.query('ROLLBACK');
      } catch (rollbackError) {
        err(
          `  the ROLLBACK itself failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}` +
            ' — the connection is closing, which ends the transaction anyway.'
        );
      }
      err(describeFailure(e, call.file, seed).join('\n'));
      return EXIT_NOT_APPLIED;
    }

    /* ---------- 5. what landed, and what did not move with it ---------- */
    const report: string[] = [];
    report.push(`applied ${call.file}`);
    report.push(...countLines(landed, BUSINESS_TABLES));

    const emptyTables = BUSINESS_TABLES.filter((t) => (landed[t] ?? 0) === 0);
    if (emptyTables.length > 0) {
      // Stated rather than left to be noticed in a column of numbers: an empty table is
      // the POINT of a deliberately sparse dataset, and a mistake in a complete one.
      report.push(`${label('empty')}${emptyTables.join(', ')}`);
    }

    const nextValue = text(sequence.next_value) ?? '?';
    const highestUsed = text(sequence.highest_used);
    report.push(
      `${label(INVOICE_SEQUENCE)}next number is ${nextValue}` +
        (highestUsed
          ? `; the highest this dataset uses is ${highestUsed}`
          : '; this dataset writes no numbered invoice')
    );

    report.push('');
    if (call.resetAgent && agentPresent.length === 0) {
      report.push(`the agent's own history was asked to be cleared, and there was none:`);
      report.push(`  ${AGENT_HISTORY_TABLES.join(', ')}`);
      report.push('  are not tables in this database, so nothing recorded can have gone stale.');
    } else if (call.resetAgent) {
      const cleared = agentPresent.reduce((sum, t) => sum + (history[t] ?? 0), 0);
      report.push(`the agent's own history was cleared (--reset-agent)`);
      report.push(`${label('deleted')}${cleared} row(s) from`);
      report.push(`${label('')}${agentPresent.join(', ')}`);
      report.push(`${label('kept')}${EVAL_HISTORY_TABLES.join(', ')} — which case passed and which`);
      report.push(
        `${label('')}failed is still true of the runs that produced it, and that record is`
      );
      report.push(`${label('')}the point of keeping any history at all.`);
    } else if (agentPresent.length === 0) {
      report.push(`the agent's own history was NOT touched, and there is none here:`);
      report.push(`  ${AGENT_HISTORY_TABLES.join(', ')}`);
      report.push('  are not tables in this database, so nothing recorded points at what just went');
      report.push('  away. db/002-agent.sql is what creates them.');
    } else {
      const total = agentPresent.reduce((sum, t) => sum + (history[t] ?? 0), 0);
      report.push(`the agent's own history was NOT touched`);
      report.push(...countLines(history, agentPresent));
      if (agentAbsent.length > 0) report.push(`${label('absent')}${agentAbsent.join(', ')}`);
      report.push('');
      if (total === 0) {
        report.push('  Those tables are empty, so nothing recorded points at the dataset that just');
        report.push('  went away.');
      } else {
        report.push(
          `  ${total} row(s) there cite business records by id — a run's evidence, a proposal's`
        );
        report.push(
          '  target, a memory\'s subject — and those ids are gone. It is jsonb with no foreign'
        );
        report.push(
          '  key, so nothing is broken; the record simply became untrue, which is worse. A'
        );
        report.push(
          '  write key claimed against a row that no longer exists is the one with teeth: an'
        );
        report.push(
          '  approval matching it replays a result about a record nobody can look up. Re-run'
        );
        report.push('  with --reset-agent to clear all four.');
      }
    }

    report.push('');
    report.push('next  npm run db:check — which eval roles bind against this dataset, and');
    report.push('      therefore which cases would skip rather than run.');
    out(report.join('\n'));

    /* ---------- the sequence, if the seed forgot its setval ---------- */
    //
    // A warning and not a refusal. The dataset is correct and the fix is one statement,
    // so rolling back a good seed to punish a missing setval would cost more than it
    // saves — but the failure it leads to arrives much later, on an innocent write, so it
    // is said loudly and with the fix attached.
    if (sequence.collides === true) {
      err(
        [
          '',
          `! ${INVOICE_SEQUENCE} will hand out ${nextValue}, and this dataset already uses ${highestUsed ?? 'a higher number'}.`,
          '  The next invoice created through the application collides on the unique index on',
          '  invoices.number. The seed file is missing its closing setval; until it has one:',
          `      SELECT setval('${INVOICE_SEQUENCE}', ${highestUsed ?? '<highest number used>'}, true);`,
        ].join('\n')
      );
    }

    return EXIT_OK;
  } finally {
    // Always. An open pg client keeps a socket and the event loop alive, so a swap that
    // finished would sit there looking like a hang (the same failure `close()` in
    // src/db.ts exists for).
    await db.end();
  }
}

/* ─── the real seams ─── */

/**
 * Node and Postgres, wired up.
 *
 * Kept in this file rather than in `scripts/seed.ts` so that it is inside `tsconfig`'s
 * `include` and `npm run typecheck` reads it. The script is three lines for the same
 * reason: nothing under `scripts/` is typechecked, so nothing that could be wrong
 * should live there.
 *
 * None of this is exercised by the unit suite — a fake `Deps` is. What it can get wrong
 * is a wrong file mode or a pg option, and only running it shows that.
 */
export function nodeDeps(): Deps {
  return {
    env: process.env,
    out: (t) => process.stdout.write(`${t}\n`),
    err: (t) => process.stderr.write(`${t}\n`),

    io: {
      async readSeed(path) {
        const { readFile } = await import('node:fs/promises');
        try {
          return { ok: true, text: await readFile(path, 'utf8') };
        } catch (e) {
          // The errno message verbatim, because ENOENT and EACCES and EISDIR are three
          // different problems and only one of them is a typo.
          return { ok: false, why: e instanceof Error ? e.message : String(e) };
        }
      },
      async listSeeds(dir) {
        const { readdir } = await import('node:fs/promises');
        try {
          const names = await readdir(dir);
          return names.filter((n) => n.toLowerCase().endsWith('.sql')).sort();
        } catch {
          // Null means "no such directory", which the refusal words differently from an
          // empty one: nothing to choose from, versus nothing there yet.
          return null;
        }
      },
    },

    async connect(url, onNotice) {
      const pg = (await import('pg')).default;
      const client = new pg.Client({
        connectionString: url,
        connectionTimeoutMillis: 5_000,
        // Well above src/db.ts's 10s. That one is sized so a slow tool call cannot
        // outlive the run paying for it; this is a whole dataset with DO-block
        // assertions over every row, and a timeout mid-apply would roll back a correct
        // seed and read as the file being at fault.
        statement_timeout: 120_000,
        application_name: 'business-agent seed',
      });
      client.on('notice', (n) => onNotice(n.message ?? String(n)));
      await client.connect();
      return {
        async query(sqlText) {
          const result = await client.query(sqlText);
          // A multi-statement string comes back as an array of results, one per
          // statement. Nothing here reads rows from the seed file itself, so the empty
          // array is the honest answer for that case.
          return Array.isArray(result) ? [] : result.rows;
        },
        async end() {
          await client.end();
        },
      };
    },
  };
}
