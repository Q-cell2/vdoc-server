import type { DomainEvent } from '@vdoc-server/domain';
import { describe, expect, it, vi } from 'vitest';
import { RelaySessionOutbox, DisconnectEventHandler } from '../src';
import { connected, harness } from './fakes';
import { loadConfig } from '../../config/src';
import { createNodeServer } from '../../../apps/node/src/create';

/** Reconstruct the commands from the durable snapshots, retaining only external stores. */
const restarted = (h: ReturnType<typeof harness>) => new RelaySessionOutbox(h.repository, [
  new DisconnectEventHandler(h.connections),
], h.events, h.clock);

const call = (sessionId: string) => ({ sessionId, callId: 'call-delivery', turnId: 'turn-delivery', name: 'read_document' });

describe('durable session audit delivery', () => {
  it('serializes concurrent turn callbacks in the actual Node composition', async () => {
    const key = 'audit-delivery-node-client-key-not-production';
    const config = loadConfig({ VDOC_SERVER_ENV: 'test', VDOC_SERVER_MODEL: 'fake', VDOC_SERVER_LOG_LEVEL: 'error', VDOC_SERVER_CLIENTS: `web:${key}` });
    if (!config.ok) throw new Error(config.errors.join('; '));
    const h = harness();
    const server = await createNodeServer(config.value, { sessions: h.repository, subscribers: [h.events], clock: h.clock });
    const created = await server.application.grantVoiceSession.execute({ credentials: { bearer: key, trustedUserId: 'node-user' }, documentId: 'node-audit' });
    if (!created.ok) throw new Error(created.error.message);
    const { sessionId } = created.value.session;
    expect((await server.application.connectRealtime.execute({ sessionId, documentId: 'node-audit', token: created.value.grant.token })).ok).toBe(true);
    try {
      await Promise.all(Array.from({ length: 8 }, () => server.application.completeTurn.execute({ sessionId, turnId: 'same-node-turn' })));
      expect(h.repository.rows.get(sessionId)?.usage.turns).toBe(1);
      expect(h.events.events.filter(event => event.type === 'TurnCompleted')).toHaveLength(1);
      const input = call(sessionId);
      expect(await server.application.reviewToolCall.execute({ ...input, arguments: {} })).toMatchObject({ kind: 'allow' });
      await Promise.all([
        server.application.recordToolResult.execute({ ...input, ok: true }),
        server.application.completeTurn.execute({ sessionId, turnId: input.turnId }),
      ]);
      await server.application.recordToolResult.execute({ ...input, ok: true });
      await server.application.completeTurn.execute({ sessionId, turnId: input.turnId });
      expect(h.repository.rows.get(sessionId)?.usage).toMatchObject({ turns: 2, toolCalls: 1 });
      expect(h.events.events.filter(event => event.type === 'TurnCompleted')).toHaveLength(2);
      expect(h.events.events.filter(event => event.type === 'ToolCallCompleted')).toHaveLength(1);
    } finally { await server.realtime.closeAll(); }
  });
  it('recovers a failed turn publication after reconstruction without consuming the turn twice', async () => {
    const h = harness();
    const { sessionId } = await connected(h);
    vi.spyOn(h.events, 'publish').mockRejectedValueOnce(new Error('audit unavailable'));
    await expect(h.app.completeTurn.execute({ sessionId, turnId: 'turn-delivery' })).rejects.toThrow('audit unavailable');
    expect(h.repository.rows.get(sessionId)?.usage.turns).toBe(1);
    expect(h.events.events.filter(event => event.type === 'TurnCompleted')).toHaveLength(0);

    const recovered = restarted(h);
    await recovered.execute(sessionId);
    await recovered.execute(sessionId);
    await h.app.completeTurn.execute({ sessionId, turnId: 'turn-delivery' });
    expect(h.repository.rows.get(sessionId)?.usage.turns).toBe(1);
    expect(h.events.events.filter(event => event.type === 'TurnCompleted')).toHaveLength(1);
    expect(h.events.events.find(event => event.type === 'TurnCompleted')).toMatchObject({
      aggregateId: sessionId, turnId: 'turn-delivery',
    });
  });

  it('recovers a failed tool result publication after reconstruction without consuming call budget twice', async () => {
    const h = harness();
    const { sessionId } = await connected(h);
    const input = call(sessionId);
    expect(await h.app.reviewToolCall.execute({ ...input, arguments: {} })).toMatchObject({ kind: 'allow' });
    vi.spyOn(h.events, 'publish').mockRejectedValueOnce(new Error('audit unavailable'));
    await expect(h.app.recordToolResult.execute({ ...input, ok: true })).rejects.toThrow('audit unavailable');
    expect(h.repository.rows.get(sessionId)?.usage.toolCalls).toBe(1);

    const recovered = restarted(h);
    await recovered.execute(sessionId);
    await recovered.execute(sessionId);
    await h.app.recordToolResult.execute({ ...input, ok: true });
    expect(h.repository.rows.get(sessionId)?.usage.toolCalls).toBe(1);
    expect(h.events.events.filter(event => event.type === 'ToolCallReviewed')).toHaveLength(1);
    expect(h.events.events.filter(event => event.type === 'ToolCallCompleted')).toHaveLength(1);
    expect(h.events.events.find(event => event.type === 'ToolCallCompleted')).toMatchObject({
      callId: input.callId, turnId: input.turnId,
    });
  });

  it('retries an ambiguous publication with stable IDs so an idempotent sink records only once', async () => {
    const h = harness();
    const { sessionId } = await connected(h);
    const rows = new Map<string, DomainEvent>();
    const publish = h.events.publish.bind(h.events);
    let loseAcknowledgement = true;
    vi.spyOn(h.events, 'publish').mockImplementation(async events => {
      const fresh: DomainEvent[] = [];
      for (const event of events) {
        const key = (event as DomainEvent & { eventId?: string }).eventId;
        expect(typeof key).toBe('string');
        if (!rows.has(key!)) { rows.set(key!, event); fresh.push(event); }
      }
      await publish(fresh);
      if (loseAcknowledgement) { loseAcknowledgement = false; throw new Error('publication acknowledgement lost'); }
    });
    await expect(h.app.completeTurn.execute({ sessionId, turnId: 'turn-ack-loss' })).rejects.toThrow('publication acknowledgement lost');
    const recovered = restarted(h);
    await recovered.execute(sessionId);
    await recovered.execute(sessionId);
    expect(h.repository.rows.get(sessionId)?.usage.turns).toBe(1);
    expect(rows.size).toBe(1);
    expect(h.events.events.filter(event => event.type === 'TurnCompleted')).toHaveLength(1);
  });

  it('records a late result after hangup once while keeping the ended session and budget unchanged', async () => {
    const h = harness();
    const { sessionId } = await connected(h);
    const input = call(sessionId);
    expect(await h.app.reviewToolCall.execute({ ...input, arguments: {} })).toMatchObject({ kind: 'allow' });
    await h.app.handleRealtimeDisconnect.execute(sessionId);
    const usage = structuredClone(h.repository.rows.get(sessionId)!.usage);
    vi.spyOn(h.events, 'publish').mockRejectedValueOnce(new Error('audit unavailable'));
    await expect(h.app.recordToolResult.execute({ ...input, ok: true })).rejects.toThrow('audit unavailable');
    await restarted(h).execute(sessionId);
    await h.app.recordToolResult.execute({ ...input, ok: true });
    await h.app.completeTurn.execute({ sessionId, turnId: input.turnId });
    const persisted = h.repository.rows.get(sessionId)!;
    expect(persisted.status).toBe('ended');
    expect(persisted.usage).toEqual(usage);
    expect(h.events.events.filter(event => event.type === 'ToolCallCompleted')).toHaveLength(1);
    expect(h.events.events.filter(event => event.type === 'TurnCompleted')).toHaveLength(0);
    expect(h.events.events.filter(event => event.type === 'VoiceSessionEnded')).toHaveLength(1);
  });
});
