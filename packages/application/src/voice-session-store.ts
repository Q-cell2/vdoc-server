import {
  DocumentId, VoiceSessionId, err, ok,
  type Principal, type Result, type VoiceSession, type VoiceSessionRepository,
} from '@vdoc-server/domain';
import { appError, fromDomain, type AppError } from './errors';
import type { EventPublisher, RealtimeConnections } from './ports';

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
    if (events.length > 0) await this.events.publish(events);
    if (session.status === 'ended' && events.some((event) => event.type === 'VoiceSessionEnded')) {
      await this.connections.close(session.id, session.endReason ?? 'client');
    }
  }
}
