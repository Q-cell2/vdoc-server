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
    expect(await grant(unavailable, 'one')).toMatchObject({ ok: false, error: { code: 'QUOTA_UNAVAILABLE', retryAfterSeconds: 1 } });
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
  it('closes despite release failure and retries release without duplicating the end event', async () => {
    const h = harness({ quotaLimits: limits });
    const first = await connected(h);
    const release = vi.spyOn(h.quotas, 'release').mockRejectedValueOnce(new Error('quota release unavailable'));
    await expect(h.app.endVoiceSession.bySystem(first.sessionId, 'disconnected')).rejects.toThrow('Voice quota service is temporarily unavailable.');
    expect(h.repository.rows.get(first.sessionId)?.status).toBe('ended');
    expect(h.connections.closed).toEqual([{ sessionId: first.sessionId, reason: 'disconnected' }]);
    await h.app.endVoiceSession.bySystem(first.sessionId, 'disconnected');
    expect(release).toHaveBeenCalledTimes(2);
    expect(h.events.events.filter(event => event.type === 'VoiceSessionEnded')).toHaveLength(1);
    expect(h.connections.closed).toHaveLength(1);
    expect((await grant(h, 'two')).ok).toBe(true);
  });

  it('cancels an uncertain reserve acknowledgement when no session was persisted', async () => {
    const h = harness({ quotaLimits: { maxConcurrentSessions: 1, maxSessionsPerHour: 1 } });
    const reserve = h.quotas.reserve.bind(h.quotas);
    vi.spyOn(h.quotas, 'reserve').mockImplementationOnce(async input => { await reserve(input); throw new Error('reserve reply lost'); });
    expect(await grant(h, 'lost-reply')).toMatchObject({ ok: false, error: { code: 'QUOTA_UNAVAILABLE' } });
    expect(h.quotas.states.get(alice.id)?.starts).toHaveLength(0);
    expect((await grant(h, 'retry')).ok).toBe(true);
  });

  it('cancels an unpersisted creation but retains a persisted start when acknowledgement is ambiguous', async () => {
    const h = harness({ quotaLimits: { maxConcurrentSessions: 1, maxSessionsPerHour: 1 } });
    vi.spyOn(h.repository, 'save').mockRejectedValueOnce(new Error('save failed'));
    await expect(grant(h, 'failed')).rejects.toThrow('save failed');
    expect(h.quotas.states.get(alice.id)?.starts).toHaveLength(0);
    expect((await grant(h, 'retry')).ok).toBe(true);

    const ambiguous = harness({ quotaLimits: { maxConcurrentSessions: 1, maxSessionsPerHour: 1 } });
    const save = ambiguous.repository.save.bind(ambiguous.repository);
    vi.spyOn(ambiguous.repository, 'save').mockImplementationOnce(async (session) => { await save(session); throw new Error('ack lost'); });
    await expect(grant(ambiguous, 'persisted')).rejects.toThrow('ack lost');
    expect(ambiguous.quotas.states.get(alice.id)?.starts).toMatchObject([{ confirmed: true }]);
    expect(await grant(ambiguous, 'retry')).toMatchObject({ ok: false, error: { code: 'QUOTA_EXCEEDED' } });
  });

  it('keeps a bounded pending hold if creation and readback both fail', async () => {
    const h = harness({ quotaLimits: { maxConcurrentSessions: 1, maxSessionsPerHour: 1 } });
    vi.spyOn(h.repository, 'save').mockRejectedValueOnce(new Error('storage down'));
    vi.spyOn(h.repository, 'get').mockRejectedValueOnce(new Error('storage down'));
    await expect(grant(h, 'uncertain')).rejects.toThrow('storage down');
    expect(await grant(h, 'blocked')).toMatchObject({ ok: false, error: { code: 'QUOTA_EXCEEDED' } });
    h.clock.advance(60_002);
    expect((await grant(h, 'recovered')).ok).toBe(true);
  });

  it('retains a consumed start after an audit failure and permits cleanup at the rate cap', async () => {
    const h = harness({ quotaLimits: { maxConcurrentSessions: 1, maxSessionsPerHour: 1 } });
    vi.spyOn(h.events, 'publish').mockRejectedValueOnce(new Error('audit failed'));
    await expect(grant(h, 'one')).rejects.toThrow('audit failed');
    const sessionId = [...h.repository.rows.keys()][0]!;
    expect(h.quotas.states.get(alice.id)?.starts).toMatchObject([{ confirmed: true }]);
    await h.app.endVoiceSession.byClient({ credentials: as(alice), documentId: 'one', sessionId });
    expect(h.quotas.states.get(alice.id)?.slots).toHaveLength(0);
    expect(await grant(h, 'two')).toMatchObject({ ok: false, error: { quotaKind: 'rate' } });
  });

});
