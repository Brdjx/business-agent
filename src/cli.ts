/**
 * The command line. One question, one answer, and the receipts.
 *
 *   tsx --env-file=.env src/cli.ts "how much is outstanding?"
 *   tsx --env-file=.env src/cli.ts --trace "who have we worked with?"
 *   tsx --env-file=.env src/cli.ts --json "what is overdue?" | jq .evidence
 *
 * This is the first thing a reader of this repository runs, so what it prints is
 * part of the argument. An agent that answers "$18,400 is outstanding" has told
 * you nothing you can check. So the default output is the answer, then the rows
 * it rests on with their ids, then one line per step with what each cost. None
 * of that is behind a flag: the whole claim of the repo is that the accounting
 * around the loop is the interesting part, and hiding it until asked would be an
 * odd way to make that case.
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
 *   0  answered
 *   1  the run did not answer: it hit a wall, was cancelled, or the provider
 *      failed. A wall is an outcome rather than a crash — but a shell reads the
 *      exit code, and "stopped after 8 steps without reaching an answer" is not
 *      a success.
 *   2  the invocation or the environment is wrong. Nothing was spent.
 *
 * ── What is deliberately not here ──
 *
 * No flag turns writes on. There is no write tool in this phase, so a flag
 * promising one would be a lie, and `--allow-writes` is the kind of switch that
 * quietly survives into the phase where it means something. The run reports the
 * mode it was in (`read-only` in the trace block) rather than the CLI asserting
 * it.
 */

import { runAgent, type AgentRun, type RunEvent } from './agent/loop';
import { providerFromEnv, type ProviderChoice } from './agent/providers';
import { persistRun, summarizeTrace } from './agent/trace';
import { ensureToolsRegistered } from './agent/registry';
import { allTools } from './agent/tools';
import { close } from './db';

/* ─── exit codes ─── */

const EXIT_ANSWERED = 0;
const EXIT_UNANSWERED = 1;
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
  return { dim: wrap('2'), bold: wrap('1'), red: wrap('31'), green: wrap('32') };
}

const style = styler(process.stdout.isTTY);
const errStyle = styler(process.stderr.isTTY);

/* ─── arguments ─── */

interface Invocation {
  question: string;
  /** The full trace: every step's arguments and stored output, plus a stack on failure. */
  trace: boolean;
  /** One JSON document on stdout; the progress events as NDJSON on stderr. */
  json: boolean;
  /** Write the run to `agent_runs`. */
  record: boolean;
  help: boolean;
}

const USAGE = 'usage: tsx --env-file=.env src/cli.ts [--trace] [--json] [--no-record] "your question"';

const HELP = `${USAGE}

Ask one question about the seeded business. The agent calls tools that read
Postgres, and prints the answer, the rows it rests on, and what each step cost.

  --trace       every step in full: the arguments the model sent, the output
                stored in the trace, and a stack trace if the run fails
  --json        one JSON document on stdout, with the progress events as NDJSON
                on stderr. Field names match the columns in agent_runs
  --no-record   do not write this run to agent_runs. The default is to record:
                a run you cannot read back afterwards cannot be debugged
  --help        this

Environment (nothing here loads .env by itself — pass --env-file to the runner):

  DATABASE_URL        where the business records are
  USER_ID             the operator uuid the agent tables are scoped by
  PROVIDER, MODEL, ANTHROPIC_API_KEY   which model answers, and how

Exit codes: 0 answered, 1 did not answer, 2 bad invocation or environment.`;

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
 */
function parse(argv: string[]): Invocation | { error: string } {
  const flags = { trace: false, json: false, record: true, help: false };
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
        flags.help = true;
        break;
      default:
        if (arg.startsWith('-')) {
          return { error: `Unrecognised flag: ${arg}. Known flags: --trace, --json, --no-record, --help.` };
        }
        words.push(arg);
    }
  }

  const question = words.join(' ').trim();
  if (!flags.help && !question) {
    return { error: 'No question was given.' };
  }
  if (question.length > MAX_QUESTION) {
    return {
      error:
        `That question is ${question.length.toLocaleString()} characters, and ${MAX_QUESTION.toLocaleString()} is the most ` +
        'that can be recorded without being truncated. Ask a shorter one rather than ' +
        'having the record disagree with what was asked.',
    };
  }
  return { ...flags, question };
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

/* ─── the report ─── */

function report(run: AgentRun, question: string, runId: string | null, inv: Invocation): void {
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

  out(style.bold('evidence'));
  if (run.evidence.length === 0) {
    // Said out loud rather than left as an empty heading. No evidence means
    // nothing in the answer above is traceable to a row, which is the one thing
    // a reader most needs to know about it.
    out(style.dim('  none — nothing above rests on a record. Treat it as a claim.'));
  } else {
    // The id is what makes this checkable: with it, disagreeing with the agent
    // is a query rather than an argument.
    const labels = run.evidence.map((e) => `${e.table}/${e.label}`);
    const width = Math.max(...labels.map((l) => l.length));
    run.evidence.forEach((e, i) => {
      out(`  ${(labels[i] ?? '').padEnd(width)}  ${style.dim(e.id)}`);
    });
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
  if (inv.help) {
    out(HELP);
    return EXIT_ANSWERED;
  }

  const env = readEnv();
  if ('error' in env) {
    // One sentence, not a stack trace. A missing variable is a line in a file,
    // and a stack trace into a module the reader has never opened suggests
    // something is broken instead.
    note(env.error);
    return EXIT_USAGE;
  }

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
      process.exit(EXIT_UNANSWERED);
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
      question: inv.question,
      userId: env.userId,
      provider: choice.provider,
      model: choice.model,
      signal: controller.signal,
      onEvent: say,
    });
  } finally {
    process.off('SIGINT', onInterrupt);
  }

  const runId = inv.record
    ? await persistRun(env.userId, inv.question, run, { kind: 'operator' })
    : null;

  report(run, inv.question, runId, inv);

  // A wall is a named outcome and was reported as one. The exit code is the
  // only part of that a script can read.
  return run.stopReason === 'answered' ? EXIT_ANSWERED : EXIT_UNANSWERED;
}

let code = EXIT_UNANSWERED;
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
  const message = err instanceof Error ? err.message : String(err);
  // A machine reader asked for a document, so it gets one either way. An empty
  // stdout and a non-zero exit is unambiguous only to whoever remembered to look
  // at the exit code.
  if (asJson) out(JSON.stringify({ error: message }, null, 2));
  note(errStyle.red(message));
  if (showStack && err instanceof Error && err.stack) note(errStyle.dim(err.stack));
  else if (!showStack) note(errStyle.dim('run again with --trace for the stack trace'));
  code = EXIT_UNANSWERED;
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
