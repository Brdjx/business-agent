/**
 * The database: one pool, two query functions, and a refusal to start without
 * being told where to connect.
 *
 * This replaces a Supabase client in the private original, and the difference
 * is not only the vendor. There is no `.from().select()` here and nothing
 * builds a query for you: a query is SQL text with $1 placeholders, and the
 * table names, the joins and the filters are written out where a reader can
 * check them against `db/001-business.sql`. That is deliberate. The predicates
 * this schema turns on — `engagement_kind = 'client' AND status IN
 * ('active','inactive')`, `status = 'open' AND due_date < CURRENT_DATE`,
 * `status NOT IN ('void','draft')` — are exactly the ones a fluent query
 * builder makes it easy to write half of.
 *
 * What this surface deliberately does NOT do is add the operator's scope for
 * you. In this schema the business tables (clients, contacts, projects,
 * invoices, time_entries) have no `user_id` column at all and the `agent_*`
 * tables do, so a helper that "remembers the scope" would be silently wrong on
 * five tables out of nine. The scope is passed as a parameter, by hand, in the
 * queries that have a column to put it in.
 */

// A default import, not `import { Pool } from 'pg'`. pg is CommonJS and builds
// its exports onto an instance at construction time, which Node's ESM interop
// cannot see by static analysis — the named form typechecks and then throws
// "Named export 'Pool' not found" at runtime, which is a failure that only
// appears once something actually runs the file. The type-only import below is
// erased, so it is free.
import pg from 'pg';
import type { Pool, QueryResultRow } from 'pg';

/**
 * DATE columns come back as strings, not as Date objects.
 *
 * pg's default parser turns a DATE into a JS Date at local midnight, so
 * `issued_at` for the 4th read back through `toISOString()` is the 3rd
 * anywhere east of UTC. The schema chose DATE over TIMESTAMPTZ precisely so
 * that a month total could not shift by a day depending on the session's time
 * zone (see the comment on `invoices.issued_at`), and re-introducing a zone in
 * the driver would hand that bug straight back.
 *
 * A 'YYYY-MM-DD' string is also what the questions are asked in, what the
 * agent's arguments arrive as, and what a proposal's precondition has to
 * compare against later.
 *
 * TIMESTAMPTZ is left alone: an absolute instant is a Date, correctly.
 * BIGINT and NUMERIC are left alone too, and that is not an oversight — see
 * the note on money below.
 */
pg.types.setTypeParser(pg.types.builtins.DATE, (value) => value);

/**
 * Money and hours arrive as strings, on purpose.
 *
 * `invoices.amount_cents` is BIGINT and `time_entries.hours` is NUMERIC(5,2),
 * and the pg driver hands both back as strings because neither fits a JS
 * number safely in general. So does `SUM(...)`: a total summed in Postgres
 * comes back as `'11050000'`, and `'11050000' + '3330000'` is a 16-character
 * string, not a number. Every total in this repo is summed in SQL and then
 * parsed once, deliberately, at the point it is formatted — never accumulated
 * in JS and never coerced by accident.
 *
 * The parsers are NOT overridden to return numbers. Doing that would make
 * `Number` the type of every money column and hide the one place it is wrong.
 */

/**
 * Statement timeout, and why an agent needs one more than an ordinary service
 * does.
 *
 * The budget has four limits, and none of them can end a query that has
 * already started. The wall-clock check runs between model calls; the
 * harness's per-tool timeout abandons the promise but not the work — Postgres
 * keeps executing, the connection stays busy, and the pool is one client
 * smaller for as long as it takes. `statement_timeout` is the only one of the
 * three that stops the work.
 *
 * It matters here because the shape of the query is chosen at runtime by the
 * model. Not the SQL — that is written by hand — but which tool runs, how wide
 * an ILIKE pattern is, how many rows a limit asks for. A tool that can hang
 * has no budget: the run's remaining wall clock is spent waiting on something
 * nobody is going to interrupt, and the answer and the trace are never
 * written.
 *
 * Kept BELOW whatever per-tool timeout the loop uses (15s in the original), so
 * the ordinary outcome of a slow query is a failed tool result the model can
 * act on — "try a narrower request" — rather than a wait that outlives the run
 * that is paying for it.
 */
const STATEMENT_TIMEOUT_MS = Number(process.env.DB_STATEMENT_TIMEOUT_MS || 10_000);

/** A wrong host or port must fail, not hang until the OS gives up on it. */
const CONNECT_TIMEOUT_MS = 5_000;

/**
 * Small, but not one. The loop runs independent tool calls together — the model
 * routinely asks for two lookups at once — and a pool of one turns that
 * concurrency back into a queue while still reporting the elapsed time as
 * though the calls had overlapped.
 */
const MAX_CLIENTS = 5;

let pool: Pool | undefined;

/**
 * The pool, built on first use.
 *
 * Built lazily rather than at module load, and the trade is worth stating.
 * Failing at import is louder, but this module is imported transitively by the
 * tools, and the unit suite exists to test argument validation and budgets
 * with no database anywhere near it. A module-level throw would mean that
 * every test of a validator needed Postgres, which ends with the validators
 * not being tested.
 *
 * So the failure is deferred to the first query and no further. Nothing here
 * ever connects to a database it was not told about.
 */
function getPool(): Pool {
  if (pool) return pool;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    // Loud, and specific about the failure being prevented. pg with no
    // connection string does not fail — it reads PGHOST/PGUSER/PGDATABASE, and
    // failing that connects to localhost:5432 with the OS username as both
    // user and database name. If anything is listening there, every query
    // succeeds against the wrong database: `select count(*) from clients`
    // either errors in a way that reads as a schema problem, or returns 0 and
    // the agent reports, fluently and with evidence, that the business has no
    // clients.
    //
    // Nothing in this repo loads .env — there is no dotenv dependency. The
    // runner supplies it: `node --env-file=.env` (Node 20.6+), or the same flag
    // through tsx.
    throw new Error(
      'DATABASE_URL is not set, so no connection pool will be built. ' +
        'Refusing to fall back to pg\'s defaults: with no connection string it ' +
        'reads PGHOST/PGUSER or connects to localhost:5432 as your OS user, and ' +
        'a successful query against the wrong database reports an empty business ' +
        'instead of an error. Copy .env.example to .env, run `npm run db:up`, and ' +
        'pass the file to the runner (node --env-file=.env / tsx --env-file=.env).'
    );
  }

  pool = new pg.Pool({
    connectionString,
    max: MAX_CLIENTS,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    statement_timeout: STATEMENT_TIMEOUT_MS,
    // So a query found running in pg_stat_activity says who started it. One
    // operator with a psql session open and an agent mid-run are both
    // "business_agent" otherwise.
    application_name: 'business-agent',
  });

  // An idle client whose connection dies — the database restarted, a container
  // was recreated — emits 'error' on the pool. An EventEmitter 'error' with no
  // listener is an uncaught exception, so without this line a restart of
  // Postgres takes the process down at whatever moment it happens, including
  // after a run has answered correctly and is writing its trace. There is
  // nothing to do about it here beyond not dying: the next query gets a fresh
  // client.
  pool.on('error', (err) => {
    console.error('[db] idle client error (the pool will replace it):', err.message);
  });

  return pool;
}

/**
 * Run a query, return its rows.
 *
 * `params` is always an array of values for $1, $2, … and values are never
 * interpolated into the text. That includes the ILIKE patterns the name
 * lookups are built from: the pattern is assembled as a *parameter*
 * (`'%' || $1 || '%'` in SQL, or the wildcards concatenated in JS and passed as
 * one value), because the string in it came from a sentence the model wrote.
 */
export async function sql<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: readonly unknown[] = []
): Promise<T[]> {
  const result = await getPool().query<T>(text, params as unknown[]);
  return result.rows;
}

/**
 * The first row, or null.
 *
 * Null rather than a throw, because "no such client" is an answer the tools
 * have to give in words — it is the case the model most needs to hear plainly
 * instead of as an exception.
 *
 * It does not check that the query matched exactly one row, and that is a
 * decision rather than laziness. Ambiguity is a tool-level judgment with a
 * different answer per tool: a read that resolves a client by name wants the
 * first of several and can say which it followed, while a write that resolves a
 * project by name must see all the matches and refuse. A throw here would move
 * that decision into a helper that cannot tell the two apart, and the refusal
 * has to be a sentence the model can act on rather than a stack trace. A caller
 * that means "exactly one" says so in its own SQL, or counts the rows itself.
 */
export async function one<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: readonly unknown[] = []
): Promise<T | null> {
  const rows = await sql<T>(text, params);
  return rows[0] ?? null;
}

/**
 * Release the pool so the process can exit.
 *
 * An idle pg client keeps a socket open and the event loop alive, so a CLI that
 * answered a question hangs afterwards instead of exiting, and a vitest file
 * reports that it "closed successfully" while the worker refuses to end. Both
 * present as something worse than they are.
 *
 * Safe to call twice, and the handle is cleared, so a test that closes and then
 * queries again builds a fresh pool rather than failing on a pool that has
 * already ended.
 */
export async function close(): Promise<void> {
  const current = pool;
  pool = undefined;
  await current?.end();
}
