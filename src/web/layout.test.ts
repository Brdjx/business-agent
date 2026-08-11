/**
 * The shell and the shared helpers.
 *
 * Two kinds of assertion here, and they are here for different reasons.
 *
 * The escaping ones are the same argument as `escape.test.ts` made one layer down:
 * a helper that takes a value and returns markup is a second place the escaper can
 * be skipped, and `evidenceList` in particular reads a JSONB column, so its input
 * is a client name that came out of the business and a shape nothing validated.
 *
 * The others are about sentences. The footer's claim that there is no
 * authentication, and `evidenceList` saying that nothing above rests on a record,
 * are part of what this UI is for rather than decoration — and both are the kind of
 * line somebody removes while tidying up a layout. `evidenceList`'s wording is
 * `src/cli.ts`'s, verbatim, because the same absence read two ways in two places is
 * how a reader learns that neither is careful.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { html } from './escape';
import { ago, clip, def, defs, duration, empty, evidenceList, figure, layout, meta, utcStamp } from './layout';

const page = (over: Partial<Parameters<typeof layout>[0]> = {}): string =>
  layout({ surface: 'runs', title: 'Runs', body: html`<p>x</p>`, ...over });

/**
 * Just the nav.
 *
 * Counting `aria-current` across the whole document counts the stylesheet too —
 * `.nav a[aria-current="page"]` is a selector in style.ts, and the stylesheet is
 * inlined into every page. The first version of this test asserted one occurrence
 * and found two, which is the sort of thing that gets "fixed" by loosening the
 * assertion.
 */
const nav = (out: string): string => out.slice(out.indexOf('<nav'), out.indexOf('</nav>'));

afterEach(() => {
  delete process.env.WEB_BIND;
});

describe('the shell', () => {
  it('marks exactly one surface as current, with aria-current', () => {
    const out = nav(page({ surface: 'approvals' }));
    expect(out.match(/aria-current="page"/g)).toHaveLength(1);
    expect(out).toContain('<a href="/approvals" aria-current="page">approvals</a>');
    // The nav is the whole of the orientation on these pages, so all four are
    // always present.
    for (const label of ['ask', 'approvals', 'runs', 'evals']) expect(out).toContain(`>${label}</a>`);
  });

  it('marks nothing when the page is none of the four', () => {
    // A 404 is a page you can leave, so it keeps the nav — and it must not
    // pretend to be one of the surfaces.
    expect(nav(page({ surface: null }))).not.toContain('aria-current');
  });

  it('escapes the title and the heading', () => {
    const out = page({ title: '<script>alert(1)</script>', heading: '"><b>' });
    expect(out).not.toContain('<script>alert(1)');
    expect(out).toContain('<title>&lt;script&gt;alert(1)&lt;/script&gt; — business-agent</title>');
    expect(out).toContain('<h1>&quot;&gt;&lt;b&gt;</h1>');
  });

  it('says on every page that there is no authentication', () => {
    // Including the error pages. It is not less true on a 500, and this is the one
    // sentence a reader of a tool with approve buttons is owed.
    for (const surface of ['ask', 'approvals', 'runs', 'evals', null] as const) {
      expect(page({ surface })).toContain('no authentication');
    }
  });

  it('says out loud when WEB_BIND is not loopback', () => {
    process.env.WEB_BIND = '0.0.0.0';
    const exposed = page();
    // Not the whole sentence: the markup wraps, so a contiguous match would be
    // asserting where the line breaks in this file rather than what it says.
    expect(exposed).toContain('reachable from beyond');
    expect(exposed).toContain('<code>0.0.0.0</code>');
  });

  it('does not cry wolf about a loopback address', () => {
    // A warning that fires on 127.0.0.5 is a warning nobody reads by the time it
    // fires on 0.0.0.0.
    for (const bind of ['127.0.0.1', '127.0.0.2', 'localhost', '::1']) {
      process.env.WEB_BIND = bind;
      expect(page()).not.toContain('reachable from beyond');
    }
    delete process.env.WEB_BIND;
    expect(page()).not.toContain('reachable from beyond');
  });
});

describe('evidence', () => {
  it('says what an empty list means, in the words the CLI uses', () => {
    const out = String(evidenceList([]));
    expect(out).toContain('nothing above rests on a record');
    expect(out).toContain('Treat it as a claim');
  });

  it('prints table, label and the id, because the id is what makes it checkable', () => {
    const out = String(
      evidenceList([{ table: 'invoices', id: 'de9bcc24-a04f-456f-8a18-791097d91193', label: 'INV-1008' }])
    );
    expect(out).toContain('invoices/INV-1008');
    expect(out).toContain('de9bcc24-a04f-456f-8a18-791097d91193');
  });

  it('escapes a label that came out of the business', () => {
    const out = String(evidenceList([{ table: 'clients', id: 'x', label: '<script>alert(1)</script>' }]));
    expect(out).not.toContain('<script>');
    expect(out).toContain('&lt;script&gt;');
  });

  it('survives a shape the column should not hold', () => {
    // It is a JSONB column: the tools write the shape and nothing enforces it, and
    // a renderer that throws on one bad entry takes the page with it — the page
    // being the only way anybody would find out the entry is bad.
    const out = String(evidenceList([{ nonsense: true }, null, 'not an object']));
    expect(out).toContain('an evidence row with no table or label');
    expect(() => evidenceList('not an array')).not.toThrow();
    expect(String(evidenceList(null))).toContain('nothing above rests on a record');
  });
});

describe('the small helpers', () => {
  it('drops the parts of a metadata line that are absent', () => {
    // A dangling separator reads as a field that failed to load.
    const out = String(meta(['answered', null, '', undefined, false, 'read-only']));
    expect(out.match(/·/g)).toHaveLength(1);
    expect(String(meta([null, undefined]))).toBe('');
  });

  it('drops a definition row that was not wanted', () => {
    const out = String(defs([def('row', 'projects/Dispatch'), null, false, def('cost', 6506)]));
    expect(out.match(/<dt>/g)).toHaveLength(2);
  });

  it('marks a value as monospace only when asked', () => {
    expect(String(def('id', 'abc', { mono: true }))).toContain('<span class="mono">abc</span>');
    expect(String(def('id', 'abc'))).not.toContain('mono');
  });

  it('makes an empty state say what would put something there', () => {
    const out = String(empty({ what: 'Nothing is waiting.', next: 'Ask something.' }));
    expect(out).toContain('Nothing is waiting.');
    expect(out).toContain('class="next"');
    expect(out).toContain('Ask something.');
  });

  it('labels an instant as UTC and reads a string as well as a Date', () => {
    // Two stamps compared across a laptop and a container disagree unless both are
    // rendered in one zone, and the label is what stops somebody subtracting them
    // in their own.
    expect(utcStamp(new Date('2026-08-11T07:06:31Z'))).toBe('2026-08-11 07:06 UTC');
    expect(utcStamp('2026-08-11T07:06:31Z')).toBe('2026-08-11 07:06 UTC');
    expect(utcStamp(null)).toBe('unknown');
    expect(utcStamp('not a date')).toBe('unknown');
  });

  it('says "in 3s" rather than "-3s ago" for a row the database has just written', () => {
    // created_at comes from the database's clock and this is the process's, so a
    // container a few seconds behind produces a negative age.
    expect(ago(new Date(Date.now() + 3_000))).toMatch(/^in \d+s$/);
    expect(ago(new Date(Date.now() - 4_000))).toMatch(/^\d+s ago$/);
  });

  it('is precise where precision is the point', () => {
    // 284ms and 0.3s are the same number, and only the first is useful next to a
    // query.
    expect(duration(284)).toBe('284ms');
    expect(duration(6_558)).toBe('6.6s');
    expect(duration(82_000)).toBe('1m22s');
    expect(duration(Number.NaN)).toBe('—');
  });

  it('formats a figure in a fixed locale', () => {
    // The default locale is the container's, so the same token count would read
    // 6,506 on a laptop and 6.506 in Docker.
    expect(figure(6506)).toBe('6,506');
    expect(figure('19518')).toBe('19,518');
    expect(figure(null)).toBe('—');
  });

  it('flattens a clipped line and marks that it was cut', () => {
    expect(clip('a\n  b\tc')).toBe('a b c');
    expect(clip('abcdefghij', 5)).toBe('abcd…');
  });
});
