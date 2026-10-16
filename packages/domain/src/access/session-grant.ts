import { DocumentId, PrincipalId, VoiceSessionId, domainError, err, ok, type DomainError, type Result } from '../shared';

export interface SessionGrantProps {
  readonly sessionId: VoiceSessionId;
  readonly documentId: DocumentId;
  readonly principalId: PrincipalId;
  /** Epoch milliseconds. */
  readonly issuedAt: number;
  readonly expiresAt: number;
}

export type GrantError = DomainError<'INVALID_GRANT' | 'GRANT_EXPIRED' | 'GRANT_SCOPE_MISMATCH'>;

/**
 * Permission to open the realtime connection of one voice session on one document,
 * for a short time. Value object: the signed token is only its transport encoding.
 */
export class SessionGrant {
  private constructor(private readonly props: SessionGrantProps) {}

  static issue(input: Omit<SessionGrantProps, 'expiresAt'> & { ttlMs: number }): SessionGrant {
    return new SessionGrant({
      sessionId: input.sessionId,
      documentId: input.documentId,
      principalId: input.principalId,
      issuedAt: input.issuedAt,
      expiresAt: input.issuedAt + input.ttlMs,
    });
  }

  /** Rebuilds a grant from a verified token payload; rejects malformed fields. */
  static restore(raw: Record<string, unknown>): Result<SessionGrant, GrantError> {
    const sessionId = VoiceSessionId.parse(raw.sessionId);
    const documentId = DocumentId.parse(raw.documentId);
    const principalId = PrincipalId.parse(raw.principalId);
    const { issuedAt, expiresAt } = raw;
    if (!sessionId.ok || !documentId.ok || !principalId.ok || typeof issuedAt !== 'number' || typeof expiresAt !== 'number' || expiresAt <= issuedAt) {
      return err(domainError('INVALID_GRANT', 'The grant is malformed.'));
    }
    return ok(new SessionGrant({ sessionId: sessionId.value, documentId: documentId.value, principalId: principalId.value, issuedAt, expiresAt }));
  }

  get sessionId(): VoiceSessionId { return this.props.sessionId; }
  get documentId(): DocumentId { return this.props.documentId; }
  get principalId(): PrincipalId { return this.props.principalId; }
  get issuedAt(): number { return this.props.issuedAt; }
  get expiresAt(): number { return this.props.expiresAt; }

  /** The grant must be unexpired and scoped to exactly this session and document. */
  authorizes(target: { sessionId: VoiceSessionId; documentId: DocumentId }, now: number): Result<void, GrantError> {
    if (now >= this.props.expiresAt) return err(domainError('GRANT_EXPIRED', 'The grant has expired. Request a new one.'));
    if (target.sessionId !== this.props.sessionId || target.documentId !== this.props.documentId) {
      return err(domainError('GRANT_SCOPE_MISMATCH', 'The grant is for a different session or document.'));
    }
    return ok(undefined);
  }

  toProps(): SessionGrantProps {
    return { ...this.props };
  }
}
