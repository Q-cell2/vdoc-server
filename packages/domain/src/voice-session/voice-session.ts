import type { Principal } from '../access/principal';
import { SessionGrant } from '../access/session-grant';
import type { AgentProfile } from '../agent-profile/agent-profile';
import {
  AggregateRoot, DocumentId, PrincipalId, ProfileId, TurnId, VoiceSessionId,
  domainError, err, ok, type DomainError, type Result,
} from '../shared';
import type { RiskAssessor } from '../tool-governance/risk';
import { fingerprint, type ToolCall } from '../tool-governance/tool-call';
import type { ToolDecision } from '../tool-governance/tool-decision';
import type { ToolPolicy } from '../tool-governance/tool-policy';
import type { EndReason, TurnMetrics, VoiceSessionEvent } from './events';
import type { SessionLimits } from './session-limits';
import { Usage } from './usage';

export type VoiceSessionStatus = 'granted' | 'active' | 'ended';
export type SessionError = DomainError<'SESSION_CLOSED'>;

/** A destructive request the user was asked about, and the turn in which it was asked. */
export interface PendingConfirmation {
  readonly fingerprint: string;
  readonly turnId: string;
}

/** Plain, serialisable state (Memento). Repositories store this, never the object. */
export interface VoiceSessionSnapshot {
  readonly id: string;
  readonly documentId: string;
  readonly principalId: string;
  readonly profileId: string;
  readonly status: VoiceSessionStatus;
  readonly limits: SessionLimits;
  readonly usage: Usage;
  readonly createdAt: number;
  readonly connectDeadline: number;
  readonly startedAt: number | null;
  readonly endedAt: number | null;
  readonly endReason: EndReason | null;
  readonly pendingConfirmations: readonly PendingConfirmation[];
}

/** Collaborators the aggregate consults when reviewing a tool call (domain services). */
export interface ToolGovernance {
  readonly policy: ToolPolicy;
  readonly assessor: RiskAssessor;
  readonly allowedTools: ReadonlySet<string>;
}

const MAX_PENDING_CONFIRMATIONS = 16;

/**
 * Aggregate root: one person talking to the agent about one document.
 *
 * Invariants: a session belongs to one principal and one document; once ended it
 * never reopens; it stays within its limits; destructive tool calls need a
 * confirmation from an earlier turn; every state change is recorded as an event.
 */
export class VoiceSession extends AggregateRoot<VoiceSessionEvent> {
  private constructor(private state: VoiceSessionSnapshot) {
    super();
  }

  static grant(input: { id: VoiceSessionId; documentId: DocumentId; principal: Principal; profile: AgentProfile; now: number }): VoiceSession {
    const { id, documentId, principal, profile, now } = input;
    const session = new VoiceSession({
      id, documentId, principalId: principal.id, profileId: profile.id, status: 'granted',
      limits: profile.limits, usage: Usage.empty, createdAt: now, connectDeadline: now + profile.limits.grantTtlMs,
      startedAt: null, endedAt: null, endReason: null, pendingConfirmations: [],
    });
    session.record({ type: 'VoiceSessionGranted', aggregateId: id, occurredAt: now, documentId, principalId: principal.id, profileId: profile.id });
    return session;
  }

  static restore(snapshot: VoiceSessionSnapshot): VoiceSession {
    return new VoiceSession(snapshot);
  }

  toSnapshot(): VoiceSessionSnapshot {
    return this.state;
  }

  get id(): VoiceSessionId { return VoiceSessionId.assume(this.state.id); }
  get documentId(): DocumentId { return DocumentId.assume(this.state.documentId); }
  get principalId(): PrincipalId { return PrincipalId.assume(this.state.principalId); }
  get profileId(): ProfileId { return ProfileId.assume(this.state.profileId); }
  get status(): VoiceSessionStatus { return this.state.status; }
  get usage(): Usage { return this.state.usage; }
  get limits(): SessionLimits { return this.state.limits; }
  get endReason(): EndReason | null { return this.state.endReason; }

  isOwnedBy(principalId: PrincipalId): boolean {
    return this.state.principalId === principalId;
  }

  /** Not ended and not past a deadline that would end it. */
  isOpenAt(now: number): boolean {
    return this.state.status !== 'ended' && this.overdueReason(now) === undefined;
  }

  /** A fresh grant for connecting or reconnecting. Keeps an unconnected session alive as long as grants are renewed. */
  issueGrant(now: number): Result<SessionGrant, SessionError> {
    if (!this.isOpenAt(now)) return err(this.closedError());
    if (this.state.status === 'granted') this.state = { ...this.state, connectDeadline: now + this.state.limits.grantTtlMs };
    return ok(SessionGrant.issue({ sessionId: this.id, documentId: this.documentId, principalId: this.principalId, issuedAt: now, ttlMs: this.state.limits.grantTtlMs }));
  }

  connect(now: number): Result<{ reconnect: boolean }, SessionError> {
    if (!this.isOpenAt(now)) return err(this.closedError());
    const reconnect = this.state.status === 'active';
    if (!reconnect) this.state = { ...this.state, status: 'active', startedAt: now };
    this.record({ type: 'VoiceSessionConnected', aggregateId: this.state.id, occurredAt: now, reconnect });
    return ok({ reconnect });
  }

  reviewToolCall(call: ToolCall, governance: ToolGovernance, now: number): ToolDecision {
    const assessment = governance.assessor.assess(call);
    let decision: ToolDecision;
    if (this.state.status !== 'active' || !this.isOpenAt(now)) {
      decision = { kind: 'deny', risk: assessment.risk, code: 'SESSION_CLOSED', message: 'This voice session has ended.' };
    } else {
      const print = fingerprint(call);
      const confirmedInEarlierTurn = this.state.pendingConfirmations.some((p) => p.fingerprint === print && p.turnId !== call.turnId);
      decision = governance.policy.review({
        call, assessment, allowedTools: governance.allowedTools, limits: this.state.limits,
        callsSoFarInTurn: Usage.callsSoFar(this.state.usage, call.turnId), confirmedInEarlierTurn,
      });
      const others = this.state.pendingConfirmations.filter((p) => p.fingerprint !== print);
      const pendingConfirmations = decision.kind === 'confirm'
        ? [...others, { fingerprint: print, turnId: call.turnId }].slice(-MAX_PENDING_CONFIRMATIONS)
        : decision.kind === 'allow' && confirmedInEarlierTurn ? others : this.state.pendingConfirmations;
      this.state = { ...this.state, usage: Usage.withToolCall(this.state.usage, call.turnId), pendingConfirmations };
    }
    this.record({
      type: 'ToolCallReviewed', aggregateId: this.state.id, occurredAt: now, callId: call.id, tool: call.name, turnId: call.turnId,
      risk: decision.risk, decision: decision.kind, ...(decision.kind === 'deny' ? { code: decision.code } : {}), operations: assessment.operations,
    });
    return decision;
  }

  recordToolResult(call: Pick<ToolCall, 'id' | 'name' | 'turnId'>, outcome: { ok: boolean; code?: string }, now: number): void {
    this.record({
      type: 'ToolCallCompleted', aggregateId: this.state.id, occurredAt: now, callId: call.id, tool: call.name, turnId: call.turnId,
      ok: outcome.ok, ...(outcome.code !== undefined ? { code: outcome.code } : {}),
    });
  }

  /** Counts the turn and ends the session if it used up its turns. Returns the end reason when it ended. */
  completeTurn(turnId: TurnId, now: number, metrics: TurnMetrics = {}): EndReason | undefined {
    if (this.state.status === 'ended') return undefined;
    const toolCalls = Usage.callsSoFar(this.state.usage, turnId);
    this.state = { ...this.state, usage: Usage.withCompletedTurn(this.state.usage) };
    this.record({ ...metrics, type: 'TurnCompleted', aggregateId: this.state.id, occurredAt: now, turnId, toolCalls });
    if (this.state.usage.turns >= this.state.limits.maxTurns) {
      this.end('limit-turns', now);
      return 'limit-turns';
    }
    return this.expireIfOverdue(now);
  }

  /** Ends the session if a deadline has passed. Returns the reason when it ended. */
  expireIfOverdue(now: number): EndReason | undefined {
    if (this.state.status === 'ended') return undefined;
    const reason = this.overdueReason(now);
    if (reason) this.end(reason, now);
    return reason;
  }

  /** Idempotent. Returns whether this call ended the session. */
  end(reason: EndReason, now: number): boolean {
    if (this.state.status === 'ended') return false;
    const durationMs = this.state.startedAt === null ? null : now - this.state.startedAt;
    this.state = { ...this.state, status: 'ended', endedAt: now, endReason: reason, pendingConfirmations: [] };
    this.record({ type: 'VoiceSessionEnded', aggregateId: this.state.id, occurredAt: now, reason, durationMs, usage: this.state.usage });
    return true;
  }

  private overdueReason(now: number): EndReason | undefined {
    const { status, connectDeadline, startedAt, limits } = this.state;
    if (status === 'granted' && now > connectDeadline) return 'expired';
    if (status === 'active' && startedAt !== null && now - startedAt >= limits.maxDurationMs) return 'limit-duration';
    return undefined;
  }

  private closedError(): SessionError {
    return domainError('SESSION_CLOSED', 'This voice session has ended. Start a new one.');
  }
}
