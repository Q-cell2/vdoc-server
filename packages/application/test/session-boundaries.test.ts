import { describe, expect, it, vi } from 'vitest';
import { Usage, VoiceSession, VoiceSessionId, type VoiceSessionEvent } from '@vdoc-server/domain';
import {
  DisconnectEventHandler, QuotaEventHandler, RelaySessionOutbox, SessionQuotaService, UsageSettlementPublisher,
  VoiceSessionStore, migrateSessionRecord, type SessionEvent,
} from '../src';
import { alice, as, connected, harness } from './fakes';

function envelope(event: VoiceSessionEvent): SessionEvent {
  return { ...event, principalId: 'alice', clientId: 'web', documentId: 'doc-1', requestId: 'request', eventId: 'vs_1:event:0' };
}
const ended = () => envelope({ type: 'VoiceSessionEnded', aggregateId: 'vs_1', occurredAt: 1, reason: 'client', durationMs: 1, usage: Usage.empty });

describe('independent session subscribers', () => {
  it('quota handler releases ended sessions and never confirms a stale grant in the same batch', async () => {
    const h = harness();
    const confirm = vi.spyOn(h.quotas, 'confirm');
    const release = vi.spyOn(h.quotas, 'release');
    const handler = new QuotaEventHandler(new SessionQuotaService(h.quotas, h.repository, h.events, h.clock));
    expect(await handler.handle([envelope({ type: 'VoiceSessionConnected', aggregateId: 'vs_1', occurredAt: 0, reconnect: false }), ended()])).toEqual({ ok: true, value: undefined });
    expect(confirm).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledWith('alice', 'vs_1');
    expect(h.connections.closed).toEqual([]);
    expect(h.events.events).toEqual([]);
  });

  it('disconnect handler only translates ending events to transport commands', async () => {
    const h = harness();
    await new DisconnectEventHandler(h.connections).handle([envelope({ type: 'TurnCompleted', aggregateId: 'vs_1', occurredAt: 0, turnId: 't1', toolCalls: 0 }), ended()]);
    expect(h.connections.closed).toEqual([{ sessionId: 'vs_1', reason: 'client' }]);
    expect(h.quotas.states.size).toBe(0);
  });

  it('settlement projection keeps stable IDs without modifying domain events', async () => {
    const h = harness();
    const publisher = new UsageSettlementPublisher(h.events);
    const event = envelope({ type: 'TurnCompleted', aggregateId: 'vs_1', occurredAt: 0, turnId: 't1', toolCalls: 0 });
    await publisher.publish([event]);
    await publisher.publish([event]);
    expect(h.events.events[0]).toMatchObject({ settlementId: 'vs_1:turn:t1', usageUnit: 'turn', usageDelta: 1 });
    expect(h.events.events[1]).toEqual(h.events.events[0]);
    expect(event).not.toHaveProperty('settlementId');
  });

  it('acknowledges successful subscribers durably even when quota release fails', async () => {
    const h = harness();
    const { sessionId } = await connected(h);
    vi.spyOn(h.quotas, 'release').mockRejectedValueOnce(new Error('unavailable'));
    await expect(h.app.handleRealtimeDisconnect.execute(sessionId)).rejects.toThrow('Voice quota service');
    const pending = await h.repository.getRecord(sessionId);
    expect(pending?.outbox).toHaveLength(1);
    expect(pending?.delivered?.publisher).toHaveLength(1);
    expect(pending?.delivered?.['realtime-disconnect']).toHaveLength(1);
    // Reordered handlers retain delivery identity across reconstruction.
    const relay = new RelaySessionOutbox(h.repository, [new DisconnectEventHandler(h.connections),
      new QuotaEventHandler(new SessionQuotaService(h.quotas, h.repository, h.events, h.clock))], new UsageSettlementPublisher(h.events), h.clock);
    expect((await relay.execute(sessionId)).ok).toBe(true);
    expect(h.connections.closed).toHaveLength(1);
    expect(h.events.events.filter(event => event.type === 'VoiceSessionEnded')).toHaveLength(1);
    expect((await h.repository.getRecord(sessionId))?.outbox).toEqual([]);
  });
});

describe('aggregate and persistence boundaries', () => {
  it('commit stages outbox without publishing, reserving quota, or closing connections', async () => {
    const h = harness();
    const { sessionId } = await connected(h);
    h.events.events.length = 0;
    const release = vi.spyOn(h.quotas, 'release');
    const session = (await h.repository.get(VoiceSessionId.assume(sessionId)))!;
    session.end('client', h.clock.now());
    await new VoiceSessionStore(h.repository, h.clock).commit(session);
    expect(h.events.events).toEqual([]);
    expect(release).not.toHaveBeenCalled();
    expect(h.connections.closed).toEqual([]);
    expect((await h.repository.getRecord(sessionId))?.outbox).toMatchObject([{ type: 'VoiceSessionEnded' }]);
  });

  it('migrates legacy outbox and attribution without changing delivery IDs or sequence', async () => {
    const h = harness();
    const { sessionId } = await connected(h);
    const snapshot = h.repository.rows.get(sessionId)!;
    const pending = ended();
    const record = migrateSessionRecord({ ...snapshot, clientId: 'web', userId: 'user', requestId: 'original', pendingAuditEvents: [pending], nextAuditSequence: 42 } as typeof snapshot);
    expect(record.identity).toEqual({ clientId: 'web', userId: 'user', requestId: 'original' });
    expect(record.outbox).toEqual([pending]);
    expect(record.nextSequence).toBe(42);
    for (const field of ['clientId', 'userId', 'requestId', 'pendingAuditEvents', 'nextAuditSequence']) expect(record.session).not.toHaveProperty(field);
    await h.repository.putRecord(record);
    const session = VoiceSession.restore(record.session);
    session.recordUserInput(h.clock.now());
    await new VoiceSessionStore(h.repository, h.clock).commit(session);
    expect((await h.repository.getRecord(sessionId))?.outbox[1]).toMatchObject({ eventId: `${sessionId}:event:42`, userId: 'user', requestId: 'original' });
  });

  it('retains confirmation and input sequence across repeated aggregate reconstruction', async () => {
    const h = harness();
    const { sessionId } = await connected(h);
    const request = (turnId: string) => ({ sessionId, callId: `call-${turnId}`, turnId, name: 'apply_document_operations', arguments: { operations: [{ type: 'block.delete', id: 'b1' }] } });
    await h.app.recordUserInput.execute({ sessionId });
    expect(await h.app.reviewToolCall.execute(request('t1'))).toMatchObject({ kind: 'confirm' });
    const first = VoiceSession.restore(structuredClone(h.repository.rows.get(sessionId)!));
    expect(first.userInputs).toBe(1);
    await h.repository.save(first);
    expect(await h.app.reviewToolCall.execute(request('t2'))).toMatchObject({ kind: 'confirm' });
    await h.app.recordUserInput.execute({ sessionId });
    const second = VoiceSession.restore(structuredClone(h.repository.rows.get(sessionId)!));
    expect(second.userInputs).toBe(2);
    await h.repository.save(second);
    expect(await h.app.reviewToolCall.execute(request('t3'))).toMatchObject({ kind: 'allow' });
  });

  it('does not sign a grant rejected by quota', async () => {
    const sign = vi.fn(async () => 'token');
    const h = harness({ signer: { sign, verify: async () => undefined }, quotaLimits: { maxConcurrentSessions: 1, maxSessionsPerHour: 10 } });
    expect((await h.app.grantVoiceSession.execute({ documentId: 'one', credentials: as(alice) })).ok).toBe(true);
    expect(await h.app.grantVoiceSession.execute({ documentId: 'two', credentials: as(alice) })).toMatchObject({ ok: false, error: { code: 'QUOTA_EXCEEDED' } });
    expect(sign).toHaveBeenCalledTimes(1);
  });

  it('queries and refused commands leave expiration to the shared maintenance service', async () => {
    const h = harness({ limits: { maxDurationMs: 100 } });
    const { sessionId, documentId, token } = await connected(h);
    h.clock.advance(100);
    const save = vi.spyOn(h.repository, 'putRecord');
    expect(await h.app.getVoiceSession.execute({ credentials: as(alice), documentId, sessionId })).toMatchObject({ ok: true, value: { status: 'ended', endReason: 'limit-duration' } });
    expect((await h.app.configureRealtimeSession.execute({ sessionId, context: {} })).ok).toBe(false);
    expect((await h.app.getRealtimeSessionDescriptor.execute({ sessionId, documentId })).ok).toBe(false);
    expect((await h.app.renewSessionGrant.execute({ credentials: as(alice), sessionId, documentId })).ok).toBe(false);
    expect((await h.app.connectRealtime.execute({ sessionId, documentId, token })).ok).toBe(false);
    expect(save).not.toHaveBeenCalled();
    expect(h.repository.rows.get(sessionId)?.status).toBe('active');
    await h.app.sessionMaintenance.execute();
    await h.app.sessionMaintenance.execute();
    expect(h.repository.rows.get(sessionId)?.endReason).toBe('limit-duration');
    expect(h.connections.closed).toEqual([{ sessionId, reason: 'limit-duration' }]);
    expect(h.events.events.filter(event => event.type === 'VoiceSessionEnded')).toHaveLength(1);
  });
});

describe('maintenance failure isolation', () => {
  it('continues expiring other sessions after one audit failure and schedules pending delivery', async () => {
    const h = harness({ limits: { maxDurationMs: 100 } });
    const first = await connected(h, 'one');
    const second = await connected(h, 'two');
    h.clock.advance(100);
    const publish = h.events.publish.bind(h.events);
    vi.spyOn(h.events, 'publish').mockRejectedValue(new Error('audit down'));
    const schedule = vi.spyOn(h.repository, 'schedule');
    await expect(h.app.sessionMaintenance.execute()).rejects.toThrow('audit down');
    expect(h.repository.rows.get(first.sessionId)?.status).toBe('ended');
    expect(h.repository.rows.get(second.sessionId)?.status).toBe('ended');
    expect(h.connections.closed).toHaveLength(2);
    expect(schedule).toHaveBeenLastCalledWith(h.clock.now() + 30_000);
    vi.mocked(h.events.publish).mockImplementation(publish);
    await h.app.sessionMaintenance.execute();
    expect((await h.repository.getRecord(first.sessionId))?.outbox).toEqual([]);
    expect((await h.repository.getRecord(second.sessionId))?.outbox).toEqual([]);
    expect(h.connections.closed).toHaveLength(2);
    expect(h.events.events.filter(event => event.type === 'VoiceSessionEnded')).toHaveLength(2);
  });

  it('retains the quota rejection code when its best-effort audit sink fails', async () => {
    const h = harness({ quotaLimits: { maxConcurrentSessions: 1, maxSessionsPerHour: 10 } });
    await connected(h, 'one');
    vi.spyOn(h.events, 'publish').mockRejectedValue(new Error('audit down'));
    expect(await h.app.grantVoiceSession.execute({ credentials: as(alice), documentId: 'two' }))
      .toMatchObject({ ok: false, error: { code: 'QUOTA_EXCEEDED' } });
  });

  it('keeps a wake-up when stale-record deletion fails', async () => {
    const h = harness();
    const { sessionId } = await connected(h);
    await h.app.handleRealtimeDisconnect.execute(sessionId);
    h.clock.advance(7 * 86_400_000 + 1);
    vi.spyOn(h.repository, 'removeRecords').mockRejectedValueOnce(new Error('delete unavailable'));
    const schedule = vi.spyOn(h.repository, 'schedule');
    await expect(h.app.sessionMaintenance.execute()).rejects.toThrow('delete unavailable');
    expect(schedule).toHaveBeenLastCalledWith(h.clock.now() + 30_000);
    expect(h.repository.rows.has(sessionId)).toBe(true);
    await h.app.sessionMaintenance.execute();
    expect(h.repository.rows.has(sessionId)).toBe(false);
    expect(schedule).toHaveBeenLastCalledWith(undefined);
  });
});
