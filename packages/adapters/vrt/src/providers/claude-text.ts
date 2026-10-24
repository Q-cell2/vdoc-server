import Anthropic from '@anthropic-ai/sdk';
import type { ChatMessage, TextModel, TextPart, TextRequest } from '@vrealtime/cascade';
import type { StopReason } from '@vrealtime/core';

type ContentBlock = Anthropic.Beta.BetaContentBlock;
type ContentBlockParam = Anthropic.Beta.BetaContentBlockParam;
type MessageParam = Anthropic.Beta.BetaMessageParam;

export const DEFAULT_CLAUDE_MODEL = 'claude-opus-5-5';

/** Models that accept `fallbacks: "default"` (server-side refusal fallback). */
const DEFAULT_FALLBACK_MODELS = new Set(['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']);
/** Assistant turns whose exact content is kept for replay; older turns fall back to text and tool calls. */
const MAX_REMEMBERED_TURNS = 256;
const REFUSAL_REPLY = 'Sorry, I can’t help with that.';

function claudeStopReason(reason: string | null): StopReason {
  switch (reason) {
    case 'end_turn': case 'stop_sequence': return 'completed';
    case 'tool_use': return 'tool_calls';
    case 'max_tokens': return 'max_tokens';
    case 'pause_turn': return 'pause';
    case 'refusal': return 'refusal';
    default: return 'unknown';
  }
}

export interface ClaudeTextOptions {
  readonly apiKey: string;
  readonly model?: string;
  /** For tests: a client double. */
  readonly client?: Pick<Anthropic, 'beta'>;
}

/**
 * Claude as a cascade text model, through the official SDK.
 *
 * The cascade keeps its own history (text and tool calls only), but Claude's
 * thinking blocks must be sent back unchanged with the turn that produced them.
 * Each assistant turn's content is therefore remembered and replayed in place of
 * the cascade's copy. When the cascade edits history (it cuts a reply to what the
 * user heard, or a context update changes the instructions), the request asks the
 * API to drop the thinking blocks that no longer match instead of failing.
 */
export function claudeText(options: ClaudeTextOptions): TextModel {
  const model = options.model ?? DEFAULT_CLAUDE_MODEL;
  const client = options.client ?? new Anthropic({ apiKey: options.apiKey });
  const remembered = new Map<string, ContentBlockParam[]>();

  return {
    id: model,
    async *stream(request: TextRequest, { signal }): AsyncIterable<TextPart> {
      const fallback = DEFAULT_FALLBACK_MODELS.has(model);
      const stream = client.beta.messages.stream({
        model,
        max_tokens: 64_000,
        betas: ['thinking-binding-controls-2026-08-01', ...(fallback ? ['server-side-fallback-2026-07-01' as const] : [])],
        ...(fallback ? { fallbacks: 'default' as const } : {}),
        thinking: { type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' } },
        // Spoken replies are short and latency-bound.
        output_config: { effort: 'low' },
        ...(request.instructions ? { system: request.instructions } : {}),
        messages: toMessages(request.messages, remembered),
        ...(request.tools.length > 0 ? {
          tools: request.tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.parameters as Anthropic.Beta.BetaTool.InputSchema })),
          tool_choice: request.toolChoice === 'none' ? { type: 'none' as const } : { type: 'auto' as const },
        } : {}),
      }, { signal });

      let spoke = false;
      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          spoke = true;
          yield { type: 'text', delta: event.delta.text };
        }
      }
      const message = await stream.finalMessage();
      const content = afterLastFallback(message.content);
      if (message.stop_reason === 'refusal' && !spoke) yield { type: 'text', delta: REFUSAL_REPLY };
      for (const block of content) {
        if (block.type === 'tool_use') yield { type: 'tool-call', callId: block.id, name: block.name, arguments: block.input };
      }
      remember(remembered, content);
      yield { type: 'finish', stopReason: claudeStopReason(message.stop_reason), ...(message.stop_reason !== null && /^[A-Za-z0-9_.:-]{1,80}$/.test(message.stop_reason) ? { rawStopReason: message.stop_reason } : {}), usage: { inputTokens: message.usage.input_tokens, outputTokens: message.usage.output_tokens } };
    },
  };
}

/**
 * After a mid-output fallback, thinking and tool calls before the last `fallback`
 * block belong to the model that declined and must not be replayed or run; text
 * before it was already spoken and stays.
 */
export function afterLastFallback(content: readonly ContentBlock[]): ContentBlock[] {
  let boundary = content.length - 1;
  while (boundary >= 0 && content[boundary]!.type !== 'fallback') boundary--;
  if (boundary < 0) return [...content];
  return [...content.slice(0, boundary).filter((block) => block.type === 'text'), ...content.slice(boundary + 1)];
}

function remember(remembered: Map<string, ContentBlockParam[]>, content: readonly ContentBlock[]): void {
  const replay = content.flatMap(toParam);
  const text = replay.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('');
  const toolCallIds = replay.flatMap((block) => (block.type === 'tool_use' ? [block.id] : []));
  remembered.set(turnKey(text, toolCallIds), replay);
  while (remembered.size > MAX_REMEMBERED_TURNS) remembered.delete(remembered.keys().next().value!);
}

/** Tool turns are recognised by their first call ID, which survives the cascade cutting the text. */
function turnKey(text: string, toolCallIds: readonly string[]): string {
  return toolCallIds.length > 0 ? `tool:${toolCallIds[0]}` : `text:${text}`;
}

function toParam(block: ContentBlock): ContentBlockParam[] {
  switch (block.type) {
    case 'thinking': return [{ type: 'thinking', thinking: block.thinking, signature: block.signature }];
    case 'redacted_thinking': return [{ type: 'redacted_thinking', data: block.data }];
    case 'text': return block.text ? [{ type: 'text', text: block.text }] : [];
    case 'tool_use': return [{ type: 'tool_use', id: block.id, name: block.name, input: block.input }];
    default: return [];
  }
}

/** Cascade history → Messages API turns; consecutive tool results go back in one user message. */
export function toMessages(history: readonly ChatMessage[], remembered: ReadonlyMap<string, ContentBlockParam[]> = new Map()): MessageParam[] {
  const messages: MessageParam[] = [];
  const append = (role: MessageParam['role'], blocks: ContentBlockParam[]): void => {
    if (blocks.length === 0) return;
    const last = messages.at(-1);
    if (last && last.role === role && role === 'user' && Array.isArray(last.content)) last.content.push(...blocks);
    else messages.push({ role, content: blocks });
  };
  for (const message of history) {
    if (message.role === 'user') append('user', message.content ? [{ type: 'text', text: message.content }] : []);
    else if (message.role === 'tool') {
      append('user', [{ type: 'tool_result', tool_use_id: message.callId, content: typeof message.output === 'string' ? message.output : JSON.stringify(message.output ?? null) }]);
    } else {
      const calls = message.toolCalls ?? [];
      const replay = remembered.get(turnKey(message.content, calls.map((call) => call.callId)));
      append('assistant', replay ?? [
        ...(message.content ? [{ type: 'text' as const, text: message.content }] : []),
        ...calls.map((call) => ({ type: 'tool_use' as const, id: call.callId, name: call.name, input: call.arguments })),
      ]);
    }
  }
  return messages;
}
