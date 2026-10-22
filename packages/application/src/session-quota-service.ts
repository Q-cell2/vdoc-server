import { err, ok, type Result, type VoiceSession } from '@vdoc-server/domain';
import { appError, fromDomain, type AppError } from './errors';
import type { Clock, EventPublisher, PrincipalQuotaStore } from './ports';
import type { AuditIdentity, SessionRecordStorage } from './session-record';

/** Operational rejection: no aggregate was committed, so this event has no durable delivery guarantee. */
export interface VoiceSessionQuotaRejected {
  readonly type: 'VoiceSessionQuotaRejected'; readonly aggregateId: string; readonly occurredAt: number;
  readonly principalId: string; readonly documentId: string; readonly clientId: string;
  readonly userId?: string; readonly requestId: string; readonly code: string; readonly quotaKind?: string;
}
export const quotaUnavailable = (): AppError => ({ code: 'QUOTA_UNAVAILABLE', message: 'Voice quota service is temporarily unavailable.', retryAfterSeconds: 1 });
/** One boundary for leases, recovery and their Result error channel. */
export class SessionQuotaService {
  constructor(private readonly quotas: PrincipalQuotaStore, private readonly repository: Pick<SessionRecordStorage, 'getRecord'>,
    private readonly events: EventPublisher, private readonly clock: Clock) {}
  async reserve(session: VoiceSession, supersedes: readonly VoiceSession[] = [], requestId?: string, identity?: AuditIdentity): Promise<Result<void, AppError>> {
    const deadline = session.deadline();
    if (deadline === undefined) return err(appError('SESSION_CLOSED', 'This voice session has ended.'));
    try {
      const reserved = await this.quotas.reserve({ principalId: session.principalId, sessionId: session.id,
        expiresAt: deadline, supersedes: supersedes.filter(old => old.principalId === session.principalId).map(old => old.id) });
      if (reserved.ok) return reserved;
      // Rejection has no committed aggregate. This best-effort operational event is explicitly non-durable.
      try {
        const attribution = identity ?? (await this.repository.getRecord(session.id))?.identity ?? { clientId: session.principalId };
        const event: VoiceSessionQuotaRejected = {
          ...attribution, type: 'VoiceSessionQuotaRejected', aggregateId: session.id, occurredAt: this.clock.now(),
          principalId: session.principalId, documentId: session.documentId, requestId: requestId ?? attribution.requestId ?? session.id,
          code: reserved.error.code, quotaKind: reserved.error.quotaKind,
        };
        await this.events.publish([event]);
      } catch { /* Operational rejection is best effort; keep the original admission error. */ }
      return err({ ...fromDomain(reserved.error), retryAfterSeconds: reserved.error.retryAfterSeconds, quotaKind: reserved.error.quotaKind });
    } catch { await this.reconcileCreation(session); return err(quotaUnavailable()); }
  }
  async withReservation<T>(session: VoiceSession, options: { supersedes?: readonly VoiceSession[]; requestId?: string | undefined; identity?: AuditIdentity },
    operation: () => Promise<Result<T, AppError>>): Promise<Result<T, AppError>> {
    const reserved = await this.reserve(session, options.supersedes, options.requestId, options.identity);
    if (!reserved.ok) return reserved;
    try {
      const result = await operation();
      if (!result.ok) await this.reconcileCreation(session);
      return result;
    } catch (error) {
      await this.reconcileCreation(session);
      throw error;
    }
  }
  async confirm(principalId: string, sessionId: string): Promise<Result<void, AppError>> {
    try { await this.quotas.confirm(principalId, sessionId); return ok(undefined); } catch { return err(quotaUnavailable()); }
  }
  async release(principalId: string, sessionId: string): Promise<Result<void, AppError>> {
    try { await this.quotas.release(principalId, sessionId); return ok(undefined); } catch { return err(quotaUnavailable()); }
  }
  async reconcileCreation(session: VoiceSession): Promise<void> {
    try {
      if (await this.repository.getRecord(session.id)) await this.quotas.confirm(session.principalId, session.id);
      else await this.quotas.cancel(session.principalId, session.id);
    } catch { /* Fail closed: uncertain reservations remain bounded by the pending lease. */ }
  }
}
