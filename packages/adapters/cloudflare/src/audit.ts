import type { EventPublisher } from '@vdoc-server/application';
import { VoiceSessionId, type DomainEvent } from '@vdoc-server/domain';

type SqlValue = string | number | ArrayBuffer | null;
export interface AuditStorage {
  readonly sql: { exec<T extends Record<string, SqlValue>>(query: string, ...bindings: SqlValue[]): Iterable<T> };
  transactionSync<T>(run: () => T): T;
}

export interface AuditRecord {
  readonly sequence: number;
  readonly event: DomainEvent & Readonly<Record<string, unknown>>;
}
export interface AuditPage {
  readonly events: readonly AuditRecord[];
  readonly nextCursor: number;
  readonly hasMore: boolean;
}

const METADATA: Readonly<Record<string, readonly string[]>> = {
  VoiceSessionGranted: ['documentId', 'principalId', 'profileId'],
  VoiceSessionGrantRenewed: [],
  VoiceSessionQuotaRejected: ['code', 'quotaKind'],
  VoiceSessionConnected: ['reconnect'],
  ToolCallReviewed: ['callId', 'tool', 'turnId', 'risk', 'decision', 'code'],
  ToolCallCompleted: ['callId', 'tool', 'turnId', 'ok', 'code'],
  TurnCompleted: ['turnId', 'toolCalls', 'modelToolCalls', 'timeToFirstAudioMs', 'timeToFirstToolCallMs', 'interruptLatencyMs'],
  VoiceSessionEnded: ['reason', 'durationMs'],
};
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

/** Explicit metadata projection: newly added event properties cannot accidentally persist content. */
function project(event: DomainEvent): DomainEvent & Record<string, unknown> {
  if (!VoiceSessionId.parse(event.aggregateId).ok || !TOKEN.test(event.type) || !finite(event.occurredAt)) throw new Error('Invalid audit event metadata.');
  const input = event as DomainEvent & Record<string, unknown>;
  const result: DomainEvent & Record<string, unknown> = { type: event.type, aggregateId: event.aggregateId, occurredAt: event.occurredAt };
  for (const key of [...(METADATA[event.type] ?? []), 'eventId', 'requestId', 'clientId', 'userId', 'principalId', 'documentId', 'usageUnit', 'usageDelta']) {
    const value = input[key];
    if (typeof value === 'boolean' || finite(value) || (typeof value === 'string' && TOKEN.test(value))) result[key] = value;
  }
  if (typeof input.settlementId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/.test(input.settlementId)) result.settlementId = input.settlementId;
  if (event.type === 'ToolCallReviewed' && Array.isArray(input.operations)) {
    result.operations = input.operations.filter((value): value is string => typeof value === 'string' && TOKEN.test(value)).slice(0, 64);
  }
  if (event.type === 'VoiceSessionEnded' && input.usage && typeof input.usage === 'object') {
    const usage = input.usage as Record<string, unknown>;
    result.usage = Object.fromEntries(['turns', 'toolCalls'].filter((key) => finite(usage[key])).map((key) => [key, usage[key]]));
  }
  return result;
}

/** Durable metadata sink in the document's existing SQLite database; no extra cloud binding. */
export class DurableObjectAuditPublisher implements EventPublisher {
  constructor(private readonly storage: AuditStorage, private readonly retainMs = 30 * 86_400_000, private readonly now: () => number = Date.now) {
    if (!Number.isFinite(retainMs) || retainMs <= 0) throw new RangeError('Audit retention must be positive.');
    storage.sql.exec('CREATE TABLE IF NOT EXISTS voice_audit_events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, recorded_at INTEGER NOT NULL, payload TEXT NOT NULL)');
    storage.sql.exec('CREATE TABLE IF NOT EXISTS voice_audit_settlements (id TEXT PRIMARY KEY, recorded_at INTEGER NOT NULL)');
    storage.sql.exec('CREATE INDEX IF NOT EXISTS voice_settlement_retention ON voice_audit_settlements(recorded_at)');
    storage.sql.exec('CREATE INDEX IF NOT EXISTS voice_audit_session ON voice_audit_events(session_id, sequence)');
    storage.sql.exec('CREATE INDEX IF NOT EXISTS voice_audit_retention ON voice_audit_events(recorded_at)');
  }

  async publish(events: readonly DomainEvent[]): Promise<void> {
    if (events.length === 0) return;
    const safe = events.map(project);
    this.storage.transactionSync(() => {
      this.#prune();
      for (const event of safe) {
        const deliveryId = event.settlementId ?? event.eventId;
        if (typeof deliveryId === 'string') {
          if ([...this.storage.sql.exec('SELECT id FROM voice_audit_settlements WHERE id = ?', deliveryId)].length) continue;
          this.storage.sql.exec('INSERT INTO voice_audit_settlements(id, recorded_at) VALUES (?, ?)', deliveryId, this.now());
        }
        this.storage.sql.exec('INSERT INTO voice_audit_events(session_id, recorded_at, payload) VALUES (?, ?, ?)', event.aggregateId, this.now(), JSON.stringify(event));
      }
    });
  }

  list(sessionId: string, after = 0, limit = 100): AuditPage {
    if (!VoiceSessionId.parse(sessionId).ok || !Number.isSafeInteger(after) || after < 0 || !Number.isInteger(limit) || limit < 1 || limit > 200) throw new RangeError('Invalid audit query.');
    this.#prune();
    const rows = [...this.storage.sql.exec<{ sequence: number; payload: string }>('SELECT sequence, payload FROM voice_audit_events WHERE session_id = ? AND sequence > ? ORDER BY sequence LIMIT ?', sessionId, after, limit + 1)];
    const events = rows.slice(0, limit).map((row) => ({ sequence: row.sequence, event: JSON.parse(row.payload) as AuditRecord['event'] }));
    return { events, nextCursor: events.at(-1)?.sequence ?? after, hasMore: rows.length > limit };
  }

  #prune(): void {
    this.storage.sql.exec('DELETE FROM voice_audit_events WHERE recorded_at < ?', this.now() - this.retainMs);
    this.storage.sql.exec('DELETE FROM voice_audit_settlements WHERE recorded_at < ?', this.now() - this.retainMs);
  }
}
