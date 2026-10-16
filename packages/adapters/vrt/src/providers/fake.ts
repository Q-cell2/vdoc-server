import type { AudioChunk } from '@vrealtime/core';
import { VirtualClock, fakeModel } from '@vrealtime/testing';
import type { ModelProvider } from '../model-registry';

/** What the fake model does with one typed message. */
export interface FakeReply {
  readonly say: string;
  readonly toolCalls?: readonly { readonly name: string; readonly arguments: unknown }[];
}

export type FakeResponder = (text: string) => FakeReply;

/** Default: echoes the text, and reads the document when asked to. */
export const echoResponder: FakeResponder = (text) => {
  if (!text) return { say: 'Done.' };
  const wantsRead = /\bread\b|读/i.test(text);
  return { say: `(dev model) You said: ${text}`, ...(wantsRead ? { toolCalls: [{ name: 'read_document', arguments: {} }] } : {}) };
};

const PCM = { encoding: 'pcm16', sampleRate: 24000, channels: 1 } as const;
const silence = (ms: number): AudioChunk => ({ data: new Uint8Array(48 * ms), format: PCM, durationMs: ms });

/**
 * A scripted model for development and tests: no network, no API key. Responds
 * to typed text (`session.send()` on the client); it does not understand audio.
 * Never use in production (configuration refuses it).
 */
export function fakeProvider(options: { respond?: FakeResponder; tickMs?: number } = {}): ModelProvider & { stop(): void } {
  const respond = options.respond ?? echoResponder;
  const clock = new VirtualClock();
  const tick = options.tickMs ?? 10;
  let timer: ReturnType<typeof setInterval> | undefined;
  let counter = 0;
  return {
    id: 'fake',
    stop: () => {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    },
    create: () => {
      if (timer === undefined) {
        timer = setInterval(() => clock.advance(tick), tick);
        (timer as { unref?: () => void }).unref?.();
      }
      let lastText = '';
      return fakeModel({
        clock,
        capabilities: { tools: { autoReplyAfterResult: false } },
        onCommand(command, session) {
          if (command.type === 'sendText') lastText = command.text;
          if (command.type !== 'respond') return;
          const id = `fake-r${++counter}`;
          const reply = respond(lastText);
          lastText = '';
          session.schedule({ type: 'response.start', responseId: id }, 10);
          session.schedule({ type: 'output.transcript', responseId: id, itemId: `${id}-a`, delta: reply.say }, 20);
          session.schedule({ type: 'output.audio', responseId: id, itemId: `${id}-a`, chunk: silence(20) }, 20);
          (reply.toolCalls ?? []).forEach((call, index) => {
            session.schedule({ type: 'tool.call', responseId: id, callId: `${id}-c${index}`, name: call.name, arguments: call.arguments }, 30 + index);
          });
          session.schedule({ type: 'response.end', responseId: id, status: 'done' }, 40 + (reply.toolCalls?.length ?? 0));
        },
      });
    },
  };
}
