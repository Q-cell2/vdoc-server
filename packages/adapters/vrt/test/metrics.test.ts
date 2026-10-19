import { fakeModel } from '@vrealtime/testing';
import { expect, it } from 'vitest';
import { connected, harness } from '../../../application/test/fakes';
import { ModelRegistry, RealtimeHost } from '../src';

it('forwards SDK turn measurements through the application and drops nonnumeric payloads', async () => {
  const h = harness();
  const { sessionId } = await connected(h);
  const host = new RealtimeHost({ handlers: () => h.app, models: new ModelRegistry().register({ id: 'fake', create: () => fakeModel() }) });
  const room = await host.open({ documentId: 'doc-1', sessionId });
  if (!room.ok) throw new Error(room.error.message);
  try {
    room.value.hub.agent.hooks!.onTurnEnd!({ id: 't-metrics', epoch: 1, state: 'idle', interrupted: true, startedAt: 0 }, {
      toolCalls: 2, timeToFirstAudioMs: 42, timeToFirstToolCallMs: 18, interruptLatencyMs: 3,
    });
    await expect.poll(() => h.events.events.find((event) => event.type === 'TurnCompleted')).toMatchObject({
      aggregateId: sessionId, turnId: 't-metrics', modelToolCalls: 2, timeToFirstAudioMs: 42, timeToFirstToolCallMs: 18, interruptLatencyMs: 3,
    });
  } finally { await host.closeAll(); }
});
