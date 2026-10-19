import type { DomainEvent } from '@vdoc-server/domain';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { DurableObjectAuditPublisher, type AuditStorage } from '../src';

class SqliteStorage implements AuditStorage {
  readonly db = new DatabaseSync(':memory:');
  failOn = '';
  readonly sql = {
    exec: <T extends Record<string, string | number | ArrayBuffer | null>>(query: string, ...bindings: (string | number | ArrayBuffer | null)[]): T[] => {
      if (query.startsWith('INSERT') && this.failOn && bindings.some((value) => typeof value === 'string' && value.includes(this.failOn))) throw new Error('disk failure');
      return this.db.prepare(query).all(...bindings.map((value) => value instanceof ArrayBuffer ? new Uint8Array(value) : value)) as T[];
    },
  };
  transactionSync<T>(run: () => T): T {
    this.db.exec('BEGIN');
    try { const result = run(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
}
const event = (type: string, extra: Record<string, unknown> = {}): DomainEvent => ({ type, aggregateId: 'vs_a', occurredAt: 100, ...extra });

describe('SQLite audit publisher', () => {
  it('survives publisher reconstruction and pages only the requested session in insertion order', async () => {
    const storage = new SqliteStorage();
    try {
      const sink = new DurableObjectAuditPublisher(storage);
      await sink.publish([event('VoiceSessionGranted'), event('VoiceSessionConnected'), event('TurnCompleted', { aggregateId: 'vs_b' }), event('VoiceSessionEnded')]);
      const restored = new DurableObjectAuditPublisher(storage);
      const first = restored.list('vs_a', 0, 2);
      expect(first.events.map((row) => row.event.type)).toEqual(['VoiceSessionGranted', 'VoiceSessionConnected']);
      expect(first.hasMore).toBe(true);
      const last = restored.list('vs_a', first.nextCursor, 2);
      expect(last.events.map((row) => row.event.type)).toEqual(['VoiceSessionEnded']);
      expect(last.hasMore).toBe(false);
      expect(restored.list('vs_a', last.nextCursor).events).toEqual([]);
      expect(() => restored.list("vs_a' OR 1=1")).toThrow(RangeError);
      expect(() => restored.list('vs_a', -1)).toThrow(RangeError);
      expect(() => restored.list('vs_a', 0, 201)).toThrow(RangeError);
    } finally { storage.db.close(); }
  });

  it('persists only allowed metadata and numeric metrics, including for future event types', async () => {
    const storage = new SqliteStorage();
    try {
      const sink = new DurableObjectAuditPublisher(storage);
      await sink.publish([
        event('ToolCallReviewed', { tool: 'read_document', decision: 'allow', risk: 'low', operations: ['text.insert', 'private document text'], arguments: { text: 'secret-content' }, fingerprint: 'secret-content' }),
        event('ToolCallCompleted', { ok: false, code: 'TIMEOUT', output: 'secret-content', message: 'secret-content' }),
        event('TurnCompleted', { timeToFirstAudioMs: 24, interruptLatencyMs: -1, modelToolCalls: 2, instructions: 'secret-content' }),
        event('VoiceSessionEnded', { reason: 'client', usage: { turns: 2, toolCalls: 3, title: 'secret-content' } }),
        event('FutureEvent', { text: 'secret-content' }),
      ]);
      const rows = sink.list('vs_a').events.map((row) => row.event);
      expect(JSON.stringify(rows)).not.toMatch(/secret-content|private document text|arguments|fingerprint|instructions/);
      expect(rows[0]).toMatchObject({ tool: 'read_document', operations: ['text.insert'] });
      expect(rows[2]).toMatchObject({ timeToFirstAudioMs: 24, modelToolCalls: 2 });
      expect(rows[2]).not.toHaveProperty('interruptLatencyMs');
      expect(rows[3]?.usage).toEqual({ turns: 2, toolCalls: 3 });
      expect(rows[4]).toEqual(event('FutureEvent'));
    } finally { storage.db.close(); }
  });

  it('rolls back an entire failed publication and propagates the storage failure', async () => {
    const storage = new SqliteStorage();
    try {
      const sink = new DurableObjectAuditPublisher(storage);
      storage.failOn = 'VoiceSessionConnected';
      await expect(sink.publish([event('VoiceSessionGranted'), event('VoiceSessionConnected')])).rejects.toThrow('disk failure');
      expect(sink.list('vs_a').events).toEqual([]);
      storage.failOn = '';
      await sink.publish([event('VoiceSessionGranted')]);
      expect(sink.list('vs_a').events).toHaveLength(1);
    } finally { storage.db.close(); }
  });

  it('uses ingestion time for retention and cleans expired rows on the next read or write', async () => {
    const storage = new SqliteStorage();
    let now = 1_000;
    try {
      const sink = new DurableObjectAuditPublisher(storage, 100, () => now);
      await sink.publish([event('VoiceSessionGranted', { occurredAt: 0 })]);
      now += 100;
      expect(sink.list('vs_a').events).toHaveLength(1);
      now++;
      expect(sink.list('vs_a').events).toEqual([]);
      await sink.publish([event('VoiceSessionConnected')]);
      now += 101;
      await sink.publish([event('VoiceSessionEnded')]);
      expect(sink.list('vs_a').events.map((row) => row.event.type)).toEqual(['VoiceSessionEnded']);
    } finally { storage.db.close(); }
  });
});
