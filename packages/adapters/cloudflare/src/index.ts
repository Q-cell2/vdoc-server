import { migrateSessionRecord, nextSessionWake, type SessionRecord, type SessionRepository } from '@vdoc-server/application';
import { VoiceSession, type DocumentId, type VoiceSessionId, type VoiceSessionSnapshot } from '@vdoc-server/domain';
export { DurableObjectAuditPublisher, type AuditPage, type AuditRecord, type AuditStorage } from './audit';

export interface StorageTransaction {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(keys: string[]): Promise<number>;
  list<T>(options: { prefix: string; limit: number; startAfter?: string }): Promise<Map<string, T>>;
  getAlarm(): Promise<number | null>;
  setAlarm(time: number): Promise<void>;
  deleteAlarm(): Promise<void>;
}

/** Structural subset of DurableObjectStorage; the SQLite-backed object's KV API is durable too. */
export interface KeyValueStorage extends StorageTransaction {
  transaction<T>(callback: (transaction: StorageTransaction) => Promise<T>): Promise<T>;
}

/** Storage input gates do not protect awaits on signing, authentication or realtime I/O. */
export class SerialCommandQueue {
  #tail: Promise<unknown> = Promise.resolve();

  run<T>(command: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(command);
    // A rejected command must not prevent the next request or alarm from running.
    this.#tail = result.catch(() => undefined);
    return result;
  }
}

const PREFIX = 'voice-session:';
const DAY = 86_400_000;
const BATCH_SIZE = 128;

/** One repository per document. The runtime must serialize complete application commands, not just saves. */
export class DurableObjectVoiceSessionRepository implements SessionRepository {
  constructor(private readonly storage: KeyValueStorage, private readonly retainEndedMs = 7 * DAY, private readonly now: () => number = Date.now) {}

  async get(id: VoiceSessionId): Promise<VoiceSession | undefined> {
    const record = await this.getRecord(id);
    return record && VoiceSession.restore(record.session);
  }
  async getRecord(id: string): Promise<SessionRecord | undefined> {
    const raw = await this.storage.get<SessionRecord | VoiceSessionSnapshot>(PREFIX + id);
    return raw && migrateSessionRecord(raw);
  }
  async *records(): AsyncGenerator<SessionRecord> {
    for await (const rows of this.#pages(this.storage)) for (const row of rows.values()) yield row;
  }
  async removeRecords(ids: readonly string[]): Promise<void> {
    for (let i = 0; i < ids.length; i += BATCH_SIZE) await this.storage.delete(ids.slice(i, i + BATCH_SIZE).map(id => PREFIX + id));
  }
  async schedule(nextWakeAt: number | undefined): Promise<void> {
    if (nextWakeAt === undefined) await this.storage.deleteAlarm();
    else await this.storage.setAlarm(Math.max(this.now(), nextWakeAt));
  }
  async findUnended(documentId: DocumentId): Promise<VoiceSession[]> {
    const records: SessionRecord[] = [];
    for await (const record of this.records()) if (record.session.documentId === documentId && record.session.status !== 'ended') records.push(record);
    return records.sort((a,b) => a.session.createdAt - b.session.createdAt || a.session.id.localeCompare(b.session.id)).map(r => VoiceSession.restore(r.session));
  }
  async save(session: VoiceSession): Promise<void> {
    const old = await this.getRecord(session.id);
    const record = old ? { ...old, session: session.toSnapshot() } : migrateSessionRecord(session.toSnapshot());
    const nextWakeAt = nextSessionWake(record, this.now(), this.retainEndedMs);
    await this.putRecord({ ...record, ...(nextWakeAt !== undefined ? { nextWakeAt } : {}) });
  }
  /** Atomically persist a precomputed wake-up with its envelope. No domain deadline rules here. */
  async putRecord(record: SessionRecord): Promise<void> {
    await this.storage.transaction(async tx => {
      await tx.put(PREFIX + record.session.id, record);
      const next = record.nextWakeAt;
      const alarm = await tx.getAlarm();
      if (next !== undefined && (alarm === null || next < alarm)) await tx.setAlarm(Math.max(this.now(), next));
    });
  }

  /** Backfill alarms for snapshots written by older deployments, without postponing an existing alarm. */
  async ensureAlarm(): Promise<void> {
    await this.storage.transaction(async (tx) => {
      if (await tx.getAlarm() !== null) return;
      const next = await this.#nextDeadline(tx);
      if (next !== undefined) await tx.setAlarm(Math.max(this.now(), next));
    });
  }

  async #nextDeadline(storage: StorageTransaction): Promise<number | undefined> {
    let next: number | undefined;
    for await (const rows of this.#pages(storage)) {
      for (const row of rows.values()) {
        const deadline = row.nextWakeAt ?? nextSessionWake(row, this.now(), this.retainEndedMs);
        if (deadline !== undefined && (next === undefined || deadline < next)) next = deadline;
      }
    }
    return next;
  }

  async *#pages(storage: StorageTransaction): AsyncGenerator<Map<string, SessionRecord>> {
    let startAfter: string | undefined;
    for (;;) {
      const rows = await storage.list<SessionRecord | VoiceSessionSnapshot>({ prefix: PREFIX, limit: BATCH_SIZE, ...(startAfter === undefined ? {} : { startAfter }) });
      if (rows.size === 0) return;
      // Capture the cursor before the caller can delete this page.
      startAfter = [...rows.keys()].at(-1)!;
      yield new Map([...rows].map(([key, row]) => [key, migrateSessionRecord(row)]));
      if (rows.size < BATCH_SIZE) return;
    }
  }
}
export { DurablePrincipalQuotaStore, PrincipalQuotaBinding } from './principal-quota';
