import type { SessionLifecycle } from '../session-lifecycle';
import { DocumentId, ProfileId, VoiceSession, VoiceSessionId, err, ok, type AgentProfile, type AgentProfileRepository, type DocumentSessionPolicy, type Result } from '@vdoc-server/domain';
import { appError, fromDomain, type AppError } from '../errors';
import type { CallerAuthenticator, CallerCredentials, Clock, GrantSigner, IdGenerator } from '../ports';
import { auditIdentityOf } from '../session-record';
import type { VoiceSessionStore } from '../voice-session-store';
import { authenticateCaller } from './caller';
import { toView, type GrantView, type VoiceSessionView } from './views';

export interface GrantVoiceSessionInput {
  readonly credentials: CallerCredentials;
  readonly documentId: string;
  readonly profileId?: string | undefined;
}

export interface GrantVoiceSessionOutput {
  readonly session: VoiceSessionView;
  readonly grant: GrantView;
}

/** Command: a client wants to start talking about a document. */
export class GrantVoiceSession {
  constructor(private readonly deps: {
    store: VoiceSessionStore; lifecycle: SessionLifecycle; profiles: AgentProfileRepository; authenticator: CallerAuthenticator;
    signer: GrantSigner; clock: Clock; ids: IdGenerator; admission: DocumentSessionPolicy;
  }) {}

  async execute(input: GrantVoiceSessionInput): Promise<Result<GrantVoiceSessionOutput, AppError>> {
    const { store, lifecycle, authenticator, signer, clock, ids, admission } = this.deps;
    const { requestId } = input.credentials;
    const principal = await authenticateCaller(authenticator, input.credentials);
    if (!principal.ok) return principal;
    const documentId = DocumentId.parse(input.documentId);
    if (!documentId.ok) return err(fromDomain(documentId.error));
    const profile = await this.resolveProfile(input.profileId);
    if (!profile.ok) return profile;

    const now = clock.now();
    const admitted = admission.admit(await store.findOpen(documentId.value, now), principal.value);
    if (!admitted.ok) return err(fromDomain(admitted.error));
    const session = VoiceSession.grant({ id: VoiceSessionId.assume(ids.next('vs')), documentId: documentId.value, principal: principal.value, profile: profile.value, now });
    const grant = session.issueGrant(now);
    if (!grant.ok) return err(fromDomain(grant.error));

    // Commit the new session before ending the ones it supersedes: a failure part-way then leaves
    // an extra open session (ended by the next grant or its deadline), never a caller with none.
    const committed = await lifecycle.persistAndDispatch(session, requestId, auditIdentityOf(principal.value, requestId));
    if (!committed.ok) return committed;
    for (const superseded of admitted.value) {
      superseded.end('superseded', now);
      const ended = await lifecycle.persistAndDispatch(superseded, requestId);
      if (!ended.ok) return ended;
    }
    const token = await signer.sign(grant.value);
    return ok({ session: toView(session, now), grant: { token, expiresAt: grant.value.expiresAt } });
  }

  /** The requested profile, or the default when none is named. */
  private async resolveProfile(profileId: string | undefined): Promise<Result<AgentProfile, AppError>> {
    const { profiles } = this.deps;
    if (profileId === undefined) return ok(await profiles.getDefault());
    const id = ProfileId.parse(profileId);
    const found = id.ok ? await profiles.get(id.value) : undefined;
    return found ? ok(found) : err(appError('NOT_FOUND', 'Unknown agent profile.'));
  }
}
