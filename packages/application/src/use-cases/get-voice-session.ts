import { ok, type Result } from '@vdoc-server/domain';
import type { AppError } from '../errors';
import type { CallerAuthenticator, Clock } from '../ports';
import type { VoiceSessionStore } from '../voice-session-store';
import { loadOwnedSession, type OwnedSessionRequest } from './caller';
import { toView, type VoiceSessionView } from './views';

/** Query: the owner reads a session's status and usage. */
export class GetVoiceSession {
  constructor(private readonly deps: { store: VoiceSessionStore; authenticator: CallerAuthenticator; clock: Clock }) {}

  async execute(input: OwnedSessionRequest): Promise<Result<VoiceSessionView, AppError>> {
    const session = await loadOwnedSession(this.deps, input);
    return session.ok ? ok(toView(session.value, this.deps.clock.now())) : session;
  }
}
