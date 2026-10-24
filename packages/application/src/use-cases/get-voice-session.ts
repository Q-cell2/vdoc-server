import type { Result } from '@vdoc-server/domain';
import type { AppError } from '../errors';
import type { CallerAuthenticator, CallerCredentials, Clock } from '../ports';
import type { VoiceSessionStore } from '../voice-session-store';
import { authenticateCaller } from './caller';
import { toView, type VoiceSessionView } from './views';

/** Query: the owner reads a session's status and usage. */
export class GetVoiceSession {
  constructor(private readonly deps: { store: VoiceSessionStore; authenticator: CallerAuthenticator; clock: Clock }) {}

  async execute(input: { credentials: CallerCredentials; documentId: string; sessionId: string }): Promise<Result<VoiceSessionView, AppError>> {
    const principal = await authenticateCaller(this.deps.authenticator, input.credentials);
    if (!principal.ok) return principal;
    const session = await this.deps.store.findOwned(input.documentId, input.sessionId, principal.value);
    if (!session.ok) return session;
    return { ok: true, value: toView(session.value, this.deps.clock.now()) };
  }
}
