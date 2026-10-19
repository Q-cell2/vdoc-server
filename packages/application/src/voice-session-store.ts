import {
  DocumentId, VoiceSessionId, err, ok,
  type Principal, type Result, type VoiceSession, type VoiceSessionRepository,
} from '@vdoc-server/domain';
import { appError, fromDomain, type AppError } from './errors';
import type { EventPublisher, PrincipalQuotaStore, RealtimeConnections } from './ports';

/**
 * Application service shared by the use cases: loads sessions with the usual
 * checks, and commits them (save, then publish the events they recorded, then
 * close live connections if the session ended).
 */
export class VoiceSessionStore {
  constructor(
    private readonly repository: VoiceSessionRepository,
    private readonly events: EventPublisher,
    private readonly connections: RealtimeConnections,
    private readonly quotas: PrincipalQuotaStore,
  ) {}

  /** Finds a session addressed as `documents/{documentId}/voice-sessions/{sessionId}`. */
  async find(documentId: unknown, sessionId: unknown): Promise<Result<VoiceSession, AppError>> {
    const doc = DocumentId.parse(documentId);
    if (!doc.ok) return err(fromDomain(doc.error));
    const id = VoiceSessionId.parse(sessionId);
    if (!id.ok) return err(fromDomain(id.error));
    const session = await this.repository.get(id.value);
    if (!session || session.documentId !== doc.value) return err(appError('NOT_FOUND', 'No such voice session for this document.'));
    return ok(session);
  }

  /** Like `find`, and the caller must own it. Others get NOT_FOUND, so ids are not probeable. */
  async findOwned(documentId: unknown, sessionId: unknown, principal: Principal): Promise<Result<VoiceSession, AppError>> {
    const found = await this.find(documentId, sessionId);
    if (found.ok && !found.value.isOwnedBy(principal.id)) return err(appError('NOT_FOUND', 'No such voice session for this document.'));
    return found;
  }

  async findById(sessionId: VoiceSessionId): Promise<VoiceSession | undefined> {
    return this.repository.get(sessionId);
  }

  async findUnended(documentId: DocumentId): Promise<VoiceSession[]> {
    return this.repository.findUnended(documentId);
  }

  async commit(session: VoiceSession): Promise<void> {
    const events = session.pullEvents();
    await this.repository.save(session);
    try {
      if (events.length > 0) await this.events.publish(events);
    } finally {
      // Audit failures must not keep ended sessions connected or their quota reserved.
      if (session.status === 'ended') {
        try { await this.quotas.release(session.principalId, session.id); }
        finally {
          if (events.some((event) => event.type === 'VoiceSessionEnded')) await this.connections.close(session.id, session.endReason ?? 'client');
        }
      }
    }
  }

  /** Reserve before persisting a new/extended deadline. A rejected lease leaves storage untouched. */
  async reserveQuota(session: VoiceSession, supersedes: readonly VoiceSession[] = []): Promise<Result<void, AppError>> {
    const snapshot = session.toSnapshot();
    const reserved = await this.quotas.reserve({
      principalId: session.principalId, sessionId: session.id,
      expiresAt: snapshot.startedAt === null ? snapshot.connectDeadline + 1 : snapshot.startedAt + snapshot.limits.maxDurationMs,
      supersedes: supersedes.filter((old) => old.principalId === session.principalId).map((old) => old.id),
    });
    return reserved.ok ? reserved : err({ ...fromDomain(reserved.error), retryAfterSeconds: reserved.error.retryAfterSeconds });
  }
}
