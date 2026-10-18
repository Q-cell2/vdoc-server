import { VoiceSession, type DocumentId, type VoiceSessionId, type VoiceSessionRepository, type VoiceSessionSnapshot } from '@vdoc-server/domain';

/** The slice of a `pg` `Pool` or `Client` the repository uses; structural, so the adapter needs no driver and tests can pass a fake. */
export interface SqlClient {
  query<R = Record<string, unknown>>(text: string, values?: readonly unknown[]): Promise<{ rows: R[] }>;
}

const DAY = 86_400_000;

/** Idempotent; run once at startup. Snapshot columns are copied out only where queries filter or sort on them. */
export const VOICE_SESSIONS_SCHEMA: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS voice_sessions (
    id          text PRIMARY KEY,
    document_id text NOT NULL,
    status      text NOT NULL,
    created_at  bigint NOT NULL,
    ended_at    bigint,
    snapshot    jsonb NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS voice_sessions_unended_idx ON voice_sessions (document_id, created_at) WHERE status <> 'ended'",
  "CREATE INDEX IF NOT EXISTS voice_sessions_ended_idx ON voice_sessions (ended_at) WHERE status = 'ended'",
];

/**
 * Voice sessions in PostgreSQL, one row per session holding its snapshot.
 * Like the in-memory repository it does not lock: a single Node process
 * serialises commands per session through the event loop.
 */
export class PostgresVoiceSessionRepository implements VoiceSessionRepository {
  constructor(private readonly sql: SqlClient, private readonly retainEndedMs = 7 * DAY, private readonly now: () => number = Date.now) {}

  async migrate(): Promise<void> {
    for (const statement of VOICE_SESSIONS_SCHEMA) await this.sql.query(statement);
  }

  async get(id: VoiceSessionId): Promise<VoiceSession | undefined> {
    const { rows } = await this.sql.query<{ snapshot: VoiceSessionSnapshot }>('SELECT snapshot FROM voice_sessions WHERE id = $1', [id]);
    return rows[0] && VoiceSession.restore(rows[0].snapshot);
  }

  async findUnended(documentId: DocumentId): Promise<VoiceSession[]> {
    const { rows } = await this.sql.query<{ snapshot: VoiceSessionSnapshot }>(
      "SELECT snapshot FROM voice_sessions WHERE document_id = $1 AND status <> 'ended' ORDER BY created_at, id",
      [documentId],
    );
    return rows.map((row) => VoiceSession.restore(row.snapshot));
  }

  async save(session: VoiceSession): Promise<void> {
    const snapshot = session.toSnapshot();
    await this.sql.query(
      `INSERT INTO voice_sessions (id, document_id, status, created_at, ended_at, snapshot) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, ended_at = EXCLUDED.ended_at, snapshot = EXCLUDED.snapshot`,
      [snapshot.id, snapshot.documentId, snapshot.status, snapshot.createdAt, snapshot.endedAt, JSON.stringify(snapshot)],
    );
    if (snapshot.status === 'ended') await this.#pruneEnded();
  }

  /** Ended sessions are kept for support and audit look-ups, then dropped so the table stays bounded. */
  async #pruneEnded(): Promise<void> {
    await this.sql.query("DELETE FROM voice_sessions WHERE status = 'ended' AND ended_at < $1", [this.now() - this.retainEndedMs]);
  }
}
