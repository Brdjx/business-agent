/**
 * The command line. One question, one answer, the receipts — and the desk where
 * a change waits for a person.
 *
 *   tsx --env-file=.env src/cli.ts "how much is outstanding?"
 *   tsx --env-file=.env src/cli.ts --trace "who have we worked with?"
 *   tsx --env-file=.env src/cli.ts --json "what is overdue?" | jq .evidence
 *
 *   tsx --env-file=.env src/cli.ts ask "log 3 hours on dispatch for tuesday"
 *   tsx --env-file=.env src/cli.ts proposals
 *   tsx --env-file=.env src/cli.ts approve 9f3c1a2b
 *   tsx --env-file=.env src/cli.ts reject 9f3c1a2b
 *
 * This is the first thing a reader of this repository runs, so what it prints is
 * part of the argument. An agent that answers "$18,400 is outstanding" has told
 * you nothing you can check. So the default output is the answer, then the rows
 * it rests on with their ids, then one line per step with what each cost. None
 * of that is behind a flag: the whole claim of the repo is that the accounting
 * around the loop is the interesting part, and hiding it until asked would be an
 * odd way to make that case.
 *
 * ── The whole consent loop, from one terminal ──
 *
 * The four subcommands are here together because the sequence is the argument,
 * and no single screen of it is convincing alone.
 *
 * A question that would change something does not change it. The run resolves
 * the record, decides everything it would do, and stops: what comes back is a
 * card — what would change, which row it landed on, the facts it asserts about
 * that row, the id to approve. `proposals` shows what is waiting and how old it
 * is. `approve` applies THAT stored call, not the question again (docs/design.md
 * §4 is the whole argument for the difference). `reject` clears it.
 *
 * So a reader can watch it: read the card, check the record is untouched,
 * approve, and see exactly what changed. A screenshot of an agent saying it will
 * ask permission proves nothing; this sequence is checkable at every step.
 *
 * ── Two streams, on purpose ──
 *
 * The answer and its receipts go to stdout. The narration — which step, which
 * tool, how long — goes to stderr, as it happens. So `… > answer.txt` keeps the
 * answer and still shows the work in a terminal, `2>/dev/null` silences the
 * narration, and `--json | jq` works without a progress line ever landing in the
 * document. Colour is decided per stream from its own isTTY, because redirecting
 * one and watching the other is the ordinary way to use this.
 *
 * ── Exit codes ──
 *
 *   0  answered — or, for a decision, the card is now in the state you asked
 *      for.
 *   1  the thing asked for did not happen. A run that hit a wall, was cancelled
 *      or whose provider failed; a proposal that was not applied because it aged
 *      out, because the record moved under it, or because it had already been
 *      decided the other way. None of those is a crash — but a shell reads the
 *      exit code, and "stopped after 8 steps without reaching an answer" and
 *      "not applied: the client is no longer active" are not successes.
 *   2  the invocation or the environment is wrong. Nothing was spent and
 *      nothing was attempted.
 *
 * ── What is deliberately not here ──
 *
 * No flag turns writes on. `--allow-writes` would hand a whole run permission to
 * change whatever the model decides next, and that is the thing this design
 * refuses: consent belongs to an action, not to a session (docs/design.md §4).
 * The only code that sets `allowWrites` is `decideProposal`, applying one stored
 * call a person read first. `ask` is read-only in every invocation there is, and
 * it reports the mode it was in (`read-only` in the trace block) rather than the
 * CLI asserting it.
 *
 * And `approve` does not register the tools. `decideProposal` calls
 * `ensureToolsRegistered()` itself, and a CLI that helpfully called it first
 * would hide exactly the fault that shipped: an approval path whose registry was
 * filled by whoever happened to import the loop, so that approving a write had
 * never once worked in production (docs/incidents.md, entry 1). If this file
 * registered the tools, deleting that call from `proposals.ts` would make no
 * difference here, and the desk would be back to working by coincidence.
 */

import { runAgent, type AgentRun, type RunEvent } from './agent/loop';
import { providerFromEnv, type ProviderChoice } from './agent/providers';
import { persistRunAndProposals, summarizeTrace } from './agent/trace';
import { ensureToolsRegistered } from './agent/registry';
import {
  decideProposal,
  listProposals,
  recordProposals,
  type Decision,
  type DecisionOutcome,
  type Proposal,
  type ProposalStatus,
} from './agent/proposals';
import { allTools, type Evidence, type Precondition, type ProposalDraft } from './agent/tools';
import { close } from './db';

/* ─── exit codes ─── */

const EXIT_OK = 0;
/** Named for the outcome and not for the run: a proposal that was refused did
 * not happen either, and it shares this code. */
const EXIT_NOT_DONE = 1;
const EXIT_USAGE = 2;

/**
 * The longest question accepted.
 *
 * This is the point at which `persistRun` truncates `question` before storing
 * it. A question the record would keep as something shorter than what was asked
 * is a run nobody can reproduce, so it is refused here rather than quietly cut
 * there. The two numbers have to agree and are not shared — trace.ts keeps its
 * bound private — so this is a duplication worth moving if either changes.
 */
const MAX_QUESTION = 4_000;

/* ─── output ─── */

/**
 * A write that throws must not lose the rest of the report.
 *
 * `… | head -1` closes the pipe while this is still writing, and an EPIPE from
 * stdout would otherwise take the process down after the answer was already
 * correct — the same rule the loop applies to its progress callback.
 */
function write(stream: NodeJS.WriteStream, text: string): void {
  try {
    stream.write(text);
  } catch {
    /* the reader has gone; there is nothing useful to do about it here */
  }
}

const out = (line = ''): void => write(process.stdout, `${line}\n`);
const note = (line = ''): void => write(process.stderr, `${line}\n`);

/**
 * Colour, decided per stream.
 *
 * Escape codes in a redirected file are worse than no colour at all, and stdout
 * and stderr are routinely redirected separately here. NO_COLOR is honoured
 * because it is the convention that already exists.
 */
function styler(isTty: boolean | undefined) {
  const on = isTty === true && !process.env.NO_COLOR;
  const wrap = (code: string) => (s: string) => (on ? `\x1b[${code}m${s}\x1b[0m` : s);
  // Yellow is for the one block that is neither a result nor a failure: a change
  // that is waiting. It must not read as green, because nothing has happened.
  return {
    dim: wrap('2'),
    bold: wrap('1'),
    red: wrap('31'),
    green: wrap('32'),
    yellow: wrap('33'),
  };
}

const style = styler(process.stdout.isTTY);
const errStyle = styler(process.stderr.isTTY);

/* ─── arguments ─── */

/**
 * The spelling every usage line and every printed hint uses.
 *
 * Not derived from `process.argv[1]`: `npm run ask --`, `tsx src/cli.ts` and a
 * bundled `node dist/cli.js` would each make the same card print a different
 * sentence, and a hint that is only correct for the way you happened to start
 * the process is worse than one spelling everybody can read past.
 */
const INVOKE = 'tsx --env-file=.env src/cli.ts';

type Command =
  | { kind: 'ask'; question: string }
  | { kind: 'proposals' }
  /** `approve` and `reject` differ by one field, because they differ by one
   * field: the same card, the same lookup, the same refusals. */
  | { kind: 'decide'; decision: Decision; ref: string }
  | { kind: 'help' };

interface Invocation {
  command: Command;
  /** The full trace: every step's arguments and stored output, plus a stack on failure. */
  trace: boolean;
  /** One JSON document on stdout; the progress events as NDJSON on stderr. */
  json: boolean;
  /** Write the run to `agent_runs`. `ask` only. */
  record: boolean;
}

/**
 * The words that are read as a subcommand rather than as the start of a question.
 *
 * `decline` is here beside `reject` because `declined` is what the record calls
 * the outcome, and somebody who read that on the desk and typed it back should
 * not be told there is no such subcommand.
 */
const SUBCOMMANDS = new Set(['ask', 'proposals', 'approve', 'reject', 'decline']);

const USAGE = `usage: ${INVOKE} [--trace] [--json] [--no-record] "your question"
       ${INVOKE} proposals
       ${INVOKE} approve <id>
       ${INVOKE} reject <id>`;

const HELP = `${USAGE}

Ask one question about the seeded business, or act on what a question proposed.
The agent calls tools that read Postgres, and prints the answer, the rows it
rests on, and what each step cost. A tool that would CHANGE something does not
change it: it comes back as a card, and applying it is a second, separate act.

  ask "…"        ask a question. The default, so the word is optional — the
                 first argument is read as a subcommand only when it is exactly
                 one of the words listed here
  proposals      what is waiting for a decision, oldest first, with how old each
                 card is and the question that produced it
  approve <id>   apply exactly the call the card holds: same tool, same
                 arguments, re-checked against the record the card pinned. The
                 question is not asked again — an hour later the same words can
                 mean a different row
  reject <id>    decline it. Nothing is changed and the card leaves the desk

An <id> is a full uuid or any unambiguous prefix of one, four characters or
more, the way git takes a short sha. An ambiguous prefix is refused with the
matches listed. Four is the floor because \`approve 1\` reads like a position in
the list above it, and a position is not what gets approved.

  --trace       every step in full: the arguments the model sent, the output
                stored in the trace, and a stack trace if anything throws
  --json        one JSON document on stdout, with the progress events as NDJSON
                on stderr. Field names match the columns in agent_runs and
                agent_proposals
  --no-record   ask only: do not write this run to agent_runs. The default is to
                record, because a run you cannot read back cannot be debugged. A
                proposal the run left is still written either way — a card is how
                consent is asked for, not part of the trace — and the desk then
                has no question to show beside it
  --help        this

Environment (nothing here loads .env by itself — pass --env-file to the runner):

  DATABASE_URL        where the business records are
  USER_ID             the operator uuid the agent tables are scoped by
  PROVIDER, MODEL, ANTHROPIC_API_KEY   which model answers, and how (ask only)

Exit codes: 0 answered, or the card is now in the state you asked for. 1 it did
not happen — a run that did not answer, a proposal that was not applied. 2 bad
invocation or environment; nothing was attempted.`;

/**
 * Parse, and refuse rather than guess.
 *
 * Unrecognised flags are an error instead of being swallowed into the question.
 * A typo'd `--jsno` folded into the text would be sent to the model as part of
 * what was asked, and the answer would be subtly about the wrong thing — the
 * failure looks like the agent misunderstanding rather than like a typo.
 *
 * Everything that is not a flag is joined with spaces, so a forgotten quote
 * still asks the whole question. `how much is outstanding` in a shell is five
 * arguments, and taking only the first would ask "how".
 *
 * ── Why the subcommand is positional and optional ──
 *
 * `cli.ts "how much is outstanding?"` has to keep working: it is what the README
 * shows and what `npm run ask` does. So the first word is read as a subcommand
 * only when it is EXACTLY one of five words, and everything else is a question.
 *
 * That leaves one ambiguity, which is stated rather than papered over: a question
 * whose first word is one of those five and which was not quoted into a single
 * argument. `cli.ts approve the halden invoice` is read as an approval and
 * refused for having three ids in it, not sent to the model. `ask "approve the
 * halden invoice"` is the way to mean the question, which is the reason `ask`
 * exists as a word at all.
 */
function parse(argv: string[]): Invocation | { error: string } {
  // Exactly the fields of `Invocation` other than `command`, so every return
  // below is a spread and one field. `help` is kept out of it deliberately: it is
  // a request for a different command, not a modifier on this one.
  const flags = { trace: false, json: false, record: true };
  let help = false;
  const words: string[] = [];

  for (const arg of argv) {
    switch (arg) {
      case '--trace':
        flags.trace = true;
        break;
      case '--json':
        flags.json = true;
        break;
      case '--no-record':
        flags.record = false;
        break;
      case '--help':
      case '-h':
        help = true;
        break;
      default:
        if (arg.startsWith('-')) {
          return { error: `Unrecognised flag: ${arg}. Known flags: --trace, --json, --no-record, --help.` };
        }
        words.push(arg);
    }
  }

  // Before anything else, so `--help` works in a directory with no .env in it and
  // with no argument to interpret.
  if (help) return { ...flags, command: { kind: 'help' } };

  const head = (words[0] ?? '').toLowerCase();
  const named = SUBCOMMANDS.has(head);
  const rest = named ? words.slice(1) : words;

  if (named && head !== 'ask') {
    if (!flags.record) {
      return {
        error:
          `--no-record applies to \`ask\` and not to \`${head}\`: it decides whether the run is ` +
          'written to agent_runs, and deciding a card is a person pressing a button rather than a ' +
          'run of the agent.',
      };
    }

    if (head === 'proposals') {
      if (rest.length > 0) {
        return {
          error: `proposals takes no arguments, and got ${rest.length} ("${rest.join(' ')}").`,
        };
      }
      return { ...flags, command: { kind: 'proposals' } };
    }

    // approve | reject | decline
    const decision: Decision = head === 'approve' ? 'approve' : 'decline';
    if (rest.length === 0) {
      return {
        error:
          `${head} needs the id of the proposal to ${
            decision === 'approve' ? 'apply' : 'decline'
          } — run \`${INVOKE} proposals\` to see what is waiting, and four characters of an id ` +
          'is enough.',
      };
    }
    if (rest.length > 1) {
      return {
        error:
          `${head} takes one proposal id, and got ${rest.length} ("${rest.join(' ')}"). ` +
          'One card is one decision: two ids in one command would make the second look decided ' +
          'when the first refused.',
      };
    }
    return { ...flags, command: { kind: 'decide', decision, ref: rest[0] ?? '' } };
  }

  const question = rest.join(' ').trim();
  if (!question) {
    return {
      error: named
        ? 'No question was given.'
        : 'Nothing was asked. Give a question, or one of: proposals, approve <id>, reject <id>.',
    };
  }
  if (question.length > MAX_QUESTION) {
    return {
      error:
        `That question is ${question.length.toLocaleString()} characters, and ${MAX_QUESTION.toLocaleString()} is the most ` +
        'that can be recorded without being truncated. Ask a shorter one rather than ' +
        'having the record disagree with what was asked.',
    };
  }
  return { ...flags, command: { kind: 'ask', question } };
}

/* ─── the environment ─── */

/**
 * Any uuid version. The seeded operator is a version 4, but policing the
 * version would refuse a perfectly good uuid for no reason.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const HOW_TO_SUPPLY =
  'Nothing here loads .env by itself: copy .env.example to .env and pass it to the runner ' +
  '(tsx --env-file=.env src/cli.ts "…").';

/**
 * Read what this process needs, and say which one is missing in a sentence.
 *
 * Checked here, before anything is spent, even though every one of these would
 * eventually fail somewhere better placed to explain itself. The point is the
 * ordering: the model call is the expensive part of a run, and finding out about
 * a missing variable after paying for it is the version of this that annoys
 * someone into not trying again.
 *
 * The model credential is deliberately NOT checked here. `providers/index.ts`
 * owns every environment variable the model layer reads, and a CLI that
 * second-guessed it would refuse a correctly configured Bedrock run for not
 * having an Anthropic key.
 */
function readEnv(): { userId: string } | { error: string } {
  if (!process.env.DATABASE_URL?.trim()) {
    return {
      error:
        'DATABASE_URL is not set, so there is nothing to read the business from. ' +
        'Checked here rather than at the first query because that would be after the ' +
        `model call has already been paid for. Run \`npm run db:up\`. ${HOW_TO_SUPPLY}`,
    };
  }

  const userId = process.env.USER_ID?.trim();
  if (!userId) {
    return {
      error:
        'USER_ID is not set, so this run has nobody to belong to. The business tables have ' +
        'no user_id column at all, but agent_runs does, and that is where the trace goes. ' +
        `The .env.example default is a deliberately fake uuid. ${HOW_TO_SUPPLY}`,
    };
  }
  if (!UUID.test(userId)) {
    return {
      error:
        `USER_ID is "${userId}", which is not a uuid. agent_runs.user_id is a uuid column, so ` +
        'the run would answer the question and then lose its trace to a Postgres error that ' +
        'persistRun swallows by design — an answer with no record, and only a line on stderr ' +
        'to say why.',
    };
  }

  return { userId };
}

/* ─── narration ─── */

const firstLine = (s: string, max = 100): string => {
  const line = (s.split('\n')[0] ?? '').trim();
  return line.length > max ? `${line.slice(0, max)}…` : line;
};

/** Arguments as one short line. They came from the model, so nothing here can
 * assume they are printable. */
function compact(args: unknown, max = 80): string {
  let text: string;
  try {
    text = JSON.stringify(args) ?? String(args);
  } catch {
    text = '(unprintable arguments)';
  }
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * One line per event, on stderr, as it happens.
 *
 * The elapsed stamp is the useful part while waiting: a step that has been
 * running for nine seconds and one that just started look identical without it,
 * and "which of these is slow" is the first question anybody asks.
 */
function narrator(startedAt: number): (event: RunEvent) => void {
  const stamp = (): string => errStyle.dim(`+${((Date.now() - startedAt) / 1000).toFixed(1)}s`);

  return (event) => {
    switch (event.kind) {
      case 'thinking':
        note(`${stamp()} ${errStyle.dim(`step ${event.step} — thinking`)}`);
        return;
      case 'thought':
        // Only when it said something. A turn that went straight to a tool call
        // has no text, and an empty line reads as the model saying nothing when
        // it was in fact working.
        if (event.text.trim()) note(`${stamp()} ${errStyle.dim(firstLine(event.text))}`);
        return;
      case 'tool':
        note(`${stamp()}   ${errStyle.dim(`→ ${event.name} ${compact(event.args)}`)}`);
        return;
      case 'tool_done': {
        const cost = event.tokens > 0 ? ` ${event.tokens}tok` : '';
        const line = `${event.name} ${event.ms}ms${cost} — ${firstLine(event.preview)}`;
        note(
          event.ok
            ? `${stamp()}   ${errStyle.green('✓')} ${errStyle.dim(line)}`
            : `${stamp()}   ${errStyle.red(`✗ ${line}`)}`
        );
        return;
      }
      case 'wall':
        // A wall is the outcome, not an error, and it is announced the moment it
        // is decided rather than only appearing in the report — whoever is
        // watching has been waiting, and is owed the reason immediately.
        note(`${stamp()}   ${errStyle.red(`! ${event.reason} — ${event.detail}`)}`);
        return;
      default: {
        // Unreachable today, and kept anyway. The loop owns this vocabulary and
        // may grow it; a kind this file has not been taught still gets a line,
        // because silence during a step that is happening is the exact thing the
        // narration exists to prevent.
        //
        // The cast is what makes that possible: the cases above are exhaustive,
        // so `event` is `never` here, and reading a property off `never` is an
        // error. Widening it back is deliberate rather than a workaround — the
        // alternative is a branch that has to be written the day an event is
        // added, which is the day nobody is looking at this file.
        const other = event as RunEvent;
        note(`${stamp()} ${errStyle.dim(other.kind)}`);
      }
    }
  };
}

/* ─── the desk ─── */

/**
 * The shortest id a prefix may be, and why it is not one.
 *
 * A prefix is accepted because typing a whole uuid by hand is how a person
 * approves the wrong thing — the same reason git takes a short sha. Four is the
 * floor for a different reason: the desk prints a list, and anybody who has used a
 * menu types the position of the thing they want. `approve 1` would resolve to
 * whichever card's id happens to start with a 1, which is not the first card and
 * not the one they were looking at, and nothing in the output would say so. So the
 * desk numbers nothing, and a prefix short enough to be mistaken for a position is
 * refused with the reason.
 */
const MIN_PREFIX = 4;

/**
 * How much of the desk a prefix is matched against.
 *
 * Deliberately larger than what `proposals` prints. A prefix the operator copied
 * off the desk must resolve, and a card that was decided ten minutes ago is still
 * something they will type at — approving it then reports "already applied",
 * which is the correct answer and not "no such proposal". Beyond this window the
 * full id still works, because that path needs no lookup at all.
 */
const RESOLVE_WINDOW = 200;

/** Eight hex characters — 32 bits — is short enough to type and long enough that
 * two cards colliding is not a thing that happens on one operator's desk. */
const shortId = (id: string): string => id.slice(0, 8);

/**
 * An instant, from whatever the row gave us.
 *
 * TIMESTAMPTZ arrives as a Date from the driver; a string is accepted because a
 * row that came back through JSON is still a row this has to print.
 */
function instant(at: Date | string | null | undefined): number | null {
  if (at === null || at === undefined) return null;
  const t = new Date(at).getTime();
  return Number.isNaN(t) ? null : t;
}

/** Coarse on purpose: nobody decides differently about a card because it is 4h12m
 * old rather than 4h. */
function duration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/**
 * How long ago, in words.
 *
 * The future branch is not defensive padding: `created_at` is the DATABASE's
 * `now()` and this is the process's clock, so a container a few seconds behind
 * makes a card that was just written read as `-3s ago`. Better to say "in 3s" and
 * look odd than to print a negative age and look broken.
 */
function ago(at: Date | string | null | undefined): string {
  const t = instant(at);
  if (t === null) return 'at an unknown time';
  const ms = Date.now() - t;
  return ms < 0 ? `in ${duration(-ms)}` : `${duration(ms)} ago`;
}

function until(at: Date | string | null | undefined): string {
  const t = instant(at);
  if (t === null) return 'at an unknown time';
  const ms = t - Date.now();
  return ms <= 0 ? 'already expired' : `in ${duration(ms)}`;
}

/**
 * What the desk says about a pending card's expiry.
 *
 * A pending card CAN be past it. Expired cards are retired by the sweep that runs
 * when the agent next proposes something, not by a clock, so the desk is where one
 * gets seen — and "expires already expired" is not a sentence. It says what will
 * happen instead, because that is the part the operator can act on: approving it
 * refuses, declining it still works.
 */
function expiry(at: Date | string | null | undefined): string {
  const t = instant(at);
  if (t === null) return 'no expiry recorded';
  return t <= Date.now() ? 'aged out — approving will refuse, rejecting still clears it' : `expires ${until(at)}`;
}

/** UTC, and labelled as such. Every DATE in this schema is a UTC day (see
 * `src/db.ts`), and an unlabelled stamp next to a relative age invites the reader
 * to subtract them in their own zone and find they disagree. */
function stamp(at: Date | string | null | undefined): string {
  const t = instant(at);
  if (t === null) return 'unknown';
  return `${new Date(t).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/** A value as the card should read it. NULL is "unset", because a person reading
 * a card is not reading SQL — the same choice `proposals.ts` makes in its refusal
 * sentences, and the two have to agree or the same fact reads two ways. */
const shown = (value: unknown): string =>
  value === null || value === undefined ? 'unset' : String(value);

/**
 * The facts the card asserts, as one line.
 *
 * An empty `expect` is not nothing: the card still pinned the row's existence, so
 * it says so rather than printing an empty list, which would read as a card that
 * checks nothing before writing.
 */
function asserts(pre: Precondition): string {
  const entries = Object.entries(pre.expect ?? {});
  if (entries.length === 0) return `${pre.table}/${shortId(pre.id)} still exists`;
  return entries.map(([column, value]) => `${column} = ${shown(value)}`).join('; ');
}

const rowOf = (card: Proposal): string =>
  card.target_table && card.target_label
    ? `${card.target_table}/${card.target_label}`
    : '(no row recorded on the card)';

/**
 * Which draft produced which card.
 *
 * `Proposal` does not carry the precondition — the desk's read does not select it
 * — and the precondition is the line on a card that matters most, so it is
 * printed from the draft that made it.
 *
 * Paired on tool name and summary, consuming each draft once, rather than by
 * index. `recordProposals` returns one card per draft that LANDED and collapses
 * drafts sharing a write key, so the two lists are legitimately different lengths
 * and pairing by position would print one card's pinned facts under another's
 * sentence — a wrong card, which is the one thing this whole path exists to
 * prevent. A card that cannot be paired prints without the asserts line, which is
 * the honest version of not knowing.
 */
function pair(
  cards: Proposal[],
  drafts: ProposalDraft[]
): Array<{ card: Proposal; draft?: ProposalDraft }> {
  const unclaimed = [...drafts];
  return cards.map((card) => {
    const at = unclaimed.findIndex(
      (d) => d.toolName === card.tool_name && d.summary === card.summary
    );
    const draft = at >= 0 ? unclaimed.splice(at, 1)[0] : undefined;
    return { card, draft };
  });
}

/**
 * The evidence rows, aligned. Shared by the run report and by an applied
 * decision, because they are the same claim — here is the row, here is its id,
 * go and look.
 */
function evidenceLines(evidence: Evidence[]): string[] {
  const labels = evidence.map((e) => `${e.table}/${e.label}`);
  const width = Math.max(...labels.map((l) => l.length));
  return evidence.map((e, i) => `  ${(labels[i] ?? '').padEnd(width)}  ${style.dim(e.id)}`);
}

/**
 * The cards a run left behind.
 *
 * Printed after the answer and before the evidence, because it is the thing that
 * needs a decision and a block under a trace summary is a block nobody reads.
 *
 * The heading says what happened in the words that matter — nothing — and it says
 * it before any of the detail. The failure mode being designed against is an
 * operator skimming a confident paragraph about hours being logged and never
 * reaching the line that says they were not.
 */
function printProposed(cards: Proposal[], drafts: ProposalDraft[]): void {
  if (drafts.length === 0 && cards.length === 0) return;

  out(style.bold(style.yellow('proposed — NOTHING HAS BEEN CHANGED')));
  if (cards.length > 0) {
    out(
      style.dim(
        `  ${
          cards.length === 1 ? 'One change is waiting' : `${cards.length} changes are waiting`
        } for your approval. The agent resolved the record, decided everything it would do, ` +
          'and then did not do it.'
      )
    );
  } else {
    // Every draft failed to record. The heading is still the truth — nothing was
    // changed — and the count below says why there is nothing to approve.
    // "0 changes are waiting for your approval" is a sentence with no useful
    // reading, and it would be the last thing anybody read before moving on.
    out(style.dim('  The agent described a change and did not make it, and no card could be written:'));
  }

  for (const { card, draft } of pair(cards, drafts)) {
    out();
    out(`  ${style.bold(card.tool_name)}  ${style.dim(card.id)}`);
    out(`    ${card.summary}`);
    out(
      `    ${style.dim('row     ')} ${rowOf(card)}${
        card.target_id ? `  ${style.dim(card.target_id)}` : ''
      }`
    );
    out(
      `    ${style.dim('asserts ')} ${
        draft
          ? asserts(draft.precondition)
          : style.dim('not shown — this card could not be matched to the draft that wrote it')
      }`
    );
    out(`    ${style.dim('expires ')} ${stamp(card.expires_at)}  ${style.dim(`(${until(card.expires_at)})`)}`);
    out(`    ${style.dim('approve ')} ${INVOKE} approve ${shortId(card.id)}`);
    out(`    ${style.dim('reject  ')} ${INVOKE} reject ${shortId(card.id)}`);
  }

  if (cards.length > 0) {
    out();
    out(
      style.dim(
        '  The asserts line is re-read immediately before anything is written. If one of those ' +
          'facts has moved, approving refuses and names what changed rather than applying a diff ' +
          'that no longer describes the record.'
      )
    );
  }

  // Counted by DISTINCT write key, not by draft. Two drafts of one act collapse
  // into one card by design — asking twice is not consenting twice — and reporting
  // that as a lost proposal would teach the reader to distrust a working desk. The
  // loop already keys its own collection by write key, so this arithmetic only
  // differs from `drafts.length` if that ever stops being true; it is written this
  // way because the claim being made is about acts and not about drafts.
  const distinct = new Set(drafts.map((d) => d.writeKey)).size;
  if (distinct > cards.length) {
    out();
    out(
      style.red(
        `  ${distinct - cards.length} proposal(s) could not be written to the desk and cannot be ` +
          'approved. The reason is on stderr above; the answer stands regardless.'
      )
    );
  }
}

/* ─── proposals: the pending queue ─── */

/**
 * A page, and it says when it is one.
 *
 * Bigger than the module's own default for pending, because this is the only
 * view: a card the desk did not print is a card nobody decides. Both counts are
 * compared against what came back, and a full page says so — a list silently cut
 * at its limit is how "nothing else is waiting" gets believed.
 */
const DESK_PENDING = 50;
const DESK_RECENT = 10;

async function showDesk(userId: string, inv: Invocation): Promise<number> {
  // No catch. `listProposals` raises rather than returning an empty desk, and
  // this file must not undo that: an empty list here is a statement that nothing
  // is waiting on you, and a failed query is not entitled to make it
  // (docs/incidents.md, entry 3). The outer catch prints the sentence.
  const desk = await listProposals(userId, { pending: DESK_PENDING, recent: DESK_RECENT });

  if (inv.json) {
    out(JSON.stringify({ pending: desk.pending, recent: desk.recent }, null, 2));
    return EXIT_OK;
  }

  out();
  out(style.bold('pending'));
  if (desk.pending.length === 0) {
    out(
      style.dim(
        '  nothing is waiting. This is an answer rather than a silence: a failed read raises ' +
          'instead of printing an empty desk.'
      )
    );
  } else {
    // Oldest first — the reverse of the read's order. The oldest card is the one
    // closest to ageing out and the one most likely to have been forgotten, so it
    // goes where the eye lands first.
    for (const card of [...desk.pending].reverse()) {
      out();
      out(
        `  ${style.bold(shortId(card.id))}  ${style.dim(`${ago(card.created_at)}`)}  ${
          card.tool_name
        }  ${style.dim(`— ${expiry(card.expires_at)}`)}`
      );
      out(`    ${card.summary}`);
      out(`    ${style.dim('row    ')} ${rowOf(card)}`);
      out(
        `    ${style.dim('asked  ')} ${
          card.origin
            ? `"${firstLine(card.origin, 120)}"`
            : style.dim(
                'not on file — the run that proposed this was not recorded, so there is no ' +
                  'question to show'
              )
        }`
      );
      out(`    ${style.dim('decide ')} ${INVOKE} approve ${shortId(card.id)}  |  reject ${shortId(card.id)}`);
    }
    if (desk.pending.length === DESK_PENDING) {
      out();
      out(
        style.dim(
          `  (the oldest ${DESK_PENDING} of more than ${DESK_PENDING} — decide some of these to see the rest)`
        )
      );
    }
  }

  out();
  // Shown even when empty. "Did I approve that?" is the question the record
  // exists to answer (docs/design.md §4), and a desk that only ever shows open
  // cards cannot answer it.
  out(style.bold('recently decided'));
  if (desk.recent.length === 0) {
    out(style.dim('  nothing has been decided yet.'));
  } else {
    // The status is padded because these are columns, and a column that moves
    // per row is one the eye has to re-find on every line.
    const width = Math.max(...desk.recent.map((c) => c.status.length));
    for (const card of desk.recent) {
      const word = card.status.padEnd(width);
      out(
        `  ${style.bold(shortId(card.id))}  ${
          card.status === 'applied' ? style.green(word) : style.dim(word)
        }  ${style.dim(ago(card.decided_at))}  ${card.tool_name}`
      );
      if (card.result) out(`    ${style.dim(firstLine(card.result, 140))}`);
    }
    if (desk.recent.length === DESK_RECENT) {
      out(style.dim(`  (the last ${DESK_RECENT}; older decisions are in agent_proposals)`));
    }
  }
  out();

  return EXIT_OK;
}

/* ─── approve / reject: one card ─── */

/**
 * A full uuid, or an unambiguous prefix of one.
 *
 * A full uuid is passed straight through WITHOUT a lookup, on purpose: a card
 * older than the window below is still decidable by its full id, and a lookup
 * that failed to find it would refuse a decision the desk is perfectly able to
 * make.
 */
async function resolveRef(userId: string, ref: string): Promise<{ id: string } | { error: string }> {
  const wanted = ref.trim().toLowerCase();

  if (UUID.test(wanted)) return { id: wanted };

  if (!/^[0-9a-f][0-9a-f-]*$/.test(wanted)) {
    return {
      error:
        `"${ref}" is not a proposal id or the start of one: an id is hex digits and dashes, like ` +
        `9f3c1a2b. Run \`${INVOKE} proposals\` to see the ids that exist.`,
    };
  }
  if (wanted.length < MIN_PREFIX) {
    return {
      error:
        `"${ref}" is too short to name a proposal — give at least ${MIN_PREFIX} characters of ` +
        'its id. A shorter one reads like a position in the list, and a position is not what ' +
        'gets approved.',
    };
  }

  const desk = await listProposals(userId, { pending: RESOLVE_WINDOW, recent: RESOLVE_WINDOW });
  // Pending and decided cards are both matched. A prefix that hits one of each is
  // ambiguous and is refused with both listed, because the alternative — quietly
  // preferring the pending one — is a rule nobody typing the prefix knows about.
  const matches = [...desk.pending, ...desk.recent].filter((p) =>
    p.id.toLowerCase().startsWith(wanted)
  );

  if (matches.length === 0) {
    return {
      error:
        `No proposal starts with "${ref}". \`${INVOKE} proposals\` lists what is waiting; the ` +
        `last ${RESOLVE_WINDOW} decided cards are searched too, and anything older can still be ` +
        'named by its full id.',
    };
  }
  if (matches.length > 1) {
    const listed = matches
      .map((p) => `  ${shortId(p.id)}  ${p.status}  ${p.tool_name} — ${firstLine(p.summary, 90)}`)
      .join('\n');
    return {
      error:
        `"${ref}" matches ${matches.length} proposals, so nothing was decided. Add a character:\n${listed}`,
    };
  }

  // `matches[0]` is defined — length is exactly 1 here — and the guard is written
  // out rather than asserted with `!` because a TypeError inside a function whose
  // job is to refuse carefully would be an odd way to fail.
  const only = matches[0];
  return only ? { id: only.id } : { error: `No proposal starts with "${ref}".` };
}

async function decide(
  userId: string,
  command: { decision: Decision; ref: string },
  inv: Invocation
): Promise<number> {
  const found = await resolveRef(userId, command.ref);
  if ('error' in found) {
    note(found.error);
    return EXIT_USAGE;
  }

  // Deliberately no `ensureToolsRegistered()` here. `decideProposal` calls it
  // itself, and if this file called it first, deleting that call would change
  // nothing visible and the approval path would be back to working by
  // coincidence — which is incident 1, exactly.
  let outcome: DecisionOutcome;
  try {
    outcome = await decideProposal({ userId, id: found.id, decision: command.decision });
  } catch (err) {
    // `decideProposal` throws only for a card that is not there and for an id
    // that cannot be one, and both arrive as a sentence. Printed as that
    // sentence: a stack trace here would suggest the desk is broken rather than
    // that the id was wrong.
    note(errStyle.red(messageOf(err)));
    return EXIT_NOT_DONE;
  }

  // What the operator asked for, against what the card now is. Compared this way
  // round on purpose: approving a card that was already DECLINED comes back with
  // status 'declined' and a true sentence, and reporting that as a success
  // because a decision was reached would be the CLI agreeing with the wrong half
  // of it.
  const wanted: ProposalStatus = command.decision === 'approve' ? 'applied' : 'declined';
  const landed = outcome.status === wanted;

  if (inv.json) {
    out(
      JSON.stringify(
        {
          proposal_id: found.id,
          decision: command.decision,
          status: outcome.status,
          result: outcome.message,
          evidence: outcome.evidence,
          landed,
        },
        null,
        2
      )
    );
    return landed ? EXIT_OK : EXIT_NOT_DONE;
  }

  out();
  out(
    landed
      ? style.green(style.bold(outcome.status))
      : style.red(style.bold(`not ${wanted} — ${outcome.status}`))
  );
  // The message is `decideProposal`'s, verbatim and unsummarised. It is the
  // sentence that says which of the four refusals happened — the record moved and
  // what moved, the card aged out, it was already decided — and rewording it here
  // would give the operator a second vocabulary for the same event, one of which
  // would eventually be the stale one.
  for (const line of outcome.message.split('\n')) out(`  ${line}`);

  if (outcome.evidence.length > 0) {
    out();
    out(style.bold('evidence'));
    for (const line of evidenceLines(outcome.evidence)) out(line);
  }

  out();
  if (landed && command.decision === 'approve') {
    out(
      style.dim(
        '  The write key for this act is claimed, so approving it again replays this result ' +
          'rather than doing it a second time.'
      )
    );
  }
  out(style.dim(`  select status, result, decided_at from agent_proposals where id = '${found.id}';`));

  return landed ? EXIT_OK : EXIT_NOT_DONE;
}

/* ─── the report ─── */

function report(
  run: AgentRun,
  question: string,
  runId: string | null,
  inv: Invocation,
  proposed: { cards: Proposal[]; drafts: ProposalDraft[] }
): void {
  if (inv.json) {
    // Field names follow the columns in agent_runs rather than the AgentRun
    // shape, so that what a wrapper reads here and what it would read out of the
    // database are the same names.
    out(
      JSON.stringify(
        {
          question,
          answer: run.answer,
          stop_reason: run.stopReason,
          stop_detail: run.stopDetail,
          steps: run.steps,
          tokens: run.tokens,
          duration_ms: run.ms,
          writes_allowed: run.writesAllowed,
          provider: run.provider,
          model: run.model,
          evidence: run.evidence,
          trace: run.trace,
          run_id: runId,
          recorded: runId !== null,
          // Column names from agent_proposals, like the run's own fields above.
          // `precondition` comes off the draft because the desk's read does not
          // select it, and is null when the card could not be paired with the
          // draft that wrote it.
          proposals: pair(proposed.cards, proposed.drafts).map(({ card, draft }) => ({
            id: card.id,
            tool_name: card.tool_name,
            summary: card.summary,
            target_table: card.target_table,
            target_id: card.target_id,
            target_label: card.target_label,
            status: card.status,
            expires_at: card.expires_at,
            precondition: draft?.precondition ?? null,
          })),
          // Distinct acts the run proposed that are NOT on the desk. A wrapper
          // that reports "1 change awaiting approval" from the array above would
          // otherwise be quietly wrong about the ones that failed to record.
          proposals_not_recorded:
            new Set(proposed.drafts.map((d) => d.writeKey)).size - proposed.cards.length,
        },
        null,
        2
      )
    );
    return;
  }

  out();
  // The answer first and unadorned, so that piping this somewhere gives the
  // answer at the top rather than a header to strip.
  //
  // The fallback is not decoration. A run that walled has its stop sentence as
  // its answer, but a model turn can also come back with tool calls and no text
  // at all, and printing nothing there would read as the agent having refused to
  // answer rather than as a turn with no prose in it.
  out(run.answer.trim() || style.dim(`(no answer text — ${run.stopDetail})`));
  out();

  // Before the evidence and the trace. A change waiting on a person outranks the
  // accounting for the run that suggested it.
  printProposed(proposed.cards, proposed.drafts);
  if (proposed.cards.length > 0 || proposed.drafts.length > 0) out();

  out(style.bold('evidence'));
  if (run.evidence.length === 0) {
    // Said out loud rather than left as an empty heading. No evidence means
    // nothing in the answer above is traceable to a row, which is the one thing
    // a reader most needs to know about it.
    out(style.dim('  none — nothing above rests on a record. Treat it as a claim.'));
  } else {
    // The id is what makes this checkable: with it, disagreeing with the agent
    // is a query rather than an argument.
    for (const line of evidenceLines(run.evidence)) out(line);
  }
  out();

  out(style.bold('trace'));
  // Printed verbatim from trace.ts, which is also what a reader of agent_runs
  // sees. The evidence line it ends with repeats the block above at a glance
  // and without ids; that is the small cost of the summary being one function
  // rather than one per caller.
  out(summarizeTrace(run));

  if (inv.trace) {
    out();
    out(style.bold('trace, in full'));
    for (const step of run.trace) {
      const head =
        step.kind === 'model'
          ? `  ${step.step}. model ${step.ms}ms in=${step.inputTokens ?? '?'} out=${step.outputTokens ?? '?'}` +
            (step.stop ? ` stop=${step.stop}` : '')
          : `  ${step.step}. ${step.toolName} ${step.ms}ms ${step.ok ? 'ok' : 'FAILED'}` +
            (step.tokens ? ` ${step.tokens}tok` : '');
      out(step.kind === 'tool' && step.ok === false ? style.red(head) : head);
      if (step.toolArgs !== undefined) {
        // Verbatim, exactly as the model sent them and before validation, so a
        // refusal can be read next to what caused it.
        out(style.dim(`       args ${JSON.stringify(step.toolArgs)}`));
      }
      if (step.output) {
        // Already cut to 500 characters by the loop. This is what the trace
        // stores, not everything the tool returned.
        for (const line of step.output.split('\n')) out(style.dim(`       ${line}`));
      }
    }
  }

  out();
  if (!inv.record) {
    out(style.dim('not recorded (--no-record)'));
  } else if (runId) {
    out(style.dim(`recorded as run ${runId}`));
    out(style.dim(`  select stop_reason, steps, tokens, trace from agent_runs where id = '${runId}';`));
  } else {
    // persistRun already logged why on stderr, and returning null instead of
    // throwing is the point: an agent that answered correctly and then died
    // recording itself has turned an observability problem into an outage.
    out(style.dim('not recorded — the reason is on stderr above; the answer stands regardless'));
  }
}

/* ─── the run ─── */

async function main(): Promise<number> {
  const inv = parse(process.argv.slice(2));
  if ('error' in inv) {
    note(inv.error);
    note(USAGE);
    return EXIT_USAGE;
  }

  const command = inv.command;
  // Before the environment is read, so `--help` works in a directory that has no
  // .env in it — which is every directory, the first time.
  if (command.kind === 'help') {
    out(HELP);
    return EXIT_OK;
  }

  const env = readEnv();
  if ('error' in env) {
    // One sentence, not a stack trace. A missing variable is a line in a file,
    // and a stack trace into a module the reader has never opened suggests
    // something is broken instead.
    note(env.error);
    return EXIT_USAGE;
  }

  // The three subcommands that only touch the database, before the one that also
  // needs a model. Neither of these registers a tool: `proposals` executes
  // nothing, and `decideProposal` owns the registration for the path that does.
  switch (command.kind) {
    case 'proposals':
      return showDesk(env.userId, inv);
    case 'decide':
      return decide(env.userId, command, inv);
    case 'ask':
      return ask(env.userId, command.question, inv);
  }
}

async function ask(userId: string, question: string, inv: Invocation): Promise<number> {
  // Caught here rather than at the bottom of the file, because the three things
  // this throws for — no key, no MODEL, a PROVIDER that is not one of ours — are
  // all the environment being wrong, and that is exit 2 with nothing spent. Let
  // through to the outer catch they would report as a failed run, which is both
  // the wrong code and an invitation to look for a bug in the harness.
  let choice: ProviderChoice;
  try {
    choice = providerFromEnv();
  } catch (err) {
    note(errStyle.red(err instanceof Error ? err.message : String(err)));
    return EXIT_USAGE;
  }

  // The registry is the allowlist, and it starts empty. Registering is an
  // explicit call made by every entry point that will reach `executeTool`,
  // rather than a side effect of importing the loop: in the private original it
  // was the side effect, so the approval path — which has no reason to import
  // the loop — ran for weeks with two tools registered and failed every write it
  // was asked to apply.
  ensureToolsRegistered();
  if (allTools().length === 0) {
    // Checked rather than assumed, because the failure it catches is silent from
    // here: with an empty registry the model is sent no tools, answers from
    // nothing, and the run looks like a fast cheap success. Refusing before the
    // model call costs nothing and cannot be misread.
    note(
      'No tools are registered, so there would be nothing to read the business with and the ' +
        'model would answer from nothing. This is a wiring fault in the harness rather than ' +
        'anything to fix in .env.'
    );
    return EXIT_USAGE;
  }

  /**
   * Ctrl-C is a cancellation, not a kill.
   *
   * The loop takes a signal and turns it into the `aborted` stop reason, so an
   * interrupted run still reports what it had established and still writes its
   * trace — which is the run you most want to read afterwards. A second Ctrl-C
   * exits immediately, because a first one that appears to do nothing is worse
   * than no handler at all.
   *
   * That second press is the one place this file still forces an exit, and it can
   * therefore still hit the libuv assertion described at the bottom of this file.
   * That is the accepted cost of an escape hatch: someone pressing Ctrl-C twice
   * is asking to be let out now, not to be told what the tidy shutdown found.
   */
  const controller = new AbortController();
  let interrupted = false;
  const onInterrupt = (): void => {
    if (interrupted) {
      note(errStyle.red('interrupted twice — exiting now, this run will not be recorded'));
      process.exit(EXIT_NOT_DONE);
    }
    interrupted = true;
    note(errStyle.dim('interrupting — finishing the current step, then reporting what there is'));
    controller.abort();
  };
  process.on('SIGINT', onInterrupt);

  const startedAt = Date.now();
  const say = inv.json
    ? // In JSON mode the events go out as NDJSON so a wrapper can still watch a
      // long run, and the document on stdout stays the only thing on stdout.
      (event: RunEvent): void => note(JSON.stringify(event))
    : narrator(startedAt);

  let run: AgentRun;
  try {
    run = await runAgent({
      question,
      userId,
      provider: choice.provider,
      model: choice.model,
      signal: controller.signal,
      onEvent: say,
      // No `allowWrites`. There is no invocation of this file that turns it on —
      // see the note at the top — so a write tool in this run resolves its target,
      // decides everything, and proposes.
    });
  } finally {
    process.off('SIGINT', onInterrupt);
  }

  // One call, because the ORDER is the guarantee: `agent_proposals.run_id` is a
  // foreign key into `agent_runs`, so the run is written first and the cards
  // after, and `trace.ts` owns that rather than this file doing it in two steps.
  //
  // `--no-record` skips the trace and NOT the cards. It says "do not write this
  // run to agent_runs", and a card is the request for consent rather than part of
  // the reasoning — dropping it would leave the operator reading a change that
  // nothing can act on, which is strictly worse than a card whose question is not
  // on file. The card takes a null `run_id`, and the desk's read left-joins the
  // run for exactly that row.
  const recorded = inv.record
    ? await persistRunAndProposals(userId, question, run, { kind: 'operator' })
    : {
        runId: null,
        // Not called with an empty list: a question that changes nothing should
        // not touch `agent_proposals` at all, which is the same judgment
        // `persistRunAndProposals` makes on the recorded path.
        proposals:
          run.proposals.length > 0 ? await recordProposals(userId, null, run.proposals) : [],
      };

  report(run, question, recorded.runId, inv, {
    cards: recorded.proposals,
    drafts: run.proposals,
  });

  // A wall is a named outcome and was reported as one. The exit code is the
  // only part of that a script can read. A run that answered and left a card is
  // 0: it answered, and the card is not a failure — it is the design.
  return run.stopReason === 'answered' ? EXIT_OK : EXIT_NOT_DONE;
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

let code = EXIT_NOT_DONE;
// Read from argv rather than from the parsed invocation, because both of these
// are needed in the catch below — which is reachable before, and instead of,
// anything being parsed.
const showStack = process.argv.includes('--trace');
const asJson = process.argv.includes('--json');

try {
  code = await main();
} catch (err) {
  // Every layer below this is expected to fail with a sentence: the provider
  // names the variable, the tools return refusals as results, the budget names
  // the wall. What reaches here is either one of those sentences or a genuine
  // bug, and printing a stack trace for the first kind teaches a reader to
  // ignore stack traces.
  const message = messageOf(err);
  // A machine reader asked for a document, so it gets one either way. An empty
  // stdout and a non-zero exit is unambiguous only to whoever remembered to look
  // at the exit code.
  if (asJson) out(JSON.stringify({ error: message }, null, 2));
  note(errStyle.red(message));
  if (showStack && err instanceof Error && err.stack) note(errStyle.dim(err.stack));
  else if (!showStack) note(errStyle.dim('run again with --trace for the stack trace'));
  code = EXIT_NOT_DONE;
} finally {
  // The pool holds an open socket, which keeps the event loop alive: without
  // this the CLI prints its answer and then sits there looking broken.
  await close();
}

/**
 * The exit code is set, not forced.
 *
 * This file first called `process.exit(code)` here, to stop a keep-alive socket
 * left by the provider's fetch from holding the process open after the answer
 * was already on screen. That cost more than it bought, and the failure is worth
 * recording because it looks like a Node bug rather than a decision:
 *
 * exiting while the pool and the HTTP agent are still closing their handles
 * aborts the process on Windows with `Assertion failed: !(handle->flags &
 * UV_HANDLE_CLOSING)`, which replaced this run's exit code with 127 and printed
 * a C assertion under the answer. Every exit code documented at the top of this
 * file was wrong for as long as that line was here.
 *
 * `close()` above releases the pool, which is the handle this process actually
 * owns. Anything the provider left is the provider's to close, and letting Node
 * finish is what keeps the reported code the real one.
 */
process.exitCode = code;
