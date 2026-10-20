import type { RealtimeModel, RealtimeSession } from '@vrealtime/core';

export interface ModelLifecycle {
  opened(session: RealtimeSession): void;
  closed(session: RealtimeSession): void;
  /**
   * The user finished an utterance or sent a text message: audio was committed,
   * text was sent, or the provider's own turn detection saw speech end.
   * One utterance may be reported more than once; only "has there been input since" matters.
   * Transcripts are deliberately not counted: a late transcript belongs to an earlier utterance.
   */
  userInput?(session: RealtimeSession): void;
}

/**
 * Decorator: reports when the runtime opens and closes model sessions and when
 * the user gives input, without changing their behaviour. The runtime closes a
 * model session when its client is gone for good (no resume) or when the server
 * shuts the session down.
 */
export function withLifecycle(model: RealtimeModel, lifecycle: ModelLifecycle): RealtimeModel {
  return {
    provider: model.provider,
    id: model.id,
    capabilities: model.capabilities,
    async connect(config, options) {
      const session = await model.connect(config, options);
      lifecycle.opened(session);
      const stopListening = session.on('input.speech.end', () => lifecycle.userInput?.(session));
      let closed = false;
      const close = session.close.bind(session);
      return new Proxy(session, {
        get(target, property, receiver) {
          if (property === 'close') {
            return async () => {
              try {
                await close();
              } finally {
                if (!closed) {
                  closed = true;
                  stopListening();
                  lifecycle.closed(session);
                }
              }
            };
          }
          if (property === 'commitAudio' || property === 'sendText') {
            const send = (target[property] as (...args: unknown[]) => void).bind(target);
            return (...args: unknown[]) => {
              lifecycle.userInput?.(session);
              send(...args);
            };
          }
          const value: unknown = Reflect.get(target, property, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }) satisfies RealtimeSession;
    },
  };
}
