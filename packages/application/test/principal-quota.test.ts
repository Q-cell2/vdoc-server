import { describe, expect, it, vi } from 'vitest';
import { alice, as, bob, connected, harness } from './fakes';

const limits = { maxConcurrentSessions: 1, maxSessionsPerHour: 3 };
const grant = (h: ReturnType<typeof harness>, documentId: string, principal = alice) => h.app.grantVoiceSession.execute({ credentials: as(principal), documentId });

describe('per-principal admission across documents', () => {
  it('does not charge connect or renewal twice and fails closed when the global store is unavailable', async () => {
    const h = harness({ quotaLimits: { ...limits, maxSessionsPerHour: 1 } });
    const first = await connected(h);
    expect((await h.app.renewSessionGrant.execute({ credentials: as(alice), ...first })).ok).toBe(true);
    expect(h.quotas.states.get(alice.id)?.starts).toHaveLength(1);
    await h.app.endVoiceSession.bySystem(first.sessionId, 'disconnected');
    expect(await grant(h, 'two')).toMatchObject({ ok: false, error: { code: 'QUOTA_EXCEEDED', retryAfterSeconds: 3600 } });
    h.clock.advance(3_600_000);
    expect((await grant(h, 'two')).ok).toBe(true);
    const unavailable = harness();
    vi.spyOn(unavailable.quotas, 'reserve').mockRejectedValueOnce(new Error('quota store unavailable'));
    await expect(grant(unavailable, 'one')).rejects.toThrow('quota store unavailable');
    expect(unavailable.repository.rows.size).toBe(0);
  });
  it('shares concurrent slots across documents, isolates principals and releases on end', async () => {
    const h = harness({ quotaLimits: limits });
    const first = await connected(h, 'one');
    expect(await grant(h, 'two')).toMatchObject({ ok: false, error: { code: 'QUOTA_EXCEEDED', retryAfterSeconds: 1800 } });
    expect((await grant(h, 'two', bob)).ok).toBe(true);
    await h.app.endVoiceSession.bySystem(first.sessionId, 'disconnected');
    expect((await grant(h, 'three')).ok).toBe(true);
  });
  it('preserves same-document supersession at the concurrency cap, while rate rejection preserves the old session', async () => {
    const h = harness({ quotaLimits: { ...limits, maxSessionsPerHour: 2 } });
    const first = await connected(h, 'one');
    const second = await grant(h, 'one');
    expect(second.ok).toBe(true);
    expect(h.repository.rows.get(first.sessionId)?.endReason).toBe('superseded');
    expect(await grant(h, 'one')).toMatchObject({ ok: false, error: { code: 'QUOTA_EXCEEDED' } });
    if (second.ok) expect(h.repository.rows.get(second.value.session.sessionId)?.status).toBe('granted');
  });
  it('expires unused reservations without reading the original document, and renews without new rate tokens', async () => {
    const h = harness({ quotaLimits: { ...limits, maxSessionsPerHour: 2 } });
    const first = await grant(h, 'one');
    if (!first.ok) throw new Error();
    h.clock.advance(59_000);
    expect((await h.app.renewSessionGrant.execute({ credentials: as(alice), documentId: 'one', sessionId: first.value.session.sessionId })).ok).toBe(true);
    h.clock.advance(2000);
    expect((await grant(h, 'two')).ok).toBe(false);
    h.clock.advance(60_000);
    expect((await grant(h, 'two')).ok).toBe(true);
    expect(h.quotas.states.get(alice.id)?.starts).toHaveLength(2);
  });
  it('does not charge rejected authentication, document conflicts or signing failure', async () => {
    const h = harness({ quotaLimits: limits, concurrency: 'reject' });
    expect((await h.app.grantVoiceSession.execute({ credentials: { bearer: undefined }, documentId: 'one' })).ok).toBe(false);
    await grant(h, 'one');
    expect(await grant(h, 'one')).toMatchObject({ ok: false, error: { code: 'DOCUMENT_BUSY' } });
    expect(h.quotas.states.get(alice.id)?.starts).toHaveLength(1);
    const failed = harness({ signer: { sign: async () => { throw new Error('signing unavailable'); }, verify: async () => undefined } });
    await expect(grant(failed, 'one')).rejects.toThrow('signing unavailable');
    expect(failed.quotas.states.size).toBe(0);
  });
  it('releases ended slots and closes sockets even if an audit subscriber fails', async () => {
    const h = harness({ quotaLimits: limits });
    const first = await connected(h);
    vi.spyOn(h.events, 'publish').mockRejectedValueOnce(new Error('audit unavailable'));
    await expect(h.app.endVoiceSession.bySystem(first.sessionId, 'limit-duration')).rejects.toThrow('audit unavailable');
    expect(h.connections.closed).toContainEqual({ sessionId: first.sessionId, reason: 'limit-duration' });
    expect((await grant(h, 'two')).ok).toBe(true);
  });
});
