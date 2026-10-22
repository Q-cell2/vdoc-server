import { expect, it } from 'vitest';
import { parseTurnMetrics } from '../src';
it('copies finite optional provider measurements without leaking content', () => {
  expect(parseTurnMetrics({ toolCalls: 2, timeToFirstAudioMs: 0, timeToFirstToolCallMs: 42.5, interruptLatencyMs: -1, text: 'secret' }))
    .toEqual({ modelToolCalls: 2, timeToFirstAudioMs: 0, timeToFirstToolCallMs: 42.5 });
  expect(parseTurnMetrics({ toolCalls: 1.5, timeToFirstAudioMs: Infinity, timeToFirstToolCallMs: NaN })).toEqual({});
});
