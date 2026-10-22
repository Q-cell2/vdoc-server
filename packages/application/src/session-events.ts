import { VoiceSessionId, err, ok, type DomainEvent, type Result } from '@vdoc-server/domain';
import type { AppError } from './errors';
import type { Clock, EventPublisher, RealtimeConnections } from './ports';
import type { SessionRecordStorage, SessionEvent } from './session-record';
import { nextSessionWake } from './session-record';
import type { SessionQuotaService } from './session-quota-service';

export interface SessionEventHandler {
  readonly key: string;
  handle(events: readonly SessionEvent[]): Promise<Result<void, AppError>>;
}
export class QuotaEventHandler implements SessionEventHandler {
  readonly key = 'quota';
  constructor(private readonly quotas: SessionQuotaService) {}
  async handle(events: readonly SessionEvent[]): Promise<Result<void, AppError>> {
    const ended = new Set(events.filter(e => e.type === 'VoiceSessionEnded').map(e => e.aggregateId));
    for (const event of events) {
      let result: Result<void, AppError> = ok(undefined);
      if (event.type === 'VoiceSessionEnded') result = await this.quotas.release(event.principalId, event.aggregateId);
      else if (!ended.has(event.aggregateId) && (event.type === 'VoiceSessionGranted' || event.type === 'VoiceSessionGrantRenewed' || event.type === 'VoiceSessionConnected')) {
        result = await this.quotas.confirm(event.principalId, event.aggregateId);
      }
      if (!result.ok) return result;
    }
    return ok(undefined);
  }
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
/** Settlement projection is independent of persistence and attribution. IDs remain stable on replay. */
export class UsageSettlementPublisher implements EventPublisher {
  constructor(private readonly sink: EventPublisher) {}
  async publish(events: readonly DomainEvent[]): Promise<void> {
    await this.sink.publish(events.map((raw) => {
      const event = raw as DomainEvent & Record<string, unknown>;
      if (event.type === 'TurnCompleted') {
        return { ...event, settlementId: `${event.aggregateId}:turn:${event.turnId}`, usageUnit: 'turn', usageDelta: 1 };
      }
      if (event.type === 'ToolCallCompleted') {
        return { ...event, settlementId: `${event.aggregateId}:call:${event.callId}`, usageUnit: 'tool-result', usageDelta: 1 };
      }
      return event;
    }));
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
