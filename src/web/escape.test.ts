/**
 * The escaper, against the strings it exists for.
 *
 * This file is short and it is the most load-bearing test in `src/web`. Every
 * other test in this repository asserts that something works; these assert that
 * something cannot happen. A page built out of template strings has exactly one
 * defence, and a regression in it is invisible — the page still renders, the
 * markup still looks right, and the hole is only found by whoever finds it.
 *
 * The values below are not invented. A client name, a proposal summary and a run's
 * answer all reach the markup, and the summary was written by a model that had
 * just read the client name out of the database. So the fixtures are what a
 * hostile row in `clients` looks like once the agent has quoted it back.
 */

import { describe, it, expect } from 'vitest';
import { escapeHtml, html, isHtml, safeUrl, scriptJson, unsafeHtml } from './escape';

describe('escapeHtml', () => {
  it('escapes all five characters', () => {
    expect(escapeHtml('&')).toBe('&amp;');
    expect(escapeHtml('<')).toBe('&lt;');
    expect(escapeHtml('>')).toBe('&gt;');
    expect(escapeHtml('"')).toBe('&quot;');
    expect(escapeHtml("'")).toBe('&#39;');
    expect(escapeHtml(`& < > " '`)).toBe('&amp; &lt; &gt; &quot; &#39;');
  });

  it('escapes the ampersand first, so an entity is not double-escaped', () => {
    // The failure this catches: five chained replaces with `&` last turn `<` into
    // `&amp;lt;`, and the page prints the entity instead of the character.
    expect(escapeHtml('<b>')).toBe('&lt;b&gt;');
    expect(escapeHtml('&lt;')).toBe('&amp;lt;');
    expect(escapeHtml('&amp;')).toBe('&amp;amp;');
  });

  it('neutralises a script tag', () => {
    const name = '<script>fetch("/approvals/1/approve",{method:"POST"})</script>';
    const escaped = escapeHtml(name);
    expect(escaped).not.toContain('<');
    expect(escaped).not.toContain('>');
    expect(escaped).toContain('&lt;script&gt;');
    // The text survives, which is the other half of the requirement: a client
    // really called that has to be readable on the page, not silently blanked.
    expect(escaped).toContain('fetch(&quot;/approvals/1/approve&quot;');
  });

  it('closes an attribute nobody opened', () => {
    // `<a title="…">` with an unescaped quote in it becomes a tag with an
    // onmouseover attribute, and no `<` was ever needed.
    const escaped = escapeHtml('" onmouseover="alert(1)');
    expect(escaped).not.toContain('"');
    expect(escaped).toBe('&quot; onmouseover=&quot;alert(1)');
  });

  it('renders null and undefined as nothing, and zero as zero', () => {
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
    // The word "null" printed into prose reads as a value. A page that wants a
    // word for an absent thing picks its own.
    expect(escapeHtml(0)).toBe('0');
    expect(escapeHtml(false)).toBe('false');
  });

  it('does not throw on a value that cannot be stringified', () => {
    const hostile = {
      toString() {
        throw new Error('no');
      },
    };
    expect(escapeHtml(hostile)).toBe('(unprintable value)');
    // A symbol is the reason the conversion is `String(value)` and not a template
    // literal: `String(sym)` is explicitly allowed and returns "Symbol(x)", while
    // `` `${sym}` `` throws. So this renders rather than falling into the catch —
    // which is the better outcome, and it is asserted so that a "tidy-up" to a
    // template literal fails here instead of on a page.
    expect(escapeHtml(Symbol('x'))).toBe('Symbol(x)');
  });
});

describe('the html tagged template', () => {
  it('leaves the literal parts alone and escapes the interpolations', () => {
    const name = '<script>alert(1)</script>';
    const out = String(html`<p class="meta">${name}</p>`);
    // The markup the author typed survives verbatim…
    expect(out.startsWith('<p class="meta">')).toBe(true);
    expect(out.endsWith('</p>')).toBe(true);
    // …and the value cannot add to it.
    expect(out).toBe('<p class="meta">&lt;script&gt;alert(1)&lt;/script&gt;</p>');
  });

  it('escapes every interpolation, not only the first', () => {
    // A loop that escapes `values[0]` and appends the rest raw passes a
    // single-value test and fails every real page.
    const out = String(html`<i>${'<a>'}</i><i>${'<b>'}</i><i>${'<c>'}</i>`);
    expect(out).toBe('<i>&lt;a&gt;</i><i>&lt;b&gt;</i><i>&lt;c&gt;</i>');
  });

  it('composes fragments without escaping them twice', () => {
    const row = html`<td>${'a & b'}</td>`;
    const out = String(html`<tr>${row}</tr>`);
    expect(out).toBe('<tr><td>a &amp; b</td></tr>');
    // Not `&amp;amp;` — a double escape is not a hole, but it is what makes
    // somebody reach for the opt-out.
    expect(out).not.toContain('amp;amp;');
  });

  it('joins an array with nothing, and escapes each item', () => {
    const names = ['<a>', '<b>'];
    expect(String(html`<ul>${names.map((n) => html`<li>${n}</li>`)}</ul>`)).toBe(
      '<ul><li>&lt;a&gt;</li><li>&lt;b&gt;</li></ul>'
    );
    // A plain array of strings is escaped item by item too, and NOT joined with
    // the comma that Array.toString would put there.
    expect(String(html`<p>${names}</p>`)).toBe('<p>&lt;a&gt;&lt;b&gt;</p>');
  });

  it('renders nothing for null, undefined and false', () => {
    const pending = false;
    expect(String(html`<p>${null}${undefined}${pending && html`<b>x</b>`}</p>`)).toBe('<p></p>');
    // Zero is a figure and prints. Which is why a conditional is written as a
    // ternary rather than with `&&` — see the note in escape.ts.
    expect(String(html`<p>${0}</p>`)).toBe('<p>0</p>');
  });

  it('returns Html, so the type marks what has been escaped', () => {
    const out = html`<p>x</p>`;
    expect(isHtml(out)).toBe(true);
    expect(isHtml('<p>x</p>')).toBe(false);
    expect(isHtml(null)).toBe(false);
  });
});

describe('unsafeHtml', () => {
  it('passes markup through untouched', () => {
    const out = html`<style>${unsafeHtml('a > b { color: red }', 'a literal in a test')}</style>`;
    expect(String(out)).toBe('<style>a > b { color: red }</style>');
  });

  it('demands a reason, and refuses a non-string', () => {
    // The reason is what a reviewer reads instead of trusting the call.
    expect(() => unsafeHtml('<b>', '')).toThrow(/reason/);
    // @ts-expect-error — the point of the test is the runtime refusal.
    expect(() => unsafeHtml(undefined, 'because')).toThrow(/not a string/);
  });
});

describe('safeUrl', () => {
  it('refuses a javascript: url, which escaping does nothing to', () => {
    // The whole reason this function exists: there is no character in
    // `javascript:alert(1)` for the escaper to touch, so escaping it into an href
    // produces a link that runs when clicked.
    expect(escapeHtml('javascript:alert(1)')).toBe('javascript:alert(1)');
    expect(safeUrl('javascript:alert(1)')).toBe('#');
    expect(safeUrl('JavaScript:alert(1)')).toBe('#');
    expect(safeUrl(' javascript:alert(1)')).toBe('#');
    expect(safeUrl('data:text/html,<script>alert(1)</script>')).toBe('#');
    expect(safeUrl('vbscript:msgbox(1)')).toBe('#');
  });

  it('keeps the paths this UI actually links to', () => {
    expect(safeUrl('/')).toBe('/');
    expect(safeUrl('/runs')).toBe('/runs');
    expect(safeUrl('/runs?only=walled&limit=30')).toBe('/runs?only=walled&amp;limit=30');
    expect(safeUrl('#trace')).toBe('#trace');
  });

  it('refuses anything that could leave this origin', () => {
    expect(safeUrl('//evil.example/x')).toBe('#');
    // Browsers treat a slash-backslash pair as protocol-relative as well, and it
    // reads like a path.
    expect(safeUrl('/\\evil.example')).toBe('#');
    expect(safeUrl('https://evil.example')).toBe('#');
    expect(safeUrl('runs')).toBe('#');
    expect(safeUrl(null)).toBe('#');
  });

  it('escapes the path it returns, because it is an attribute value', () => {
    expect(safeUrl('/runs?q="x"')).toBe('/runs?q=&quot;x&quot;');
  });
});

describe('scriptJson', () => {
  it('cannot end the script element it sits in', () => {
    const question = 'how much is outstanding?</script><script>alert(1)</script>';
    const out = String(html`<script>const q = ${scriptJson(question)};</script>`);
    // One `</script` in the output, and it is the one the page wrote.
    expect(out.match(/<\/script/g)).toHaveLength(1);
    expect(out).toContain('\\u003c/script\\u003e');
  });

  it('stays valid JSON, so the script it lands in can read it', () => {
    const value = { question: 'a & b < c', ids: [1, 2] };
    const literal = String(scriptJson(value));
    expect(JSON.parse(literal)).toEqual(value);
  });

  it('escapes the two line separators that are legal in JSON and not in JS', () => {
    const literal = String(scriptJson('a\u2028b\u2029c'));
    expect(literal).not.toContain('\u2028');
    expect(literal).not.toContain('\u2029');
    expect(JSON.parse(literal)).toBe('a\u2028b\u2029c');
  });

  it('renders undefined as null rather than throwing', () => {
    // JSON.stringify(undefined) is undefined, and `.replace` on that is a
    // TypeError inside a page render.
    expect(String(scriptJson(undefined))).toBe('null');
    expect(String(scriptJson(() => {}))).toBe('null');
  });
});
