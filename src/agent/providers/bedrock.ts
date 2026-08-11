/**
 * The same interface, over Bedrock's Converse API.
 *
 * This adapter is why there is an interface at all. A one-implementation
 * boundary is an assumption rather than an abstraction — you find out whether it
 * is drawn in the right place only once something else has been fitted through
 * it — and Converse disagrees with the Anthropic API about enough to be a real
 * test of the shape:
 *
 *   Anthropic API                     Converse
 *   ─────────────────────────────     ─────────────────────────────────────
 *   tool_use / tool_result            toolUse / toolResult
 *   tool_use_id                       toolUseId
 *   input_schema                      inputSchema.json, inside a toolSpec
 *   cache_control on the block        cachePoint as its own array element
 *   is_error: true                    status: 'error'
 *   max_tokens at the top level       inferenceConfig.maxTokens
 *   usage.input_tokens                usage.inputTokens
 *
 * None of those spellings appear in `types.ts`, which is the point. This is also
 * the API the private original runs on, so the request shape below is the one
 * that has actually been in production; where this file departs from it, the
 * comment says why.
 *
 * The AWS SDK is imported dynamically, inside the factory, so that a user
 * running the Anthropic provider never needs it installed. It is an optional
 * dependency for the same reason: an install that pulls an AWS SDK in order to
 * talk to api.anthropic.com invites the reasonable question of what else is
 * being sent where.
 */

import type {
  Completion,
  CompletionRequest,
  CompletionStop,
  ContentBlock,
  Message,
  Provider,
  SystemBlock,
  ToolSpec,
  Usage,
} from './types';

/** Three tries total, and see the note on `maxAttempts` in `createBedrockProvider`. */
const DEFAULT_MAX_ATTEMPTS = 3;

/* ─── the Converse wire format, as narrowly as this file needs it ─── */

interface ConverseTextBlock {
  text: string;
}

interface ConverseToolUseBlock {
  toolUse: { toolUseId: string; name: string; input: unknown };
}

interface ConverseToolResultBlock {
  toolResult: {
    toolUseId: string;
    content: Array<{ text: string }>;
    status: 'success' | 'error';
  };
}

type ConverseRequestBlock = ConverseTextBlock | ConverseToolUseBlock | ConverseToolResultBlock;

/** A system list element: either text, or the cache breakpoint on its own. */
type ConverseSystemBlock = ConverseTextBlock | { cachePoint: { type: 'default' } };

interface ConverseRequest {
  modelId: string;
  messages: Array<{ role: 'user' | 'assistant'; content: ConverseRequestBlock[] }>;
  system?: ConverseSystemBlock[];
  toolConfig?: {
    tools: Array<{
      toolSpec: {
        name: string;
        description: string;
        inputSchema: { json: Record<string, unknown> };
      };
    }>;
  };
  inferenceConfig: { maxTokens: number; temperature?: number };
  /** Where model-specific parameters live on this API — `thinking`, for one. */
  additionalModelRequestFields?: Record<string, unknown>;
}

interface ConverseResponse {
  output?: { message?: { role?: string; content?: Array<Record<string, unknown>> } };
  stopReason?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadInputTokens?: number;
    cacheWriteInputTokens?: number;
  };
}

/**
 * Only the two constructors and the one method this file calls.
 *
 * Written out rather than imported as types, because the package is an optional
 * dependency: `import type` from a module that may not be installed fails
 * `npm run typecheck` in a fresh clone that skipped optional dependencies, and
 * failing a typecheck for a package nobody on the Anthropic path needs is
 * exactly the friction the dynamic import exists to avoid.
 */
interface BedrockModule {
  BedrockRuntimeClient: new (config: {
    region?: string;
    maxAttempts?: number;
  }) => {
    send(
      command: unknown,
      options?: { abortSignal?: AbortSignal }
    ): Promise<ConverseResponse>;
  };
  ConverseCommand: new (input: ConverseRequest) => unknown;
}

/* ─── model quirks, in this provider's spelling ─── */

/**
 * The same two quirks `anthropic.ts` documents at length — `temperature` was
 * removed from the current models, and some of them think unless told not to —
 * but keyed on Bedrock's ids, which are a different string for the same model:
 * `anthropic.claude-opus-5`, or `us.anthropic.claude-sonnet-4-5-20250929-v1:0`
 * with a cross-region prefix. That is the reason these lists are duplicated per
 * adapter instead of shared: one list would have to hold both spellings of
 * every model, and a mismatch would read as the other provider's bug.
 *
 * Read the comments on ACCEPTS_TEMPERATURE and THINKS_BY_DEFAULT in
 * anthropic.ts for why the allowlist points the direction it does, and for the
 * honest cost of asking for thinking to be off.
 */
const ACCEPTS_TEMPERATURE: RegExp[] = [
  /^claude-3/,
  /^claude-(opus|sonnet)-4-[0-6]\b/,
  /^claude-haiku-4-/,
];

const THINKS_BY_DEFAULT: RegExp[] = [/^claude-opus-5\b/, /^claude-sonnet-5\b/];

/** `us.anthropic.claude-opus-5` -> `claude-opus-5`. */
function baseModelName(modelId: string): string {
  const marker = 'anthropic.';
  const at = modelId.indexOf(marker);
  return at === -1 ? modelId : modelId.slice(at + marker.length);
}

const matches = (modelId: string, patterns: RegExp[]): boolean => {
  const base = baseModelName(modelId);
  return patterns.some((pattern) => pattern.test(base));
};

/* ─── this repo's types -> Converse ─── */

/**
 * The system prompt, with the cache breakpoint as its own list element.
 *
 * The breakpoint means "cache everything up to and including this block", which
 * on this API is expressed by putting a `cachePoint` element *after* the block
 * it applies to. Empty text blocks are dropped for the same reason as in the
 * Anthropic adapter: a rendered notes block is empty for an operator who has
 * been told nothing, and an empty text block is a validation error.
 */
function systemToWire(system: SystemBlock[]): ConverseSystemBlock[] {
  const blocks: ConverseSystemBlock[] = [];
  for (const block of system) {
    if (block.text.trim() === '') continue;
    blocks.push({ text: block.text });
    if (block.cacheBreakpoint) blocks.push({ cachePoint: { type: 'default' } });
  }
  return blocks;
}

function blockToWire(block: ContentBlock): ConverseRequestBlock {
  switch (block.type) {
    case 'text':
      return { text: block.text };

    case 'tool_use':
      // The id goes back exactly as it arrived. Reconstructing it is how the
      // next request gets rejected for a toolUseId nobody wrote.
      return { toolUse: { toolUseId: block.id, name: block.name, input: block.input } };

    case 'tool_result':
      return {
        toolResult: {
          toolUseId: block.toolUseId,
          // An empty content block is a validation error here too, and a tool
          // that found nothing is a normal outcome — see the same guard in
          // anthropic.ts.
          content: [{ text: block.content.trim() === '' ? '(no output)' : block.content }],
          // A refusal is reported to the model as an error result so it can
          // correct itself on the next step, rather than being thrown and
          // losing a run that was otherwise fine.
          status: block.isError ? 'error' : 'success',
        },
      };
  }
}

function messagesToWire(messages: Message[]): ConverseRequest['messages'] {
  return messages.map((message) => ({
    role: message.role,
    content: message.content.map(blockToWire),
  }));
}

function toolConfigToWire(tools: ToolSpec[]): NonNullable<ConverseRequest['toolConfig']> {
  return {
    tools: tools.map((tool) => ({
      toolSpec: {
        name: tool.name,
        description: tool.description,
        inputSchema: { json: tool.inputSchema },
      },
    })),
  };
}

/** Exported for the tests, which assert the mapping without an AWS account. */
export function toConverseRequest(request: CompletionRequest): ConverseRequest {
  const wire: ConverseRequest = {
    modelId: request.model,
    messages: messagesToWire(request.messages),
    inferenceConfig: { maxTokens: request.maxTokens },
  };

  const system = systemToWire(request.system);
  if (system.length > 0) wire.system = system;

  // Omitted, not empty. `toolConfig: { tools: [] }` is a validation error on
  // this API — the field is either absent or has at least one tool — and an
  // empty tool list is legal in the boundary, meaning "answer from what you
  // have". This is one of the two places the two adapters genuinely differ.
  if (request.tools.length > 0) wire.toolConfig = toolConfigToWire(request.tools);

  if (request.temperature !== undefined && matches(request.model, ACCEPTS_TEMPERATURE)) {
    wire.inferenceConfig.temperature = request.temperature;
  }

  if (matches(request.model, THINKS_BY_DEFAULT)) {
    wire.additionalModelRequestFields = { thinking: { type: 'disabled' } };
  }

  return wire;
}

/* ─── Converse -> this repo's types ─── */

function blockFromWire(raw: Record<string, unknown>): ContentBlock {
  if (typeof raw.text === 'string') {
    return { type: 'text', text: raw.text };
  }

  const toolUse = raw.toolUse as
    | { toolUseId?: string; name?: string; input?: unknown }
    | undefined;
  if (toolUse) {
    // `input` stays unknown all the way to `executeTool`, which is where the
    // tool's own validator decides.
    return {
      type: 'tool_use',
      id: String(toolUse.toolUseId ?? ''),
      name: String(toolUse.name ?? ''),
      input: toolUse.input,
    };
  }

  // Loud, for the reason spelled out in anthropic.ts: a block the boundary
  // cannot carry is a block the loop cannot replay, and a dropped one surfaces
  // two steps later as a validation error about message content.
  throw new Error(
    `bedrock returned a content block this provider boundary cannot carry: ` +
      `${Object.keys(raw).join(', ') || '(empty block)'}. ContentBlock in ` +
      'src/agent/providers/types.ts covers text, tool_use and tool_result only. If this is a ' +
      'reasoningContent block, the model thinks by default and this adapter did not recognise ' +
      'it as one — see THINKS_BY_DEFAULT in bedrock.ts.'
  );
}

/** Converse's vocabulary for why the turn ended, narrowed to what the loop
 * branches on. `guardrail_intervened` and `content_filtered` become `other` and
 * survive in `rawStopReason`, which is the only place they can be seen. */
function stopFromWire(raw: string | undefined): CompletionStop {
  switch (raw) {
    case 'end_turn':
      return 'end_turn';
    case 'tool_use':
      return 'tool_use';
    case 'max_tokens':
      return 'max_tokens';
    default:
      return 'other';
  }
}

/**
 * Four counters folded into two, as in the Anthropic adapter.
 *
 * Worth one honest caveat: this assumes Converse reports cache reads and writes
 * *alongside* `inputTokens` rather than inside it. Unverified against a live
 * response — nothing in this port has run against Bedrock. If the assumption is
 * wrong the cached tokens are charged twice, which stops a run early rather
 * than letting it run long, and the budget is fail-closed on purpose: over-
 * charging is the mistake it should be making. The private original summed only
 * inputTokens + outputTokens and therefore under-charged every cached prefix.
 */
function usageFromWire(raw: ConverseResponse['usage']): Usage {
  const n = (value: unknown): number =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;

  return {
    input:
      n(raw?.inputTokens) + n(raw?.cacheReadInputTokens) + n(raw?.cacheWriteInputTokens),
    output: n(raw?.outputTokens),
  };
}

/** Exported for the tests, which assert the mapping without an AWS account. */
export function fromConverseResponse(response: ConverseResponse): Completion {
  const blocks = response.output?.message?.content ?? [];
  const completion: Completion = {
    content: blocks.map(blockFromWire),
    stopReason: stopFromWire(response.stopReason),
    usage: usageFromWire(response.usage),
  };
  if (typeof response.stopReason === 'string') completion.rawStopReason = response.stopReason;
  return completion;
}

/* ─── failure and retry ─── */

/**
 * Which AWS failures are worth trying again.
 *
 * By name rather than by status, because that is how this SDK reports them and
 * because the names say what happened: throttling and a not-yet-warm model are
 * transient, a `ValidationException` is a malformed request that will fail
 * identically forever. The status check is a backstop for names added after
 * this was written.
 */
const RETRYABLE_ERRORS = new Set([
  'ThrottlingException',
  'TooManyRequestsException',
  'ServiceUnavailableException',
  'InternalServerException',
  'ModelNotReadyException',
  'ModelTimeoutException',
]);

function isRetryable(err: unknown): boolean {
  const name = (err as { name?: string })?.name;
  if (name && RETRYABLE_ERRORS.has(name)) return true;
  const status = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata
    ?.httpStatusCode;
  return status === 429 || (typeof status === 'number' && status >= 500);
}

const isAbort = (err: unknown): boolean =>
  err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');

function backoffMs(attempt: number): number {
  return 500 * 2 ** attempt + Math.floor(Math.random() * 250);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('The request was aborted.'));
      return;
    }
    let timer: ReturnType<typeof setTimeout>;
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error('The request was aborted.'));
    };
    timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** The service's own words, plus the request id, because that is what support
 * traces. A failure that says only "request failed" costs an hour. */
function describe(err: unknown, attempts: number, maxAttempts: number): string {
  const name = (err as { name?: string })?.name ?? 'Error';
  const message = err instanceof Error ? err.message : String(err);
  const meta = (err as { $metadata?: { httpStatusCode?: number; requestId?: string } })
    ?.$metadata;

  const parts = [`bedrock ${name}`];
  if (meta?.httpStatusCode) parts.push(`HTTP ${meta.httpStatusCode}`);
  if (message) parts.push(message);
  if (meta?.requestId) parts.push(`request-id ${meta.requestId}`);
  if (attempts > 1) parts.push(`after ${attempts} of ${maxAttempts} attempts`);
  return parts.join(' — ');
}

/* ─── the provider ─── */

export interface BedrockOptions {
  /**
   * Optional, and passed through only when set.
   *
   * Not defaulted here, and that is the interesting part: `us-east-1` is what
   * the private original defaults to and what `.env.example` ships, but a
   * default in this file would be handed to the client on every construction and
   * would silently override the region an AWS profile already names. Left
   * undefined, the SDK resolves it the way every other AWS tool does —
   * AWS_REGION, then the profile's config — and fails saying "Region is
   * missing", which is at least a sentence about regions.
   *
   * `providers/index.ts` owns every environment variable; this adapter reads
   * none. There is no key either: credentials come from the SDK's normal chain,
   * which is also why a missing credential cannot be told from a wrong one until
   * the first call.
   */
  region?: string;
  /** Total attempts, including the first. */
  maxAttempts?: number;
}

export function createBedrockProvider(options: BedrockOptions): Provider {
  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);

  /**
   * The client, built on first use.
   *
   * The import is dynamic so that nothing on the Anthropic path loads an AWS
   * SDK, and the failure is deferred to the first call rather than to
   * construction — the same trade `src/db.ts` makes for the connection pool,
   * for the same reason: a module that throws at import makes every unrelated
   * test depend on a package it does not use.
   */
  let clientPromise: Promise<InstanceType<BedrockModule['BedrockRuntimeClient']>> | undefined;
  let commandCtor: BedrockModule['ConverseCommand'] | undefined;

  async function ready(): Promise<{
    client: InstanceType<BedrockModule['BedrockRuntimeClient']>;
    ConverseCommand: BedrockModule['ConverseCommand'];
  }> {
    if (!clientPromise) {
      clientPromise = (async () => {
        // The specifier is a variable on purpose: with a literal, `tsc`
        // resolves the module at typecheck time, and a fresh clone that
        // installed without optional dependencies would fail `npm run
        // typecheck` on a package only the Bedrock path needs.
        const specifier = '@aws-sdk/client-bedrock-runtime';
        let mod: BedrockModule;
        try {
          mod = (await import(specifier)) as unknown as BedrockModule;
        } catch (err) {
          clientPromise = undefined;
          throw new Error(
            'PROVIDER=bedrock needs the AWS SDK, which is not installed. Run ' +
              '`npm install @aws-sdk/client-bedrock-runtime` (it is an optional dependency, so ' +
              'an install with --omit=optional skips it), or set PROVIDER=anthropic to use the ' +
              `Anthropic API instead. The import failed with: ${
                err instanceof Error ? err.message : String(err)
              }`,
            { cause: err }
          );
        }
        commandCtor = mod.ConverseCommand;
        return new mod.BedrockRuntimeClient({
          region: options.region,
          // Retry lives in one place, and this is it.
          //
          // The SDK retries throttling on its own by default (three attempts,
          // adaptive backoff). Left on, its loop multiplies with the one below —
          // up to nine calls for one step, and a wall clock nobody predicted, on
          // a run whose whole point is that its limits are checked before it
          // spends. So the SDK's retries are turned off and the policy here is
          // the only one, matching the Anthropic adapter attempt for attempt.
          maxAttempts: 1,
        });
      })();
    }
    const client = await clientPromise;
    // Set alongside the client above; the assertion is for the type, not a
    // claim about ordering.
    return { client, ConverseCommand: commandCtor as BedrockModule['ConverseCommand'] };
  }

  return {
    id: 'bedrock',

    async complete(request: CompletionRequest): Promise<Completion> {
      const { client, ConverseCommand } = await ready();
      const input = toConverseRequest(request);

      for (let attempt = 0; ; attempt++) {
        try {
          const response = await client.send(new ConverseCommand(input), {
            // Without this the wall-clock budget is only checked between steps,
            // so a request that hangs is bounded by nothing.
            abortSignal: request.signal,
          });
          return fromConverseResponse(response);
        } catch (err) {
          // A cancelled run is not a failed provider. Rethrown untouched so the
          // name survives for whoever is distinguishing the two.
          if (isAbort(err)) throw err;
          const last = attempt >= maxAttempts - 1;
          if (last || !isRetryable(err)) {
            throw new Error(describe(err, attempt + 1, maxAttempts), { cause: err });
          }
          await sleep(backoffMs(attempt), request.signal);
        }
      }
    },
  };
}
