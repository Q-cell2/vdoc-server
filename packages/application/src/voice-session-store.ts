import {
  DocumentId, VoiceSessionId, err, ok,
  type Principal, type Result, type VoiceSession, type VoiceSessionRepository,
} from '@vdoc-server/domain';
import { appError, fromDomain, type AppError } from './errors';
import type { Clock, EventPublisher, PrincipalQuotaStore, RealtimeConnections } from './ports';

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
    private readonly clock: Clock,
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

  async commit(session: VoiceSession, requestId?: string): Promise<void> {
    const snapshot = session.toSnapshot();
    const events = session.pullEvents().map((event) => ({
      ...event, principalId: session.principalId, clientId: snapshot.clientId ?? session.principalId,
      ...(snapshot.userId ? { userId: snapshot.userId } : {}), documentId: session.documentId,
      requestId: requestId ?? snapshot.requestId ?? session.id,
      ...(event.type === 'TurnCompleted' ? { settlementId: `${session.id}:turn:${event.turnId}`, usageUnit: 'turn', usageDelta: 1 } : {}),
      ...(event.type === 'ToolCallCompleted' ? { settlementId: `${session.id}:call:${event.callId}`, usageUnit: 'tool-result', usageDelta: 1 } : {}),
    }));
    const pending = session.stageAuditEvents(events);
    await this.repository.save(session);
    let quotaFailed = false;
    if (session.status !== 'ended' && pending.some((event) => ['VoiceSessionGranted', 'VoiceSessionGrantRenewed', 'VoiceSessionConnected'].includes(event.type))) {
      try { await this.quotas.confirm(session.principalId, session.id); }
      catch { quotaFailed = true; }
    }
    try {
      if (pending.length > 0) {
        await this.events.publish(pending);
        session.acknowledgeAuditEvents();
        await this.repository.save(session);
      }
    } finally {
      // Audit failures must not keep ended sessions connected or their quota reserved.
      if (session.status === 'ended') {
        try { await this.quotas.release(session.principalId, session.id); }
        catch { throw new QuotaUnavailable(); }
        finally {
          if (pending.some((event) => event.type === 'VoiceSessionEnded')) await this.connections.close(session.id, session.endReason ?? 'client');
        }
      }
    }
    if (quotaFailed) throw new QuotaUnavailable();
  }

  /** If persistence is uncertain, keep a bounded lease rather than refunding a possibly created session. */
  async reconcileCreation(session: VoiceSession): Promise<void> {
    try {
      const persisted = await this.repository.get(session.id);
      if (persisted) await this.quotas.confirm(session.principalId, session.id);
      else await this.quotas.cancel(session.principalId, session.id);
    } catch { /* Fail closed: the pending lease expires even if either service is unavailable. */ }
  }

  /** Reserve before persisting a new/extended deadline. A rejected lease leaves storage untouched. */
  async reserveQuota(session: VoiceSession, supersedes: readonly VoiceSession[] = [], requestId?: string): Promise<Result<void, AppError>> {
    const snapshot = session.toSnapshot();
    let reserved;
    try {
      reserved = await this.quotas.reserve({
        principalId: session.principalId, sessionId: session.id,
        expiresAt: snapshot.startedAt === null ? snapshot.connectDeadline + 1 : snapshot.startedAt + snapshot.limits.maxDurationMs,
        supersedes: supersedes.filter((old) => old.principalId === session.principalId).map((old) => old.id),
      });
    } catch {
      await this.reconcileCreation(session);
      return err(quotaUnavailable());
    }
    if (!reserved.ok) {
      const event = {
        type: 'VoiceSessionQuotaRejected', aggregateId: session.id, occurredAt: this.clock.now(),
        principalId: session.principalId, clientId: snapshot.clientId ?? session.principalId,
        ...(snapshot.userId ? { userId: snapshot.userId } : {}), documentId: session.documentId,
        requestId: requestId ?? snapshot.requestId ?? session.id, code: reserved.error.code, quotaKind: reserved.error.quotaKind,
      };
      await this.events.publish([event]);
    }
    return reserved.ok ? reserved : err({ ...fromDomain(reserved.error), retryAfterSeconds: reserved.error.retryAfterSeconds, quotaKind: reserved.error.quotaKind });
  }
}

export const quotaUnavailable = (): AppError => ({ code: 'QUOTA_UNAVAILABLE', message: 'Voice quota service is temporarily unavailable.', retryAfterSeconds: 1 });
export class QuotaUnavailable extends Error { constructor() { super('Voice quota service is temporarily unavailable.'); } }
