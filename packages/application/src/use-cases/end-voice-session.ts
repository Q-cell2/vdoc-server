import type { SessionLifecycle } from '../session-lifecycle';
import { err, type Result } from '@vdoc-server/domain';
import type { AppError } from '../errors';
import type { CallerAuthenticator, CallerCredentials, Clock } from '../ports';
import type { VoiceSessionStore } from '../voice-session-store';
import { authenticateCaller } from './caller';

export interface EndVoiceSessionByClientInput {
  readonly credentials: CallerCredentials;
  readonly documentId: string;
  readonly sessionId: string;
}

/** Command: the authenticated owner hangs up. */
export class EndVoiceSession {
  constructor(private readonly deps: { store: VoiceSessionStore; lifecycle: SessionLifecycle; authenticator: CallerAuthenticator; clock: Clock }) {}

  async execute(input: EndVoiceSessionByClientInput): Promise<Result<void, AppError>> {
    const principal = await authenticateCaller(this.deps.authenticator, input.credentials);
    if (!principal.ok) return principal;
    const session = await this.deps.store.findOwned(input.documentId, input.sessionId, principal.value);
    if (!session.ok) return err(session.error);
    session.value.end('client', this.deps.clock.now());
    return this.deps.lifecycle.persistAndDispatch(session.value, input.credentials.requestId);
  }
}
