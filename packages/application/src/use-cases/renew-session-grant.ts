import type { SessionLifecycle } from '../session-lifecycle';
import { err, ok, type Result } from '@vdoc-server/domain';
import { fromDomain, type AppError } from '../errors';
import type { CallerAuthenticator, CallerCredentials, Clock, GrantSigner } from '../ports';
import type { VoiceSessionStore } from '../voice-session-store';
import type { SessionQuotaService } from '../session-quota-service';
import { authenticateCaller } from './caller';
import type { GrantView } from './views';

export interface RenewSessionGrantInput {
  readonly credentials: CallerCredentials;
  readonly documentId: string;
  readonly sessionId: string;
}

/** Command: a fresh short-lived grant, e.g. before every reconnect. */
export class RenewSessionGrant {
  constructor(private readonly deps: { store: VoiceSessionStore; lifecycle: SessionLifecycle; quotas: SessionQuotaService; authenticator: CallerAuthenticator; signer: GrantSigner; clock: Clock }) {}

  async execute(input: RenewSessionGrantInput): Promise<Result<GrantView, AppError>> {
    const { store, authenticator, signer, clock } = this.deps;
    const principal = await authenticateCaller(authenticator, input.credentials);
    if (!principal.ok) return principal;
    const session = await store.findOwned(input.documentId, input.sessionId, principal.value);
    if (!session.ok) return session;
    const now = clock.now();
    const grant = session.value.issueGrant(now);
    if (!grant.ok) {
      return err(fromDomain(grant.error));
    }
    return this.deps.quotas.withReservation(session.value, { requestId: input.credentials.requestId }, async () => {
      const token = await signer.sign(grant.value);
      session.value.recordGrantRenewal(now);
      const committed = await this.deps.lifecycle.persistAndDispatch(session.value, input.credentials.requestId);
      return committed.ok ? ok({ token, expiresAt: grant.value.expiresAt }) : committed;
    });
  }
}
