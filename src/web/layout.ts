/**
 * The page shell, and the handful of render helpers every surface needs.
 *
 * Four surfaces — ask, approvals, runs, evals — and one shell around them, so
 * that a reader is never unsure which of the four they are looking at and never
 * has to wonder what this thing is allowed to do. The footer says both, on every
 * page, including the 404.
 *
 * ── What the shell is for beyond the nav ──
 *
 * This UI can approve writes and has no authentication, so the sentence saying so
 * belongs somewhere it cannot be missed and cannot be forgotten by a page author.
 * That means the shell, not a paragraph on one screen. And when `WEB_BIND` has
 * been pointed at something other than the loopback interface, the footer says
 * THAT too — a tool that is quietly reachable from the network while claiming to
 * be local is the failure this whole file's worth of caution is about.
 *
 * ── The helpers ──
 *
 * `def`, `meta`, `evidenceList` and `empty` are here rather than in each page
 * because four copies of a definition row is four places for the 11px label to
 * drift, and because two of them carry sentences that are part of the argument
 * this repository makes:
 *
 * `evidenceList` on an empty list says that nothing above rests on a record and
 * to treat it as a claim. That sentence is `src/cli.ts` verbatim. The two have to
 * agree — the same absence read two ways in two places is how a reader learns
 * that neither is careful.
 *
 * `empty` REQUIRES a sentence saying what would put something here. An empty
 * state that says only "nothing yet" is a dead end, and on an approvals desk it
 * is worse than that: "nothing is waiting" is a claim about the business, and a
 * page is only entitled to make it when the read succeeded.
 *
 * Everything a page interpolates goes through `escape.ts`. These helpers take
 * `unknown` for their values on purpose, so a page cannot be tempted to
 * `String(x)` its way around the escaper.
 */

import { html, safeUrl, unsafeHtml, type Html } from './escape';
import { STYLE } from './style';

/* ─── the four surfaces ─── */

export type Surface = 'ask' | 'approvals' | 'runs' | 'evals';

/**
 * The nav, in the order the argument is made: ask something, decide what it
 * proposed, read what happened, see what is measured. Exported so the server's
 * route table and the nav cannot disagree about a path.
 */
export const SURFACES: ReadonlyArray<{ id: Surface; href: string; label: string }> = [
  { id: 'ask', href: '/', label: 'ask' },
  { id: 'approvals', href: '/approvals', label: 'approvals' },
  { id: 'runs', href: '/runs', label: 'runs' },
  { id: 'evals', href: '/evals', label: 'evals' },
];

export interface PageOptions {
  /** The browser tab. `— business-agent` is appended here so no page repeats it. */
  title: string;
  /**
   * Which nav item is current, or null for a page that is none of them — an
   * error, or a run's own page reached from the list. A run detail passes 'runs',
   * because that is where the reader is.
   */
  surface: Surface | null;
  /** The h1. Defaults to `title`, because they are usually the same sentence and
   * two fields that differ by accident is worse than one. */
  heading?: string;
  /** One sentence under the heading, at reading size. */
  lede?: string | Html;
  body: Html;
  /** For a surface that is a column of figures. 46rem cuts the runs table. */
  wide?: boolean;
}

/**
 * The whole document, as a string ready for `res.end()`.
 *
 * Returns a string rather than `Html` deliberately: this is the end of the
 * pipeline, and a value that can still be interpolated into another page invites
 * exactly that.
 */
export function layout(opts: PageOptions): string {
  const heading = opts.heading ?? opts.title;

  const nav = SURFACES.map(
    (s) => html`<a href="${safeUrl(s.href)}"${
      // aria-current rather than a class, so what is styled and what is announced
      // are the same fact. `unsafeHtml` for the attribute itself, which is a
      // literal in this file with nothing interpolated into it.
      s.id === opts.surface ? unsafeHtml(' aria-current="page"', 'a literal attribute in layout.ts') : ''
    }>${s.label}</a>`
  );

  // The whole document goes through the same tagged template every page fragment
  // does, so there is exactly one way markup is built in this directory and the
  // two places that skip the escaper are both spelled `unsafeHtml` with a reason.
  return String(html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<!-- Local by default and never meant to be indexed. Here for the day somebody
     puts this behind a tunnel to show a colleague and forgets. -->
<meta name="robots" content="noindex, nofollow">
<title>${opts.title} — business-agent</title>
<style>${unsafeHtml(STYLE, 'a literal in style.ts, with nothing interpolated into it')}</style>
</head>
<body>
<div class="wrap${opts.wide === true ? ' is-wide' : ''}">
  <header class="masthead">
    <h1>${heading}</h1>
    ${opts.lede ? html`<p class="lede">${opts.lede}</p>` : ''}
    <nav class="nav" aria-label="surfaces">${nav}</nav>
  </header>
  <main>${opts.body}</main>
  ${footer()}
</div>
</body>
</html>
`);
}

/**
 * What this is, on every page.
 *
 * The sentence about authentication is not a disclaimer to be skimmed: the
 * approvals surface has buttons that apply writes to the business, and the only
 * thing standing between them and the network is which interface the process
 * bound to. So the footer reports what it actually bound to, and says the
 * uncomfortable version when that is not loopback.
 *
 * `WEB_BIND` is read here as well as in `server.ts`, and the duplication is
 * deliberate: a footer that read a constant would keep claiming loopback while
 * the server listened on 0.0.0.0, which is the one sentence on the page that must
 * not be able to be wrong. Only the variable name is shared, and the default is
 * described rather than repeated.
 */
function footer(): Html {
  const bind = process.env.WEB_BIND?.trim();
  const exposed = bind !== undefined && bind !== '' && !isLoopback(bind);

  return html`<footer class="foot">
    <p>
      A local tool for one operator. There is no authentication and none is
      pretended: anyone who can reach this port can approve a write to the
      business.
    </p>
    <p>
      It binds to 127.0.0.1 unless <code>WEB_BIND</code> says otherwise, which is
      the whole of the access control.
    </p>
    ${
      exposed
        ? html`<p class="seal">
            WEB_BIND is <code>${bind}</code>, so this is reachable from beyond this
            machine. Nothing here asks who you are.
          </p>`
        : ''
    }
    <p>
      The database is the record. Every figure on these pages is computed in SQL
      and every id is printable, so disagreeing with this UI is a query.
    </p>
  </footer>`;
}

/**
 * Whether an address means "this machine only".
 *
 * The whole of `127.0.0.0/8` rather than just `127.0.0.1`, plus the IPv6 and named
 * spellings, because all of those are things somebody actually types into
 * `WEB_BIND` — and a warning that fires on a loopback address is a warning that
 * gets ignored, which costs more than the one case it was aimed at. Anything else,
 * including `0.0.0.0` and any LAN address, is exposed, because it is.
 */
const isLoopback = (bind: string): boolean =>
  /^127\./.test(bind) || bind === '::1' || bind === '[::1]' || bind === 'localhost';

/* ─── definition rows ─── */

/**
 * One `label → value` row. The workhorse of every detail view: a proposal's row
 * and asserts lines, a run's stop reason, a suite's commit.
 *
 * `mono` for anything a person would copy or compare character by character — an
 * id, a tool name, a figure, a fragment of SQL.
 */
export function def(term: string, value: unknown, opts: { mono?: boolean } = {}): Html {
  return html`<div>
    <dt>${term}</dt>
    <dd>${opts.mono === true ? html`<span class="mono">${value}</span>` : value}</dd>
  </div>`;
}

/**
 * A block of them.
 *
 * Takes the rows rather than pairs so a page can pass a conditional row as
 * `condition ? def(…) : null` — which is how "only show the expiry when there is
 * one" is written without an if-statement in the middle of the markup.
 */
export function defs(rows: Array<Html | null | false | undefined>): Html {
  return html`<dl class="defs">${rows.filter(Boolean)}</dl>`;
}

/* ─── a metadata line ─── */

/**
 * The facts about the thing above, on one line, separated by a middot.
 *
 * Empty parts are dropped rather than rendered as an empty gap between two
 * separators — a run with no verdict would otherwise read as `answered · ·
 * 6,506 tokens`, which looks like a field that failed to load.
 */
export function meta(parts: Array<unknown>): Html {
  const kept = parts.filter((p) => p !== null && p !== undefined && p !== false && p !== '');
  if (kept.length === 0) return html``;

  const separator = unsafeHtml(' <span aria-hidden="true">·</span> ', 'a literal separator in layout.ts');
  return html`<p class="meta">${kept.flatMap((p, i) => (i === 0 ? [p] : [separator, p]))}</p>`;
}

/* ─── evidence ─── */

/**
 * The rows an answer rests on, with their ids.
 *
 * The id is the point. "Outstanding is $33,300" is worth nothing on its own; with
 * the invoice ids under it, disagreeing with the agent is a query rather than an
 * argument.
 *
 * `evidence` is read defensively because it arrives from a JSONB column. The
 * shape is written by the tools and nothing else, so it is right in practice —
 * but a renderer that throws on one malformed entry takes the whole page with it,
 * and the page is how anybody would find out that the entry is malformed.
 */
export function evidenceList(evidence: unknown): Html {
  const rows = Array.isArray(evidence) ? evidence : [];

  if (rows.length === 0) {
    // Said out loud rather than left as an empty heading, and in the same words
    // src/cli.ts uses. No evidence means nothing above is traceable to a row,
    // which is the one thing a reader most needs to know about it.
    return html`<p class="meta">none — nothing above rests on a record. Treat it as a claim.</p>`;
  }

  return html`<ul class="evidence">
    ${rows.map((row) => {
      const e = (row ?? {}) as { table?: unknown; id?: unknown; label?: unknown };
      const where = [e.table, e.label].filter((v) => typeof v === 'string' && v !== '').join('/');
      return html`<li>
        <span class="where">${where === '' ? '(an evidence row with no table or label)' : where}</span>
        <span class="id">${e.id}</span>
      </li>`;
    })}
  </ul>`;
}

/* ─── nothing here yet ─── */

/**
 * The empty state, which has to say what would put something here.
 *
 * `next` is required. An empty state that says only "nothing yet" leaves the
 * reader with no move, and on a surface that reports absence — an empty desk, a
 * history with no runs — it invites the wrong conclusion: that there is nothing
 * to decide, rather than that nobody has asked anything yet.
 */
export function empty(opts: { label?: string; what: string | Html; next: string | Html }): Html {
  return html`<div class="empty">
    <span class="label">${opts.label ?? 'nothing here yet'}</span>
    <p>${opts.what}</p>
    <p class="next">${opts.next}</p>
  </div>`;
}

/* ─── formatting ─── */

/**
 * An instant, in UTC, marked as such.
 *
 * UTC rather than the reader's zone, and labelled. Every DATE in this schema is a
 * UTC day (see `src/db.ts`), the container and the laptop are rarely in the same
 * zone, and two stamps compared across those two renderings disagree. The `Z` is
 * there so nobody reads 22:20 as their own evening.
 *
 * Accepts a string as well as a `Date`: TIMESTAMPTZ arrives as a `Date` from this
 * driver and DATE arrives as a string, and a formatter that assumed one throws on
 * the other.
 */
export function utcStamp(at: Date | string | null | undefined): string {
  const t = instant(at);
  if (t === null) return 'unknown';
  return `${new Date(t).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/**
 * How long ago, in words.
 *
 * The future branch is not padding: `created_at` is the DATABASE's `now()` and
 * this is the process's clock, so a container a few seconds behind makes a row
 * that was just written read as `-3s ago`. Better to say "in 3s" and look odd
 * than to print a negative age and look broken. (`src/cli.ts` has the same
 * branch, for the same reason.)
 */
export function ago(at: Date | string | null | undefined): string {
  const t = instant(at);
  if (t === null) return 'at an unknown time';
  const ms = Date.now() - t;
  return ms < 0 ? `in ${coarse(-ms)}` : `${coarse(ms)} ago`;
}

/** Time until an instant, or that it has passed. */
export function until(at: Date | string | null | undefined): string {
  const t = instant(at);
  if (t === null) return 'at an unknown time';
  const ms = t - Date.now();
  return ms <= 0 ? 'already expired' : `in ${coarse(ms)}`;
}

/**
 * How long something took.
 *
 * Precise where precision is the point and coarse where it is not: a tool call is
 * milliseconds, a run is seconds to one decimal, and anything past a minute is
 * minutes and seconds. `284ms` and `0.3s` are the same number, and only the first
 * is useful next to a query.
 */
export function duration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
  const seconds = Math.round(ms / 1_000);
  return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s`;
}

/** Coarse on purpose: nobody decides differently about a card because it is 4h12m
 * old rather than 4h. */
function coarse(ms: number): string {
  const seconds = Math.round(ms / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function instant(at: Date | string | null | undefined): number | null {
  if (at === null || at === undefined) return null;
  const t = new Date(at).getTime();
  return Number.isNaN(t) ? null : t;
}

/** Eight hex characters — 32 bits — is short enough to read and long enough that
 * two ids colliding is not a thing that happens on one operator's desk. The full
 * id is always somewhere on the page it links to. */
export const shortId = (id: unknown): string => (typeof id === 'string' ? id.slice(0, 8) : '');

/**
 * A figure with thousands separators, in a fixed locale.
 *
 * `en-US` rather than the default: the default is the container's locale, so the
 * same run would report `6,506` on a laptop and `6.506` in Docker, and a token
 * count that changes shape depending on where the page was rendered is not a
 * figure anybody can quote.
 */
export function figure(n: unknown): string {
  // Absent is not zero, and `Number(null)` is 0 — which would print a confident
  // "0 tokens" where the truth is that nothing was recorded. Percentiles over an
  // empty window arrive here as null for exactly that reason.
  if (n === null || n === undefined || n === '') return '—';
  const value = typeof n === 'number' ? n : Number(n);
  return Number.isFinite(value) ? value.toLocaleString('en-US') : '—';
}

/**
 * One line, flattened, and marked when it was cut.
 *
 * Flattened because a question or a tool result with newlines in it breaks every
 * alignment; marked because a truncated sentence read as the whole one is its own
 * kind of wrong report.
 */
export function clip(text: unknown, max = 140): string {
  const flat = (typeof text === 'string' ? text : String(text ?? '')).replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
