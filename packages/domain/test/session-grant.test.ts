import { describe, expect, it } from 'vitest';
import { DocumentId, PrincipalId, SessionGrant, VoiceSessionId } from '../src';

const target = { sessionId: VoiceSessionId.assume('vs-1'), documentId: DocumentId.assume('doc-1') };
const grant = SessionGrant.issue({ ...target, principalId: PrincipalId.assume('p'), issuedAt: 1_000, ttlMs: 60_000 });

describe('SessionGrant', () => {
  it('authorizes its own session and document until it expires', () => {
    expect(grant.authorizes(target, 60_999).ok).toBe(true);
    expect(grant.authorizes(target, 61_000)).toMatchObject({ ok: false, error: { code: 'GRANT_EXPIRED' } });
  });

  it('refuses any other session or document', () => {
    expect(grant.authorizes({ ...target, sessionId: VoiceSessionId.assume('vs-2') }, 2_000)).toMatchObject({ ok: false, error: { code: 'GRANT_SCOPE_MISMATCH' } });
    expect(grant.authorizes({ ...target, documentId: DocumentId.assume('doc-2') }, 2_000)).toMatchObject({ ok: false, error: { code: 'GRANT_SCOPE_MISMATCH' } });
  });

  it('restores only well-formed payloads', () => {
    const restored = SessionGrant.restore({ ...grant.toProps() });
    expect(restored.ok && restored.value.toProps()).toEqual(grant.toProps());
    for (const bad of [{}, { ...grant.toProps(), sessionId: 'bad id' }, { ...grant.toProps(), expiresAt: 0 }, { ...grant.toProps(), issuedAt: '1' }]) {
      expect(SessionGrant.restore(bad as Record<string, unknown>)).toMatchObject({ ok: false, error: { code: 'INVALID_GRANT' } });
    }
  });
});
