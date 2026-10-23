import { expect, it } from 'vitest';
import { parseTurnMetrics } from '../src';
it('copies finite optional provider measurements without leaking content', () => {
  expect(parseTurnMetrics({ toolCalls: 2, timeToFirstAudioMs: 0, timeToFirstToolCallMs: 42.5, interruptLatencyMs: -1, text: 'secret' }))
    .toEqual({ modelToolCalls: 2, timeToFirstAudioMs: 0, timeToFirstToolCallMs: 42.5 });
  expect(parseTurnMetrics({ toolCalls: 1.5, timeToFirstAudioMs: Infinity, timeToFirstToolCallMs: NaN })).toEqual({});
});


it('allows only standard stop reasons and nonnegative integer continuation counts', () => {
  expect(parseTurnMetrics({ stopReason: 'continuation_limit', continuations: 16, rawStopReason: 'private', output: 'private' })).toEqual({ stopReason: 'continuation_limit', continuations: 16 });
  for (const continuations of [-1, 1.5, NaN, Infinity, '2']) expect(parseTurnMetrics({ stopReason: 'private', continuations })).toEqual({});
  expect(parseTurnMetrics({ stopReason: 'completed', continuations: 0 })).toEqual({ stopReason: 'completed', continuations: 0 });
});
