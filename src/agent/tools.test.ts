/**
 * The gate in front of the tools, tested with tools that do nothing.
 *
 * Every tool call is a string the model wrote. This file is about what happens
 * to it before anything runs — the name is matched against the registry, the
 * arguments go through that tool's own validator, and a refusal comes back as a
 * tool RESULT so the model can correct itself rather than the run dying.
 *
 * The tools here are stubs on purpose. `tools.ts` registers nothing (see the
 * registry comment there for the bug that decision comes from), so a test of
 * the gate that used the real read tools would be testing SQL, need a database,
 * and fail for reasons that have nothing to do with the gate. The stubs record
 * what they were handed, which is how the interesting assertions — that only
 * validated arguments reach `run`, that the run's context arrives as an argument
 * rather than as module state — can be made at all.
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  allTools,
  asObject,
  executeTool,
  getTool,
  optionalDate,
  optionalEnum,
  optionalInt,
  optionalString,
  registerTools,
  requireString,
  ToolError,
  toolSpecs,
  type Tool,
  type ToolContext,
} from './tools';

/** The obviously-synthetic operator from .env.example. Never taken from the model. */
const CTX: ToolContext = { userId: '00000000-0000-4000-8000-000000000001', allowWrites: false };

/** What the last stub call was actually handed. */
let seen: { args: Record<string, unknown>; ctx: ToolContext } | undefined;

const LOOKUP: Tool = {
  name: 'stub_find_client',
  description: 'Stub. Stands in for a read tool so the gate can be tested without a database.',
  inputSchema: {
    type: 'object',
    properties: { name: { type: 'string' }, limit: { type: 'integer' } },
    required: ['name'],
  },
  validate: (raw) => {
    const o = asObject(raw);
    return {
      name: requireString(o, 'name', { max: 200 }),
      limit: optionalInt(o, 'limit', { default: 10, max: 25 }),
    };
  },
  run: async (args, ctx) => {
    seen = { args, ctx };
    return {
      content: 'Halden Freight — active client.',
      evidence: [{ table: 'clients', id: 'c-halden', label: 'Halden Freight' }],
    };
  },
};

const BROKEN: Tool = {
  name: 'stub_broken_lookup',
  description: 'Stub. Throws, so the gate can be caught turning a failure into a result.',
  inputSchema: { type: 'object', properties: {} },
  validate: () => ({}),
  run: async () => {
    throw new Error('connection reset');
  },
};

/**
 * This suite runs FIRST and registers nothing, and both halves of that are
 * load-bearing.
 *
 * The registry is module state. vitest gives each test file its own module
 * graph, so another file registering the real tools cannot reach this one — but
 * within this file, anything that registers before this test would defeat it
 * silently. Registration below therefore happens in `beforeAll`, not at the top
 * of a `describe` body: a describe body runs during collection, before the first
 * test executes, which would fill the registry before this ever ran.
 */
describe('an empty registry', () => {
  it('says nothing is registered at all, rather than listing a plausible few', async () => {
    expect(
      allTools(),
      'something registered a tool before this test — the empty-registry case has to run first'
    ).toEqual([]);

    const { ok, result } = await executeTool('find_client', { name: 'Halden' }, CTX);
    expect(ok).toBe(false);
    // The distinction this makes is the whole reason the message is separate. In
    // the private original, registration was a side effect of importing the
    // loop, so the approval endpoint ran with only the two tools tools.ts defined
    // itself and every approval of a write came back "There is no tool called
    // draft_upwork_proposal. Available tools: find_client, invoice_totals." It
    // ran that way for weeks, because a short plausible list reads like an
    // allowlist working rather than like a wiring fault.
    expect(result.content).toContain('No tools are registered');
    expect(result.content).toContain('fault in the harness');
    // And it must not invite a retry: there is no name that would work, so the
    // model is told to say it cannot look anything up.
    expect(result.content).not.toContain('Available tools:');
    expect(result.evidence).toEqual([]);
  });
});

describe('the tool gate', () => {
  beforeAll(() => registerTools([LOOKUP, BROKEN]));
  beforeEach(() => {
    seen = undefined;
  });

  it('refuses a tool that does not exist, and says what does', async () => {
    const { ok, result } = await executeTool('drop_database', {}, CTX);
    expect(ok).toBe(false);
    // The refusal goes back to the model as a result it can read and act on,
    // rather than being thrown and losing a run that was otherwise fine. A model
    // that half-remembers a tool name from its training data, or invents the tool
    // it wishes you had, is a normal Tuesday.
    expect(result.content).toContain('no tool called "drop_database"');
    expect(result.content).toContain('stub_find_client');
  });

  it('refuses arguments that fail validation, naming the field, without throwing', async () => {
    const { ok, result } = await executeTool('stub_find_client', { name: '' }, CTX);
    expect(ok).toBe(false);
    expect(result.content).toContain('Invalid arguments for stub_find_client');
    expect(result.content).toContain('"name"');
    // The tool never ran. Validation is a gate, not a warning printed on the way
    // past it.
    expect(seen).toBeUndefined();
  });

  it('refuses positional arguments instead of indexing them', async () => {
    const { ok, result } = await executeTool('stub_find_client', ['Halden'], CTX);
    expect(ok).toBe(false);
    expect(result.content).toContain('JSON object');
  });

  it('surfaces a tool failure as a result rather than throwing', async () => {
    // A tool that throws is a tool that failed, not a run that failed. Whether
    // retrying is worth it is the model's next decision; whether the run
    // continues at all is the budget's (see maxConsecutiveToolErrors).
    const { ok, result } = await executeTool('stub_broken_lookup', {}, CTX);
    expect(ok).toBe(false);
    expect(result.content).toContain('stub_broken_lookup failed');
    expect(result.content).toContain('connection reset');
  });

  it('carries evidence back from the tool untouched', async () => {
    const { ok, result } = await executeTool('stub_find_client', { name: 'Halden' }, CTX);
    expect(ok).toBe(true);
    // Evidence is what turns an answer into a statement about records: with the
    // ids behind it, disagreeing with the agent is a query. It is also what the
    // eval suite asserts on — "this answer rests on a row from clients" is
    // checkable, "this answer is good" is not — so the gate must pass it through
    // rather than summarise it.
    expect(result.evidence).toEqual([
      { table: 'clients', id: 'c-halden', label: 'Halden Freight' },
    ]);
  });

  it('hands run() the validated arguments, not the ones the model sent', async () => {
    const { ok } = await executeTool(
      'stub_find_client',
      { name: '  Halden Freight  ', limit: 999, also_delete_everything: true },
      CTX
    );
    expect(ok).toBe(true);
    // The validator returns a NEW object, so a field it never accepted cannot
    // ride along inside it. This matters beyond tidiness: these are the
    // arguments a proposal stores and re-runs on approval, and anything smuggled
    // in here would be approved as part of the card.
    expect(seen?.args).toEqual({ name: 'Halden Freight', limit: 25 });
    // Clamped rather than refused. A limit of 999 is greed, not a
    // misunderstanding, and a round trip to say so costs more than capping it.
    expect(seen?.args.limit).toBe(25);
  });

  it('passes the run context to the tool instead of leaving it in module state', async () => {
    await executeTool('stub_find_client', { name: 'Halden' }, CTX);
    // A module-level flag works right up until two runs share a process, at
    // which point a write tool reads another run's permission.
    expect(seen?.ctx.allowWrites).toBe(false);
    expect(seen?.ctx.userId).toBe(CTX.userId);
  });

  it('looks up by name without inheriting anything from Object.prototype', () => {
    expect(getTool('stub_find_client')).toBeDefined();
    // The key comes from the model. On a plain object, a call to a tool named
    // `constructor` finds something truthy and the allowlist hands back a value
    // that is not a tool; a Map has no inherited keys to find.
    expect(getTool('constructor')).toBeUndefined();
    expect(getTool('__proto__')).toBeUndefined();
    expect(getTool('toString')).toBeUndefined();
  });

  it('publishes exactly what the registry holds', () => {
    const specs = toolSpecs();
    expect(specs).toHaveLength(allTools().length);
    expect(specs.map((s) => s.name)).toContain('stub_find_client');
    // The schema goes to the provider as the tool wrote it. A gate that rebuilt
    // it would be a second description of the arguments, free to disagree with
    // the validator that actually decides.
    expect(specs.find((s) => s.name === 'stub_find_client')?.inputSchema).toBe(LOOKUP.inputSchema);
  });

  it('replaces a repeated name rather than registering it twice', async () => {
    // Two entry points both calling the registration helper must not make the
    // second one fail. The cost is that a genuine collision is silent, which is
    // acceptable only because the names are literals in this repo's own source.
    const before = allTools().length;
    registerTools([{ ...BROKEN, description: 'Stub, second definition.' }]);
    expect(allTools()).toHaveLength(before);
    expect(getTool('stub_broken_lookup')?.description).toBe('Stub, second definition.');

    // Still the same tool as far as the gate is concerned.
    const { ok } = await executeTool('stub_broken_lookup', {}, CTX);
    expect(ok).toBe(false);
  });
});

/**
 * The shared validators.
 *
 * Shared because the model reads these sentences: three spellings of "that
 * field is required" is three chances for one of them to be the unhelpful one,
 * and which one the model gets decides what it tries next.
 */
describe('the validation helpers', () => {
  it('throws ToolError, which is what the gate knows how to convert', () => {
    try {
      asObject('a string');
      expect.unreachable('asObject accepted a string');
    } catch (err) {
      expect(err).toBeInstanceOf(ToolError);
      expect((err as Error).name).toBe('ToolError');
    }
  });

  it('does not treat an array or null as an argument object', () => {
    expect(() => asObject([{ name: 'Halden' }])).toThrow(ToolError);
    expect(() => asObject(null)).toThrow(ToolError);
    expect(() => asObject(undefined)).toThrow(ToolError);
    expect(asObject({ name: 'Halden' })).toEqual({ name: 'Halden' });
  });

  it('trims a required string and refuses an empty one', () => {
    expect(requireString({ name: '  Halden Freight ' }, 'name')).toBe('Halden Freight');
    expect(() => requireString({ name: '   ' }, 'name')).toThrow(/"name" is required/);
    expect(() => requireString({}, 'name')).toThrow(/"name" is required/);
    expect(() => requireString({ name: 12 }, 'name')).toThrow(/"name" is required/);
    expect(() => requireString({ name: 'x'.repeat(11) }, 'name', { max: 10 })).toThrow(
      /10 characters or fewer/
    );
  });

  it('treats an empty optional string as absent', () => {
    // A model filling in `client_name: ""` means "no filter", not "the client
    // whose name is the empty string". The second reading turns an ILIKE '%%'
    // into a scan that matches everything — an unfiltered answer to a filtered
    // question, which is worse than an error because it looks like data.
    expect(optionalString({ client_name: '' }, 'client_name')).toBeUndefined();
    expect(optionalString({ client_name: '   ' }, 'client_name')).toBeUndefined();
    expect(optionalString({}, 'client_name')).toBeUndefined();
    expect(optionalString({ client_name: null }, 'client_name')).toBeUndefined();
    expect(optionalString({ client_name: ' Halden ' }, 'client_name')).toBe('Halden');
  });

  it('clamps a greedy limit and refuses one that is a misunderstanding', () => {
    const opts = { default: 10, max: 100 };
    expect(optionalInt({}, 'limit', opts)).toBe(10);
    expect(optionalInt({ limit: 500 }, 'limit', opts)).toBe(100);
    expect(optionalInt({ limit: 5 }, 'limit', opts)).toBe(5);
    // -1 and 2.5 are not appetites, they are mistakes, and a clamped mistake
    // returns rows to a caller who asked for something else.
    expect(() => optionalInt({ limit: 0 }, 'limit', opts)).toThrow(/positive whole number/);
    expect(() => optionalInt({ limit: -1 }, 'limit', opts)).toThrow(/positive whole number/);
    expect(() => optionalInt({ limit: 2.5 }, 'limit', opts)).toThrow(/positive whole number/);
    expect(() => optionalInt({ limit: 'lots' }, 'limit', opts)).toThrow(/positive whole number/);
  });

  it('lists the allowed values when it refuses an enum', () => {
    const STATUSES = ['active', 'inactive', 'prospect'] as const;
    expect(optionalEnum({ status: 'active' }, 'status', STATUSES)).toBe('active');
    expect(optionalEnum({}, 'status', STATUSES)).toBeUndefined();
    // 'lead' is the value this schema does NOT have, and it is the one a model
    // reaches for. A tool that accepted it would filter on a value no row can
    // hold and return nothing — and nothing reads as "you have no such clients".
    // The list in the refusal is the only thing that makes the second attempt
    // better than the first.
    expect(() => optionalEnum({ status: 'lead' }, 'status', STATUSES)).toThrow(
      /active, inactive, prospect/
    );
  });

  it('accepts a real calendar date as a string and refuses one that only looks like a date', () => {
    expect(optionalDate({ entry_date: '2026-08-04' }, 'entry_date')).toBe('2026-08-04');
    expect(optionalDate({}, 'entry_date')).toBeUndefined();
    // Matches the pattern and is not a day. Postgres would reject it too, but as
    // an error string the model then has to explain to a person.
    expect(() => optionalDate({ entry_date: '2026-02-31' }, 'entry_date')).toThrow(/not a real date/);
    expect(() => optionalDate({ entry_date: '2026-13-01' }, 'entry_date')).toThrow(/not a real date/);
    expect(() => optionalDate({ entry_date: '04/08/2026' }, 'entry_date')).toThrow(/YYYY-MM-DD/);
    expect(() => optionalDate({ entry_date: 'yesterday' }, 'entry_date')).toThrow(/YYYY-MM-DD/);
  });
});
