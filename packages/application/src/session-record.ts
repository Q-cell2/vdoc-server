import { VoiceSession, type DomainEvent, type VoiceSessionSnapshot, type VoiceSessionRepository, type VoiceSessionEvent } from '@vdoc-server/domain';

export type SessionEvent = VoiceSessionEvent & {
  readonly eventId: string; readonly principalId: string; readonly documentId: string;
  readonly clientId: string; readonly userId?: string; readonly requestId: string;
};
export interface AuditIdentity { readonly clientId: string; readonly userId?: string; readonly requestId?: string; }
/** Persistence envelope, atomically stored with the aggregate; never part of its state. */
export interface SessionRecord {
  readonly session: VoiceSessionSnapshot;
  readonly identity: AuditIdentity;
  readonly outbox: readonly SessionEvent[];
  readonly nextSequence: number;
  readonly delivered?: Readonly<Record<string, readonly string[]>>;
  readonly nextWakeAt?: number;
}
export interface SessionRecordStorage {
  getRecord(id: string): Promise<SessionRecord | undefined>;
  putRecord(record: SessionRecord): Promise<void>;
}
export interface SessionMaintenanceStorage {
  records(): AsyncIterable<SessionRecord>;
  removeRecords(ids: readonly string[]): Promise<void>;
  schedule(nextWakeAt: number | undefined): Promise<void>;
}
export interface SessionPersistence extends VoiceSessionRepository, SessionRecordStorage {}
export interface SessionRepository extends SessionPersistence, SessionMaintenanceStorage {}
/** Legacy snapshots are read without discarding delivery IDs or attribution. */
export function migrateSessionRecord(raw: SessionRecord | VoiceSessionSnapshot): SessionRecord {
  if ('session' in raw) return raw;
  const { pendingAuditEvents, nextAuditSequence, clientId, userId, requestId, ...session } = raw as VoiceSessionSnapshot & {
    pendingAuditEvents?: readonly DomainEvent[]; nextAuditSequence?: number; clientId?: string; userId?: string; requestId?: string;
  };
  return { session, identity: { clientId: clientId ?? session.principalId, ...(userId ? { userId } : {}), ...(requestId ? { requestId } : {}) },
    outbox: (pendingAuditEvents ?? []) as readonly SessionEvent[], nextSequence: nextAuditSequence ?? 0 };
}
export const RETAIN_ENDED_MS = 7 * 86_400_000;
export function nextSessionWake(record: SessionRecord, now: number, retainMs = RETAIN_ENDED_MS): number | undefined {
  const session = VoiceSession.restore(record.session);
  if (record.outbox.length) return Math.min(now + 30_000, session.deadline() ?? Infinity);
  return session.deadline() ?? (session.endedAt === null ? undefined : session.endedAt + retainMs + 1);
}
