import type { SessionLifecycle } from '../session-lifecycle';
import type { Result } from '@vdoc-server/domain';
import type { AppError } from '../errors';
import type { CallerAuthenticator, Clock } from '../ports';
import type { VoiceSessionStore } from '../voice-session-store';
import { loadOwnedSession, type OwnedSessionRequest } from './caller';

export type EndVoiceSessionByClientInput = OwnedSessionRequest;

/** Command: the authenticated owner hangs up. */
export class EndVoiceSession {
  constructor(private readonly deps: { store: VoiceSessionStore; lifecycle: SessionLifecycle; authenticator: CallerAuthenticator; clock: Clock }) {}

  async execute(input: EndVoiceSessionByClientInput): Promise<Result<void, AppError>> {
    const session = await loadOwnedSession(this.deps, input);
    if (!session.ok) return session;
    session.value.end('client', this.deps.clock.now());
    return this.deps.lifecycle.persistAndDispatch(session.value, input.credentials.requestId);
  }
}
