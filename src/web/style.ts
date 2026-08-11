/**
 * The design system, as one string.
 *
 * Hand-written CSS, inlined into every page by `layout.ts`. No framework and no
 * build step, for the same reason the provider adapter posts with `fetch` instead
 * of loading an SDK: the dependency list stays honest, and the code reads as
 * documentation of what it actually does. A stylesheet this size is also cheaper
 * inlined than fetched — one request, no cache to invalidate, and no state where
 * the markup has arrived and the styling has not.
 *
 * ── Letterpress, not dashboard ──
 *
 * The private system this is extracted from calls its house style the quiet room:
 * warm paper, warm ink, hairline structure, and one seal-red accent that means
 * something. Ported here as tokens and about two hundred lines.
 *
 * The rules that keep it from drifting into a dashboard:
 *
 *   Structure is drawn with 1px hairlines and horizontal rules, never with a
 *   rounded card and a drop shadow. A shadow implies depth this page does not
 *   have, and a page of floating cards has no reading order.
 *
 *   Whitespace does the grouping. Where a dashboard would add a border to
 *   separate two things, this adds space.
 *
 *   Serif for headings, the system UI sans for body, monospace for anything a
 *   person would copy — an id, a uuid, a tool name, SQL, a figure.
 *
 *   ONE accent. `--seal` marks the things that need attention and nothing else: a
 *   refusal, a wall that was hit, a case that failed, a card waiting on a
 *   decision. There is deliberately no success colour. A green tick beside every
 *   answered run trains the eye to skip the colour, and then it is not there on
 *   the run where it mattered.
 *
 * ── Theme ──
 *
 * The light palette is defined on bare `:root` and the dark one overrides the same
 * tokens inside a media query. No colour is defined ONLY inside the query: a
 * value that exists in one theme and not the other is a page that renders
 * differently depending on a system setting nobody was thinking about.
 *
 * `color-scheme` is set so the browser's own furniture — form controls, the
 * scrollbar, the caret — follows the page instead of staying light under a dark
 * one.
 *
 * ── Motion ──
 *
 * There is almost none: a border and a text colour on hover. Everything that
 * moves at all is switched off under `prefers-reduced-motion`, which is at the
 * bottom of the file and has to keep listing anything added later.
 */

export const STYLE = `
/* ─── tokens ─── */

:root {
  color-scheme: light dark;

  /* Warm paper and warm ink. Not #fff on #000: a page that is going to be read
     for twenty minutes at a time should not be the brightest thing on the
     desk. */
  --paper: #faf8f4;
  --fg: #1c1b18;
  --muted: #6e6a61;
  --wash: #f1ebe1;
  --line: rgba(28, 27, 24, 0.12);
  --line-strong: rgba(28, 27, 24, 0.28);

  /* The seal. Darker on paper than in the dark theme, deliberately: the house
     red (#f03d5f) on a light background is about 3:1 against small text, which
     is not enough for the 11px labels this file uses it on. Same seal, two
     inks, so the accent still reads as one thing. */
  --seal: #c22643;
  --seal-wash: rgba(194, 38, 67, 0.08);

  --serif: ui-serif, Georgia, "Iowan Old Style", "Palatino Linotype", Palatino,
    "Times New Roman", serif;
  --sans: system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas,
    "Liberation Mono", monospace;
}

@media (prefers-color-scheme: dark) {
  :root {
    --paper: #1c1b18;
    --fg: #faf8f4;
    --muted: #a5a099;
    --wash: #23211d;
    --line: rgba(250, 248, 244, 0.14);
    --line-strong: rgba(250, 248, 244, 0.3);
    --seal: #f4708a;
    --seal-wash: rgba(240, 61, 95, 0.14);
  }
}

/* ─── the page ─── */

*, *::before, *::after { box-sizing: border-box; }

html { -webkit-text-size-adjust: 100%; }

body {
  margin: 0;
  /* Painted explicitly. A transparent body borrows whatever is behind it, and
     what is behind it is a browser default that does not match either theme. */
  background: var(--paper);
  color: var(--fg);
  font-family: var(--sans);
  font-size: 15px;
  line-height: 1.65;
  /* Never a horizontal scrollbar on the page itself. Anything wider than the
     column — a table, a trace line, a block of SQL — scrolls inside its own
     .scroll box. */
  overflow-x: hidden;
}

.wrap {
  max-width: 46rem;
  margin: 0 auto;
  padding: 2.5rem 1.5rem 4rem;
}

/* A wide surface asks for it. The runs table and the eval matrix are columns of
   figures, and 46rem cuts them. */
.wrap.is-wide { max-width: 68rem; }

/* ─── type ─── */

h1, h2, h3 {
  font-family: var(--serif);
  font-weight: 400;
  letter-spacing: -0.01em;
  margin: 0;
}

h1 { font-size: 1.9rem; line-height: 1.2; }
h2 { font-size: 1.3rem; margin-top: 2.5rem; }
h3 { font-size: 1.05rem; margin-top: 1.75rem; }

p { margin: 0 0 1rem; }
p:last-child { margin-bottom: 0; }

/* The 11px uppercase label. Every metadata heading in this UI is one of these,
   and the wide tracking is what stops it reading as shouted small text. */
.label {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.14em;
  color: var(--muted);
  font-weight: 500;
}

/* One line of facts about the thing above it. */
.meta { font-size: 12.5px; color: var(--muted); }
.meta a { color: inherit; }

/* A sentence under a heading, at reading size. */
.lede { font-size: 1rem; color: var(--muted); max-width: 34rem; }

.seal { color: var(--seal); }
.quiet { color: var(--muted); }

a { color: var(--fg); text-decoration: underline; text-decoration-color: var(--line-strong); text-underline-offset: 0.22em; }
a:hover { text-decoration-color: currentColor; }

/* Anything a person might copy, or compare character by character. */
code, .mono, .id, kbd {
  font-family: var(--mono);
  font-size: 0.88em;
  /* Figures line up in a column even when they are not in a table. */
  font-variant-numeric: tabular-nums;
}
.id { color: var(--muted); }
.num { font-family: var(--mono); font-variant-numeric: tabular-nums; }

pre {
  font-family: var(--mono);
  font-size: 12.5px;
  line-height: 1.6;
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
}

/* ─── structure ─── */

hr, .rule {
  border: 0;
  border-top: 1px solid var(--line);
  margin: 2rem 0;
  height: 0;
}

/* A block set off by a hairline. Square corners, no shadow: this is a ruled box
   on a page, not a card floating above one. */
.panel {
  border: 1px solid var(--line);
  padding: 1.25rem 1.25rem;
  margin: 1.25rem 0;
}

/* A list of things, separated by rules rather than boxed individually. */
.rows { list-style: none; margin: 0; padding: 0; }
.rows > li { padding: 1.1rem 0; border-top: 1px solid var(--line); }
.rows > li:first-child { border-top: 0; }

/* ─── the masthead and the four surfaces ─── */

.masthead { padding-bottom: 1.25rem; border-bottom: 1px solid var(--line); margin-bottom: 2rem; }
.masthead h1 { font-size: 1.35rem; }
.masthead .meta { margin-top: 0.35rem; }

.nav { display: flex; flex-wrap: wrap; gap: 1.5rem; margin-top: 1.1rem; }
.nav a {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.14em;
  color: var(--muted);
  text-decoration: none;
  padding-bottom: 0.35rem;
  border-bottom: 1px solid transparent;
}
.nav a:hover { color: var(--fg); }
/* The current surface is marked with aria-current, so the styling and the thing
   a screen reader announces cannot disagree. */
.nav a[aria-current="page"] { color: var(--fg); border-bottom-color: var(--fg); }

.foot {
  margin-top: 4rem;
  padding-top: 1.25rem;
  border-top: 1px solid var(--line);
  font-size: 12px;
  color: var(--muted);
}
.foot p { margin: 0 0 0.4rem; }

/* ─── definition rows: label on the left, value on the right ─── */

.defs { margin: 0; }
.defs > div {
  display: grid;
  grid-template-columns: 9.5rem 1fr;
  gap: 0.75rem;
  padding: 0.45rem 0;
  border-top: 1px solid var(--line);
}
.defs > div:first-child { border-top: 0; }
.defs dt {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.14em;
  color: var(--muted);
  padding-top: 0.2rem;
}
.defs dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }

@media (max-width: 34rem) {
  /* The two-column grid stops being a grid before it starts truncating values. */
  .defs > div { grid-template-columns: 1fr; gap: 0.15rem; }
}

/* ─── evidence: the rows an answer rests on ─── */

.evidence { list-style: none; margin: 0; padding: 0; }
.evidence li {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
  align-items: baseline;
  padding: 0.3rem 0;
  font-size: 13px;
}
.evidence .where { font-family: var(--mono); font-size: 12.5px; }
.evidence .id { font-size: 11.5px; }

/* ─── saying what has not happened ─── */

/* A block whose whole job is to state what did NOT happen: nothing has been
   changed, no evidence was returned, the run stopped at a wall. Marked with the
   seal down its left edge rather than filled, so it reads as a note in the
   margin and not as an error banner. */
.notice {
  border-left: 2px solid var(--line-strong);
  padding: 0.15rem 0 0.15rem 1rem;
  margin: 1.25rem 0;
}
.notice.is-seal { border-left-color: var(--seal); background: var(--seal-wash); padding-right: 1rem; }
.notice .label { display: block; margin-bottom: 0.3rem; }
.notice.is-seal .label { color: var(--seal); }

/* An outcome as one word, in line with prose. */
.badge {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.12em;
  border: 1px solid var(--line-strong);
  padding: 0.1rem 0.4rem;
  white-space: nowrap;
}
.badge.is-seal { border-color: var(--seal); color: var(--seal); }

/* ─── nothing here yet ─── */

.empty {
  border: 1px solid var(--line);
  padding: 1.5rem;
  margin: 1.25rem 0;
  color: var(--muted);
}
.empty .label { display: block; margin-bottom: 0.5rem; }
/* The sentence that says what would put something here. It is the point of the
   whole block, so it is not the small print. */
.empty .next { color: var(--fg); font-size: 14px; }

/* ─── figures ─── */

.stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(7.5rem, 1fr));
  gap: 1.25rem 1.5rem;
  margin: 1.5rem 0;
}
.stat .label { display: block; }
.stat b {
  display: block;
  font-family: var(--serif);
  font-weight: 400;
  font-size: 1.5rem;
  font-variant-numeric: tabular-nums;
  line-height: 1.3;
}
.stat.is-seal b { color: var(--seal); }
.stat .of { font-size: 12px; color: var(--muted); }

/* ─── tables ─── */

/* Every table lives inside one of these. A table wider than the column scrolls
   itself rather than making the page scroll. */
.scroll { overflow-x: auto; margin: 1.25rem 0; }

table { border-collapse: collapse; width: 100%; font-size: 13.5px; }
th, td { text-align: left; padding: 0.55rem 0.85rem 0.55rem 0; border-bottom: 1px solid var(--line); vertical-align: baseline; }
th {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.14em;
  color: var(--muted);
  font-weight: 500;
  white-space: nowrap;
}
td.num, th.num { text-align: right; font-family: var(--mono); font-variant-numeric: tabular-nums; padding-right: 0; }
tbody tr:last-child td { border-bottom: 0; }

/* ─── the trace ─── */

.trace { list-style: none; margin: 0; padding: 0; font-size: 13px; }
.trace > li { padding: 0.5rem 0; border-top: 1px solid var(--line); }
.trace > li:first-child { border-top: 0; }
.trace .head { display: flex; flex-wrap: wrap; gap: 0.65rem; align-items: baseline; }
.trace .n { font-family: var(--mono); color: var(--muted); font-size: 12px; }
.trace .failed { color: var(--seal); }
.trace pre { color: var(--muted); margin-top: 0.35rem; }

/* Per-step timing, as a rule the length of the step. The page sets --w to a
   percentage it has clamped itself; a bar is a figure drawn, so nothing here
   should be able to overflow the row. */
.bar { display: block; height: 2px; background: var(--line); margin-top: 0.4rem; overflow: hidden; }
/* Offset as well as width, so the bars form a timeline: two starting at the same
   place were tool calls the loop made together, and a gap is the harness between
   rounds. margin-left rather than absolute positioning — both percentages resolve
   against the same track, and one box needs no positioning context. */
.bar > i {
  display: block;
  height: 2px;
  background: var(--muted);
  margin-left: var(--l, 0%);
  width: var(--w, 0%);
}
.bar.is-seal > i { background: var(--seal); }

/* Where the agent's narration is shown as it happens. */
.stream {
  font-family: var(--mono);
  font-size: 12.5px;
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 22rem;
  overflow-y: auto;
  border: 1px solid var(--line);
  padding: 0.85rem 1rem;
  margin: 1.25rem 0;
  color: var(--muted);
}

/* ─── forms ─── */

.field { margin: 1.25rem 0; }
.field label { display: block; margin-bottom: 0.45rem; }

textarea, input[type="text"], input[type="search"] {
  width: 100%;
  font: inherit;
  color: var(--fg);
  background: var(--paper);
  border: 1px solid var(--line-strong);
  border-radius: 0;
  padding: 0.6rem 0.7rem;
}
textarea { resize: vertical; min-height: 5.5rem; line-height: 1.6; }

.actions { display: flex; flex-wrap: wrap; gap: 0.75rem; align-items: center; margin-top: 0.75rem; }
/* Approve and reject are separate forms, side by side. Inline so two POSTs do
   not become two paragraphs. */
.actions form { margin: 0; display: inline; }

.btn {
  font: inherit;
  font-size: 13px;
  color: var(--fg);
  background: var(--paper);
  border: 1px solid var(--line-strong);
  border-radius: 0;
  padding: 0.4rem 0.9rem;
  cursor: pointer;
  text-decoration: none;
  display: inline-block;
}
.btn:hover { border-color: var(--fg); }
.btn:disabled { color: var(--muted); border-color: var(--line); cursor: not-allowed; }
/* The seal on a button means the button acts on the business. Used on approve,
   and on nothing that only reads. */
.btn.is-seal { border-color: var(--seal); color: var(--seal); }
.btn.is-seal:hover { background: var(--seal-wash); }
.btn.is-quiet { border-color: transparent; color: var(--muted); padding-left: 0; padding-right: 0; text-decoration: underline; text-decoration-color: var(--line-strong); }
.btn.is-quiet:hover { color: var(--fg); border-color: transparent; }

/* Visible, and in the accent, because a keyboard user landing on the approve
   button needs to know that is where they are. */
:focus-visible { outline: 2px solid var(--seal); outline-offset: 2px; }

/* For a label a screen reader needs and the page already says in its layout. */
.sr-only {
  position: absolute;
  width: 1px; height: 1px;
  padding: 0; margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

/* ─── motion, and switching it off ─── */

a, .btn, .nav a { transition: color 120ms ease, border-color 120ms ease, background-color 120ms ease, text-decoration-color 120ms ease; }

@media (prefers-reduced-motion: reduce) {
  /* The wildcard rather than a list, because a list is a thing to keep in step
     with everything added later, and it is always one rule behind. */
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}

/* ─── motion ───────────────────────────────────────────────────────────────
   Ported from the private OS, curves and durations unchanged, because the two
   easings are used for different classes of movement and swapping them makes
   both look wrong.

   --ease-enter is for something arriving from nothing, over a long duration:
   it decelerates hard and settles, so a large movement does not read as a
   slide. --ease-step is the sheet curve, used for short movements of something
   already on screen — a step appearing, a size changing.

   What is deliberately NOT ported: the view-stack height transition. It exists
   there because a panel eases between two child views' natural heights, and
   this is server-rendered with full page loads — there is no stack and no
   measured height, so bringing the class across would be a name with nothing
   behind it. Every rule below is attached to something on these four pages. */

:root {
  --ease-enter: cubic-bezier(0.16, 1, 0.3, 1);
  --ease-step: cubic-bezier(0.32, 0.72, 0, 1);
}

/* A step entering the stream as the run produces it. It comes in from the side
   it came from, so the direction of travel is legible without a progress bar.
   Short, because the reader is mid-task and not watching a show. */
@keyframes ff-step-in {
  from { opacity: 0; transform: translateX(10px); }
  to   { opacity: 1; transform: translateX(0); }
}

.ff-step {
  animation: ff-step-in 190ms var(--ease-step) both;
}

/* A row that has just been written settles from a wash back to paper, so the
   eye can find what it just made without anything blinking. Used on the outcome
   of an approval and on a verdict that was just recorded. */
@keyframes ff-settle {
  from { background-color: var(--wash); }
  to   { background-color: transparent; }
}

.ff-settle {
  animation: ff-settle 900ms var(--ease-step) both;
}

/* In flight, and not yet touchable: a run that is still streaming has no id, so
   a click would open a record that does not exist. Faded enough to read as
   unfinished, legible enough to read. */
.ff-pending {
  opacity: 0.7;
  pointer-events: none;
}

/* The soft edge over a scrolling body — the stream, and a long trace output.
   Not a hairline: a hairline says "a new section starts here", which is a lie
   when the truth is "there is more of this one below". */
.ff-scroll {
  position: relative;
}

.ff-scroll::after {
  content: "";
  pointer-events: none;
  position: absolute;
  inset-inline: 1px;
  bottom: 1px;
  height: 2rem;
  background: linear-gradient(to top, var(--paper), transparent);
  transition: opacity 200ms ease;
}

/* Scrolled to the end: there is nothing more below, so the promise of more is
   withdrawn. Set by the small amount of script the stream already runs. */
.ff-scroll[data-end="1"]::after {
  opacity: 0;
}

/* One curve for the things that merely acknowledge a press. */
.btn, nav a, .trace summary {
  transition: background-color 160ms var(--ease-step), color 160ms var(--ease-step),
    border-color 160ms var(--ease-step);
}

/* The bar grows to its measured length once, on arrival. The delay is per-step
   and set inline, so a six-step trace draws itself left to right in the order it
   happened rather than all at once — the shape of the run, at the speed it can
   be read. */
@keyframes ff-bar-draw {
  from { transform: scaleX(0); }
  to   { transform: scaleX(1); }
}

.bar > i {
  transform-origin: left center;
  animation: ff-bar-draw 420ms var(--ease-enter) var(--bd, 0ms) both;
}

@media (prefers-reduced-motion: reduce) {
  .ff-step,
  .ff-settle,
  .bar > i,
  .ff-scroll::after,
  .btn,
  nav a,
  .trace summary {
    animation: none;
    transition: none;
  }
  /* The end state, not the start one: with animation off, an animation-fill of
     both would otherwise leave a bar at scaleX(0) and a step invisible. */
  .ff-step { opacity: 1; transform: none; }
  .bar > i { transform: none; }
}
`;
