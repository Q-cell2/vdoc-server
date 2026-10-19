import type { TurnMetrics } from '@vdoc-server/domain';

/** Provider instrumentation is untrusted metadata; copy only finite nonnegative measurements. */
export function parseTurnMetrics(raw: unknown): TurnMetrics {
  const input = raw !== null && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const result: Record<string, number> = {};
  for (const field of ['timeToFirstAudioMs', 'timeToFirstToolCallMs', 'interruptLatencyMs']) {
    const value = input[field];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) result[field] = value;
  }
  if (typeof input.toolCalls === 'number' && Number.isSafeInteger(input.toolCalls) && input.toolCalls >= 0) result.modelToolCalls = input.toolCalls;
  return result;
}
