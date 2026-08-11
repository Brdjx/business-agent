/**
 * The web UI: one `node:http` server, server-rendered HTML, no framework.
 *
 *   tsx --env-file=.env src/web/server.ts
 *   PORT=4000 tsx --env-file=.env src/web/server.ts
 *
 * ── Why this exists ──
 *
 * The strongest thing in this repository is per-action consent, and it is
 * currently invisible. The card that says NOTHING HAS BEEN CHANGED, the asserts
 * line that is re-read before the write, the refusal that names what moved, the
 * trace with a duration on every step — all of it lives in terminal scrollback.
 * These four surfaces put the mechanism where it can be looked at.
 *
 * The rule this is built to, which is worth applying to every page added later:
 * if a screen does not show evidence, cost, or what has NOT happened, it is the
 * wrong screen. This is not a chat app that happens to have an audit log.
 *
 * ── Why no framework ──
 *
 * The only runtime dependency in this repository is `pg`, and this file keeps it
 * that way. The reasoning is the same as for the provider adapter posting with
 * plain `fetch` rather than loading an SDK: the dependency list stays honest, and
 * the code reads as documentation of what it actually does. A router is a switch
 * on a method and a path; HTML is a template string; the escaping is one file that
 * nothing can bypass by accident.
 *
 * ── SECURITY, and there is not much of it ──
 *
 * Read this before adding a route, because this UI can APPROVE WRITES to the
 * business.
 *
 * **It binds to 127.0.0.1.** `WEB_BIND` is the only way to change that, and it is
 * named for what it does. One operator, one machine, a local tool.
 *
 * **There is no authentication and none is pretended.** Not a session, not a
 * token, not basic auth. Anything reachable here is approvable by whoever reaches
 * it, so the footer says so on every page and says it louder when `WEB_BIND` has
 * been pointed somewhere else.
 *
 * **Every write is a POST.** A GET that applies a write is one crawler, one
 * prefetch or one `<img src>` away from approving something, and the browser will
 * make that request without anybody clicking. No handler reached by GET in this
 * file mutates anything, and that is a rule rather than a coincidence.
 *
 * **Cross-site POSTs are refused.** No authentication also means no CSRF token to
 * check, and a form on any web page in the world can aim a POST at
 * `127.0.0.1:3000`. What a browser does volunteer is `Sec-Fetch-Site` and
 * `Origin`, both of which it sets itself and page JavaScript cannot forge, so a
 * POST whose origin is not this server's own is rejected before it reaches a
 * handler. A request with neither header — curl, a script — is allowed: it is not
 * a browser being used as a weapon against its own user, which is the whole of
 * what this guard is for.
 *
 * **Every interpolated value is escaped**, through `escape.ts`, which exists as
 * its own file so that it cannot be forgotten. Client names, invoice notes,
 * proposal summaries and model output all end up in this markup, and the proposal
 * summary was written by a model reading a database somebody else fills in.
 *
 * ── The seam for the four page modules ──
 *
 * This file owns HTTP and nothing else: the router, the body, the headers, the
 * logging, the error pages. A page is a function from a `Ctx` to a `Reply`, so a
 * page module imports `layout.ts`, `escape.ts` and whatever it reads out of
 * `src/agent/`, and needs no runtime import from this file at all — `Ctx` and
 * `Reply` are types, and a type import is erased. That direction matters: this
 * module starts listening when it is loaded, so anything importing it for a value
 * would start a second server as a side effect.
 *
 * All four surfaces now live in `./pages/`, and the route table below is the only
 * place that names them. Each of those modules was written against a stub that said
 * what its screen had to show; the stubs are gone and each brief is now the header
 * comment of the module that has to keep it true.
 *
 * ── What this deliberately does not do ──
 *
 * It does not call `ensureToolsRegistered()`. The registry is the allowlist and it
 * starts empty; filling it is an explicit call made by the entry point that is
 * about to reach `executeTool`. Doing it here at boot would mean the ask handler
 * worked because this file happened to have done it, which is exactly the shape of
 * incident 1 — an approval path whose registry was filled by whoever imported the
 * loop, so that approving a write had never once worked in production. The ask
 * handler calls it, and `decideProposal` calls it for the approval path.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { close } from '../db';
// `html` and these two helpers are all this file needs now that the pages are their
// own modules: the error pages are the only markup left in here.
import { html } from './escape';
import { empty, layout } from './layout';
// A page module is a function from a Ctx to a Reply. It imports the types from here
// and nothing else, so the dependency runs one way only — this file starts listening
// when it is loaded, and anything importing a value from it would start a second
// server as a side effect.
import { evalCasePage, evalsPage, evalSuitePage } from './pages/evals';
// A page module, imported for its handlers. The dependency runs one way only:
// `pages/ask.ts` imports Ctx and Reply from this file as TYPES, which are erased,
// so nothing there starts a second server.
import { askPage, askRun } from './pages/ask';
import { approvalsDecide, approvalsPage } from './pages/approvals';
// A page module is imported for its values; it imports only TYPES from here. The
// direction matters and is not stylistic: this file starts listening when it is
// loaded, so a page that imported a value from it would start a second server as
// a side effect of being rendered.
import { runPage, runVerdict, runsPage } from './pages/runs';

/* ─── the environment ─── */

const DEFAULT_PORT = 3000;

/**
 * Loopback, and only loopback, unless somebody says otherwise in a variable whose
 * name is about binding.
 *
 * Not `0.0.0.0`. The difference is not theoretical: on a laptop on a café network,
 * `0.0.0.0` publishes a page with approve buttons to everyone on that network, and
 * nothing on it asks who they are.
 */
const DEFAULT_BIND = '127.0.0.1';

/** The whole of 127.0.0.0/8 and the two other spellings of the same idea. See the
 * matching note in `layout.ts`, which decides the same thing for the footer: the
 * variable name is shared, and neither file reads the other's constant, so a page
 * cannot claim loopback while the process listens somewhere else. */
const isLoopback = (bind: string): boolean =>
  /^127\./.test(bind) || bind === '::1' || bind === '[::1]' || bind === 'localhost';

/** Any uuid version, as the CLI accepts one. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const HOW_TO_SUPPLY =
  'Nothing here loads .env by itself: copy .env.example to .env and pass it to the runner ' +
  '(tsx --env-file=.env src/web/server.ts).';

/**
 * Read what this process needs, before it starts listening.
 *
 * Checked up front rather than at the first query, because the alternative is a
 * server that starts, serves a nav, and then puts a Postgres error on every page —
 * which reads as a broken UI rather than as a variable nobody set.
 */
function readEnv(): { userId: string; port: number; bind: string } | { error: string } {
  if (!process.env.DATABASE_URL?.trim()) {
    return {
      error:
        'DATABASE_URL is not set, so there is nothing to read the business from. Every one of ' +
        `the four surfaces is a query. Run \`npm run db:up\`. ${HOW_TO_SUPPLY}`,
    };
  }

  const userId = process.env.USER_ID?.trim();
  if (!userId) {
    return {
      error:
        'USER_ID is not set, so there is nobody whose runs, proposals and notes these pages ' +
        `would show. The .env.example default is a deliberately fake uuid. ${HOW_TO_SUPPLY}`,
    };
  }
  if (!UUID.test(userId)) {
    return {
      error:
        `USER_ID is "${userId}", which is not a uuid. The agent tables are scoped by a uuid ` +
        'column, so every page would fail with a Postgres syntax error that reads like a broken ' +
        'schema rather than a wrong variable.',
    };
  }

  const rawPort = process.env.PORT?.trim();
  const port = rawPort ? Number(rawPort) : DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    return {
      error:
        `PORT is "${rawPort}", which is not a port. Refused here rather than passed to listen(), ` +
        'which would fail with an error naming a number nobody typed.',
    };
  }

  const bind = process.env.WEB_BIND?.trim() || DEFAULT_BIND;

  return { userId, port, bind };
}

/* ─── what a page is ─── */

/**
 * Everything a page gets. Held together in one object so that adding something a
 * page needs is one field rather than a signature change in five files.
 */
export interface Ctx {
  req: IncomingMessage;
  /**
   * The raw response.
   *
   * Present for the one case a `Reply` cannot describe: the ask surface streams
   * the run's own events as they happen, because a page that shows a spinner for
   * twenty seconds and then everything at once has thrown away the part of the
   * trace that is interesting while you wait. A handler that writes to this
   * returns `{ kind: 'handled' }` and takes on the logging of its own status.
   * Every other page should leave it alone.
   */
  res: ServerResponse;
  /** The request URL. `searchParams` is where a filter or a page number comes
   * from, and every one of those is untrusted text. */
  url: URL;
  /** The operator, from the environment. Never from the request — a UI with no
   * authentication must not also let the request choose whose records it reads. */
  userId: string;
  /** Named groups from the route's pattern, percent-decoded. */
  params: Record<string, string>;
  /**
   * The parsed body of a POST, or empty.
   *
   * Parsed by the router rather than by each handler, so the size cap and the
   * content-type check exist once and cannot be forgotten by the page that
   * happens to be written last.
   */
  form: URLSearchParams;
}

export type Reply =
  | { kind: 'html'; body: string; status?: number }
  /** Always used after a POST that changed something. A redirect turns the
   * browser's back button and its reload into a GET, so a refresh cannot re-post
   * an approval — and the write-key ledger would replay rather than repeat it, but
   * a page that invites the attempt is a page that teaches the wrong thing. */
  | { kind: 'redirect'; to: string; status?: 303 | 302 }
  /** The handler wrote the response itself. Explicit rather than `void`, so a
   * handler that simply forgot to return is a bug this file can name. */
  | { kind: 'handled' };

export type Handler = (ctx: Ctx) => Promise<Reply> | Reply;

interface Route {
  method: 'GET' | 'POST';
  /** A string is matched exactly. A pattern's named groups become `ctx.params`. */
  path: string | RegExp;
  handler: Handler;
}

/* ─── the routes ─── */

/**
 * Four surfaces, and the POSTs that act on them.
 *
 * The ids in the patterns are deliberately loose — `[^/]{1,64}` rather than a uuid
 * — because "that is not a run id" and "there is no such run" are different
 * sentences, and both belong to the page rather than to the router. A router that
 * refuses a malformed id with a 404 makes a typo look like a missing record.
 */
const ROUTES: Route[] = [
  { method: 'GET', path: '/', handler: askPage },
  // So a typed /ask lands somewhere rather than 404ing. It is the same surface.
  // 302 rather than the 303 default: this is an alias, not the redirect after a
  // POST, and using the same code for both would make the default's reason a
  // coincidence.
  { method: 'GET', path: '/ask', handler: () => ({ kind: 'redirect', to: '/', status: 302 }) },
  { method: 'POST', path: '/ask', handler: askRun },

  { method: 'GET', path: '/approvals', handler: approvalsPage },
  // Approve and reject are POSTs, and there is no GET spelling of either. A GET
  // that applies a write is one prefetch away from approving something.
  {
    method: 'POST',
    path: /^\/approvals\/(?<id>[^/]{1,64})\/(?<decision>approve|reject)$/,
    handler: approvalsDecide,
  },

  { method: 'GET', path: '/runs', handler: runsPage },
  { method: 'GET', path: /^\/runs\/(?<id>[^/]{1,64})$/, handler: runPage },
  { method: 'POST', path: /^\/runs\/(?<id>[^/]{1,64})\/verdict$/, handler: runVerdict },

  { method: 'GET', path: '/evals', handler: evalsPage },
  // A case id, not a uuid: `money-outstanding` is the id the cases file gives it and
  // the id the CLI's `--case=` takes, so it is the id a person passes back.
  { method: 'GET', path: /^\/evals\/case\/(?<caseId>[^/]{1,64})$/, handler: evalCasePage },
  // A full uuid or any unambiguous prefix of it, which is what the suites table on
  // /evals links with. The page refuses an ambiguous prefix rather than picking one.
  { method: 'GET', path: /^\/evals\/suite\/(?<ref>[^/]{1,64})$/, handler: evalSuitePage },
];

/* ─── where the pages went ─── */

// The `stub()` helper that stood here is gone, along with the last of the four
// placeholder handlers it rendered. It said "not built yet" in the words of what the
// screen still had to show, which is the only kind of placeholder worth committing —
// and a helper for building them is dead weight once the pages exist. The notes below
// say where each surface lives, because a route table is a list of names and a reader
// who has just read one wants to know which file it is in.

// The two ask handlers are in `./pages/ask`, imported at the top of this file.
// The stubs that were here said what the surface had to show, and that brief is
// now the module's own header. Two things it inherits from those stubs are worth
// keeping in mind from here: that module calls `ensureToolsRegistered()` itself,
// because this file deliberately does not (incident 1), and the POST is the only
// route on this server that spends money — which is why the run is a POST and the
// page's stream is read with `fetch` rather than by an `EventSource`, since an
// EventSource can only GET.

// The two approvals handlers are in `./pages/approvals`, imported at the top of
// this file. The stub that was here said what the desk had to show — the pending
// card with its summary, its row, the facts it asserts, its age and its expiry,
// then what was recently decided — and that brief is now the module's own header,
// beside the code that has to keep it true.

// The three runs handlers are in `./pages/runs`, imported at the top of this
// file. The stubs that were here said what the surface had to show; that brief is
// now the module's own header comment, where it can go stale against the code
// rather than against a route table.

// The three evals handlers are in `./pages/evals`, imported at the top of this file.
// The stub that was here said what the surface had to show — recent suites with their
// commit and model, then per-case stability from `agent_eval_flaky()`, where a skip is
// never counted as a failure — and that brief is now the module's own header. Its two
// extra routes are above: one case across suites, and one suite across cases, which
// are two different views and are deliberately not one page with a toggle.

/* ─── the router ─── */

/** Bigger than any form on these pages and small enough that a body nobody
 * asked for cannot be a memory problem. An approval posts an id. */
const MAX_BODY_BYTES = 64 * 1024;

function match(route: Route, pathname: string): Record<string, string> | null {
  if (typeof route.path === 'string') return route.path === pathname ? {} : null;

  const found = route.path.exec(pathname);
  if (!found) return null;

  const params: Record<string, string> = {};
  for (const [key, value] of Object.entries(found.groups ?? {})) {
    if (value === undefined) continue;
    try {
      params[key] = decodeURIComponent(value);
    } catch {
      // A malformed percent escape is not a reason to lose the request. The raw
      // segment is handed on, and the page's own id check refuses it.
      params[key] = value;
    }
  }
  return params;
}

/**
 * Read a urlencoded body, with a cap.
 *
 * Only `application/x-www-form-urlencoded`, because that is what a `<form>` with
 * no JavaScript sends and there is nothing else here. A different content type is
 * not parsed and not guessed at: an empty `form` reaches the handler, which
 * refuses for want of the field it needed.
 */
async function readForm(req: IncomingMessage): Promise<URLSearchParams | { error: string }> {
  const type = (req.headers['content-type'] ?? '').split(';')[0]?.trim();
  if (type !== 'application/x-www-form-urlencoded') {
    return {
      error:
        `This expects a form body (application/x-www-form-urlencoded) and got "${type || 'nothing'}". ` +
        'These pages post ordinary forms; there is no JSON API here.',
    };
  }

  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY_BYTES) {
      return {
        error: `The body is larger than ${MAX_BODY_BYTES} bytes, which no form on these pages is.`,
      };
    }
    chunks.push(buf);
  }

  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

/**
 * Whether a POST came from this server's own pages.
 *
 * There is no authentication here, so there is no session for a CSRF token to be
 * bound to — and a form on any site can target `127.0.0.1:3000` and have the
 * operator's own browser approve a write. What the browser does supply is
 * `Sec-Fetch-Site` and `Origin`, both set by the browser itself and not settable
 * from page JavaScript.
 *
 * A request with neither header is allowed. That is curl or a script, which is not
 * a browser being turned against the person using it — and refusing it would break
 * the ordinary way somebody pokes at a local server without buying any safety.
 */
function sameOrigin(req: IncomingMessage): boolean {
  const site = req.headers['sec-fetch-site'];
  if (typeof site === 'string' && site !== '') {
    // 'none' is a user-typed navigation; 'same-origin' is our own form.
    return site === 'same-origin' || site === 'none';
  }

  const origin = req.headers.origin;
  if (typeof origin === 'string' && origin !== '' && origin !== 'null') {
    try {
      return new URL(origin).host === req.headers.host;
    } catch {
      return false;
    }
  }

  return true;
}

/* ─── responses ─── */

function sendHtml(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    // Every page is a live read of the database, and a cached approvals desk is a
    // card that has already been decided still offering its buttons.
    'cache-control': 'no-store',
    // What this policy does and does not buy, because overstating it would be
    // worse than not sending it.
    //
    // It does NOT stop cross-site scripting. The streaming on the ask surface is
    // inline vanilla JS, so `script-src` has to allow inline, and an injected
    // `<script>` would therefore run. `escape.ts` is the defence against that, and
    // this header is not a second one.
    //
    // What it does buy: nothing can be loaded from another origin, nothing can be
    // sent to one (so a hole that did get past the escaper cannot exfiltrate the
    // page it is on), a form cannot post anywhere but here, `<base>` cannot
    // rewrite every relative link, and the page cannot be framed by anything.
    'content-security-policy':
      "default-src 'none'; style-src 'unsafe-inline'; script-src 'self' 'unsafe-inline'; " +
      "connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
}

/**
 * The two failures, rendered as pages.
 *
 * Through the layout rather than as a bare string, because a 404 with the nav on it
 * is a page somebody can leave, and because the footer's sentence about there being
 * no authentication is not less true on an error.
 */
function errorPage(status: number, title: string, what: string, next: string): string {
  return layout({
    surface: null,
    title,
    heading: title,
    body: html`${empty({ label: `${status}`, what, next })}`,
  });
}

/* ─── the request ─── */

async function handle(ctx: Ctx): Promise<Reply> {
  const { url, req } = ctx;

  // HEAD is served as GET with the body suppressed at the end. Browsers and
  // `curl -I` both send it, and a 404 for HEAD on a page that exists is a
  // confusing way to find out this server only speaks GET and POST.
  const method = req.method === 'HEAD' ? 'GET' : req.method;

  if (method !== 'GET' && method !== 'POST') {
    return {
      kind: 'html',
      status: 405,
      body: errorPage(
        405,
        'Not that method',
        `This server answers GET and POST, and this request was ${req.method}. There is no API ` +
          'here beyond the pages themselves.',
        'Open one of the four surfaces in the nav.',
      ),
    };
  }

  for (const route of ROUTES) {
    if (route.method !== method) continue;
    const params = match(route, url.pathname);
    if (params === null) continue;
    return route.handler({ ...ctx, params });
  }

  // A path that exists for the other method. Worth telling apart from a 404: on
  // this server it almost always means a write was reached for with a GET, which
  // is the one thing the route table is arranged to prevent.
  const otherMethod = ROUTES.some((r) => r.method !== method && match(r, url.pathname) !== null);
  if (otherMethod) {
    return {
      kind: 'html',
      status: 405,
      body: errorPage(
        405,
        'Not that method',
        `${url.pathname} exists, but not for ${method}. Approving and rejecting are POSTs and ` +
          'have no GET spelling: a GET that applies a write is one prefetch away from being made ' +
          'by something nobody clicked.',
        'Use the button on the approvals page.',
      ),
    };
  }

  return {
    kind: 'html',
    status: 404,
    body: errorPage(
      404,
      'No such page',
      `Nothing is served at ${url.pathname}.`,
      'The four surfaces are in the nav above: ask, approvals, runs, evals.',
    ),
  };
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/* ─── the server ─── */

const env = readEnv();
if ('error' in env) {
  // One sentence, not a stack trace. A missing variable is a line in a file, and
  // a stack trace into a module the reader has never opened suggests something is
  // broken instead. Exit 2 is the CLI's code for "the environment is wrong and
  // nothing was attempted", and the two agree on purpose.
  console.error(env.error);
  process.exit(2);
}

const { userId, port, bind } = env;

const server = createServer((req, res) => {
  const startedAt = Date.now();

  // Logged when the response ends rather than when it begins, so the line carries
  // the status and the duration. A log of arrivals tells you nothing about which
  // page is slow, and slow is what this UI is most likely to be — every surface is
  // a live query and one of them runs a model.
  res.on('finish', () => {
    console.log(
      `${req.method ?? '?'} ${req.url ?? '?'} ${res.statusCode} ${Date.now() - startedAt}ms`
    );
  });

  void (async () => {
    // A fixed base: nothing here uses the absolute form of a URL, and taking the
    // host from the request means a Host header decides what the page links to.
    const url = new URL(req.url ?? '/', 'http://localhost');

    try {
      let form = new URLSearchParams();

      if (req.method === 'POST') {
        if (!sameOrigin(req)) {
          sendHtml(
            res,
            403,
            errorPage(
              403,
              'Refused',
              'That POST came from another site. This UI has no authentication, so a form on any ' +
                'page in the world could otherwise aim an approval at this port and your own ' +
                'browser would send it. Nothing was changed.',
              'Open the approvals page here and use the button on it.',
            )
          );
          return;
        }

        const body = await readForm(req);
        if ('error' in body) {
          sendHtml(res, 415, errorPage(415, 'Refused', body.error, 'Use the form on the page.'));
          return;
        }
        form = body;
      }

      // Widened on purpose. The type says a handler returns a Reply; the cast is
      // what lets the next line check that it actually did, because the handlers
      // are written by four other files and a `return` left off a branch
      // typechecks as `undefined` inside a union somewhere upstream.
      const reply = (await handle({ req, res, url, userId, params: {}, form })) as Reply | undefined;

      if (reply === undefined || reply === null) {
        // A handler that returned nothing is a bug in this repository, not a bad
        // request, and it is named rather than left as a socket that never
        // answers.
        throw new Error(
          `The handler for ${req.method} ${url.pathname} returned nothing. A page returns a Reply, ` +
            "or { kind: 'handled' } if it wrote the response itself."
        );
      }

      if (reply.kind === 'handled') return;

      if (reply.kind === 'redirect') {
        // 303 by default: after a POST it tells the browser to follow with a GET,
        // so reload and back cannot re-submit the decision.
        res.writeHead(reply.status ?? 303, { location: reply.to, 'cache-control': 'no-store' });
        res.end();
        return;
      }

      if (req.method === 'HEAD') {
        // Same status and headers, no body — which is what HEAD means.
        res.writeHead(reply.status ?? 200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
        });
        res.end();
        return;
      }

      sendHtml(res, reply.status ?? 200, reply.body);
    } catch (err) {
      // The stack goes to the log; the message goes on the page. This is a local
      // tool with one user, and that user is the only person who can fix it —
      // hiding "could not read the proposals: …" behind a generic apology would
      // cost more than it protects.
      console.error(`[web] ${req.method} ${url.pathname} failed:`, err);

      if (res.headersSent) {
        // A streaming handler that failed halfway. There is no status left to set,
        // so the connection is ended rather than having a second response
        // appended to the first.
        res.end();
        return;
      }

      sendHtml(
        res,
        500,
        errorPage(
          500,
          'That failed',
          messageOf(err),
          'The full error, with its stack, is on this process’s stderr. Nothing on these ' +
            'pages changes a record except a form that says it does, so a failed read has ' +
            'changed nothing.',
        )
      );
    }
  })();
});

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(
      `Something is already listening on ${bind}:${port}. Set PORT to another port, or stop the ` +
        'other process — this one has not started.'
    );
    process.exit(2);
  }
  if (err.code === 'EADDRNOTAVAIL' || err.code === 'EACCES') {
    console.error(
      `Could not bind ${bind}:${port}: ${err.message}. WEB_BIND has to name an address on this ` +
        'machine, and a port below 1024 usually needs privileges this process should not have.'
    );
    process.exit(2);
  }
  throw err;
});

server.listen(port, bind, () => {
  const shown = bind.includes(':') ? `[${bind}]` : bind;
  console.log(`business-agent web — http://${shown}:${port}`);
  console.log(`  operator ${userId}`);
  if (isLoopback(bind)) {
    console.log('  no authentication, and none is needed: this listens on the loopback interface');
  } else {
    // Loud, because this is the whole of the access control and it has just been
    // turned off. The footer of every page says it too.
    console.warn(
      `  WARNING: WEB_BIND=${bind} — this is reachable from beyond this machine, it has no ` +
        'authentication, and its approvals page applies writes to the business.'
    );
  }
});

/* ─── shutdown ─── */

/**
 * Stop accepting, then release the pool.
 *
 * Both halves matter. Without `server.close()` an in-flight request is dropped
 * mid-response on a Ctrl-C, which looks like a crash. Without `close()` the pg
 * pool keeps a socket open, the event loop stays alive, and the process sits there
 * looking hung after saying it was shutting down — the same failure `src/cli.ts`
 * has a note about.
 *
 * The code is set rather than forced with `process.exit()`. Exiting while the pool
 * and the server are still closing their handles aborts the process on Windows
 * with `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` and replaces the
 * exit code with 127 — recorded at the bottom of `src/cli.ts`, and it applies here
 * for the same reason. A second signal is the escape hatch, because a first Ctrl-C
 * that appears to do nothing is worse than no handler at all.
 */
let stopping = false;
function shutdown(signal: string): void {
  if (stopping) {
    console.error(`${signal} again — exiting now`);
    process.exit(130);
  }
  stopping = true;
  console.log(`${signal} — finishing open requests, then closing the pool`);

  server.close(async () => {
    try {
      await close();
    } catch (err) {
      console.error('[web] the pool did not close cleanly:', messageOf(err));
    }
    process.exitCode = 0;
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
