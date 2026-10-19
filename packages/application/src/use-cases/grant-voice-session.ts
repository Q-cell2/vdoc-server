import { DocumentId, ProfileId, VoiceSession, VoiceSessionId, err, ok, type AgentProfileRepository, type DocumentSessionPolicy, type Result } from '@vdoc-server/domain';
import { appError, fromDomain, type AppError } from '../errors';
import type { CallerAuthenticator, CallerCredentials, Clock, GrantSigner, IdGenerator } from '../ports';
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
    store: VoiceSessionStore; profiles: AgentProfileRepository; authenticator: CallerAuthenticator;
    signer: GrantSigner; clock: Clock; ids: IdGenerator; admission: DocumentSessionPolicy;
  }) {}

  async execute(input: GrantVoiceSessionInput): Promise<Result<GrantVoiceSessionOutput, AppError>> {
    const { store, profiles, authenticator, signer, clock, ids, admission } = this.deps;
    const principal = await authenticateCaller(authenticator, input.credentials);
    if (!principal.ok) return principal;
    const documentId = DocumentId.parse(input.documentId);
    if (!documentId.ok) return err(fromDomain(documentId.error));

    let profile = await profiles.getDefault();
    if (input.profileId !== undefined) {
      const profileId = ProfileId.parse(input.profileId);
      const found = profileId.ok ? await profiles.get(profileId.value) : undefined;
      if (!found) return err(appError('NOT_FOUND', 'Unknown agent profile.'));
      profile = found;
    }

    const now = clock.now();
    const open: VoiceSession[] = [];
    for (const session of await store.findUnended(documentId.value)) {
      if (session.expireIfOverdue(now)) await store.commit(session);
      else open.push(session);
    }
    const admitted = admission.admit(open);
    if (!admitted.ok) return err(fromDomain(admitted.error));
    const session = VoiceSession.grant({ id: VoiceSessionId.assume(ids.next('vs')), documentId: documentId.value, principal: principal.value, profile, now });
    const grant = session.issueGrant(now);
    if (!grant.ok) return err(fromDomain(grant.error));
    const token = await signer.sign(grant.value);
    const reserved = await store.reserveQuota(session, admitted.value);
    if (!reserved.ok) return reserved;
    for (const superseded of admitted.value) {
      superseded.end('superseded', now);
      await store.commit(superseded);
    }
    await store.commit(session);
    return ok({ session: toView(session, now), grant: { token, expiresAt: grant.value.expiresAt } });
  }
}
