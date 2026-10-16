import { err, ok, type Result } from '@vdoc-server/domain';
import { fromDomain, type AppError } from '../errors';
import type { CallerAuthenticator, CallerCredentials, Clock, GrantSigner } from '../ports';
import type { VoiceSessionStore } from '../voice-session-store';
import { authenticateCaller } from './caller';
import type { GrantView } from './views';

export interface RenewSessionGrantInput {
  readonly credentials: CallerCredentials;
  readonly documentId: string;
  readonly sessionId: string;
}

/** Command: a fresh short-lived grant, e.g. before every reconnect. */
export class RenewSessionGrant {
  constructor(private readonly deps: { store: VoiceSessionStore; authenticator: CallerAuthenticator; signer: GrantSigner; clock: Clock }) {}

  async execute(input: RenewSessionGrantInput): Promise<Result<GrantView, AppError>> {
    const { store, authenticator, signer, clock } = this.deps;
    const principal = await authenticateCaller(authenticator, input.credentials);
    if (!principal.ok) return principal;
    const session = await store.findOwned(input.documentId, input.sessionId, principal.value);
    if (!session.ok) return session;
    const now = clock.now();
    const grant = session.value.issueGrant(now);
    if (!grant.ok) {
      session.value.expireIfOverdue(now);
      await store.commit(session.value);
      return err(fromDomain(grant.error));
    }
    const token = await signer.sign(grant.value);
    await store.commit(session.value);
    return ok({ token, expiresAt: grant.value.expiresAt });
  }
}
