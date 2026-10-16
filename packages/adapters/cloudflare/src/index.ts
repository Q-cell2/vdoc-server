import { VoiceSession, type DocumentId, type VoiceSessionId, type VoiceSessionRepository, type VoiceSessionSnapshot } from '@vdoc-server/domain';

/** The slice of `DurableObjectStorage` the repository uses; structural, so tests can pass a Map-backed fake. */
export interface KeyValueStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(keys: string[]): Promise<number>;
  list<T>(options: { prefix: string }): Promise<Map<string, T>>;
}

const PREFIX = 'voice-session:';
const DAY = 86_400_000;

/**
 * Voice sessions in a Durable Object's storage. One object per document, so the
 * object's single-threaded execution serialises every command on that
 * document's sessions (no lost updates without explicit locking).
 */
export class DurableObjectVoiceSessionRepository implements VoiceSessionRepository {
  constructor(private readonly storage: KeyValueStorage, private readonly retainEndedMs = 7 * DAY, private readonly now: () => number = Date.now) {}

  async get(id: VoiceSessionId): Promise<VoiceSession | undefined> {
    const snapshot = await this.storage.get<VoiceSessionSnapshot>(PREFIX + id);
    return snapshot && VoiceSession.restore(snapshot);
  }

  async findUnended(documentId: DocumentId): Promise<VoiceSession[]> {
    const rows = await this.storage.list<VoiceSessionSnapshot>({ prefix: PREFIX });
    return [...rows.values()]
      .filter((row) => row.documentId === documentId && row.status !== 'ended')
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((row) => VoiceSession.restore(row));
  }

  async save(session: VoiceSession): Promise<void> {
    await this.storage.put(PREFIX + session.id, session.toSnapshot());
    if (session.status === 'ended') await this.#pruneEnded();
  }

  /** Ended sessions are kept for support and audit look-ups, then dropped so storage stays bounded. */
  async #pruneEnded(): Promise<void> {
    const cutoff = this.now() - this.retainEndedMs;
    const rows = await this.storage.list<VoiceSessionSnapshot>({ prefix: PREFIX });
    const stale = [...rows].filter(([, row]) => row.status === 'ended' && row.endedAt !== null && row.endedAt < cutoff).map(([key]) => key);
    if (stale.length > 0) await this.storage.delete(stale);
  }
}
