/**
 * Escaping, alone in its own file so it cannot be forgotten.
 *
 * The pages in this directory are HTML built out of template strings. There is no
 * framework doing this for you: nothing between a value and the markup except the
 * function below, and a single interpolation that skips it is a cross-site
 * scripting hole in a tool that can approve writes.
 *
 * This is not hypothetical, and it is worth naming what actually flows into these
 * pages. Client names, contact names and invoice notes come from the business
 * tables. A proposal's `summary` and a run's `answer` were written by a language
 * model that had just read that database — so a client called
 * `<script>fetch('/approvals/…/approve',{method:'POST'})</script>` is a name the
 * model will faithfully quote back into a card, on a page whose buttons apply
 * writes. Tool arguments in a trace are strings the model invented outright. None
 * of it is trusted input, and none of it is separable from the parts that are.
 *
 * So: the escaper is the default, and the way around it is loud.
 *
 * ── What escaping does not do ──
 *
 * Escaping makes text safe as TEXT. It does not make a value safe in every place
 * a value can go, and the two mistakes that survive it are both in here:
 *
 * A `javascript:` url is untouched by escaping — `javascript&#58;` is not a thing,
 * because there is nothing to escape. Escape it into an `href` and it still runs
 * when clicked. That is what `safeUrl` is for.
 *
 * A `<script>` element does not decode HTML entities, so escaping a value into one
 * changes nothing about it, and `</script>` inside a string ends the element
 * whatever the quotes say. That is what `scriptJson` is for.
 *
 * ── Attributes ──
 *
 * `"` and `'` are both escaped, so an escaped value is safe inside either kind of
 * quoted attribute. An UNQUOTED attribute is not made safe by any of this — a
 * value with a space in it becomes two attributes — so every attribute in this
 * directory is quoted, and there is no helper that would let one not be.
 */

/**
 * The five characters, and why each one.
 *
 * `&` must be first, which is why this is one pass over a character class rather
 * than five chained `replace` calls: escaping `<` to `&lt;` and then escaping `&`
 * turns it into `&amp;lt;`, and the page shows the entity instead of the text.
 *
 * `'` becomes the numeric reference and not `&apos;`, which is not defined in
 * HTML 4 and is therefore not something every consumer of this markup has to
 * agree about.
 */
const ESCAPED: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

const NEEDS_ESCAPE = /[&<>"']/g;

/**
 * A value as text that cannot become markup.
 *
 * Takes `unknown` on purpose. What arrives here comes out of JSONB columns, model
 * output and query strings, and a signature demanding `string` would only mean
 * every caller writing `String(x)` first — which is the same coercion, done
 * somewhere that cannot see the null.
 *
 * `null` and `undefined` render as nothing rather than as "null". A page that
 * wants a word for an absent value chooses its own — the CLI says `unset` on a
 * card — and printing "null" or "undefined" into prose is how a UI ends up
 * reporting a missing field as a value.
 */
export function escapeHtml(value: unknown): string {
  if (value === null || value === undefined) return '';

  let text: string;
  try {
    // `String(value)`, never `` `${value}` ``. They differ on a symbol: the
    // explicit conversion is allowed and gives "Symbol(x)", the template literal
    // throws. Neither belongs on a page, but one of them takes the page with it.
    text = typeof value === 'string' ? value : String(value);
  } catch {
    // An object whose `toString` throws. It should not reach a page, and a page
    // that renders a placeholder is better than one that 500s over a field nobody
    // was reading.
    return '(unprintable value)';
  }

  // The common case — most values contain none of the five — walks the string
  // once and allocates nothing.
  return text.replace(NEEDS_ESCAPE, (c) => ESCAPED[c] ?? c);
}

/* ─── markup that is already markup ─── */

/**
 * Markup that has been through the escaper, or that never needed to be.
 *
 * A distinct type rather than a string, because that is the whole mechanism: the
 * `html` tagged template escapes every interpolated value EXCEPT one of these, so
 * fragments compose without being escaped twice, and a plain string can never be
 * mistaken for safe markup. Escaping twice is not a security failure — it is a
 * page that displays `&lt;em&gt;` — but it is the bug that makes people reach for
 * the opt-out.
 *
 * The class is deliberately not exported. The only ways to obtain one are `html`,
 * which escapes, and `unsafeHtml`, which says what it is in its name. An exported
 * constructor would be a third way, spelled like neither.
 */
class SafeMarkup {
  constructor(readonly markup: string) {}
  /** So a finished page can be handed to `res.end()` or put in an ordinary
   * template literal without every call site reaching for a field. */
  toString(): string {
    return this.markup;
  }
}

/** Markup that is safe to write into a page. Obtained from `html` or, with a
 * stated reason, from `unsafeHtml`. */
export type Html = SafeMarkup;

export const isHtml = (value: unknown): value is Html => value instanceof SafeMarkup;

/**
 * One interpolated value, as markup.
 *
 * Three cases beyond "escape it", and each one exists because the alternative
 * shows up on the page:
 *
 * An `Html` passes through. That is what makes fragments compose.
 *
 * An array is rendered item by item and joined with nothing. `${rows.map(row)}`
 * is how every list in this directory is written, and the default `Array.toString`
 * would join with commas — a comma between every table row, which reads as a
 * rendering bug rather than as a missing helper.
 *
 * `null`, `undefined` and `false` render as nothing. `${pending && html`…`}` is
 * the ordinary way to write a conditional fragment and it evaluates to `false`
 * when the condition fails; the word "false" printed in a page looks like a
 * decision somebody made. `0` is NOT in that list and renders as `0`: it is a
 * figure, and "0 changes are waiting" needs its zero. Which means `${count &&
 * html`…`}` renders a bare `0` when the count is zero — write the ternary.
 */
function interpolate(value: unknown): string {
  if (isHtml(value)) return value.markup;
  if (value === null || value === undefined || value === false) return '';
  if (Array.isArray(value)) return value.map(interpolate).join('');
  return escapeHtml(value);
}

/**
 * The tagged template. Literal parts are kept as written; every interpolation is
 * escaped.
 *
 *   html`<p class="meta">${client.name}</p>`
 *
 * The literal parts are the markup a person typed in this repository, so they are
 * left alone — escaping them would print the tags. The values are everything else.
 */
export function html(strings: TemplateStringsArray, ...values: unknown[]): Html {
  // Built by index rather than by zipping, because `strings` always has exactly
  // one more element than `values` and relying on that explicitly is clearer than
  // a reduce that happens to be correct.
  let out = strings[0] ?? '';
  for (let i = 0; i < values.length; i += 1) {
    out += interpolate(values[i]) + (strings[i + 1] ?? '');
  }
  return new SafeMarkup(out);
}

/**
 * The opt-out, and it is named for what it is.
 *
 * `why` is required, and is not decoration. Every use of this is a claim that a
 * string is safe markup, and the claim has to be checkable by whoever reads the
 * line — `unsafeHtml(STYLE, 'a literal in style.ts, no interpolation')` says the
 * thing a reviewer needs to know. Grepping this file's name lists every place the
 * escaper was skipped, each with its own justification next to it.
 *
 * Throws on anything but a string, and on an empty reason. A page that fails to
 * render is a bug found the first time it is opened; markup assembled out of
 * `undefined` is a bug found by whoever reads the page and believes it.
 */
export function unsafeHtml(markup: string, why: string): Html {
  if (typeof markup !== 'string') {
    throw new TypeError(
      `unsafeHtml was given ${typeof markup}, not a string. It is the one way past the escaper, ` +
        'so it refuses to coerce: an "undefined" spliced into a page is markup nobody wrote.'
    );
  }
  if (typeof why !== 'string' || why.trim() === '') {
    throw new TypeError(
      'unsafeHtml needs a reason as its second argument, saying why this markup is safe without ' +
        'escaping. The reason is how the next reader checks the claim rather than trusting it.'
    );
  }
  return new SafeMarkup(markup);
}

/* ─── the two places escaping is not enough ─── */

/**
 * A url that cannot execute.
 *
 * Escaping does nothing to `javascript:alert(1)` — there is no character in it to
 * escape — so a link built from a value has to be checked rather than escaped.
 * Everything this UI links to is its own page or its own asset, so the rule is a
 * whitelist of shapes rather than a search for dangerous ones:
 *
 *   a root-relative path (`/runs/…`, `/approvals?only=walled`),
 *   a fragment (`#trace`),
 *   nothing else.
 *
 * A refused url becomes `#`, which is a link that goes nowhere, because the
 * alternative — dropping the attribute — produces text that looks like a link and
 * is not one. `//host/path` is refused too: it is a protocol-relative URL to
 * another origin, and it reads like a path.
 *
 * Returns a string rather than `Html` because it is an attribute VALUE, and it is
 * still escaped on the way in — a path could contain a quote.
 */
export function safeUrl(value: unknown): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (raw.startsWith('#')) return escapeHtml(raw);
  // A single leading slash, and the second character must not be another slash or
  // a backslash: browsers treat `/\evil.example` as protocol-relative too.
  if (/^\/(?![/\\])/.test(raw)) return escapeHtml(raw);
  return '#';
}

/**
 * A value as a JSON literal that is safe inside a `<script>` element.
 *
 * A script element is not HTML text. Entities are not decoded inside it, so
 * `escapeHtml` changes nothing that matters, and the parser looks for the literal
 * characters `</script` regardless of what quotes it appears inside — so a
 * question containing `</script>` ends the element and everything after it is
 * markup the page did not write.
 *
 * `<` is therefore escaped as a unicode string escape, which is valid JSON and
 * valid JavaScript and never reaches the HTML parser as a `<`. U+2028 and U+2029
 * are escaped for a different reason: they are legal in JSON strings and are line
 * terminators in JavaScript, so an unescaped one is a syntax error in the middle
 * of the page's script.
 *
 * This is the only sanctioned way to get data from the server into the small
 * amount of vanilla JS these pages use.
 */
export function scriptJson(value: unknown): Html {
  const json = (JSON.stringify(value ?? null) ?? 'null')
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  return unsafeHtml(json, 'JSON with every character the HTML parser or JS lexer could act on escaped');
}
