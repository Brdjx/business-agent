/**
 * Registering the tools, once, for whoever is about to execute one.
 *
 * ── The bug this file exists to prevent ──
 *
 * Registration used to be a side effect of importing the loop. That worked for
 * the endpoint that runs the agent, which imports the loop by definition, and it
 * silently failed for the one that matters most: approving a proposal.
 *
 * The approval path imports the proposals module, which imports `executeTool`,
 * and has no reason to touch the loop. So its bundle carried a registry holding
 * only the tools the gate module happened to define itself, and every approval of
 * a write came back with `There is no tool called draft_upwork_proposal.
 * Available tools: find_client, invoice_totals.`
 *
 * Approving a write had never once worked in production. Nothing caught it,
 * and that part is the lesson: every unit test called the registration helper
 * itself at the top of the file, and the one end-to-end check imported the loop,
 * so the registry was full in every process anybody looked at. A registry
 * assembled by whichever entry point happens to import which module is not a
 * registry, it is a coincidence. The full write-up is incident 1 in
 * `docs/incidents.md`.
 *
 * ── Why a function, and not another import side effect ──
 *
 * Because replacing one implicit side effect with another leaves the same trap.
 * An import whose only purpose is to run code is also the first thing a bundler
 * is entitled to drop — the original's handlers are built with esbuild and
 * minified, and this repository is run through tsx today but says nothing about
 * how anybody else will build it.
 *
 * So: an explicit, idempotent call, made by every entry point that will reach
 * `executeTool`. There is exactly one such entry point in this phase (whatever
 * asks a question). The write phase adds a second — the path that applies an
 * approved proposal — and it must call this too, without importing the loop.
 * That requirement is the whole point: "may the agent change things" and "may it
 * do this one thing" are different questions and must not share a code path.
 *
 * Note what registration does and does not decide. It makes a tool *callable*.
 * Whether a write tool acts or only describes what it would do is `allowWrites`
 * on the per-run context. Two separate gates, and neither substitutes for the
 * other.
 */

import { registerTools } from './tools';
import { READ_TOOLS } from './tools/read';

/**
 * Module state, deliberately.
 *
 * `registerTools` is already idempotent — a repeated name replaces the earlier
 * tool rather than throwing — so this flag is not what makes a second call safe.
 * It is what makes a second call free, which matters because the honest way to
 * use this is to call it at the top of every entry point without checking
 * whether someone else already did.
 */
let done = false;

/**
 * Make every tool callable. Safe to call repeatedly.
 *
 * There is no unregister, and no way to ask what is registered from here: the
 * registry itself answers that (`allTools`), and a second source of truth about
 * which tools exist is the shape of the bug above.
 */
export function ensureToolsRegistered(): void {
  if (done) return;
  registerTools([
    // Read tools only, in this phase. The write tools are a separate array added
    // to this same call — not a separate registration function, because a second
    // entry point is a second thing to forget.
    ...READ_TOOLS,
  ]);
  done = true;
}
