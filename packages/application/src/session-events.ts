import { VoiceSessionId, err, ok, type Result } from '@vdoc-server/domain';
import type { AppError } from './errors';
import type { Clock, EventPublisher, RealtimeConnections } from './ports';
import type { SessionRecordStorage, SessionEvent } from './session-record';
import { nextSessionWake } from './session-record';

export interface SessionEventHandler {
  readonly key: string;
  handle(events: readonly SessionEvent[]): Promise<Result<void, AppError>>;
}
export class DisconnectEventHandler implements SessionEventHandler {
  readonly key = 'realtime-disconnect';
  constructor(private readonly connections: RealtimeConnections) {}
  async handle(events: readonly SessionEvent[]): Promise<Result<void, AppError>> {
    for (const event of events) {
      if (event.type === 'VoiceSessionEnded') await this.connections.close(VoiceSessionId.assume(event.aggregateId), event.reason);
    }
    return ok(undefined);
  }
}
/** At-least-once relay: all handlers run even if one fails; acknowledgement follows every success. */
export class RelaySessionOutbox {
  constructor(private readonly repository: SessionRecordStorage, private readonly handlers: readonly SessionEventHandler[],
    private readonly publisher: EventPublisher, private readonly clock: Clock) {}
  async execute(sessionId: string): Promise<Result<void, AppError>> {
    const record = await this.repository.getRecord(sessionId);
    if (!record?.outbox.length) return ok(undefined);
    let current = record;
    let failure: AppError | undefined;
    let thrown: unknown;
    const subscribers = [
      ...this.handlers.map((handler) => ({ key: handler.key, run: (events: readonly SessionEvent[]) => handler.handle(events) })),
      { key: 'publisher', run: async (events: readonly SessionEvent[]) => { await this.publisher.publish(events); return ok(undefined); } },
    ];
    for (const subscriber of subscribers) {
      const delivered = new Set(current.delivered?.[subscriber.key] ?? []);
      const pending = current.outbox.filter(event => !delivered.has(event.eventId));
      if (!pending.length) continue;
      try {
        const result = await subscriber.run(pending);
        if (!result.ok) { failure ??= result.error; continue; }
        const updated = { ...current, delivered: { ...current.delivered, [subscriber.key]: [
          ...delivered, ...pending.map(event => event.eventId),
        ] } };
        await this.repository.putRecord(updated);
        current = updated;
      } catch (error) { thrown ??= error; }
    }
    if (failure) return err(failure);
    if (thrown) throw thrown;
    const { nextWakeAt: _, ...clean } = { ...current, outbox: [], delivered: {} };
    const nextWakeAt = nextSessionWake(clean, this.clock.now());
    await this.repository.putRecord({ ...clean, ...(nextWakeAt !== undefined ? { nextWakeAt } : {}) });
    return ok(undefined);
  }
}
