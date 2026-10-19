import { DocumentId, VoiceSessionId, err, ok, type Result } from '@vdoc-server/domain';
import { appError, fromDomain, type AppError } from '../errors';
import type { Clock, GrantSigner } from '../ports';
import type { VoiceSessionStore } from '../voice-session-store';

export interface AuthorizeRealtimeConnectionInput {
  /** `hello.auth` from the realtime client. */
  readonly token: string | undefined;
  /** From the connection's route; the grant must be scoped to exactly these. */
  readonly documentId: string;
  readonly sessionId: string;
}

/** Who is on the other end of a realtime connection. */
export interface RealtimeIdentity {
  readonly sessionId: string;
  readonly documentId: string;
  readonly principalId: string;
  readonly profileId: string;
}

/** Command: a realtime connection (new or resumed) presents its grant. */
export class AuthorizeRealtimeConnection {
  constructor(private readonly deps: { store: VoiceSessionStore; signer: GrantSigner; clock: Clock }) {}

  async execute(input: AuthorizeRealtimeConnectionInput): Promise<Result<RealtimeIdentity, AppError>> {
    const { store, signer, clock } = this.deps;
    const grant = input.token ? await signer.verify(input.token) : undefined;
    if (!grant) return err(appError('GRANT_INVALID', 'A valid session grant is required.'));
    const documentId = DocumentId.parse(input.documentId);
    const sessionId = VoiceSessionId.parse(input.sessionId);
    if (!documentId.ok || !sessionId.ok) return err(appError('INVALID_INPUT', 'Malformed realtime route.'));
    const now = clock.now();
    const authorized = grant.authorizes({ documentId: documentId.value, sessionId: sessionId.value }, now);
    if (!authorized.ok) return err(fromDomain(authorized.error));

    const session = await store.findById(sessionId.value);
    if (!session || !session.isOwnedBy(grant.principalId)) return err(appError('GRANT_INVALID', 'A valid session grant is required.'));
    const connected = session.connect(now);
    if (!connected.ok) {
      session.expireIfOverdue(now);
      await store.commit(session);
      return err(fromDomain(connected.error));
    }
    const reserved = await store.reserveQuota(session);
    if (!reserved.ok) return reserved;
    await store.commit(session);
    return ok({ sessionId: session.id, documentId: session.documentId, principalId: session.principalId, profileId: session.profileId });
  }
}
