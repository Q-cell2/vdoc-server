import { VoiceSessionId, err, ok, type EndReason, type Result } from '@vdoc-server/domain';
import type { AppError } from '../errors';
import type { CallerAuthenticator, CallerCredentials, Clock } from '../ports';
import type { VoiceSessionStore } from '../voice-session-store';
import { authenticateCaller } from './caller';

export interface EndVoiceSessionByClientInput {
  readonly credentials: CallerCredentials;
  readonly documentId: string;
  readonly sessionId: string;
}

/** Command: the owner hangs up, or the system ends a session (e.g. nobody reconnected). */
export class EndVoiceSession {
  constructor(private readonly deps: { store: VoiceSessionStore; authenticator: CallerAuthenticator; clock: Clock }) {}

  async byClient(input: EndVoiceSessionByClientInput): Promise<Result<void, AppError>> {
    const principal = await authenticateCaller(this.deps.authenticator, input.credentials);
    if (!principal.ok) return principal;
    const session = await this.deps.store.findOwned(input.documentId, input.sessionId, principal.value);
    if (!session.ok) return err(session.error);
    session.value.end('client', this.deps.clock.now());
    await this.deps.store.commit(session.value);
    return ok(undefined);
  }

  async bySystem(sessionId: string, reason: Exclude<EndReason, 'client'>): Promise<void> {
    const id = VoiceSessionId.parse(sessionId);
    const session = id.ok ? await this.deps.store.findById(id.value) : undefined;
    if (!session) return;
    session.end(reason, this.deps.clock.now());
    await this.deps.store.commit(session);
  }
}
