/**
 * The write tools: three acts on the business, and the judgment that makes each
 * one safe to say yes to.
 *
 * A read-only agent is a demo. The moment a tool changes a row, four problems
 * arrive at once, and every one of them has already gone wrong in the system this
 * is extracted from.
 *
 * **Consent.** `ctx.allowWrites` is false by default. A write tool called with it
 * off does not fail — it resolves its target, decides everything it would decide,
 * and returns what it WOULD do plus a `ProposalDraft`. It writes nothing. The same
 * tool serves both modes, so the model needs no separate vocabulary for proposing
 * and doing, and the flag is set to true only by the approval path
 * (`decideProposal`), which re-runs the STORED call rather than the question.
 *
 * **Idempotency.** A model can call the same tool twice in one turn and a retried
 * step can replay a call that already succeeded. For a lookup that is waste. For
 * "log four hours against Halden Freight" it is a second billable line against
 * someone real. Every write here goes through `once()` from `../write-keys` —
 * claim the key, then write, then record — and never assembles those three itself:
 * the ordering is the guarantee and a call site that has it wrong looks identical
 * to one that has it right.
 *
 * **Ambiguity.** A name in a sentence is not an identity. `projects.name` is
 * resolved with `ILIKE '%phrase%'`, and two projects whose names contain one
 * another are an ambiguity that must be REFUSED rather than resolved by ordering
 * more cleverly. Hours or money attributed to the wrong record is wrong in the way
 * nobody re-checks. Note that exactness is not identity either: the unique index on
 * projects is per client, so even an exact name can name two rows.
 *
 * **Reporting the difference between doing and having done.** Setting a status to
 * the value it already has changes nothing. That is not a failure, but the tool
 * must SAY so, and it must return no proposal — a card asking someone to approve a
 * no-op is noise, and "marked inactive" when it was already inactive is a small lie
 * that makes everything else the agent reports unverifiable by feel. Same rule for
 * a silent correction: when `billable` is overridden, it is said out loud.
 *
 * ── Two rules that are here because of one incident each ──
 *
 * **Billable is decided in `run`, after the client is resolved** (incident 7). It
 * used to default to `true` in `validate`, which runs before the project name has
 * been resolved to a project and a client — so the decision was being made in the
 * layer that had not yet read the record it depended on, and the first write this
 * agent ever performed landed billable on one of the studio's own ventures. An
 * `own_venture` is the studio's own and an `artifact` was never work anyone bought,
 * so neither can be billed to anybody; an explicit `billable: true` on either is
 * overridden rather than obeyed. That rule is two joins from `time_entries.billable`
 * (entry -> project -> client.engagement_kind), so no CHECK constraint can see it
 * and the tool owns it outright.
 *
 * **Nothing here is registered by this file** (incident 1). `WRITE_TOOLS` is
 * exported as data and `../registry` registers it by an explicit call. Registration
 * as an import side effect is what made approving a write fail in production for
 * weeks while every test passed.
 *
 * ── What these tools do not do ──
 *
 * Each touches exactly ONE row, and that is a constraint rather than a coincidence:
 * the write-key ledger makes a repeat safe, it does not make a multi-row write
 * atomic, so a write spanning two tables would need the claim inside the same
 * transaction (see the open edges in `docs/design.md`). None of them writes a
 * human's free-text column — see the note on `reason` in `set_client_status`.
 */

// `../tools` is the FILE src/agent/tools.ts, not this directory; `../../db` is
// src/db.ts. Both spellings look odd together and both are right.
import { one, sql } from '../../db';
import {
  ToolError,
  asObject,
  optionalDate,
  optionalString,
  requireString,
  type Evidence,
  type Precondition,
  type Tool,
} from '../tools';
import { once, writeKey } from '../write-keys';

/* ─── what may never be billed ─── */

/**
 * The engagement kinds nobody can be charged for.
 *
 * `own_venture` is the studio's own product: there is no counterparty and no
 * invoice path. `artifact` is a record of something built for another reason — a
 * take-home — and was never work anyone bought. Both are `clients` rows because
 * the projects and hours have to hang off something, and neither is a customer.
 *
 * `passed` is deliberately NOT in this set. A lead the studio passed on has no
 * revenue either, but the schema names only these two as never billable
 * (`db/001-business.sql`, on `time_entries.billable`), and inventing a third rule
 * here would be policy this extraction has no mandate for. What the tool does
 * instead is print the kind on the card, so the operator approving it can see what
 * they are billing.
 */
const NEVER_BILLABLE = new Set(['own_venture', 'artifact']);

/** What each kind means, in the words the card has to get right. */
const KIND_NOTE: Record<string, string> = {
  passed: 'took a call and never became a client',
  own_venture: "the studio's own, never billable",
  artifact: 'built for another reason, such as a take-home — a record, not an engagement',
};

/** The statuses `clients.status` can hold. There is no 'lead' — see the tool. */
const CLIENT_STATUSES = ['active', 'inactive', 'prospect'] as const;

/* ─── resolving a name, and refusing when it is not one row ─── */

/** A write resolves to one row or refuses. Enough candidates to list, no more. */
const MAX_MATCHES = 5;

/** How many names a miss lists back, so a misspelling is recoverable. */
const NAME_HINTS = 12;

/**
 * An ILIKE pattern from a string the model wrote.
 *
 * The value goes in as a bound parameter, so there is no injection here — but `%`
 * and `_` are still wildcards to LIKE, and an unescaped `_` silently widens the
 * lookup while the extra match reads like a hit. Widening the lookup for a WRITE
 * is worse than for a read: it turns one project into two and the tool then refuses
 * something it should have performed.
 *
 * The same four lines are in `read.ts`. Deliberately copied rather than shared: the
 * two files have no module between them today and the alternative is exporting a
 * private helper across a boundary that exists for a reason. If a third copy
 * appears, hoist it — two implementations of one escape rule is exactly the sort of
 * thing that drifts.
 */
function contains(needle: string): string {
  return `%${needle.replace(/[\\%_]/g, '\\$&')}%`;
}

type ProjectRow = {
  id: string;
  name: string;
  rate_cents: number | null;
  client_id: string;
  client_name: string;
  engagement_kind: string;
  client_status: string;
};

/**
 * Projects whose name contains the needle, with the client that decides whether
 * their hours can be billed.
 *
 * The client is joined rather than looked up afterwards because the billable
 * decision needs `engagement_kind` in the same breath as the project, and a second
 * round trip is a second chance for the two to disagree about which row they read.
 *
 * Ordered like `read.ts` orders it — the tightest containing match first — purely
 * so a listed refusal reads sensibly. Nothing here PICKS by that order.
 */
async function projectsByName(needle: string): Promise<ProjectRow[]> {
  return sql<ProjectRow>(
    `SELECT p.id, p.name, p.rate_cents, p.client_id,
            c.name AS client_name, c.engagement_kind, c.status AS client_status
       FROM projects p
       JOIN clients c ON c.id = p.client_id
      WHERE p.name ILIKE $1
      ORDER BY length(p.name), p.name
      LIMIT $2`,
    [contains(needle), MAX_MATCHES]
  );
}

type ClientRow = {
  id: string;
  name: string;
  status: string;
  engagement_kind: string;
};

async function clientsByName(needle: string): Promise<ClientRow[]> {
  return sql<ClientRow>(
    `SELECT id, name, status, engagement_kind
       FROM clients
      WHERE name ILIKE $1
      ORDER BY length(name), name
      LIMIT $2`,
    [contains(needle), MAX_MATCHES]
  );
}

type NameRow = { id: string; name: string; total: number };

/**
 * A few names and how many exist, for the miss path.
 *
 * `count(*) OVER ()` is evaluated before LIMIT, so the total is the table's and not
 * the page's. A misspelling and an empty table must not reach the model looking the
 * same: one is worth a second call with a different spelling and the other is worth
 * saying the table is empty.
 */
async function namesOnFile(table: 'projects' | 'clients'): Promise<NameRow[]> {
  // The table name is a literal from this file — one of two, chosen by a parameter
  // that is a union type — and never a value from anywhere else.
  return sql<NameRow>(
    `SELECT id, name, (count(*) OVER ())::int AS total
       FROM ${table}
      ORDER BY name
      LIMIT $1`,
    [NAME_HINTS]
  );
}

const namesEvidence = (table: 'projects' | 'clients', rows: NameRow[]): Evidence[] =>
  rows.map((r) => ({ table, id: r.id, label: r.name }));

/**
 * What a miss says instead of nothing.
 *
 * The listed names are cited as evidence, and that is not over-reporting: the
 * sentence hands the model real names read out of the table and the model will
 * repeat them. An answer that rests on rows has to say which rows, or the evidence
 * line cannot be trusted in either direction.
 */
function nothingNamed(thing: string, needle: string, onFile: NameRow[], verb: string): string {
  if (onFile.length === 0) {
    return (
      `No ${thing} matches "${needle}", and there are no ${thing} records on file at all. ` +
      `Nothing was ${verb}. Say the table is empty — do not guess at a name.`
    );
  }
  const total = onFile[0].total;
  return (
    `No ${thing} matches "${needle}". Nothing was ${verb}. ` +
    `${total} ${thing} record(s) are on file` +
    `${onFile.length < total ? `; the first ${onFile.length} by name are` : ', named'}: ` +
    `${onFile.map((r) => r.name).join(', ')}. Ask which was meant rather than guessing — a ` +
    `write against the wrong record is not something anyone notices afterwards.`
  );
}

/**
 * The refusal an ambiguous name owes a write.
 *
 * `find_client` may list several matches and let the model choose, because a list
 * attributes nothing. A tool that is about to CHANGE a row cannot: it says what
 * matched, does nothing, and asks. This is the eval case `write-refuses-ambiguity`,
 * and the case was wrong twice before the agent was — asking which project before
 * calling the tool is better behaviour than calling it and being refused, so the
 * assertion is about the outcome and not about the wording.
 */
function tooManyMatches(thing: string, needle: string, labels: string[], verb: string): string {
  return (
    `"${needle}" matches ${labels.length} ${thing}${labels.length === MAX_MATCHES ? ' or more' : ''}: ` +
    `${labels.join(', ')}. Nothing was ${verb}. Ask which one is meant — this is a write, and ` +
    `guessing at the record is how the wrong client gets billed.`
  );
}

/* ─── validation the shared helpers do not cover ─── */

/**
 * A required calendar date, in the past or close to it.
 *
 * `optionalDate` from `../tools` does the format and the is-this-a-real-day check
 * (`2026-02-31` matches the pattern and is not a date), so this adds only the two
 * judgments a write needs. A required variant is kept local rather than added to
 * the shared helpers: one tool needing it is not yet a shared rule.
 *
 * **Not in the future.** `db/001-business.sql` deliberately has no
 * `CHECK (entry_date <= CURRENT_DATE)` — it is not immutable, so a dump taken today
 * could fail to restore tomorrow — and says a write tool refusing a date next March
 * is the same guard with a better error message. This is that guard.
 *
 * One day of tolerance, because "today" is a question with two answers: the
 * process runs in UTC and an operator east of it is already on tomorrow. Refusing
 * their date would be the harness's time zone overruling theirs.
 *
 * **Not absurdly old.** A year before 2000 in this business is a transposed digit,
 * not a backdated entry. Backdating itself is legitimate and stays allowed: hours
 * get logged late and `invoices.paid_at` exists precisely so a payment can be
 * recorded on the day the money actually arrived.
 *
 * Compared as strings throughout, which works because both sides are 'YYYY-MM-DD' —
 * the same reason `db/` chose DATE over TIMESTAMPTZ and `src/db.ts` hands DATE back
 * as text. There is no time in the comparison to get a zone wrong in.
 */
function requireWorkDate(o: Record<string, unknown>, key: string, what: string): string {
  const value = optionalDate(o, key);
  if (value === undefined) {
    throw new ToolError(
      `"${key}" is required: ${what}, as YYYY-MM-DD. It is not assumed to be today — the day ` +
        'something happened is not the day you are being told about it.'
    );
  }

  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  if (value > tomorrow) {
    throw new ToolError(
      `"${key}" is ${value}, which is in the future. ${what} cannot be a date that has not ` +
        'happened yet. Check the year and the month.'
    );
  }
  if (value < '2000-01-01') {
    throw new ToolError(
      `"${key}" is ${value}, which is before 2000 and is a mistyped year rather than a date.`
    );
  }
  return value;
}

/**
 * Hours, as the canonical decimal string the column holds.
 *
 * Returned as a STRING, not a number, and that is deliberate three times over.
 * `time_entries.hours` is `NUMERIC(5,2)`, so '3.00' is exactly what the row will
 * hold and exactly what the driver will hand back; passing the string to the
 * parameter means Postgres parses the decimal rather than JS formatting a float
 * into one. It is also what makes the write key stable — `3` and `'3.00'` hash
 * differently, so the tool has to commit to one spelling and the column's own is
 * the obvious choice.
 *
 * Two decimal places by rounding, not by refusal. 1.333 hours is 80 minutes, which
 * is an ordinary thing to log and not a misunderstanding; refusing it would spend a
 * round trip on something the column simply cannot hold. The recorded value is
 * printed in the summary and in the result, so a request that was rounded is
 * visible rather than silently altered. (`Math.round(n * 100)` is the one place
 * hours pass through a float. At 24 or less that is nowhere near a double's limits;
 * the only cost is that an exact half — 3.005 — may round down where Postgres's
 * decimal arithmetic would round up. It cannot cause a disagreement with the row,
 * because the string computed here is what gets written.)
 *
 * The ceiling is the same one the column enforces, and the two are not redundant:
 * `CHECK (hours > 0 AND hours <= 24)` is what cannot be bypassed, and this refusal
 * is what puts a sentence in front of the model instead of a Postgres error string
 * it has to explain to a person. A 40 in this field is a week typed into a day, and
 * it lands in a billable total nobody re-checks.
 */
function requireHours(o: Record<string, unknown>, key: string): string {
  const v = o[key];
  const raw =
    typeof v === 'number' ? (Number.isFinite(v) ? String(v) : null) : typeof v === 'string' ? v.trim() : null;

  // No sign and no exponent. '-2' and '1e3' are refused here rather than parsed,
  // because both are a different intent from anything this column can hold.
  if (raw === null || !/^\d+(\.\d+)?$/.test(raw)) {
    throw new ToolError(
      `"${key}" is required and must be a positive number of hours, like 3 or 1.5. ` +
        'Hours, not minutes: 90 minutes is 1.5.'
    );
  }

  const n = Number(raw);
  if (!(n > 0)) {
    throw new ToolError(
      `"${key}" must be more than 0. An entry of no hours records nothing, and the column ` +
        'refuses it.'
    );
  }
  if (n > 24) {
    throw new ToolError(
      `"${key}" is ${raw}, and cannot exceed 24 — that is more than a day. A 40 in this field ` +
        'is a week typed into a day. Log one entry per day.'
    );
  }
  return (Math.round(n * 100) / 100).toFixed(2);
}

/**
 * A boolean that is actually a boolean.
 *
 * `Boolean(raw)` is what the private original used, and `Boolean('false')` is
 * `true` — so a model that sent the string "false" would have had time billed to a
 * client that asked not to be billed, silently, in the direction that costs
 * somebody money. A wrong flag is refused with a sentence instead.
 */
function requireBoolean(o: Record<string, unknown>, key: string): boolean {
  const v = o[key];
  if (typeof v !== 'boolean') {
    throw new ToolError(
      `"${key}" must be true or false, as a boolean and not as a string. Leave it out ` +
        'entirely to accept the default.'
    );
  }
  return v;
}

/* ─── money and hours, printed once ─── */

const USD = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/**
 * `amount_cents` as a person reads it.
 *
 * `invoices.amount_cents` is BIGINT and arrives from the driver as a STRING. It is
 * parsed here, once, at the point it is printed, and nowhere else: nothing in this
 * file adds money up, and the value pinned in a precondition stays the string the
 * driver gave us so that two sixteen-digit amounts cannot compare equal by rounding
 * to one double.
 */
function dollars(amountCents: unknown): string {
  const n = Number(amountCents);
  if (!Number.isFinite(n)) {
    throw new ToolError(
      `An invoice amount came back unreadable (${JSON.stringify(amountCents)}), so nothing was ` +
        'changed. The row needs looking at before it is marked anything.'
    );
  }
  return USD.format(n / 100);
}

/* ─── the shape of a refusal, and the shape of a proposal ─── */

/**
 * What the model is told when it was not allowed to act.
 *
 * The instructions in the last sentence are not decoration. Left to itself a model
 * reports a proposal as a completed action, or offers to do it later — and it
 * cannot act again on its own, so the offer is a promise nobody will keep.
 *
 * "Returned as a proposal" rather than "recorded as a proposal", precisely: whether
 * a draft becomes a card on the desk is the caller's decision (`recordProposals`),
 * and a tool that claimed the row exists would be asserting something it did not do.
 */
function proposedInstead(verb: string, summary: string, note = ''): string {
  return (
    `WRITES ARE DISABLED for this run, so nothing was ${verb}. This is returned as a proposal ` +
    `for the operator to approve, and nothing changes unless they do:\n` +
    `  ${summary}${note}\n` +
    `Tell them what you would do and that it is waiting on their approval. Do not say it is ` +
    `done, and do not offer to do it later — you cannot act again on your own.`
  );
}

/* ═══ log_time ═══ */

/**
 * Log a block of time against a project.
 *
 * The honest demonstration of the whole mechanism, because getting it wrong costs
 * someone money. Two identical calls must produce one entry and the second must say
 * so; an ambiguous project must be asked about rather than picked; and whether the
 * hours can be billed is a fact about the CLIENT, which is why it is decided here
 * and not in `validate`.
 */
export const logTime: Tool = {
  name: 'log_time',
  description:
    'Log a block of time against a project: the project name, the day the work ' +
    'happened, the hours, and a note saying what was done. Hours, not minutes. If ' +
    'the project name matches more than one project, nothing is logged and it asks ' +
    'which — do not guess. Whether the time is billable is decided from the client ' +
    "(the studio's own ventures and artifacts can never be billed to anyone), so " +
    'leave "billable" out unless the operator says otherwise. With writes off this ' +
    'returns a proposal for the operator to approve and changes nothing. Logging the ' +
    'same work twice is prevented: a repeat is reported, not performed.',
  inputSchema: {
    type: 'object',
    properties: {
      project_name: {
        type: 'string',
        description:
          'The project to log against, or a distinctive part of its name, e.g. "Dispatch Rewrite".',
      },
      date: {
        type: 'string',
        description: 'The day the work happened, YYYY-MM-DD. Not today unless it was today.',
      },
      hours: {
        type: 'number',
        description:
          'Hours worked that day, to two decimal places. 90 minutes is 1.5. More than 24 is refused.',
      },
      note: {
        type: 'string',
        description: 'What was done, in a phrase. Two blocks of work on one day need two notes.',
      },
      billable: {
        type: 'boolean',
        description:
          'Leave this out unless the operator says. Billable by default, except on the ' +
          "studio's own ventures and artifacts, which are never billable whatever is passed.",
      },
    },
    required: ['project_name', 'date', 'hours', 'note'],
  },
  validate: (raw) => {
    const o = asObject(raw);
    return {
      project_name: requireString(o, 'project_name', { max: 200 }),
      date: requireWorkDate(o, 'date', 'the day the work happened'),
      hours: requireHours(o, 'hours'),
      /**
       * Required, and not because the column is — `time_entries.note` is nullable.
       * It is required because it is part of the write key: two different blocks of
       * work on one day, on one project, at the same length are told apart by
       * nothing else, and without a note the ledger would recognise the second as
       * the first and report it as already logged.
       */
      note: requireString(o, 'note', { max: 500 }),
      // Absent stays absent. The default is not decided here — see the tool's own
      // note, and incident 7.
      ...(o.billable === undefined || o.billable === null
        ? {}
        : { billable: requireBoolean(o, 'billable') }),
    };
  },
  run: async (args, ctx) => {
    const projectName = args.project_name as string;
    const date = args.date as string;
    // The canonical 'H.HH' string `validate` produced. It goes into the write key,
    // into the summary and into the NUMERIC parameter unchanged.
    const hours = args.hours as string;
    const note = args.note as string;
    const asked = args.billable as boolean | undefined;

    const matches = await projectsByName(projectName);

    if (matches.length === 0) {
      const onFile = await namesOnFile('projects');
      return {
        content: nothingNamed('project', projectName, onFile, 'logged'),
        evidence: namesEvidence('projects', onFile),
      };
    }
    if (matches.length > 1) {
      // No proposal. A card whose target the operator cannot identify is worse than
      // no card: they would be approving hours against whichever row the tool
      // resolved second.
      return {
        content: tooManyMatches(
          'projects',
          projectName,
          matches.map((p) => `${p.name} (${p.client_name})`),
          'logged'
        ),
        evidence: matches.map((p) => ({ table: 'projects', id: p.id, label: p.name })),
      };
    }

    const project = matches[0];

    /**
     * Billable, decided HERE — after the client came back with its
     * `engagement_kind` — and not in `validate` (incident 7).
     *
     * An explicit `true` on an own venture or an artifact is overridden rather than
     * obeyed: the model does not get to bill the studio's own product by asking
     * twice. An explicit `false` on a real client is honoured, because deciding not
     * to charge for something is nobody's business but the operator's.
     */
    const neverBillable = NEVER_BILLABLE.has(project.engagement_kind);
    const billable = neverBillable ? false : (asked ?? true);
    const overridden = neverBillable && asked === true;

    /**
     * Said out loud on BOTH paths. Quietly flipping a flag the caller asked for is
     * the kind of silent correction that makes the rest of a report suspect.
     *
     * Phrased for two readers at once, which took a correction. The first version
     * ended "Say that." — an instruction aimed at the model, written on the
     * assumption that a tool result is only ever read by one. It is not: the CLI
     * prints a proposal's and an applied write's result text verbatim, so the
     * operator got a stray order to say something. A tool result has to read as a
     * statement of fact to a person and still be clear enough that the model
     * repeats it, so the instruction is gone and only the fact remains.
     */
    const billableNote = overridden
      ? `\n  (This was requested as billable. ${project.client_name} is engagement_kind ` +
        `${project.engagement_kind} — ${KIND_NOTE[project.engagement_kind]} — so it is ` +
        `recorded as non-billable instead.)`
      : '';

    const kindNote =
      project.engagement_kind === 'client'
        ? ''
        : ` — ${project.engagement_kind}: ${KIND_NOTE[project.engagement_kind] ?? 'not a client engagement'}`;

    /**
     * The act, as one phrase, so the card and the receipt cannot describe it
     * differently. The verb is prefixed per use — "Log …" on the card the operator
     * reads, "Logged …" once it has happened — because the two must not read the
     * same. A card that says something is done is the failure this whole mechanism
     * exists to prevent.
     */
    const phrase =
      `${hours}h on ${date} against ${project.name} (${project.client_name}${kindNote})` +
      ` — ${note}${billable ? '' : ' [not billable]'}`;
    const summary = `Log ${phrase}`;

    /**
     * Derived before the branch, so the proposal carries the SAME key the write will
     * claim. That is what lets the ledger recognise an approval and a write-enabled
     * run as one act rather than two.
     *
     * The part names are the columns the row will hold, and they are the list spelled
     * out in `write-keys.ts` — renaming one changes every key derived from it, which
     * is a durable-data decision and not a refactor. The project ID rather than the
     * name the operator typed: "Dispatch Rewrite", "dispatch rewrite" and "dispatch"
     * are one act. `billable` is in it because the same hours logged billable and
     * non-billable are two different entries and must not collide.
     */
    const key = writeKey('log_time', ctx.userId, {
      project_id: project.id,
      entry_date: date,
      hours,
      note,
      billable,
    });

    const target: Evidence = { table: 'projects', id: project.id, label: project.name };
    // The client row is cited as well, because the billable decision rests on it.
    // An answer that rests on a record has to be able to point at it.
    const resolved: Evidence[] = [
      target,
      { table: 'clients', id: project.client_id, label: project.client_name },
    ];

    /**
     * What the card asserted about the row it named.
     *
     * `name`, because the stored argument is still a NAME and storing the call does
     * not by itself freeze which row it lands on: a project renamed while the card
     * sat on the desk would resolve to something else, or to nothing, and pinning
     * the name turns that into "the project changed after this was proposed" instead
     * of a card that settles as applied having logged nothing.
     *
     * `rate_cents`, because it decides the consequence even though the card never
     * prints it. The rate is what the client is eventually billed, and hours
     * approved at one rate must not be applied at another.
     *
     * `client_id`, because whose project this is decides both the name on the card
     * and whether the hours can be billed at all.
     *
     * What is NOT pinned, and cannot be: `clients.engagement_kind`, which lives on
     * another row, and a precondition pins one row. A client reclassified as an own
     * venture between propose and approve is caught later instead — `run` re-decides
     * `billable` from the client it re-reads, so the entry is written non-billable
     * and the override is reported. The cost of that is worth naming: the key
     * derived at apply time then differs from the one on the card, so the ledger sees
     * a different act from the one the desk recorded.
     */
    const precondition: Precondition = {
      table: 'projects',
      id: project.id,
      expect: {
        name: project.name,
        rate_cents: project.rate_cents,
        client_id: project.client_id,
      },
    };

    if (!ctx.allowWrites) {
      return {
        content: proposedInstead('logged', summary, billableNote),
        evidence: resolved,
        proposal: {
          toolName: 'log_time',
          // The VALIDATED arguments, exactly as `validate` returned them — never the
          // model's raw input. `billable` is absent when it was not asked for, on
          // purpose: whether it applies is decided from the client at apply time, not
          // frozen here from a client that may have been reclassified since.
          args,
          summary,
          writeKey: key,
          // No subject key. There is nothing revisable about a block of time; a key
          // invented for every write is a second identity to keep consistent for no
          // gain.
          target,
          precondition,
          evidence: resolved,
        },
      };
    }

    return once(key, ctx, 'log_time', async () => {
      /**
       * One row, one statement.
       *
       * No `user_id`: `time_entries` has no such column in this schema and inserting
       * one would fail outright. No `start_time`/`end_time`/`duration_minutes`
       * either — the private original stored a start/end pair plus minutes and
       * divided by 60 at four separate call sites, any one of which could round
       * differently. Here the column is the unit the question was asked in.
       *
       * `hours` goes in as the canonical decimal string against `::numeric`, so the
       * exact value is parsed by Postgres rather than formatted out of a float.
       * `updated_at` is not set: `touch_updated_at()` owns it, because a timestamp
       * maintained by whichever client remembered to set it is one nobody can reason
       * about.
       */
      const row = await one<{ id: string }>(
        `INSERT INTO time_entries (project_id, entry_date, hours, note, billable)
         VALUES ($1, $2, $3::numeric, $4, $5)
         RETURNING id`,
        [project.id, date, hours, note, billable]
      );

      if (!row) {
        // RETURNING on a successful single-row insert always yields a row, so this is
        // unreachable in practice. It throws rather than reporting a success it
        // cannot cite — and because it throws, `once` releases the claim, so the act
        // is not left permanently blocked by an outcome nobody can confirm.
        throw new ToolError(
          'The time entry insert returned no row, so whether it was written cannot be told ' +
            'from here. Say the record needs checking rather than reporting it as logged.'
        );
      }

      return {
        content: `Logged ${phrase}${billableNote}`,
        evidence: [
          { table: 'time_entries', id: row.id, label: `${date} — ${hours}h — ${project.name}` },
          ...resolved,
        ],
      };
    });
  },
};

/* ═══ set_client_status ═══ */

/**
 * Set a client's status.
 *
 * Naturally idempotent — setting a value it already has changes nothing — and the
 * no-op case is the one that matters. It returns NO proposal and says the value is
 * already set: a card asking someone to approve a change that changes nothing is
 * noise, and reporting it afterwards as a change would be a lie. The private eval
 * suite had a case asserting the opposite, and that case was wrong (incident 6).
 *
 * It touches `status` and nothing else. `engagement_kind` is a different question —
 * what the relationship IS, against where it stands — and no tool here conflates
 * them.
 */
export const setClientStatus: Tool = {
  name: 'set_client_status',
  description:
    'Set one client\'s status to active, inactive or prospect. active means live ' +
    'right now, inactive means over or dormant, prospect means the relationship has ' +
    'not started. There is no "lead" status in this schema. This does not change ' +
    'engagement_kind — whether a record is a client, a passed lead, an own venture ' +
    'or an artifact is a separate fact and no tool here changes it. If the name ' +
    'matches more than one client, nothing changes and it asks which. If the status ' +
    'is already the one asked for, nothing changes and it says so. With writes off ' +
    'this returns a proposal for the operator to approve.',
  inputSchema: {
    type: 'object',
    properties: {
      client_name: {
        type: 'string',
        description: 'The client name or a distinctive part of it.',
      },
      status: {
        type: 'string',
        enum: [...CLIENT_STATUSES],
        description:
          'active, inactive or prospect. Not "lead" — this schema has no such value, and a ' +
          'relationship that has not started is a client with status prospect.',
      },
      reason: {
        type: 'string',
        description:
          'Why, in a few words. It is recorded on the proposal and repeated in the answer. It ' +
          'is NOT written onto the client: notes is a field a person wrote.',
      },
    },
    required: ['client_name', 'status'],
  },
  validate: (raw) => {
    const o = asObject(raw);
    const status = requireString(o, 'status', { max: 20 });
    if (!(CLIENT_STATUSES as readonly string[]).includes(status)) {
      // The list is in the refusal because the model is about to guess again, and it
      // is the only thing that makes the second attempt better than the first. The
      // value to be careful about is 'lead': `clients.status` cannot hold it, and a
      // tool that accepted it would write nothing and report a change.
      throw new ToolError(
        `"status" must be one of: ${CLIENT_STATUSES.join(', ')}. There is no "lead" — a ` +
          'relationship that has not started is status "prospect".'
      );
    }

    const out: Record<string, unknown> = {
      client_name: requireString(o, 'client_name', { max: 120 }),
      status,
    };
    const reason = optionalString(o, 'reason', { max: 300 });
    if (reason) out.reason = reason;
    return out;
  },
  run: async (args, ctx) => {
    const clientName = args.client_name as string;
    const status = args.status as string;
    const reason = args.reason as string | undefined;

    const matches = await clientsByName(clientName);

    if (matches.length === 0) {
      const onFile = await namesOnFile('clients');
      return {
        content: nothingNamed('client', clientName, onFile, 'changed'),
        evidence: namesEvidence('clients', onFile),
      };
    }
    if (matches.length > 1) {
      return {
        content: tooManyMatches(
          'clients',
          clientName,
          matches.map((c) => `${c.name} (${c.status}, ${c.engagement_kind})`),
          'changed'
        ),
        evidence: matches.map((c) => ({ table: 'clients', id: c.id, label: c.name })),
      };
    }

    const client = matches[0];
    const evidence: Evidence[] = [{ table: 'clients', id: client.id, label: client.name }];

    if (client.status === status) {
      /**
       * Already there. Not a failure, and not a change either.
       *
       * No proposal, on either path: with writes off this would be a card asking the
       * operator to approve nothing, and with writes on there is nothing to claim a
       * key for. "Marked inactive" when it was already inactive is a small lie, and
       * one small lie is enough to make everything else the agent reports
       * unverifiable by feel.
       */
      return {
        content:
          `${client.name} is already ${status}. Nothing was changed and there is nothing to ` +
          `approve. Say it was already ${status} rather than reporting a change.`,
        evidence,
      };
    }

    // `reason` is deliberately not a key part. It annotates the act; setting the
    // same client to the same status is one act whatever is written beside it.
    const key = writeKey('set_client_status', ctx.userId, {
      client_id: client.id,
      status,
    });

    const kindNote =
      client.engagement_kind === 'client'
        ? ''
        : ` (engagement_kind ${client.engagement_kind} — ${KIND_NOTE[client.engagement_kind] ?? 'not a client engagement'})`;

    const summary =
      `Set ${client.name}${kindNote} from ${client.status} to ${status}` +
      (reason ? ` — ${reason}` : '');

    /**
     * What the card asserted.
     *
     * `status`, because "active -> inactive" is a claim about the present tense: if
     * it has since become something else, applying the change would overwrite
     * whatever happened in between. `engagement_kind`, because it is printed on the
     * card and it decides what the new status even means — 'active' on a lead that
     * was passed on is not the change anybody read.
     *
     * `name` is NOT pinned, and that is the one judgment here worth arguing with. A
     * rename changes the label the card printed and nothing about the act, and a
     * precondition that refuses an approval over a cosmetic edit teaches the operator
     * that the reason is noise. The risk accepted in exchange: a client renamed while
     * the card sat on the desk resolves the stored name to nothing, and the tool then
     * reports that it changed nothing — which is true, and settles the card as
     * `applied` (a known open edge in `docs/design.md`).
     */
    const precondition: Precondition = {
      table: 'clients',
      id: client.id,
      expect: { status: client.status, engagement_kind: client.engagement_kind },
    };

    if (!ctx.allowWrites) {
      return {
        content: proposedInstead('changed', summary),
        evidence,
        proposal: {
          toolName: 'set_client_status',
          args,
          summary,
          writeKey: key,
          target: evidence[0],
          precondition,
          evidence,
        },
      };
    }

    return once(key, ctx, 'set_client_status', async () => {
      /**
       * One column, and a compare-and-swap on the value the card was read at.
       *
       * `AND status = $3` is not redundant with the precondition. The approval path
       * re-reads the row and then runs the tool, so there is a window between the two
       * where somebody else's update lands; putting the previous value in the WHERE
       * closes it in the database rather than in this process. Zero rows back means
       * the world moved inside that window, and the honest report is that nothing was
       * changed.
       *
       * `notes` is deliberately untouched. The private original wrote `reason` into
       * it, which OVERWROTE whatever a person had typed there — `clients.notes` is
       * free text somebody wrote and this tool has no business replacing it. The
       * reason lives on the proposal, in this result, and in the trace, which is also
       * why it is not part of the write key: it changes no record.
       *
       * `updated_at` is not set either; `touch_updated_at()` owns it.
       */
      const row = await one<{ id: string; name: string }>(
        `UPDATE clients
            SET status = $2
          WHERE id = $1
            AND status = $3
          RETURNING id, name`,
        [client.id, status, client.status]
      );

      if (!row) {
        // Thrown, so `once` releases the claim: nothing was written, and a later
        // attempt must not be told this act has already happened.
        throw new ToolError(
          `${client.name} was no longer ${client.status} when the change ran, so nothing was ` +
            'changed. Somebody else moved it in between — read it again before deciding.'
        );
      }

      return {
        content:
          `${row.name}: ${client.status} -> ${status}.` +
          (reason ? ` Reason recorded with the decision: ${reason}` : '') +
          ' engagement_kind was not touched.',
        evidence,
      };
    });
  },
};

/* ═══ mark_invoice_paid ═══ */

type InvoiceRow = {
  id: string;
  number: string;
  status: string;
  /** BIGINT: a STRING from the driver. Never parsed except to print it. */
  amount_cents: string;
  currency: string;
  issued_at: string | null;
  due_date: string | null;
  paid_at: string | null;
  exact: boolean;
  client_id: string;
  client_name: string;
};

/**
 * Invoices by number, exact match first.
 *
 * Two ways of naming one invoice in a single query: the number as typed, and the
 * number as a fragment, so "INV-1008" and "1008" both land. The exact match is
 * ordered first and preferred outright, because a substring search for "INV-100"
 * matches INV-1001 through INV-1009 and would refuse a name that identifies exactly
 * one row.
 *
 * `lower(number) = lower($1)` rather than `=`: the UNIQUE constraint on
 * `invoices.number` is byte-wise, so 'inv-1008' and 'INV-1008' could both exist and
 * a case-insensitive match is not guaranteed to be one row. The caller counts them.
 */
async function invoicesByNumber(needle: string): Promise<InvoiceRow[]> {
  return sql<InvoiceRow>(
    `SELECT i.id, i.number, i.status, i.amount_cents, i.currency,
            i.issued_at, i.due_date, i.paid_at,
            (lower(i.number) = lower($1)) AS exact,
            c.id AS client_id, c.name AS client_name
       FROM invoices i
       JOIN clients c ON c.id = i.client_id
      WHERE lower(i.number) = lower($1) OR i.number ILIKE $2
      ORDER BY (lower(i.number) = lower($1)) DESC, length(i.number), i.number
      LIMIT $3`,
    [needle, contains(needle), MAX_MATCHES]
  );
}

/**
 * Mark an invoice paid, on the day the money arrived.
 *
 * The interesting precondition. What the card asserts is the invoice's `status` and
 * its `amount_cents`, so approving it later refuses if the invoice was voided, or
 * paid by someone else, or its amount edited in between — an operator who agreed to
 * mark $16,500 paid did not agree to mark $65,000 paid.
 *
 * The two statuses that cannot be paid are refused outright, and the refusal says
 * WHICH: a void invoice was never owed, and a draft was never sent, so neither is
 * money anybody can pay. `db/001-business.sql` makes the same point from the other
 * side — a total filtered as `status <> 'paid'` counts both as outstanding.
 */
export const markInvoicePaid: Tool = {
  name: 'mark_invoice_paid',
  description:
    'Mark one invoice paid, with the date the money actually arrived. Identify the ' +
    'invoice by its number, e.g. INV-1008. The date is required and is not assumed ' +
    'to be today: it is when the payment landed, and it can be backdated. Refuses a ' +
    'void invoice (it was never owed) and a draft (it was never sent), saying which. ' +
    'An invoice already marked paid is reported as already paid, not changed. With ' +
    'writes off this returns a proposal for the operator to approve.',
  inputSchema: {
    type: 'object',
    properties: {
      invoice_number: {
        type: 'string',
        description: 'The invoice number, e.g. "INV-1008". A distinctive fragment also works.',
      },
      paid_date: {
        type: 'string',
        description:
          'The day the money arrived, YYYY-MM-DD. Ask the operator rather than assuming today.',
      },
    },
    required: ['invoice_number', 'paid_date'],
  },
  validate: (raw) => {
    const o = asObject(raw);
    return {
      invoice_number: requireString(o, 'invoice_number', { max: 40 }),
      /**
       * Required, deliberately, with no default.
       *
       * `paid_at` is the date the money arrived and it is what every question about
       * income is answered from. The private system had no such column and fell back
       * on `updated_at`, so marking six historical retainers paid in one sitting put
       * every one of those dollars into the current month. Defaulting this to today
       * would rebuild that bug on top of the column that fixed it.
       */
      paid_date: requireWorkDate(o, 'paid_date', 'the day the money arrived'),
    };
  },
  run: async (args, ctx) => {
    const number = args.invoice_number as string;
    const paidDate = args.paid_date as string;

    const matches = await invoicesByNumber(number);

    if (matches.length === 0) {
      // No name listing here, unlike the project and client misses. An invoice
      // number is an identifier a person reads off a document, so listing twelve
      // other invoice numbers invites picking one — and a payment recorded against
      // the wrong invoice is money that looks collected and is still owed.
      return {
        content:
          `No invoice matches "${number}". Nothing was changed. Ask for the invoice number as ` +
          'it appears on the invoice — do not guess at one, and do not pick a nearby number.',
        evidence: [],
      };
    }

    // An exact match wins outright, and only ties among exact matches are ambiguous.
    const exact = matches.filter((i) => i.exact);
    const candidates = exact.length > 0 ? exact : matches;

    if (candidates.length > 1) {
      return {
        content: tooManyMatches(
          'invoices',
          number,
          candidates.map((i) => `${i.number} (${i.client_name}, ${dollars(i.amount_cents)}, ${i.status})`),
          'changed'
        ),
        evidence: candidates.map((i) => ({ table: 'invoices', id: i.id, label: i.number })),
      };
    }

    const invoice = candidates[0];
    const evidence: Evidence[] = [
      { table: 'invoices', id: invoice.id, label: invoice.number },
      { table: 'clients', id: invoice.client_id, label: invoice.client_name },
    ];
    const amount = dollars(invoice.amount_cents);

    if (invoice.status === 'paid') {
      // A no-op, reported as one, with the date it was already paid — which is the
      // fact the operator is actually asking about. Moving a paid date is a different
      // act and this tool deliberately does not perform it: the two would share a
      // row and nothing would record what the date used to be.
      return {
        content:
          `${invoice.number} (${invoice.client_name}, ${amount}) is already marked paid, on ` +
          `${invoice.paid_at ?? 'a date that is missing from the row'}. Nothing was changed and ` +
          'there is nothing to approve. This tool does not move a paid date; if the recorded ' +
          'date is wrong, that needs a person.',
        evidence,
      };
    }

    if (invoice.status === 'void' || invoice.status === 'draft') {
      /**
       * Refused, and named. A bare "cannot do that" reads as a broken system; which
       * of the two it is tells the operator what to do next.
       *
       * The database would refuse this anyway — `CHECK (status = 'draft' OR issued_at
       * IS NOT NULL)` and the paid/paid_at pairing make some of it impossible — but
       * as a Postgres error string, which the model then has to explain to a person.
       */
      const why =
        invoice.status === 'void'
          ? 'it was voided, so it was never owed. Nothing was voided by mistake here — if the ' +
            'money did arrive, the invoice was reissued and it is the reissued one that gets ' +
            'marked paid.'
          : 'it is a draft and was never sent, so nobody owes it. It has to be issued before it ' +
            'can be paid.';
      return {
        content:
          `${invoice.number} (${invoice.client_name}, ${amount}) is ${invoice.status}: ${why} ` +
          'Nothing was changed.',
        evidence,
      };
    }

    // Everything left is 'open'. Refused rather than assumed, because a status this
    // file does not know about is a schema change, not a row to write blind.
    if (invoice.status !== 'open') {
      throw new ToolError(
        `${invoice.number} has status "${invoice.status}", which this tool does not know how to ` +
          'handle, so nothing was changed.'
      );
    }

    if (invoice.issued_at && paidDate < invoice.issued_at) {
      // 'YYYY-MM-DD' strings compare correctly, and `CHECK (paid_at >= issued_at)`
      // would reject this. Refused here so the model gets a sentence instead of a
      // constraint violation to translate.
      return {
        content:
          `${invoice.number} was issued on ${invoice.issued_at}, so it cannot have been paid on ` +
          `${paidDate}. Nothing was changed. Check the date the money arrived.`,
        evidence,
      };
    }

    const key = writeKey('mark_invoice_paid', ctx.userId, {
      invoice_id: invoice.id,
      paid_at: paidDate,
    });

    const summary =
      `Mark ${invoice.number} (${invoice.client_name}, ${amount} ${invoice.currency}) paid on ` +
      `${paidDate}` +
      (invoice.issued_at ? `, issued ${invoice.issued_at}` : '') +
      (invoice.due_date ? `, due ${invoice.due_date}` : ', no due date recorded');

    /**
     * The status and the amount, as they were when the card was shown.
     *
     * `status` because the card is a claim about an OPEN invoice: voided since, or
     * paid by somebody else since, and the change describes nothing that exists.
     * `amount_cents` because it is the figure printed on the card — approving
     * "$16,500 paid" is not approving whatever the row says an hour later.
     *
     * The amount is pinned as the STRING the driver returned. `amount_cents` is
     * BIGINT, and parsing it into a JS number to store it here would let two
     * different sixteen-digit amounts compare equal by rounding to one double —
     * a precondition that passed by losing information.
     */
    const precondition: Precondition = {
      table: 'invoices',
      id: invoice.id,
      expect: { status: invoice.status, amount_cents: invoice.amount_cents },
    };

    if (!ctx.allowWrites) {
      return {
        content: proposedInstead('changed', summary),
        evidence,
        proposal: {
          toolName: 'mark_invoice_paid',
          args,
          summary,
          writeKey: key,
          target: evidence[0],
          precondition,
          evidence,
        },
      };
    }

    return once(key, ctx, 'mark_invoice_paid', async () => {
      /**
       * Both columns in one statement, because the schema holds them together:
       * `CHECK ((status = 'paid' AND paid_at IS NOT NULL) OR (status <> 'paid' AND
       * paid_at IS NULL))`. A row marked paid with no date is invisible to every
       * question about when money arrived, and a row carrying a date while still open
       * is counted as outstanding money that is already in the bank.
       *
       * `AND status = 'open'` is the same compare-and-swap as the client update: the
       * precondition was checked before the tool ran, and this closes the window
       * between the two in the database. `amount_cents` is not touched — this tool
       * marks a payment, it does not restate what was billed.
       */
      const row = await one<{ id: string; number: string }>(
        `UPDATE invoices
            SET status = 'paid', paid_at = $2
          WHERE id = $1
            AND status = 'open'
          RETURNING id, number`,
        [invoice.id, paidDate]
      );

      if (!row) {
        throw new ToolError(
          `${invoice.number} was no longer open when the change ran, so nothing was changed. ` +
            'Read it again — it was voided or marked paid in between.'
        );
      }

      return {
        content:
          `${row.number} (${invoice.client_name}, ${amount}) is now paid, dated ${paidDate}. ` +
          'The amount was not changed.',
        evidence,
      };
    });
  },
};

/**
 * What `../registry` registers.
 *
 * Exported as data rather than registered here. A module that registers itself on
 * import is a module whose registration a bundler is entitled to drop, and that is
 * the failure `registry.ts` exists to describe: approving a write had never once
 * worked in production because the registry was assembled by whichever entry point
 * happened to import which module.
 *
 * Registering these is what makes them callable. It is NOT what lets them write:
 * that is `allowWrites` on the per-run context, which only the approval path sets.
 * Two separate gates, and neither substitutes for the other.
 */
export const WRITE_TOOLS: Tool[] = [logTime, setClientStatus, markInvoicePaid];
