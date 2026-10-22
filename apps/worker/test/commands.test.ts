import { SerialCommandQueue } from '@vdoc-server/adapter-cloudflare';
import { describe, expect, it } from 'vitest';
import { alice, as, connected, harness } from '../../../packages/application/test/fakes';

const setup = (options: Parameters<typeof harness>[0] = {}) => {
  const queue = new SerialCommandQueue();
  return harness({ ...options, runCommand: (command) => queue.run(command) });
};

describe('document command serialization', () => {
  it('admits only one of simultaneous grants under reject policy', async () => {
    const h = setup({ concurrency: 'reject' });
    const results = await Promise.all(Array.from({ length: 10 }, () =>
      h.app.grantVoiceSession.execute({ credentials: as(alice), documentId: 'doc-1' })));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect([...h.repository.rows.values()].filter((r) => r.status !== 'ended')).toHaveLength(1);
  });

  it('preserves parallel turn increments and never resurrects a closed session', async () => {
    const h = setup();
    const { sessionId } = await connected(h);
    await Promise.all(Array.from({ length: 10 }, (_, n) => h.app.completeTurn.execute({ sessionId, turnId: 't' + n })));
    expect(h.repository.rows.get(sessionId)?.usage.turns).toBe(10);
    await Promise.all([
      h.app.handleRealtimeDisconnect.execute(sessionId),
      h.app.completeTurn.execute({ sessionId, turnId: 'late' }),
    ]);
    expect(h.repository.rows.get(sessionId)).toMatchObject({ status: 'ended', endReason: 'disconnected', usage: { turns: 10 } });
  });

  it('expires idle grants once and closes active sessions at their time limit', async () => {
    const h = setup({ limits: { maxDurationMs: 100 } });
    const { sessionId } = await connected(h);
    h.clock.advance(100);
    await h.app.expireVoiceSession.execute(sessionId);
    await h.app.expireVoiceSession.execute(sessionId);
    expect(h.connections.closed).toEqual([{ sessionId, reason: 'limit-duration' }]);
    expect(h.events.events.filter((e) => e.type === 'VoiceSessionEnded')).toHaveLength(1);
    const grant = await h.app.grantVoiceSession.execute({ credentials: as(alice), documentId: 'doc-2' });
    if (!grant.ok) throw new Error('grant failed');
    h.clock.advance(60_001);
    await h.app.expireVoiceSession.execute(grant.value.session.sessionId);
    expect(h.repository.rows.get(grant.value.session.sessionId)).toMatchObject({ status: 'ended', endReason: 'expired' });
  });

  it('rechecks the stored deadline, so an old alarm does not end a renewed grant', async () => {
    const h = setup({ limits: { grantTtlMs: 100 } });
    const grant = await h.app.grantVoiceSession.execute({ credentials: as(alice), documentId: 'doc-1' });
    if (!grant.ok) throw new Error('grant failed');
    const sessionId = grant.value.session.sessionId;
    h.clock.advance(90);
    await h.app.renewSessionGrant.execute({ credentials: as(alice), documentId: 'doc-1', sessionId });
    h.clock.advance(11);
    await h.app.expireVoiceSession.execute(sessionId);
    expect(h.repository.rows.get(sessionId)?.status).toBe('granted');
    expect(h.connections.closed).toEqual([]);
  });
});
