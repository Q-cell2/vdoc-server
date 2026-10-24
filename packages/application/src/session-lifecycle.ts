import type { VoiceSession } from '@vdoc-server/domain';
import type { VoiceSessionStore } from './voice-session-store';
import type { AuditIdentity } from './session-record';
import type { RelaySessionOutbox } from './session-events';
/** Explicit command orchestration: durable commit first, then independent subscribers. */
export class SessionLifecycle {
  constructor(private readonly store: VoiceSessionStore, private readonly relay: RelaySessionOutbox) {}
  async persistAndDispatch(session: VoiceSession, requestId?: string, identity?: AuditIdentity) {
    await this.store.commit(session, requestId, identity);
    return this.relay.execute(session.id);
  }
}
