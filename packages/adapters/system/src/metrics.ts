import type { EventPublisher } from '@vdoc-server/application';
import type { DomainEvent } from '@vdoc-server/domain';
import type { Logger } from './index';

const FIELDS: Readonly<Record<string, { metric: string; strings: readonly string[]; numbers: readonly string[] }>> = {
  TurnCompleted: { metric: 'turn.completed', strings: ['turnId'], numbers: ['toolCalls'] },
  TurnTelemetry: { metric: 'turn.telemetry', strings: ['turnId'], numbers: ['modelToolCalls', 'timeToFirstAudioMs', 'timeToFirstToolCallMs', 'interruptLatencyMs'] },
  ToolCallReviewed: { metric: 'tool.reviewed', strings: ['turnId', 'callId', 'tool', 'risk', 'decision', 'code'], numbers: [] },
  ToolCallCompleted: { metric: 'tool.completed', strings: ['turnId', 'callId', 'tool', 'code'], numbers: [] },
};
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** One structured point per turn/review/result, for log queries and downstream metrics pipelines. */
export class TurnMetricsPublisher implements EventPublisher {
  constructor(private readonly logger: Logger) {}

  async publish(events: readonly DomainEvent[]): Promise<void> {
    for (const event of events) {
      const schema = FIELDS[event.type];
      if (!schema || !TOKEN.test(event.aggregateId) || !Number.isFinite(event.occurredAt) || event.occurredAt < 0) continue;
      const input = event as DomainEvent & Record<string, unknown>;
      const fields: Record<string, unknown> = { metrics: true, metric: schema.metric, sessionId: event.aggregateId, occurredAt: event.occurredAt, count: 1 };
      for (const field of schema.strings) {
        const value = input[field];
        if (typeof value === 'string' && TOKEN.test(value)) fields[field] = value;
      }
      for (const field of schema.numbers) {
        const value = input[field];
        const count = field === 'toolCalls' || field === 'modelToolCalls';
        if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && (!count || Number.isSafeInteger(value))) fields[field] = value;
      }
      if (event.type === 'ToolCallCompleted' && typeof input.ok === 'boolean') fields.ok = input.ok;
      this.logger.log('info', 'voice metrics', fields);
    }
  }
}
