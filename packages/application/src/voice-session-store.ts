import {
  DocumentId, VoiceSessionId, err, ok,
  type Principal, type Result, type VoiceSession,
} from '@vdoc-server/domain';
import { appError, fromDomain, type AppError } from './errors';
import type { SessionPersistence, AuditIdentity } from './session-record';
import { nextSessionWake } from './session-record';
import type { Clock } from './ports';

/** Loads aggregates and atomically stages their events with the snapshot. */
export class VoiceSessionStore {
  constructor(readonly repository: SessionPersistence, private readonly clock: Clock) {}

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

  /** Unended sessions that are not yet past a deadline. Overdue ones may await their wake-up and do not count. */
  async findOpen(documentId: DocumentId, now: number): Promise<VoiceSession[]> {
    return (await this.repository.findUnended(documentId)).filter((session) => session.isOpenAt(now));
  }

  async commit(session: VoiceSession, requestId?: string, identity?: AuditIdentity): Promise<void> {
    const previous = await this.repository.getRecord(session.id);
    const attribution = identity ?? previous?.identity ?? { clientId: session.principalId };
    let sequence = previous?.nextSequence ?? 0;
    const fresh = session.pullEvents().map((event) => ({ ...event,
      principalId: session.principalId, ...attribution, documentId: session.documentId,
      requestId: requestId ?? attribution.requestId ?? session.id, eventId: `${session.id}:event:${sequence++}`,
    }));
    const record = { session: session.toSnapshot(), identity: attribution, outbox: [...(previous?.outbox ?? []), ...fresh], nextSequence: sequence, delivered: previous?.delivered ?? {} };
    const nextWakeAt = nextSessionWake(record, this.clock.now());
    await this.repository.putRecord({ ...record, ...(nextWakeAt !== undefined ? { nextWakeAt } : {}) });
  }
}
