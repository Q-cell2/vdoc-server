import type { Clock, EventPublisher, IdGenerator } from '@vdoc-server/application';
import type { DomainEvent } from '@vdoc-server/domain';
export { TurnMetricsPublisher } from './metrics';

export const systemClock: Clock = { now: () => Date.now() };

export class RandomIdGenerator implements IdGenerator {
  next(prefix: string): string {
    return `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;
  }
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export interface Logger {
  log(level: LogLevel, message: string, fields?: Readonly<Record<string, unknown>>): void;
}

/** One JSON object per line, so any log pipeline (Workers Logs, Loki, CloudWatch) can index it. */
export class JsonLogger implements Logger {
  constructor(
    private readonly minimum: LogLevel = 'info',
    private readonly sink: (line: string) => void = (line) => console.log(line),
    private readonly base: Readonly<Record<string, unknown>> = {},
  ) {}

  log(level: LogLevel, message: string, fields: Readonly<Record<string, unknown>> = {}): void {
    if (RANK[level] < RANK[this.minimum]) return;
    this.sink(JSON.stringify({ time: new Date().toISOString(), level, message, ...this.base, ...fields }));
  }

  child(fields: Readonly<Record<string, unknown>>): JsonLogger {
    return new JsonLogger(this.minimum, this.sink, { ...this.base, ...fields });
  }
}
const RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/** Audit trail: every domain event becomes a log line. Events carry no document content by design. */
export class AuditLogPublisher implements EventPublisher {
  constructor(private readonly logger: Logger) {}

  async publish(events: readonly DomainEvent[]): Promise<void> {
    for (const event of events) {
      const { type, aggregateId, occurredAt, ...fields } = event as DomainEvent & Record<string, unknown>;
      this.logger.log('info', type, { audit: true, sessionId: aggregateId, occurredAt, ...fields });
    }
  }
}

/** Composite: fans events out to several publishers (audit log, metrics, a queue…). */
export class CompositeEventPublisher implements EventPublisher {
  constructor(private readonly publishers: readonly EventPublisher[]) {}

  async publish(events: readonly DomainEvent[]): Promise<void> {
    await Promise.all(this.publishers.map((publisher) => publisher.publish(events)));
  }
}
