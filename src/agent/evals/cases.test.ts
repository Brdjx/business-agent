/**
 * The shape of the case list. No model, no database, nothing spent.
 *
 * ── What this is for ──
 *
 * A case that asserts nothing passes forever. It appears in the output, it is counted
 * in the total, and it is indistinguishable from a case that is doing its job — which
 * makes it worse than a missing case, because a missing case is at least missing.
 *
 * The ways a case goes quiet are all mechanical, and all of them have happened
 * somewhere in this lineage:
 *
 *  - A role read by a question but not declared in `needs`. The role is never bound, so
 *    the question asks about the literal string `undefined` and the agent correctly
 *    finds nothing. The case runs, the assertions are about an admission of ignorance,
 *    and it passes for the wrong reason.
 *  - An expectation list that is empty. Nothing to require, nothing to forbid.
 *  - A typo in `forbidTools`. A tool that does not exist is never called, so the
 *    forbidding is free and permanent.
 *  - A phrase forbidden that the question itself contains, so quoting the question back
 *    fails a correct answer.
 *  - A date written as a literal. It is in the past today and in the future eventually,
 *    and `log_time` refuses a future date, so the case starts failing a correct agent
 *    on a day nobody changed anything.
 *
 * Every one of those is checked below. None of it needs a model, which is the point: it
 * runs on every commit, and it is what stops a green suite from being a green suite of
 * nothing.
 *
 * ── The one thing here that is a stand-in ──
 *
 * Roles are bound at run time, so a question can only be rendered here against a stub
 * binding. The stub is shaped like the seed. Where a check depends on the VALUE a role
 * takes — that a forbidden phrase is not inside a required one, say — it proves the
 * property for names of that shape and not for every dataset. The comment on
 * `hazardsOfShortNames` below says where that limitation bites, because it bites in a
 * way that would fail a correct agent rather than pass a wrong one.
 */

import { describe, expect, it } from 'vitest';

import { CASES, toolNamesReferenced, type EvalCase } from './cases';
import { ROLES, type Bound, type Role } from './roles';
import { ensureToolsRegistered } from '../registry';
import { allTools } from '../tools';

/**
 * A binding shaped like `db/900-seed.sql`, for rendering a question without a database.
 *
 * All nine roles are filled, deliberately: a stub with holes in it would make the
 * "reads a role it did not declare" check pass for the wrong reason, since an undeclared
 * role would render as `undefined` either way and there would be nothing to compare.
 */
const STUB: Bound = {
  client_multi_project: 'Halden Freight',
  client_with_project: 'Calderwood Diagnostics',
  passed_lead: 'Quillon Robotics',
  inactive_client: 'Northaven Credit Union',
  client_with_invoices: 'Halden Freight',
  contact_at_client: 'Dana Ruiz',
  client_of_contact: 'Halden Freight',
  single_project: 'Dispatch Rewrite',
  absent_client: 'Initech',
  money: {
    outstandingCents: '3330000',
    naiveOutstandingCents: '4080000',
    collectedCents: '11050000',
    voidCount: 1,
    draftCount: 1,
    voidInvoice: 'INV-1006',
    draftInvoice: 'INV-1011',
  },
  hours: {
    totalHours: '257.50',
    billableHours: '217.00',
    nonBillableHours: '40.50',
    neverBillableHours: '29.50',
  },
};

/** The business tables, as named in `db/001-business.sql`. Evidence comes from these. */
const TABLES = ['clients', 'contacts', 'projects', 'invoices', 'time_entries'];

/** Every field that makes a case assert something. */
const EXPECTATIONS = [
  'expectTools',
  'forbidTools',
  'expectContains',
  'expectAbsent',
  'expectEvidenceFrom',
  'expectProposes',
  'expectNoProposal',
  'expectStop',
] as const satisfies ReadonlyArray<keyof EvalCase>;

/** The fields that describe a case rather than assert anything about the run. */
type Descriptive = 'id' | 'tests' | 'question' | 'needs' | 'allowWrites';
type ExpectationNotListed = Exclude<keyof EvalCase, Descriptive | (typeof EXPECTATIONS)[number]>;
/**
 * A compile error here means a new expectation field was added to `EvalCase` and not to
 * `EXPECTATIONS`. It matters because "does this case assert anything" is answered by
 * that list: a new field left out of it would make a case whose only assertion uses it
 * read as a case that asserts nothing, and — worse in the other direction — a case that
 * lost its other assertions would still look covered.
 */
const _everyExpectationIsListed: ExpectationNotListed extends never ? true : never = true;
void _everyExpectationIsListed;

type ListOrFunction = string[] | ((r: Bound) => string[]) | undefined;

const resolve = (field: ListOrFunction, r: Bound = STUB): string[] =>
  typeof field === 'function' ? field(r) : (field ?? []);

const lower = (xs: string[]): string[] => xs.map((x) => x.toLowerCase());

const question = (c: EvalCase): string => c.question(STUB);

/**
 * Which roles a function actually reads, recorded rather than inferred.
 *
 * A Proxy rather than a scan of the source, because a question is a function and can
 * read a role however it likes. `money` and `hours` are read this way too and are not
 * roles, so the result is filtered to `ROLES` — a case cannot declare a need for a
 * figure, and nothing skips for want of one.
 */
function rolesRead(fn: (r: Bound) => unknown): Role[] {
  const seen = new Set<string>();
  const spy = new Proxy({ ...STUB } as Record<string, unknown>, {
    get(target, property) {
      if (typeof property === 'string') seen.add(property);
      return Reflect.get(target, property);
    },
  }) as Bound;
  fn(spy);
  return ROLES.filter((role) => seen.has(role));
}

/** Every role a case touches anywhere: the question and both expectation functions. */
function rolesUsed(c: EvalCase): Role[] {
  const seen = new Set<Role>();
  for (const fn of [
    c.question,
    typeof c.expectContains === 'function' ? c.expectContains : undefined,
    typeof c.expectAbsent === 'function' ? c.expectAbsent : undefined,
  ]) {
    if (fn) for (const role of rolesRead(fn)) seen.add(role);
  }
  return [...seen];
}

const each = (assert: (c: EvalCase) => void) => () => {
  for (const c of CASES) {
    try {
      assert(c);
    } catch (err) {
      // The case id, or the failure names an anonymous object and sends the reader
      // counting braces in a seventeen-element array.
      throw new Error(`case ${c.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
};

describe('the case list', () => {
  it('is not empty', () => {
    // A filter left in, an export gone wrong: a suite with no cases reports "0 failed"
    // and exits 0, which is the same output as a suite that passed.
    expect(CASES.length).toBeGreaterThan(0);
  });

  it('gives every case a unique id', () => {
    const ids = CASES.map((c) => c.id);
    expect(new Set(ids).size, `duplicate id in ${ids.join(', ')}`).toBe(ids.length);
    for (const id of ids) {
      // The id is written to `agent_eval_runs.case_id` and is how a failure six weeks
      // old is matched to a case that still exists, so it is a stable slug rather than a
      // sentence.
      expect(id, `${id} is not a stable slug`).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    }
  });

  it(
    'gives every case a sentence saying what breaks if it fails',
    each((c) => {
      // Printed on a failure. "test money" tells whoever is reading the output nothing
      // they could not see from the id.
      expect(c.tests.trim().length).toBeGreaterThan(30);
    })
  );

  it(
    'asserts something',
    each((c) => {
      const set = EXPECTATIONS.filter((field) => c[field] !== undefined);
      expect(set.length, 'no expectation field is set, so this case passes forever').toBeGreaterThan(
        0
      );
    })
  );

  it(
    'asserts something that no dataset can empty',
    each((c) => {
      // The stronger form. `expectContains: (r) => dollarSpellings(r.money?.…)` returns
      // nothing on a dataset with no invoices, which is deliberate — the case degrades
      // rather than failing for want of a fixture. But a case whose ONLY expectations
      // are functions can degrade to asserting nothing at all, and it would still be
      // counted as a pass. So every case carries at least one assertion that does not
      // depend on what bound.
      const fixed = [
        c.expectTools?.length,
        c.forbidTools?.length,
        c.expectEvidenceFrom?.length,
        Array.isArray(c.expectContains) ? c.expectContains.length : 0,
        Array.isArray(c.expectAbsent) ? c.expectAbsent.length : 0,
        c.expectProposes ? 1 : 0,
        c.expectNoProposal ? 1 : 0,
        c.expectStop ? 1 : 0,
      ].reduce<number>((total, n) => total + (n ?? 0), 0);
      expect(fixed, 'every assertion here could evaluate to nothing').toBeGreaterThan(0);
    })
  );

  it(
    'writes no empty list',
    each((c) => {
      // A literal `[]` asserts nothing and reads as though it asserts something, which
      // is the difference between this and the deliberate degradation above.
      for (const field of ['expectTools', 'forbidTools', 'expectEvidenceFrom'] as const) {
        if (c[field] !== undefined) expect(c[field]!.length, `${field} is empty`).toBeGreaterThan(0);
      }
      for (const field of ['expectContains', 'expectAbsent'] as const) {
        const value = c[field];
        if (Array.isArray(value)) expect(value.length, `${field} is empty`).toBeGreaterThan(0);
      }
    })
  );
});

describe('roles a case depends on', () => {
  it(
    'declares only real roles',
    each((c) => {
      for (const role of c.needs ?? []) expect(ROLES).toContain(role);
      expect(new Set(c.needs ?? []).size).toBe((c.needs ?? []).length);
    })
  );

  it(
    'declares every role its question reads',
    each((c) => {
      // The failure this catches: an undeclared role is never bound, the question is
      // rendered with the literal string "undefined" in it, and the case runs against a
      // question nobody wrote. It usually passes, because "we have no record of
      // undefined" satisfies most hedging assertions.
      for (const role of rolesRead(c.question)) {
        expect(c.needs ?? [], `${role} is read by the question but not declared`).toContain(role);
      }
    })
  );

  it(
    'reads every role it declares',
    each((c) => {
      // The other direction, and a coverage question rather than a correctness one: a
      // stale entry in `needs` makes the case skip on data it does not use, and a case
      // that has been skipping for six weeks is a gap nobody is being told about.
      //
      // Counted across the expectation functions as well as the question:
      // `unreachable-record-is-admitted` needs the contact only so it can forbid the
      // name appearing in the answer.
      const used = rolesUsed(c);
      for (const role of c.needs ?? []) {
        expect(used, `${role} is declared but never used`).toContain(role);
      }
    })
  );

  it(
    'renders a question with nothing missing from it',
    each((c) => {
      const q = question(c);
      expect(q.trim().length).toBeGreaterThan(0);
      // What an undeclared role, a renamed role, or an object interpolated by accident
      // looks like in the text that gets sent to the model.
      for (const hole of ['undefined', 'null', '[object Object]', 'NaN']) {
        expect(q, `the question contains ${hole}`).not.toContain(hole);
      }
    })
  );
});

describe('dates in a question', () => {
  const today = new Date().toISOString().slice(0, 10);

  it(
    'are not written into the case at all',
    each((c) => {
      // The immediate check, and the one that matters: a date literal in the SOURCE of a
      // question. The rendered check below cannot see one that is still recent — a
      // literal written today is indistinguishable from `daysAgo(1)` until the clock
      // moves — so it would report the rot weeks after it was introduced, on a day
      // nobody had touched the file.
      //
      // Function.prototype.toString returns the source as transpiled, which keeps
      // literals; a computed date leaves `daysAgo(...)` in it and no digits.
      expect(c.question.toString(), 'a date is written into this question').not.toMatch(
        /\d{4}-\d{2}-\d{2}/
      );
    })
  );

  it(
    'are in the past when rendered',
    each((c) => {
      for (const date of question(c).match(/\d{4}-\d{2}-\d{2}/g) ?? []) {
        // `log_time` refuses a date in the future, so a literal quietly becomes a case
        // that fails a correct agent the day the clock passes it. ISO dates compare
        // correctly as strings.
        expect(date <= today, `${date} is in the future`).toBe(true);

        // And the reason this is not just a not-in-the-future check: a literal in the
        // past is in the future of nothing, and would pass forever while drifting
        // further from the "yesterday" the case means. Thirty days is enough slack for a
        // clock skew and not enough to hide a hardcoded date for long.
        const ageDays = (Date.parse(today) - Date.parse(date)) / 86_400_000;
        expect(ageDays, `${date} is ${Math.round(ageDays)} days old`).toBeLessThanOrEqual(30);
      }
    })
  );
});

describe('tools a case names', () => {
  it('names only tools that are registered', () => {
    // A typo in `expectTools` fails its case loudly and gets fixed. A typo in
    // `forbidTools` matches nothing, forbids nothing, and passes forever.
    //
    // Registered through the same helper every entry point uses, rather than by
    // registering the arrays here: a check that assembles its own registry cannot
    // notice a tool missing from the real one (incident 1 in docs/incidents.md).
    ensureToolsRegistered();
    const registered = allTools().map((t) => t.name);

    expect(toolNamesReferenced().length).toBeGreaterThan(0);
    for (const name of toolNamesReferenced()) {
      expect(registered, `no tool called ${name}`).toContain(name);
    }
  });

  it('collects every referenced name once, in a stable order', () => {
    const names = toolNamesReferenced();
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual([...names].sort());
  });

  it(
    'never requires and forbids the same tool',
    each((c) => {
      // Unsatisfiable, and it would read as the agent failing.
      for (const name of c.expectTools ?? []) {
        expect(c.forbidTools ?? [], `${name} is both required and forbidden`).not.toContain(name);
      }
      if (c.expectProposes) {
        expect(
          c.forbidTools ?? [],
          `${c.expectProposes} must be called to propose anything`
        ).not.toContain(c.expectProposes);
      }
    })
  );

  it(
    'leaves writes off',
    each((c) => {
      // `allowWrites` is the gate that decides whether a tool acts or describes what it
      // would do. A suite that turned it on would be measuring the agent against a
      // database it had edited, and the next run would measure what this one left
      // behind.
      expect(c.allowWrites ?? false, 'this case would let the agent write').toBe(false);
    })
  );
});

describe('proposals', () => {
  it(
    'never both expects a proposal and forbids one',
    each((c) => {
      expect(
        c.expectProposes !== undefined && c.expectNoProposal === true,
        'expects a proposal and also requires that there is none'
      ).toBe(false);
    })
  );

  it('checks both outcomes somewhere in the list', () => {
    // Per-action consent is the repository's other claim, and it has two halves: a
    // described write is left approvable, and a write that would change nothing leaves
    // nothing to approve. Losing either half of that would still leave a green suite.
    expect(CASES.some((c) => c.expectProposes !== undefined)).toBe(true);
    expect(CASES.some((c) => c.expectNoProposal === true)).toBe(true);
  });
});

describe('evidence a case requires', () => {
  it(
    'names tables that exist',
    each((c) => {
      for (const table of c.expectEvidenceFrom ?? []) {
        expect(TABLES, `no table called ${table}`).toContain(table);
      }
    })
  );
});

describe('phrases a case forbids', () => {
  it(
    'are not phrases the question itself contains',
    each((c) => {
      const q = question(c).toLowerCase();
      // The fourth way a case goes quiet: an answer that quotes the question back is
      // failed for it. `no-invented-numbers` asks for "a ballpark" and deliberately does
      // NOT forbid the word, because "I don't do ballparks, here is the exact figure" is
      // the best possible answer.
      for (const phrase of lower(resolve(c.expectAbsent))) {
        expect(q, `the question contains the forbidden "${phrase}"`).not.toContain(phrase);
      }
    })
  );

  it(
    'do not overlap the phrases the same case requires',
    each((c) => {
      // Proved for a stub binding, which is as far as this can go without a database,
      // and the gap is worth naming: `unreachable-record-is-admitted` forbids the bound
      // CONTACT'S NAME as a substring of the answer, and requires any one of 'cannot',
      // 'unable', 'no contact' and others. A short bound name can be inside one of them
      // — 'Ann' is inside 'cannot' — and the case would then be unsatisfiable against
      // that dataset, landing as the agent getting it wrong. Nothing here can check
      // that; the binding printed at the top of a run is where it would be visible.
      const required = lower(resolve(c.expectContains));
      const forbidden = lower(resolve(c.expectAbsent));
      for (const r of required) {
        for (const f of forbidden) {
          // Either containment makes the case unsatisfiable in one direction: a required
          // phrase holding a forbidden one cannot be written at all, and a forbidden
          // phrase holding a required one is tripped by the honest answer that quotes
          // the figure in full.
          expect(r.includes(f), `required "${r}" contains forbidden "${f}"`).toBe(false);
          expect(f.includes(r), `forbidden "${f}" contains required "${r}"`).toBe(false);
        }
      }
    })
  );

  it(
    'survive their own negation',
    each((c) => {
      // The rule the cases file states, checked as far as a substring can check it.
      // "marked paid" is inside "cannot be marked paid", so forbidding it fails the
      // correct refusal — but whether that is true of a given phrase is a fact about
      // English, not about anything in this repository. What IS checkable is the extreme
      // form: a forbidden phrase that is ITSELF a negation forbids the honest answer
      // outright.
      //
      // Two phrases in the current list are NOT proved safe by this, and passing here
      // should not be read as their being safe. 'revenue from them' is inside "no revenue
      // from them", and 'check back' is inside "you don't need to check back" — both
      // would fail an answer that is correct. Catching those needs the rule stated as
      // grammar rather than as substrings, which is why they are recorded here instead.
      for (const phrase of lower(resolve(c.expectAbsent))) {
        for (const negation of ['not ', 'never ', 'cannot ', "can't ", 'no ']) {
          expect(
            phrase.startsWith(negation),
            `"${phrase}" is itself a negation, so the phrase it negates is what should be forbidden`
          ).toBe(false);
        }
      }
    })
  );
});

describe('the kinds of assertion the suite makes', () => {
  it('still uses each of them', () => {
    // Section 8 of docs/design.md lists what a mechanical assertion may be. If one of
    // those kinds quietly left the file — no case checks evidence any more, nothing
    // asserts how a run stopped — the suite would go on passing at the same count while
    // covering less. Read as a list of what is currently exercised, and it is meant to
    // be updated deliberately rather than silently.
    const used = new Set<string>();
    for (const c of CASES) {
      for (const field of EXPECTATIONS) if (c[field] !== undefined) used.add(field);
    }
    expect([...used].sort()).toEqual([...EXPECTATIONS].sort());
  });
});
