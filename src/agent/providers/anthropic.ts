/**
 * The Anthropic Messages API, over plain `fetch`.
 *
 * No SDK, and that is a decision rather than an omission:
 *
 * - The dependency list stays honest. `pg` is the only runtime dependency, so a
 *   reader can check for themselves that nothing here phones anywhere else.
 * - This file doubles as documentation of the wire format. Every string in the
 *   mapping below is a field the API actually reads, so the translation between
 *   this repo's vocabulary (`toolUseId`, `cacheBreakpoint`) and the vendor's
 *   (`tool_use_id`, `cache_control`) is visible in one place instead of
 *   happening three layers inside a library.
 *
 * The cost is that retry, error shapes and cancellation are ours to get right,
 * and that is most of the length here. The mapping itself is about forty lines.
 *
 * ── What this adapter does NOT do ──
 *
 * No streaming, no thinking blocks, no server tools, no batching. The provider
 * boundary carries three kinds of content block (`types.ts`), and an adapter
 * that quietly returned a fourth would produce an assistant turn the loop
 * cannot replay. Where that is a live risk it is handled loudly rather than
 * silently — see `blockFromWire` and the note on thinking below.
 */

import { ProviderUnavailableError } from './types';
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

const ENDPOINT = 'https://api.anthropic.com/v1/messages';

/**
 * Required on every request. Without it the API rejects the call before it
 * looks at the body, with a message about a missing header — which reads like a
 * networking problem rather than a one-line omission. It is pinned rather than
 * tracked: the version is what promises the response shape this file parses.
 */
const API_VERSION = '2023-06-01';

/** Three tries total. See `isRetryable` for which failures earn them. */
const DEFAULT_MAX_ATTEMPTS = 3;

/**
 * A `retry-after` longer than this is ignored in favour of our own backoff.
 *
 * The header is honoured because the service knows more about its own load than
 * we do, but the run has a wall-clock budget measured in seconds and sleeping
 * for a minute inside one step spends all of it on waiting. Capped, so the
 * worst case is a failure the caller can see rather than a hang.
 */
const MAX_RETRY_AFTER_MS = 10_000;

/* ─── the wire format, as narrowly as this file needs it ─── */

/**
 * Deliberately hand-written rather than imported from a vendor package.
 *
 * These describe only the fields this adapter sends and reads. Everything is
 * optional on the way in because it is JSON off a socket: the response has not
 * been validated by anything at the point these types describe it, and a
 * required field here would be a promise this file is not in a position to
 * make.
 */
interface WireTextBlock {
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral' };
}

interface WireToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
}

interface WireToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: Array<{ type: 'text'; text: string }>;
  is_error?: boolean;
}

type WireRequestBlock = WireTextBlock | WireToolUseBlock | WireToolResultBlock;

interface WireRequest {
  model: string;
  max_tokens: number;
  system?: WireTextBlock[];
  messages: Array<{ role: 'user' | 'assistant'; content: WireRequestBlock[] }>;
  tools?: Array<{ name: string; description: string; input_schema: Record<string, unknown> }>;
  temperature?: number;
  thinking?: { type: 'disabled' };
}

interface WireResponse {
  content?: Array<Record<string, unknown>>;
  stop_reason?: string | null;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

/* ─── model quirks this adapter has to argue with ─── */

/**
 * Models that still accept `temperature`.
 *
 * An allowlist, and the direction matters. The current models removed the
 * sampling parameters outright and reject a request that carries one with a 400
 * naming the field — so with a list of models *known to refuse* it, the next
 * model released is the one that fails, and it fails on the first call of every
 * run. With a list of models known to *accept* it, the next model released
 * loses `temperature: 0` and answers with default sampling instead. That is a
 * real loss and a smaller one: the loop asks for 0 to make runs comparable, and
 * a temperature of 0 never guaranteed identical output anyway.
 *
 * `MODEL=claude-opus-5` is the documented default in `.env.example` and is in
 * the refusing set, so this is not a hypothetical: sent unconditionally,
 * `temperature` breaks the out-of-the-box configuration.
 */
const ACCEPTS_TEMPERATURE: RegExp[] = [
  /^claude-3/,
  /^claude-(opus|sonnet)-4-[0-6]\b/,
  /^claude-haiku-4-/,
];

/**
 * Models that think unless told not to, and accept being told not to.
 *
 * This is the one place the adapter overrides a model default, and the reason
 * is the shape of the boundary rather than a preference about reasoning.
 *
 * On these models an omitted `thinking` field means thinking is ON. The turn
 * then comes back with a `thinking` block in front of the tool calls, and
 * `types.ts` has no block for it: the loop would replay an assistant turn with
 * the thinking stripped, and the API rejects exactly that — the second step of
 * every multi-tool run, i.e. the first interesting thing the agent ever does,
 * would fail with an error naming a field nobody in this repo wrote.
 *
 * So thinking is asked off, and the honest cost is written down here rather
 * than discovered later. With thinking off these models occasionally (a) write
 * a tool call into their visible text instead of emitting a tool call, so the
 * turn succeeds and the call silently never runs, and (b) leak `<thinking>`
 * tags into the answer. Both are prompt-side, and both mitigations belong in
 * the system prompt when the loop lands: allow a brief sentence before a tool
 * call, and never instruct the model not to reason (that makes the tag leak
 * worse, not better).
 *
 * Turning thinking back on is a change to the boundary — a fourth block type
 * that round-trips verbatim — not a change to this file. Models that cannot
 * disable thinking at all (`claude-fable-5`, `claude-mythos-5`) are therefore
 * not usable here yet; they fail in `blockFromWire` with a sentence saying so.
 */
const THINKS_BY_DEFAULT: RegExp[] = [/^claude-opus-5\b/, /^claude-sonnet-5\b/];

const matches = (model: string, patterns: RegExp[]): boolean =>
  patterns.some((pattern) => pattern.test(model));

/* ─── this repo's types -> the wire ─── */

/**
 * The system prompt as a list of text blocks, with the cache breakpoint
 * expressed the way this API expresses it: `cache_control` on the last block
 * that should be cached, not a marker of its own.
 *
 * Empty blocks are dropped. A text block with no text is a 400, and the way one
 * arrives is ordinary: the notes block is rendered from whatever the operator
 * has been told, and a new operator has been told nothing. Dropping it is
 * strictly better than refusing the run, and if the dropped block was the one
 * carrying the breakpoint then the request is simply uncached — worth money,
 * not correctness.
 *
 * Caching is best-effort by design on this API: a prefix below the model's
 * minimum is silently not cached, with no error and no flag. `usage`
 * (folded into `Usage.input`) is the only place it shows up.
 */
function systemToWire(system: SystemBlock[]): WireTextBlock[] {
  const blocks: WireTextBlock[] = [];
  for (const block of system) {
    if (block.text.trim() === '') continue;
    blocks.push(
      block.cacheBreakpoint
        ? { type: 'text', text: block.text, cache_control: { type: 'ephemeral' } }
        : { type: 'text', text: block.text }
    );
  }
  return blocks;
}

/**
 * One content block, outbound.
 *
 * `tool_use` goes back with the id it arrived with. That is the whole reason
 * the loop keeps the assistant turn verbatim, and the reason this function
 * copies the id rather than deriving anything from it.
 */
function blockToWire(block: ContentBlock): WireRequestBlock {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text };

    case 'tool_use':
      return { type: 'tool_use', id: block.id, name: block.name, input: block.input };

    case 'tool_result': {
      const wire: WireToolResultBlock = {
        type: 'tool_result',
        tool_use_id: block.toolUseId,
        // An empty tool result is a 400 on this API, and a tool that found
        // nothing is a normal outcome rather than a bug — so the placeholder is
        // preferred to failing the run. It is deliberately dull: the model
        // reads it, and inventing something more descriptive here would be this
        // adapter putting words in a tool's mouth.
        content: [{ type: 'text', text: block.content.trim() === '' ? '(no output)' : block.content }],
      };
      // Sent only when true. `is_error: false` is legal and means the same as
      // absent; omitting it keeps the recorded request readable.
      if (block.isError) wire.is_error = true;
      return wire;
    }
  }
}

function messagesToWire(messages: Message[]): WireRequest['messages'] {
  return messages.map((message) => ({
    role: message.role,
    content: message.content.map(blockToWire),
  }));
}

function toolsToWire(tools: ToolSpec[]): NonNullable<WireRequest['tools']> {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    // Passed through untouched. It is a JSON Schema the tool owns; rewriting it
    // here would make the schema the model sees differ from the one the tool's
    // author reads.
    input_schema: tool.inputSchema,
  }));
}

/** Exported for the tests, which assert the mapping without a network. */
export function toWireRequest(request: CompletionRequest): WireRequest {
  const wire: WireRequest = {
    model: request.model,
    max_tokens: request.maxTokens,
    messages: messagesToWire(request.messages),
  };

  const system = systemToWire(request.system);
  if (system.length > 0) wire.system = system;

  // Omitted rather than sent empty. An empty tool list is legal here and means
  // "answer from what you have", which is also what omitting it means — and the
  // Bedrock adapter has to omit its `toolConfig` outright, so the two agree.
  if (request.tools.length > 0) wire.tools = toolsToWire(request.tools);

  if (request.temperature !== undefined && matches(request.model, ACCEPTS_TEMPERATURE)) {
    wire.temperature = request.temperature;
  }

  if (matches(request.model, THINKS_BY_DEFAULT)) wire.thinking = { type: 'disabled' };

  return wire;
}

/* ─── the wire -> this repo's types ─── */

function blockFromWire(raw: Record<string, unknown>): ContentBlock {
  const type = raw.type;

  if (type === 'text') {
    return { type: 'text', text: typeof raw.text === 'string' ? raw.text : '' };
  }

  if (type === 'tool_use') {
    // Not validated beyond being present. `input` stays `unknown` all the way
    // to `executeTool`, which is where a tool's own validator decides.
    return {
      type: 'tool_use',
      id: String(raw.id ?? ''),
      name: String(raw.name ?? ''),
      input: raw.input,
    };
  }

  // Loud, because the alternative is worse than a failed run.
  //
  // The block cannot be represented, so it cannot be replayed, so the next
  // request in this run would be an assistant turn missing something the API
  // requires — and that arrives as a 400 about message content two steps from
  // the cause. Failing here names the block, the model and the reason.
  throw new Error(
    `anthropic returned a "${String(type)}" content block, which this provider boundary ` +
      'cannot carry: ContentBlock in src/agent/providers/types.ts covers text, tool_use and ' +
      'tool_result only, and a turn replayed without this block is rejected by the API on the ' +
      'next step. If this is a "thinking" block, the model thinks by default and this adapter ' +
      'did not recognise it as one — see THINKS_BY_DEFAULT in anthropic.ts. Models whose ' +
      'thinking cannot be turned off (claude-fable-5, claude-mythos-5) are not usable here ' +
      'until the boundary carries a block that round-trips verbatim.'
  );
}

/**
 * Normalise the vendor's word for why the turn ended.
 *
 * Only three of them change what the loop does. Everything else — a stop
 * sequence, a refusal, a content filter, a pause, a value invented after this
 * was written — becomes `other`, and the original is kept in `rawStopReason`
 * so the trace can say what actually happened.
 */
function stopFromWire(raw: string | null | undefined): CompletionStop {
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
 * Fold the four token counters into two.
 *
 * Cache reads and cache writes are input tokens that were paid for, at
 * different rates. The budget sums input + output and knows nothing about
 * cache tiers, so a counter it cannot see is a cost nobody charges — and a
 * request whose prefix was 30k cached tokens would otherwise report as nearly
 * free.
 *
 * A missing field contributes 0 rather than an estimate. If the API reported
 * nothing at all the result is `{0, 0}`, which the budget charges
 * pessimistically (see `Budget.recordStep`); a number made up here would be
 * charged as though it were measured.
 */
function usageFromWire(raw: WireResponse['usage']): Usage {
  const n = (value: unknown): number =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;

  return {
    input:
      n(raw?.input_tokens) +
      n(raw?.cache_creation_input_tokens) +
      n(raw?.cache_read_input_tokens),
    output: n(raw?.output_tokens),
  };
}

/** Exported for the tests, which assert the mapping without a network. */
export function fromWireResponse(body: WireResponse): Completion {
  const blocks = Array.isArray(body.content) ? body.content : [];
  const completion: Completion = {
    content: blocks.map(blockFromWire),
    stopReason: stopFromWire(body.stop_reason),
    usage: usageFromWire(body.usage),
  };
  if (typeof body.stop_reason === 'string') completion.rawStopReason = body.stop_reason;
  return completion;
}

/* ─── failure, retry and cancellation ─── */

/**
 * Which HTTP statuses are worth trying again.
 *
 * 429 is throttling and 5xx is the service (529 is this API's "overloaded").
 * 408 and 409 are the ones the vendor's own SDKs retry, and they are here for
 * the same reason: a request that timed out or raced is not a request that was
 * wrong.
 *
 * 400 is absent on purpose. A validation error means the request is malformed —
 * a parameter this model removed, a tool_result with no matching tool_use — and
 * it will fail identically forever. Retrying it turns a five-second error into
 * a fifteen-second error and buries the message under two pointless attempts.
 * 401 and 403 are credentials, and 404 is usually a model id from the other
 * provider; none of them improve with waiting either.
 */
function isRetryable(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

/** Exponential with jitter. The jitter matters when several runs are throttled
 * at once, which is exactly when retries are happening. */
function backoffMs(attempt: number): number {
  return 500 * 2 ** attempt + Math.floor(Math.random() * 250);
}

function retryAfterMs(response: Response): number | undefined {
  const header = response.headers.get('retry-after');
  if (!header) return undefined;
  const seconds = Number(header);
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
}

const isAbort = (err: unknown): boolean =>
  err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');

/**
 * Sleep, but abortable.
 *
 * A plain `setTimeout` between attempts is invisible to the request's signal,
 * so a cancelled run would sit in a backoff nobody is waiting for any more —
 * which is the same bug as not passing the signal to `fetch`, one level up.
 */
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

/**
 * Describe a failed response using the API's own words.
 *
 * A provider failure that says only "request failed" costs an hour: the body
 * on a 400 usually names the exact field, and the request id is what support
 * can trace. So the body is read on every non-2xx — also because an unread
 * body holds the connection open — and everything useful goes in the message,
 * since a `catch` at the top of a run has nowhere else to look.
 */
async function describeFailure(
  response: Response,
  attempt: number,
  maxAttempts: number
): Promise<string> {
  let raw = '';
  try {
    raw = await response.text();
  } catch {
    /* a body that cannot be read is not the interesting part of this failure */
  }

  let detail = raw.slice(0, 500);
  try {
    const parsed = JSON.parse(raw) as { error?: { type?: string; message?: string } };
    if (parsed?.error?.message) {
      detail = parsed.error.type
        ? `${parsed.error.type}: ${parsed.error.message}`
        : parsed.error.message;
    }
  } catch {
    /* not JSON — the truncated text above is what there is */
  }

  const requestId = response.headers.get('request-id');
  const parts = [`anthropic ${response.status}`];
  if (detail) parts.push(detail);
  if (requestId) parts.push(`request-id ${requestId}`);
  if (attempt > 0) parts.push(`after ${attempt + 1} of ${maxAttempts} attempts`);
  return parts.join(' — ');
}

/* ─── the provider ─── */

export interface AnthropicOptions {
  /**
   * Required, and not read from the environment here.
   *
   * `providers/index.ts` owns every environment variable, so the failure for a
   * missing key is one sentence in one place rather than a different message
   * depending on which module happened to look first.
   */
  apiKey: string;
  /** For a proxy or a gateway. Default is the public endpoint. */
  baseUrl?: string;
  /** Total attempts, including the first. */
  maxAttempts?: number;
  /**
   * A seam for the tests, which drive the whole adapter — mapping, retry,
   * failure text — with no network and no key. Not a plugin point: anything
   * real belongs behind `baseUrl`.
   */
  fetch?: typeof fetch;
}

export function createAnthropicProvider(options: AnthropicOptions): Provider {
  const { apiKey } = options;
  const endpoint = options.baseUrl ?? ENDPOINT;
  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const fetchImpl = options.fetch ?? fetch;

  return {
    id: 'anthropic',

    async complete(request: CompletionRequest): Promise<Completion> {
      const body = JSON.stringify(toWireRequest(request));

      for (let attempt = 0; ; attempt++) {
        const last = attempt >= maxAttempts - 1;

        let response: Response;
        try {
          response = await fetchImpl(endpoint, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'anthropic-version': API_VERSION,
              'x-api-key': apiKey,
            },
            body,
            // Without this the wall-clock budget is only checked between steps,
            // so a request that hangs is bounded by nothing at all.
            signal: request.signal,
          });
        } catch (err) {
          // A cancelled run is not a failed provider. Rethrown untouched so the
          // name stays `AbortError` and the caller can tell the two apart.
          if (isAbort(err)) throw err;
          // Connection reset, DNS, TLS: transient by nature, and indistinguishable
          // from a 5xx from here.
          const reason = err instanceof Error ? err.message : String(err);
          if (last) {
            // ProviderUnavailableError, not a plain Error: this branch is only
            // reached when fetch itself threw, so the request never got an answer
            // and the caller has learned nothing about its own correctness. The
            // eval suite depends on being able to tell that apart from a wrong
            // answer — see the note on the class.
            throw new ProviderUnavailableError(
              `anthropic could not be reached after ${maxAttempts} attempts: ${reason}`,
              'anthropic',
              { cause: err }
            );
          }
          await sleep(backoffMs(attempt), request.signal);
          continue;
        }

        if (response.ok) {
          const raw = await response.text();
          let parsed: WireResponse;
          try {
            parsed = JSON.parse(raw) as WireResponse;
          } catch {
            // A 200 that is not JSON is nearly always something between here and
            // the API — a captive portal, a proxy error page — so the snippet is
            // the useful part.
            throw new Error(
              `anthropic returned a 200 that is not JSON: ${raw.slice(0, 200)}`
            );
          }
          return fromWireResponse(parsed);
        }

        const detail = await describeFailure(response, attempt, maxAttempts);
        if (last || !isRetryable(response.status)) throw new Error(detail);
        await sleep(retryAfterMs(response) ?? backoffMs(attempt), request.signal);
      }
    },
  };
}
