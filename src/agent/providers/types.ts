/**
 * The provider boundary.
 *
 * One function — `complete` — and the smallest set of types the loop needs to
 * call it. Everything vendor-shaped lives on the far side: an adapter posts to
 * whatever endpoint it talks to and returns these types back.
 *
 * The boundary is drawn from what the loop does, not from what either vendor's
 * wire format looks like. The loop needs to: send a system prompt with one
 * cache breakpoint in it, send the conversation so far, send the tool
 * definitions, get back the assistant's turn *verbatim* so tool-use ids
 * survive, know whether that turn was tool calls or an answer, and know what
 * the call cost. That is the whole list, and nothing else belongs here.
 *
 * ── Why an interface at all ──
 *
 * A one-implementation interface is an assumption rather than an abstraction:
 * you only find out whether the boundary is in the right place once something
 * else has been fitted through it. Two adapters are expected here — the
 * Anthropic API, which this port uses, and Bedrock's Converse API, which the
 * private original runs on — and they disagree about enough to be a real test
 * of the shape. Converse names the fields `toolUse` / `toolResult` and carries
 * a cache breakpoint as its own array element; the Anthropic API names them
 * `tool_use` / `tool_result` and carries `cache_control` on the block it
 * applies to. Neither spelling appears below.
 *
 * The second reason is measurement: two models disagreeing about the same
 * records is something an eval suite should be able to record rather than
 * something you take on faith, and `Provider.id` plus the model id is what
 * makes a run attributable to one of them.
 */

/* ─── the conversation ─── */

/**
 * A block of content, in either direction.
 *
 * The tags are snake_case because that is the vocabulary the schema comments,
 * the trace and the docs already use; the field names are camelCase because
 * they are ours rather than any vendor's.
 *
 * `tool_use.input` is `unknown`, and it stays `unknown` all the way to
 * `executeTool`. It is a JSON value a language model produced. It has not been
 * validated by anything at the point this type describes it, and typing it as a
 * record of known keys would be a claim the boundary is not in a position to
 * make.
 */
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | {
      type: 'tool_result';
      /** The `id` of the `tool_use` block this answers. */
      toolUseId: string;
      /** What the model reads. Prose, bounded — see `ToolResult.content`. */
      content: string;
      /**
       * A refusal, a validation failure, an unknown tool name, a timeout.
       *
       * Flagged rather than thrown: the model reads it and can correct itself
       * on the next step, where a harness that throws on a bad tool call
       * teaches it nothing and loses a run that was otherwise fine. Adapters
       * map this to whatever their provider calls an error result.
       */
      isError?: boolean;
    };

/**
 * One turn.
 *
 * `content` is always an array of blocks, never a bare string, in both
 * directions. The convenience of a string form is not worth it: the assistant's
 * turn has to go back to the provider exactly as it arrived, and the moment
 * there are two representations someone reconstructs one from the other and
 * drops the tool-use ids — after which the next request is rejected and the
 * error names a field nobody wrote.
 *
 * There is no `system` role. The system prompt is a field on the request,
 * because it is not part of the conversation and is not trimmed with it.
 */
export interface Message {
  role: 'user' | 'assistant';
  content: ContentBlock[];
}

/**
 * A piece of the system prompt, and where the cache breakpoint goes.
 *
 * This exists as a list rather than a string for one reason: the notes the
 * agent has been told go *after* the cached prefix. They differ per operator
 * and change as the agent is told things, so inside the cached prefix they
 * would invalidate it on every run and re-bill the instructions along with
 * them. That decision cannot be expressed if the system prompt is one opaque
 * string, so the boundary carries it.
 *
 * A provider with no caching ignores the flag and is correct — it costs more,
 * it does not behave differently.
 */
export interface SystemBlock {
  text: string;
  /** Cache everything up to and including this block. */
  cacheBreakpoint?: boolean;
}

/* ─── tools ─── */

/**
 * A tool, as the provider needs to see it: a name, a sentence about when to use
 * it, and a JSON Schema for its arguments.
 *
 * This is only the *description* sent to the model. It carries no validator and
 * no implementation, and that separation is the point — the schema is a hint
 * the model follows most of the time, and the tool's own `validate` is what
 * actually decides. Nothing on this side of the boundary is a gate.
 */
export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema, passed through untouched. */
  inputSchema: Record<string, unknown>;
}

/* ─── the call ─── */

export interface CompletionRequest {
  /** The provider's own id for the model. Not interchangeable between
   * providers: `claude-opus-5` is an Anthropic API id and
   * `us.anthropic.claude-sonnet-4-5-20250929-v1:0` is a Bedrock one, and
   * crossing them fails as a 404 that reads like the wrong endpoint. */
  model: string;
  system: SystemBlock[];
  messages: Message[];
  /** Empty is legal and means "answer from what you have". */
  tools: ToolSpec[];
  maxTokens: number;
  /** Omitted, the provider's default. The loop asks for 0. */
  temperature?: number;
  /**
   * Optional, and the honest note is what happens without it: the budget's
   * wall-clock limit is checked between steps, so a request that hangs is not
   * bounded by anything. Passing a signal is what lets the run stop while there
   * is still time to write the answer and the trace. An adapter that ignores it
   * is not broken, only unbounded.
   */
  signal?: AbortSignal;
}

/**
 * Why the turn ended, normalised to the smallest set the loop branches on.
 *
 * - `tool_use` — the turn contains tool calls; execute them and continue.
 * - `end_turn` — an answer.
 * - `max_tokens` — the turn was CUT OFF mid-sentence. Kept separate from
 *   `end_turn` even though the loop treats both as "not a tool call", because
 *   a truncated answer and a complete one look identical to a caller and only
 *   one of them should be believed. Collapsing this into `end_turn` is how
 *   silent truncation gets reported as an answer.
 * - `other` — anything else a provider invents: a stop sequence, a content
 *   filter, a refusal, a pause. The union does not grow every time a vendor
 *   adds one; `rawStopReason` carries the detail for the trace.
 */
export type CompletionStop = 'end_turn' | 'tool_use' | 'max_tokens' | 'other';

/**
 * What one call cost, in tokens.
 *
 * Reported on every call, not optional, because the budget is fail-closed and
 * it cannot fail closed on a number it cannot see. Four limits guard the run
 * and one of them is total tokens; a provider that omits usage turns that limit
 * off silently, and the run that goes wrong is the expensive kind.
 *
 * Zero means *unknown*, and the budget charges unknown pessimistically rather
 * than as free (`Budget.recordStep`). So an adapter reports what the provider
 * told it and nothing else: no estimate, no guess from string lengths. A
 * fabricated number is worse than a zero, because zero is handled.
 *
 * Cache reads and cache writes are folded into `input` by the adapter. They are
 * not separate fields here on purpose — the budget sums input + output, and a
 * field it does not know about is a cost nobody charges.
 */
export interface Usage {
  input: number;
  output: number;
}

export interface Completion {
  /**
   * The assistant's turn, exactly as it came back.
   *
   * The loop appends this to `messages` unaltered. An adapter maps the wire
   * format into `ContentBlock[]` and must not drop blocks it does not
   * understand or rewrite the ids: a reconstructed turn loses the tool-use id
   * and the next request is rejected.
   */
  content: ContentBlock[];
  stopReason: CompletionStop;
  /** The provider's own word for it, for the trace. Useful precisely when
   * `stopReason` is `other` and nobody can guess what happened. */
  rawStopReason?: string;
  usage: Usage;
}

/**
 * A model provider.
 *
 * Two things live behind this interface and not in the loop:
 *
 * - **Retry.** Only for throttling, and with backoff. Which errors are
 *   transient is a vendor question (a `ThrottlingException` name, a 429, an
 *   `overloaded_error` body), and the loop has no business knowing the answer.
 *   A validation error is never retried: trying it again produces the same
 *   error more slowly.
 * - **Failure.** `complete` rejects. A provider outage is not a tool refusal —
 *   the model cannot correct itself out of the endpoint being down — so it is
 *   not converted into something the model reads. The run ends and says so.
 *
 * There is no streaming method. Progress is a callback on the one loop rather
 * than a second implementation of it: the last time something in this directory
 * existed in two forms, one of them ran for weeks with the wrong tools
 * registered and nothing could see it.
 */
export interface Provider {
  /**
   * Which adapter answered — `'anthropic'`, `'bedrock'`. Recorded per run
   * alongside the model id, because a regression after a model change and a
   * regression after a prompt change are different investigations and a pass
   * count cannot tell them apart.
   */
  readonly id: string;
  complete(request: CompletionRequest): Promise<Completion>;
}
