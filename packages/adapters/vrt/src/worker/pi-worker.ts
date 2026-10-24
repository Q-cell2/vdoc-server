import { Agent, type StreamFn } from '@earendil-works/pi-agent-core';
import { createModels } from '@earendil-works/pi-ai/models';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import type { TSchema } from '@earendil-works/pi-ai';
import type { ToolSpec, Usage } from '@vrealtime/core';

export type WorkerEvent =
  | { type: 'start' }
  | { type: 'text'; delta: string }
  | { type: 'arguments'; callId: string; name: string; delta: string }
  | { type: 'turn-end'; usage: Usage };

export interface WorkerRequest {
  instructions: string;
  prompt: string;
  tools: readonly ToolSpec[];
}
export interface WorkerContext {
  signal: AbortSignal;
  emit(event: WorkerEvent): void;
  execute(callId: string, name: string, args: unknown): Promise<unknown>;
  /** Delivers what the user says while this task runs; the worker reads it before its next model request. */
  onSteer?(listener: (message: string) => void): () => void;
}
export interface WorkerRunner {
  run(request: WorkerRequest, context: WorkerContext): Promise<string>;
}
export interface PiWorkerOptions {
  apiKey: string;
  model?: string;
  maxRequests?: number;
  /** Provider stream injection for deterministic tests; the real Pi loop still runs. */
  streamFn?: StreamFn;
}

/** One Pi agent per delegated task; no coding-agent shell, files, or ambient tools. */
export function createPiWorker(options: PiWorkerOptions): WorkerRunner {
  const models = createModels();
  models.setProvider(anthropicProvider());
  const modelId = options.model ?? 'claude-sonnet-5-5';
  const model = models.getModel('anthropic', modelId);
  if (!model) throw new Error(`Unknown Pi worker model: ${modelId}`);
  const stream: StreamFn = options.streamFn ?? ((choice, context, call) => models.streamSimple(choice, context, { ...call, apiKey: options.apiKey, maxTokens: 8192 }));
  return {
    async run(request, context) {
      context.signal.throwIfAborted();
      let requests = 0;
      let text = '';
      let finalText: string | undefined;
      let failure: string | undefined;
      let returnedChars = 0;
      const agent = new Agent({
        initialState: {
          model, thinkingLevel: 'low', systemPrompt: request.instructions,
          tools: request.tools.map(spec => ({
            name: spec.name, label: spec.name, description: spec.description,
            parameters: spec.parameters as TSchema,
            async execute(callId, args) {
              context.signal.throwIfAborted();
              const output = await context.execute(callId, spec.name, args);
              context.signal.throwIfAborted();
              const content = JSON.stringify(output ?? null);
              returnedChars += content.length;
              if (returnedChars > 160_000) throw new Error('Worker tool result budget exceeded');
              return { content: [{ type: 'text' as const, text: content }], details: undefined,
                isError: typeof output === 'object' && output !== null && (('ok' in output && output.ok === false) || 'error' in output) };
            },
          })),
        },
        toolExecution: 'sequential', streamFn: stream,
        getApiKey: () => options.apiKey,
        prepareRequest() {
          context.signal.throwIfAborted();
          if (++requests > (options.maxRequests ?? 12)) throw new Error('Worker generation budget exceeded');
        },
      });
      const unsubscribe = agent.subscribe(event => {
        if (context.signal.aborted) return;
        if (event.type === 'message_start' && event.message.role === 'assistant') {
          text = '';
          context.emit({ type: 'start' });
        } else if (event.type === 'message_update') {
          const part = event.assistantMessageEvent;
          if (part.type === 'text_delta') {
            text += part.delta;
            if (text.length > 16_000) { failure = 'Worker text budget exceeded'; agent.abort(); return; }
            context.emit({ type: 'text', delta: part.delta });
          } else if (part.type === 'toolcall_delta') {
            const call = part.partial.content[part.contentIndex];
            if (call?.type === 'toolCall' && call.id && call.name) context.emit({ type: 'arguments', callId: call.id, name: call.name, delta: part.delta });
          }
        } else if (event.type === 'turn_end' && event.message.role === 'assistant') {
          const message = event.message;
          if (message.stopReason === 'error' || message.stopReason === 'aborted' || message.stopReason === 'length') {
            failure = `Worker stopped: ${message.stopReason}`;
          } else if (message.content.some(block => block.type === 'toolCall')) {
            context.emit({ type: 'turn-end', usage: { inputTokens: message.usage.input, outputTokens: message.usage.output } });
          } else {
            finalText = message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('');
          }
        }
      });
      const offSteer = context.onSteer?.(message => agent.steer({ role: 'user', content: [{ type: 'text', text: message }], timestamp: Date.now() }));
      const abort = () => agent.abort();
      context.signal.addEventListener('abort', abort, { once: true });
      try {
        await agent.prompt(request.prompt);
        context.signal.throwIfAborted();
        if (failure || !finalText?.trim()) throw new Error(failure ?? 'Worker ended without a final reply');
        return finalText;
      } finally {
        context.signal.removeEventListener('abort', abort);
        offSteer?.();
        unsubscribe();
      }
    },
  };
}
