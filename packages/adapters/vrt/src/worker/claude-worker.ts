import Anthropic from '@anthropic-ai/sdk';
import {
  appError, type AppError, type Application, type DelegatedTaskRunner, type DelegatedTaskStep,
  type WorkerToolCall, type WorkerToolDefinition, type WorkerToolResult,
} from '@vdoc-server/application';
import { err, ok, type Result } from '@vdoc-server/domain';
import { DEFAULT_CLAUDE_MODEL, afterLastFallback } from '../providers/claude-text';
import type { RealtimeLogger } from '../realtime-host';

type MessageParam = Anthropic.Beta.BetaMessageParam;
type ContentBlockParam = Anthropic.Beta.BetaContentBlockParam;
type ToolResultBlockParam = Anthropic.Beta.BetaToolResultBlockParam;

/** Models that accept `fallbacks: "default"` (server-side refusal fallback). */
const DEFAULT_FALLBACK_MODELS = new Set(['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']);
/** Model requests per task, server-side search continuations included. */
const MAX_STEPS = 16;
const MAX_TOOLS = 32;
/** Older exchanges are dropped once a conversation grows past this many messages. */
const MAX_MESSAGES = 80;
const MAX_RESULT_CHARS = 200_000;
const MAX_CONVERSATIONS = 256;
const FAILED_REPLY = 'Sorry, the assistant could not finish that.';
const REFUSAL_REPLY = 'Sorry, I can’t help with that.';

export type WorkerHandlers = Pick<Application, 'authorizeDelegatedTask' | 'getVoiceSession' | 'reviewToolCall' | 'recordToolResult'>;

export interface ClaudeWorkerOptions {
  readonly apiKey: string;
  readonly model?: string;
  /** The worker's system prompt. */
  readonly instructions: string;
  readonly handlers: WorkerHandlers;
  readonly logger?: RealtimeLogger;
  /** For tests: a client double. */
  readonly client?: Pick<Anthropic, 'beta'>;
  readonly ids?: () => string;
}

interface PendingTask {
  readonly id: string;
  readonly turnId: string;
  steps: number;
  /** Calls the client runs, in the order the model made them. */
  calls: WorkerToolCall[];
  /** Results already known on the server: calls the review refused. */
  refused: ToolResultBlockParam[];
}

interface Conversation {
  readonly sessionId: string;
  messages: MessageParam[];
  tools: Anthropic.Beta.BetaTool[];
  task?: PendingTask;
  tail: Promise<unknown>;
}

/**
 * The worker of the worker-speaker profile: Claude with Anthropic's web search,
 * editing through the client's document tools.
 *
 * One conversation per voice session, so a follow-up ("yes, delete it") reaches
 * the worker that asked. Every tool call Claude makes is reviewed by the session
 * under the speaker's turn before the client may run it; refused calls go back to
 * Claude as errors without a round trip. The conversation lives in memory, like
 * the session's realtime room.
 */
export class ClaudeWorker implements DelegatedTaskRunner {
  readonly #client: Pick<Anthropic, 'beta'>;
  readonly #model: string;
  readonly #conversations = new Map<string, Conversation>();
  readonly #ids: () => string;

  constructor(private readonly options: ClaudeWorkerOptions) {
    this.#client = options.client ?? new Anthropic({ apiKey: options.apiKey });
    this.#model = options.model ?? DEFAULT_CLAUDE_MODEL;
    this.#ids = options.ids ?? (() => `task_${crypto.randomUUID()}`);
  }

  start: DelegatedTaskRunner['start'] = async (input) => {
    const authorized = await this.options.handlers.authorizeDelegatedTask.execute(input);
    if (!authorized.ok) return authorized;
    const tools = toTools(input.tools);
    if (!tools.ok) return tools;
    const { sessionId, turnId, request } = authorized.value;
    const conversation = this.#conversation(sessionId);
    return this.#serialize(conversation, async () => {
      // A new request while calls are out: their results will never be needed.
      if (conversation.task) this.#append(conversation, 'user', [...conversation.task.refused, ...conversation.task.calls.map((call) => errorResult(call.callId, 'SUPERSEDED', 'The user moved on to a new request.'))]);
      conversation.tools = tools.value;
      trim(conversation);
      this.#append(conversation, 'user', [{ type: 'text', text: request }]);
      const task: PendingTask = { id: this.#ids(), turnId, steps: 0, calls: [], refused: [] };
      conversation.task = task;
      return ok(await this.#advance(conversation, task));
    });
  };

  submit: DelegatedTaskRunner['submit'] = async (input) => {
    const view = await this.options.handlers.getVoiceSession.execute(input);
    if (!view.ok) return view;
    if (view.value.status !== 'active') return err(appError('SESSION_CLOSED', 'This voice session has ended.'));
    const conversation = this.#conversations.get(view.value.sessionId);
    if (!conversation) return err(appError('NOT_FOUND', 'No such task.'));
    return this.#serialize(conversation, async () => {
      const task = conversation.task;
      if (!task || task.id !== input.taskId || task.calls.length === 0) return err(appError('NOT_FOUND', 'No such task.'));
      const byId = new Map(input.results.map((result) => [result.callId, result]));
      const results = task.calls.map((call) => {
        const result = byId.get(call.callId);
        void this.options.handlers.recordToolResult.execute({
          sessionId: conversation.sessionId, callId: call.callId, name: call.name, turnId: task.turnId,
          ok: result?.ok ?? false, ...(result?.ok ? {} : { code: result ? 'FAILED' : 'NO_RESULT' }),
        }).catch((error: unknown) => this.#log('error', 'recording a worker tool result failed', { sessionId: conversation.sessionId, error: String(error) }));
        return result ? toolResult(call.callId, result) : errorResult(call.callId, 'NO_RESULT', 'The client returned no result for this call.');
      });
      this.#append(conversation, 'user', [...task.refused, ...results]);
      task.calls = [];
      task.refused = [];
      return ok(await this.#advance(conversation, task));
    });
  };

  /** Asks Claude until it needs the client or is done. */
  async #advance(conversation: Conversation, task: PendingTask): Promise<DelegatedTaskStep> {
    const done = (reply: string): DelegatedTaskStep => {
      if (conversation.task === task) delete conversation.task;
      return { taskId: task.id, status: 'done', reply };
    };
    while (task.steps++ < MAX_STEPS) {
      let message: Anthropic.Beta.BetaMessage;
      try {
        message = await this.#request(conversation);
      } catch (error) {
        this.#log('error', 'worker request failed', { sessionId: conversation.sessionId, error: error instanceof Anthropic.APIError ? `${error.status} ${error.message}` : String(error) });
        return done(FAILED_REPLY);
      }
      const content = afterLastFallback(message.content);
      // Thinking and search blocks are replayed unchanged on the next request.
      this.#append(conversation, 'assistant', content as ContentBlockParam[]);
      if (message.stop_reason === 'pause_turn') continue;
      if (message.stop_reason === 'refusal') return done(textOf(content) || REFUSAL_REPLY);
      const uses = content.filter((block) => block.type === 'tool_use');
      if (uses.length === 0) return done(textOf(content) || FAILED_REPLY);
      for (const use of uses) {
        const decision = await this.options.handlers.reviewToolCall.execute({
          sessionId: conversation.sessionId, callId: use.id, name: use.name, arguments: use.input, turnId: task.turnId,
        });
        if (decision.kind === 'allow') task.calls.push({ callId: use.id, name: use.name, arguments: use.input });
        else task.refused.push(errorResult(use.id, decision.kind === 'confirm' ? 'CONFIRMATION_REQUIRED' : decision.code, decision.message));
      }
      if (task.calls.length > 0) return { taskId: task.id, status: 'calls', calls: task.calls };
      this.#append(conversation, 'user', task.refused);
      task.refused = [];
    }
    return done(FAILED_REPLY);
  }

  #request(conversation: Conversation): Promise<Anthropic.Beta.BetaMessage> {
    const fallback = DEFAULT_FALLBACK_MODELS.has(this.#model);
    return this.#client.beta.messages.stream({
      model: this.#model,
      max_tokens: 64_000,
      betas: ['thinking-binding-controls-2026-08-01', ...(fallback ? ['server-side-fallback-2026-07-01' as const] : [])],
      ...(fallback ? { fallbacks: 'default' as const } : {}),
      // Trimming old exchanges edits the history; drop thinking that no longer matches instead of failing.
      thinking: { type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' } },
      output_config: { effort: 'medium' },
      cache_control: { type: 'ephemeral' },
      system: this.options.instructions,
      tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 5 }, ...conversation.tools],
      messages: conversation.messages,
    }).finalMessage();
  }

  #conversation(sessionId: string): Conversation {
    let conversation = this.#conversations.get(sessionId);
    if (!conversation) {
      conversation = { sessionId, messages: [], tools: [], tail: Promise.resolve() };
      this.#conversations.set(sessionId, conversation);
      while (this.#conversations.size > MAX_CONVERSATIONS) this.#conversations.delete(this.#conversations.keys().next().value!);
    }
    return conversation;
  }

  /** One step at a time per conversation: a step reads and appends the whole history. */
  #serialize<T>(conversation: Conversation, step: () => Promise<T>): Promise<T> {
    const next = conversation.tail.then(step);
    conversation.tail = next.catch(() => undefined);
    return next;
  }

  #append(conversation: Conversation, role: MessageParam['role'], blocks: ContentBlockParam[]): void {
    if (blocks.length === 0) return;
    const last = conversation.messages.at(-1);
    if (last && last.role === role && role === 'user' && Array.isArray(last.content)) last.content.push(...blocks);
    else conversation.messages.push({ role, content: blocks });
  }

  #log(level: 'debug' | 'info' | 'warn' | 'error', message: string, fields: Record<string, unknown>): void {
    this.options.logger?.log(level, message, fields);
  }
}

function toTools(tools: readonly WorkerToolDefinition[]): Result<Anthropic.Beta.BetaTool[], AppError> {
  if (!Array.isArray(tools) || tools.length > MAX_TOOLS) return err(appError('INVALID_INPUT', `"tools" must be an array of at most ${MAX_TOOLS} tools.`));
  const valid = tools.every((tool) => tool !== null && typeof tool === 'object' && typeof tool.name === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(tool.name)
    && typeof tool.description === 'string' && tool.parameters !== null && typeof tool.parameters === 'object');
  if (!valid) return err(appError('INVALID_INPUT', 'Each tool needs a name, a description and JSON Schema parameters.'));
  return ok(tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.parameters as Anthropic.Beta.BetaTool.InputSchema })));
}

/** Drops the oldest exchanges; the history then starts at a request, never at a tool result. */
function trim(conversation: Conversation): void {
  if (conversation.messages.length <= MAX_MESSAGES) return;
  const from = conversation.messages.findIndex((message, index) => index >= conversation.messages.length - MAX_MESSAGES && isRequest(message));
  conversation.messages = from < 0 ? [] : conversation.messages.slice(from);
}

function isRequest(message: MessageParam): boolean {
  return message.role === 'user' && Array.isArray(message.content) && message.content.every((block) => block.type === 'text');
}

function textOf(content: readonly Anthropic.Beta.BetaContentBlock[]): string {
  return content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('').trim();
}

function toolResult(callId: string, result: WorkerToolResult): ToolResultBlockParam {
  const text = JSON.stringify(result.output ?? null) ?? 'null';
  return {
    type: 'tool_result', tool_use_id: callId,
    content: text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}… (truncated)` : text,
    ...(result.ok ? {} : { is_error: true }),
  };
}

function errorResult(callId: string, code: string, message: string): ToolResultBlockParam {
  return { type: 'tool_result', tool_use_id: callId, content: JSON.stringify({ ok: false, code, message }), is_error: true };
}
