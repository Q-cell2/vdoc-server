import { VoiceSession, type DocumentId, type VoiceSessionId, type VoiceSessionRepository, type VoiceSessionSnapshot } from '@vdoc-server/domain';
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
export class DurableObjectVoiceSessionRepository implements VoiceSessionRepository {
  constructor(private readonly storage: KeyValueStorage, private readonly retainEndedMs = 7 * DAY, private readonly now: () => number = Date.now) {}

  async get(id: VoiceSessionId): Promise<VoiceSession | undefined> {
    const snapshot = await this.storage.get<VoiceSessionSnapshot>(PREFIX + id);
    return snapshot && VoiceSession.restore(snapshot);
  }

  async findUnended(documentId: DocumentId): Promise<VoiceSession[]> {
    const sessions: VoiceSessionSnapshot[] = [];
    for await (const rows of this.#pages(this.storage)) {
      for (const row of rows.values()) if (row.documentId === documentId && row.status !== 'ended') sessions.push(row);
    }
    return sessions.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)).map(VoiceSession.restore);
  }

  async save(session: VoiceSession): Promise<void> {
    const snapshot = session.toSnapshot();
    // A committed snapshot must always have a wake-up, even if the object is evicted immediately.
    await this.storage.transaction(async (tx) => {
      await tx.put(PREFIX + session.id, snapshot);
      const next = this.#deadline(snapshot);
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

  /** Candidates only: the application must reload each session and recheck its deadline before ending it. */
  async findOverdue(): Promise<string[]> {
    const ids: string[] = [];
    const now = this.now();
    for await (const rows of this.#pages(this.storage)) {
      for (const row of rows.values()) {
        if (row.status !== 'ended' && !VoiceSession.restore(row).isOpenAt(now)) ids.push(row.id);
      }
    }
    return ids;
  }

  async findPendingPublications(): Promise<string[]> {
    const ids: string[] = [];
    for await (const rows of this.#pages(this.storage)) {
      for (const row of rows.values()) if (row.pendingAuditEvents?.length) ids.push(row.id);
    }
    return ids;
  }

  /** Called by the alarm in the same command queue as HTTP and WebSocket commands. */
  async pruneAndSchedule(): Promise<void> {
    await this.storage.transaction(async (tx) => {
      const cutoff = this.now() - this.retainEndedMs;
      for await (const rows of this.#pages(tx)) {
        const stale = [...rows].filter(([, row]) => row.status === 'ended' && row.endedAt !== null && row.endedAt < cutoff && !row.pendingAuditEvents?.length).map(([key]) => key);
        if (stale.length > 0) await tx.delete(stale);
      }
      const next = await this.#nextDeadline(tx);
      if (next === undefined) await tx.deleteAlarm();
      else await tx.setAlarm(Math.max(this.now(), next));
    });
  }

  #deadline(row: VoiceSessionSnapshot): number | undefined {
    if (row.pendingAuditEvents?.length) return row.status === 'ended'
      ? this.now() + 30_000
      : Math.min(this.now() + 30_000, this.#sessionDeadline(row) ?? Infinity);
    return this.#sessionDeadline(row);
  }

  #sessionDeadline(row: VoiceSessionSnapshot): number | undefined {
    if (row.status === 'granted') return row.connectDeadline + 1; // Domain grants are open at the deadline itself.
    if (row.status === 'active' && row.startedAt !== null) return row.startedAt + row.limits.maxDurationMs;
    if (row.status === 'ended' && row.endedAt !== null) return row.endedAt + this.retainEndedMs + 1;
    return undefined;
  }

  async #nextDeadline(storage: StorageTransaction): Promise<number | undefined> {
    let next: number | undefined;
    for await (const rows of this.#pages(storage)) {
      for (const row of rows.values()) {
        const deadline = this.#deadline(row);
        if (deadline !== undefined && (next === undefined || deadline < next)) next = deadline;
      }
    }
    return next;
  }

  async *#pages(storage: StorageTransaction): AsyncGenerator<Map<string, VoiceSessionSnapshot>> {
    let startAfter: string | undefined;
    for (;;) {
      const rows = await storage.list<VoiceSessionSnapshot>({ prefix: PREFIX, limit: BATCH_SIZE, ...(startAfter === undefined ? {} : { startAfter }) });
      if (rows.size === 0) return;
      // Capture the cursor before the caller can delete this page.
      startAfter = [...rows.keys()].at(-1)!;
      yield rows;
      if (rows.size < BATCH_SIZE) return;
    }
  }
}
export { DurablePrincipalQuotaStore, PrincipalQuotaBinding } from './principal-quota';
