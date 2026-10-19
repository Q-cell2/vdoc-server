import type { RealtimeModel, RealtimeSession } from '@vrealtime/core';

export interface ModelLifecycle {
  opened(session: RealtimeSession): void;
  closed(session: RealtimeSession): void;
}

/**
 * Decorator: reports when the runtime opens and closes model sessions, without
 * changing their behaviour. The runtime closes a model session when its client
 * is gone for good (no resume) or when the server shuts the session down.
 */
export function withLifecycle(model: RealtimeModel, lifecycle: ModelLifecycle): RealtimeModel {
  return {
    provider: model.provider,
    id: model.id,
    capabilities: model.capabilities,
    async connect(config, options) {
      const session = await model.connect(config, options);
      lifecycle.opened(session);
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
                  lifecycle.closed(session);
                }
              }
            };
          }
          const value: unknown = Reflect.get(target, property, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }) satisfies RealtimeSession;
    },
  };
}
