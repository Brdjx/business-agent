/**
 * Which provider answers, decided from the environment.
 *
 * ── Why there are two ──
 *
 * A one-implementation interface is an assumption, not an abstraction. You do
 * not find out whether a boundary is drawn in the right place by describing one
 * thing behind it; you find out the first time something else has to fit
 * through, and then either the second implementation is easy or the boundary
 * was really the first vendor's shape with the names changed.
 *
 * So there are two, and they disagree about enough to make the point: Converse
 * names the blocks `toolUse` / `toolResult` and carries a cache breakpoint as
 * its own array element, the Anthropic API names them `tool_use` / `tool_result`
 * and hangs `cache_control` on the block it applies to. Neither spelling
 * reaches the loop. The Anthropic adapter is the one this port uses; Bedrock is
 * here because it is what the private original runs on.
 *
 * The second reason is measurement: two models disagreeing about the same
 * records is something an eval suite should be able to record rather than
 * something taken on faith, and `Provider.id` plus the model id is what makes a
 * run attributable to one of them.
 *
 * ── Why this file owns the environment ──
 *
 * Every `process.env` read for the model layer is here. The adapters take plain
 * arguments, so a missing variable produces one sentence naming it, in one
 * place, rather than a different message depending on which module happened to
 * look first — and so a test can construct a provider without setting anything.
 */

import { createAnthropicProvider } from './anthropic';
import { createBedrockProvider } from './bedrock';
import type { Provider } from './types';

export { createAnthropicProvider, type AnthropicOptions } from './anthropic';
export { createBedrockProvider, type BedrockOptions } from './bedrock';

/** The adapters, by the name `PROVIDER` uses. */
const PROVIDER_IDS = ['anthropic', 'bedrock'] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

/**
 * The default, and it is the Anthropic API rather than the provider the
 * original ran on: it needs one key and no cloud account, so a reader who
 * cloned this repo to see whether the thing works can find out.
 */
export const DEFAULT_PROVIDER: ProviderId = 'anthropic';

export interface ProviderChoice {
  provider: Provider;
  /**
   * Returned alongside the provider rather than baked into it, because the id
   * belongs to the request and has to be recorded per run: a regression after a
   * model change and a regression after a prompt change are different
   * investigations, and a pass count cannot tell them apart.
   */
  model: string;
}

/**
 * Nothing in this repo loads a .env file — there is no dotenv dependency — so
 * every "not set" message has to say how the file gets read, or the reader
 * copies `.env.example`, sees the variable filled in, and is told it is missing.
 */
const HOW_TO_SUPPLY =
  'Copy .env.example to .env and pass it to the runner: nothing here loads .env by itself ' +
  '(`node --env-file=.env`, or the same flag through tsx).';

/** A blank string is not a value. An exported-but-empty variable is the usual
 * way a shell hands one over, and treating `''` as set turns a missing key into
 * a 401 that reads like a revoked one. */
function read(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value === '' ? undefined : value;
}

/**
 * Build the provider named by `PROVIDER`, with the model named by `MODEL`.
 *
 * Throws with a sentence, never a stack trace into a vendor SDK. The three
 * things that can be wrong here — no key, no model, a provider name that is not
 * one of ours — are all things a person fixes in one line of a file, and the
 * message says which line.
 */
export function providerFromEnv(env: NodeJS.ProcessEnv = process.env): ProviderChoice {
  const requested = read(env, 'PROVIDER') ?? DEFAULT_PROVIDER;
  if (!(PROVIDER_IDS as readonly string[]).includes(requested)) {
    throw new Error(
      `PROVIDER is "${requested}", which is not a provider this repo has. ` +
        `Set it to one of: ${PROVIDER_IDS.join(', ')} — or leave it unset for ` +
        `${DEFAULT_PROVIDER}.`
    );
  }
  const id = requested as ProviderId;

  const model = read(env, 'MODEL');
  if (!model) {
    throw new Error(
      'MODEL is not set, so there is no model to ask. It is deliberately not defaulted in ' +
        'code: which model answered has to be recorded per run, and a silent default is the ' +
        'one thing that makes a run unattributable. ' +
        // The failure this note prevents: the ids are not interchangeable, and
        // crossing them reads as the wrong endpoint rather than the wrong name.
        'The id belongs to the provider — `claude-opus-5` for PROVIDER=anthropic, ' +
        '`anthropic.claude-opus-5` (optionally with a `us.` cross-region prefix) for ' +
        `PROVIDER=bedrock. ${HOW_TO_SUPPLY}`
    );
  }

  if (id === 'bedrock') {
    return {
      // No key to check: credentials come from the AWS SDK's normal chain, so a
      // missing one cannot be distinguished from a wrong one until the first
      // call. Region is passed through only when set — see BedrockOptions.
      provider: createBedrockProvider({ region: read(env, 'AWS_REGION') }),
      model,
    };
  }

  const apiKey = read(env, 'ANTHROPIC_API_KEY');
  if (!apiKey) {
    throw new Error(
      'ANTHROPIC_API_KEY is not set, so the agent has no model to reason with. Get one from ' +
        'console.anthropic.com; it is sent as the x-api-key header to api.anthropic.com and ' +
        `nothing else in this repo reads it. ${HOW_TO_SUPPLY} ` +
        '(The unit tests do not need a key — a suite that spends money on every commit stops ' +
        'being run.)'
    );
  }

  return { provider: createAnthropicProvider({ apiKey }), model };
}
