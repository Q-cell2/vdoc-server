import type { SessionLifecycle } from '../session-lifecycle';
import { err, ok, type Result } from '@vdoc-server/domain';
import { fromDomain, type AppError } from '../errors';
import type { CallerAuthenticator, Clock, GrantSigner } from '../ports';
import type { VoiceSessionStore } from '../voice-session-store';
import { loadOwnedSession, type OwnedSessionRequest } from './caller';
import type { GrantView } from './views';

export type RenewSessionGrantInput = OwnedSessionRequest;

/** Command: a fresh short-lived grant, e.g. before every reconnect. */
export class RenewSessionGrant {
  constructor(private readonly deps: { store: VoiceSessionStore; lifecycle: SessionLifecycle; authenticator: CallerAuthenticator; signer: GrantSigner; clock: Clock }) {}

  async execute(input: RenewSessionGrantInput): Promise<Result<GrantView, AppError>> {
    const { signer, clock } = this.deps;
    const session = await loadOwnedSession(this.deps, input);
    if (!session.ok) return session;
    const now = clock.now();
    const grant = session.value.issueGrant(now);
    if (!grant.ok) return err(fromDomain(grant.error));
    const token = await signer.sign(grant.value);
    session.value.recordGrantRenewal(now);
    const committed = await this.deps.lifecycle.persistAndDispatch(session.value, input.credentials.requestId);
    return committed.ok ? ok({ token, expiresAt: grant.value.expiresAt }) : committed;
  }
}
