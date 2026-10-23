/** Optional measurements; missing latency means it was not measured, never zero. */
export interface TurnMetrics {
  readonly timeToFirstAudioMs?: number;
  readonly timeToFirstToolCallMs?: number;
  readonly interruptLatencyMs?: number;
  /** Complete calls admitted to the SDK's current epoch, counted before policy and execution. */
  readonly modelToolCalls?: number;
  readonly stopReason?: TurnStopReason;
  readonly continuations?: number;
}

const STOP_REASONS = ['completed', 'tool_calls', 'max_tokens', 'pause', 'refusal', 'content_filter', 'cancelled', 'failed', 'unknown', 'continuation_limit'] as const;
export type TurnStopReason = typeof STOP_REASONS[number];
export function isTurnStopReason(value: unknown): value is TurnStopReason {
  return typeof value === 'string' && (STOP_REASONS as readonly string[]).includes(value);
}

/** Provider instrumentation is untrusted metadata; copy only finite nonnegative measurements. */
export function parseTurnMetrics(raw: unknown): TurnMetrics {
  const input = raw !== null && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const result: Record<string, number | TurnStopReason> = {};
  for (const field of ['timeToFirstAudioMs', 'timeToFirstToolCallMs', 'interruptLatencyMs']) {
    const value = input[field];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) result[field] = value;
  }
  if (typeof input.toolCalls === 'number' && Number.isSafeInteger(input.toolCalls) && input.toolCalls >= 0) result.modelToolCalls = input.toolCalls;
  if (typeof input.continuations === 'number' && Number.isSafeInteger(input.continuations) && input.continuations >= 0) result.continuations = input.continuations;
  if (isTurnStopReason(input.stopReason)) result.stopReason = input.stopReason;
  return result;
}
