import type { DomainEvent } from '../shared';
import type { RiskLevel } from '../tool-governance/risk';
import type { ToolDecision } from '../tool-governance/tool-decision';
import type { Usage } from './usage';

export type EndReason = 'client' | 'disconnected' | 'superseded' | 'expired' | 'limit-duration' | 'limit-turns';

export interface VoiceSessionGranted extends DomainEvent<'VoiceSessionGranted'> {
  readonly documentId: string;
  readonly principalId: string;
  readonly profileId: string;
}
export interface VoiceSessionGrantRenewed extends DomainEvent<'VoiceSessionGrantRenewed'> {}
export interface VoiceSessionConnected extends DomainEvent<'VoiceSessionConnected'> {
  readonly reconnect: boolean;
}
/** Content-free on purpose: tool arguments can contain document text. */
export interface ToolCallReviewed extends DomainEvent<'ToolCallReviewed'> {
  readonly callId: string;
  readonly tool: string;
  readonly turnId: string;
  readonly risk: RiskLevel;
  readonly decision: ToolDecision['kind'];
  readonly code?: string;
  readonly operations: readonly string[];
}
export interface ToolCallCompleted extends DomainEvent<'ToolCallCompleted'> {
  readonly callId: string;
  readonly tool: string;
  readonly turnId: string;
  readonly ok: boolean;
  readonly code?: string;
}
/** Optional measurements; missing latency means it was not measured, never zero. */
export interface TurnMetrics {
  readonly timeToFirstAudioMs?: number;
  readonly timeToFirstToolCallMs?: number;
  readonly interruptLatencyMs?: number;
  /** Complete calls admitted to the SDK's current epoch, counted before policy and execution. */
  readonly modelToolCalls?: number;
}
export interface TurnCompleted extends DomainEvent<'TurnCompleted'>, TurnMetrics {
  readonly turnId: string;
  readonly toolCalls: number;
}
export interface VoiceSessionEnded extends DomainEvent<'VoiceSessionEnded'> {
  readonly reason: EndReason;
  readonly durationMs: number | null;
  readonly usage: Usage;
}

export type VoiceSessionEvent =
  | VoiceSessionGranted
  | VoiceSessionGrantRenewed
  | VoiceSessionConnected
  | ToolCallReviewed
  | ToolCallCompleted
  | TurnCompleted
  | VoiceSessionEnded;
