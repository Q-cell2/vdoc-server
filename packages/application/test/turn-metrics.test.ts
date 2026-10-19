import { expect, it } from 'vitest';
import { connected, harness } from './fakes';

it('copies only valid optional turn measurements and keeps missing latency absent', async () => {
  const h = harness();
  const { sessionId } = await connected(h);
  await h.app.completeTurn.execute({ sessionId, turnId: 'measured', metrics: { toolCalls: 2, timeToFirstAudioMs: 0, timeToFirstToolCallMs: 42.5, interruptLatencyMs: -1, text: 'secret metrics content' } });
  await h.app.completeTurn.execute({ sessionId, turnId: 'invalid', metrics: { toolCalls: 1.5, timeToFirstAudioMs: Infinity, timeToFirstToolCallMs: NaN } });
  const turns = h.events.events.filter((event) => event.type === 'TurnCompleted');
  expect(turns[0]).toMatchObject({ turnId: 'measured', modelToolCalls: 2, timeToFirstAudioMs: 0, timeToFirstToolCallMs: 42.5 });
  expect(turns[0]).not.toHaveProperty('interruptLatencyMs');
  expect(turns[1]).not.toHaveProperty('modelToolCalls');
  expect(turns[1]).not.toHaveProperty('timeToFirstAudioMs');
  expect(turns[1]).not.toHaveProperty('timeToFirstToolCallMs');
  expect(JSON.stringify(h.events.events)).not.toContain('secret metrics content');
});
