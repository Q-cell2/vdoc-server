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
import type { EndReason, VoiceSessionEvent } from './events';
import type { SessionLimits } from './session-limits';
import { Usage } from './usage';

export type VoiceSessionStatus = 'granted' | 'active' | 'ended';
export type SessionError = DomainError<'SESSION_CLOSED'>;
export type DelegationError = DomainError<'SESSION_CLOSED' | 'DELEGATION_UNKNOWN'>;

/** A destructive request the user was asked about, the turn in which it was asked, and how much user input there had been by then. */
export interface PendingConfirmation {
  readonly fingerprint: string;
  readonly turnId: string;
  /** Absent in snapshots written before this field existed; such confirmations are asked again. */
  readonly userInputs?: number;
}

/** Plain, serialisable state (Memento). Repositories store this, never the object. */
export interface VoiceSessionSnapshot {
  readonly id: string;
  readonly documentId: string;
  readonly principalId: string;
  readonly principalKind?: Principal['kind'];
  readonly completedTurnIds?: readonly string[];
  readonly completedToolCallIds?: readonly string[];
  readonly toolDecisions?: Readonly<Record<string, { readonly fingerprint: string; readonly turnId: string; readonly decision: ToolDecision }>>;
  readonly profileId: string;
  readonly status: VoiceSessionStatus;
  readonly limits: SessionLimits;
  readonly usage: Usage;
  readonly createdAt: number;
  readonly connectDeadline: number;
  readonly startedAt: number | null;
  readonly endedAt: number | null;
  readonly endReason: EndReason | null;
  readonly userInputs?: number;
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
 * Idempotency memory for repeated callbacks (resume replays, retried commands). Repeats
 * arrive within moments, so a recent window is enough; unbounded lists would grow the
 * snapshot by every turn and call until it hit the storage row limit.
 */
const REMEMBERED_TURNS = 64;
const REMEMBERED_TOOL_RESULTS = 256;

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
      id, documentId, principalId: principal.id, principalKind: principal.kind,
      profileId: profile.id, status: 'granted',
      limits: profile.limits, usage: Usage.empty, createdAt: now, connectDeadline: now + Math.min(profile.limits.grantTtlMs, profile.limits.maxDurationMs),
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
  get principalKind(): Principal['kind'] { return this.state.principalKind ?? 'client'; }
  get endedAt(): number | null { return this.state.endedAt; }
  get userInputs(): number { return this.state.userInputs ?? 0; }

  recordUserInput(now: number): void {
    if (this.state.status !== 'active' || !this.isOpenAt(now)) return;
    this.state = { ...this.state, userInputs: this.userInputs + 1 };
    this.record({ type: 'UserInputRecorded', aggregateId: this.id, occurredAt: now, sequence: this.userInputs });
  }

  /** First millisecond at which this session is overdue. */
  deadline(): number | undefined {
    if (this.state.status === 'granted') return this.state.connectDeadline + 1;
    if (this.state.status === 'active' && this.state.startedAt !== null) return this.state.startedAt + this.state.limits.maxDurationMs;
    return undefined;
  }

  get profileId(): ProfileId { return ProfileId.assume(this.state.profileId); }
  get status(): VoiceSessionStatus { return this.state.status; }
  get usage(): Usage { return this.state.usage; }
  get limits(): SessionLimits { return this.state.limits; }
  get endReason(): EndReason | null { return this.state.endReason; }

  isOwnedBy(principalId: PrincipalId): boolean {
    return this.state.principalId === principalId;
  }

  /** Why the session has ended or would end at `now` (a passed deadline nobody has acted on yet); `null` while open. */
  endReasonAt(now: number): EndReason | null {
    return this.state.status === 'ended' ? this.state.endReason : this.overdueReason(now) ?? null;
  }

  /** Not ended and not past a deadline that would end it. */
  isOpenAt(now: number): boolean {
    return this.state.status !== 'ended' && this.overdueReason(now) === undefined;
  }

  /** A fresh reconnect grant. Unconnected renewal is bounded by the session duration limit. */
  issueGrant(now: number): Result<SessionGrant, SessionError> {
    if (!this.isOpenAt(now)) return err(this.closedError());
    if (this.state.status === 'granted') this.state = { ...this.state, connectDeadline: Math.min(now + this.state.limits.grantTtlMs, this.state.createdAt + this.state.limits.maxDurationMs) };
    return ok(SessionGrant.issue({ sessionId: this.id, documentId: this.documentId, principalId: this.principalId, issuedAt: now, ttlMs: this.state.limits.grantTtlMs }));
  }

  recordGrantRenewal(now: number): void {
    this.record({ type: 'VoiceSessionGrantRenewed', aggregateId: this.state.id, occurredAt: now });
  }

  connect(now: number): Result<{ reconnect: boolean }, SessionError> {
    if (!this.isOpenAt(now)) return err(this.closedError());
    const reconnect = this.state.status === 'active';
    if (!reconnect) this.state = { ...this.state, status: 'active', startedAt: now };
    this.record({ type: 'VoiceSessionConnected', aggregateId: this.state.id, occurredAt: now, reconnect });
    return ok({ reconnect });
  }

  /**
   * `userInputs` counts the user's committed utterances and text messages in this session so far.
   * A turn can start without the user (a late tool result, a model-initiated response), so a
   * confirmation is consumed only once the user has given input since it was asked.
   */
  reviewToolCall(call: ToolCall, governance: ToolGovernance, now: number): ToolDecision {
    const userInputs = this.userInputs;
    const cached = this.state.toolDecisions && Object.hasOwn(this.state.toolDecisions, call.id) ? this.state.toolDecisions[call.id] : undefined;
    if (cached && this.state.status === 'active' && this.isOpenAt(now)) {
      if (cached.fingerprint === fingerprint(call) && cached.turnId === call.turnId) return cached.decision;
      return { kind: 'deny', risk: 'high', code: 'CALL_ID_REUSED', message: 'A tool call ID cannot identify a different request.' };
    }
    const assessment = governance.assessor.assess(call);
    let decision: ToolDecision;
    if (this.state.status !== 'active' || !this.isOpenAt(now)) {
      decision = { kind: 'deny', risk: assessment.risk, code: 'SESSION_CLOSED', message: 'This voice session has ended.' };
    } else {
      const print = fingerprint(call);
      const confirmedInEarlierTurn = this.state.pendingConfirmations.some((p) =>
        p.fingerprint === print && p.turnId !== call.turnId && userInputs > (p.userInputs ?? Infinity));
      decision = governance.policy.review({
        call, assessment, allowedTools: governance.allowedTools, limits: this.state.limits,
        callsSoFarInTurn: Usage.callsSoFar(this.state.usage, call.turnId), confirmedInEarlierTurn,
      });
      const others = this.state.pendingConfirmations.filter((p) => p.fingerprint !== print);
      const pendingConfirmations = decision.kind === 'confirm'
        ? [...others, { fingerprint: print, turnId: call.turnId, userInputs }].slice(-MAX_PENDING_CONFIRMATIONS)
        : decision.kind === 'allow' && confirmedInEarlierTurn ? others : this.state.pendingConfirmations;
      this.state = { ...this.state, usage: Usage.withToolCall(this.state.usage, call.turnId), pendingConfirmations };
    }
    // A session is bounded by turns/calls; persist only decisions that consumed its call budget.
    if (this.state.status === 'active' && this.isOpenAt(now)) this.state = { ...this.state, toolDecisions: { ...this.state.toolDecisions, [call.id]: { fingerprint: fingerprint(call), turnId: call.turnId, decision } } };
    this.record({
      type: 'ToolCallReviewed', aggregateId: this.state.id, occurredAt: now, callId: call.id, tool: call.name, turnId: call.turnId,
      risk: decision.risk, decision: decision.kind, ...(decision.kind === 'deny' ? { code: decision.code } : {}), operations: assessment.operations,
    });
    return decision;
  }

  /**
   * The turn a delegated task works in. A task starts only from a hand-off this
   * session allowed: `callId` must name an allowed call for exactly `handOff`,
   * still in its turn. The task's own tool calls are reviewed and counted under that turn.
   */
  delegatedTurn(callId: string, handOff: Pick<ToolCall, 'name' | 'arguments'>, now: number): Result<TurnId, DelegationError> {
    if (this.state.status !== 'active' || !this.isOpenAt(now)) return err(this.closedError());
    const entry = this.state.toolDecisions && Object.hasOwn(this.state.toolDecisions, callId) ? this.state.toolDecisions[callId] : undefined;
    if (!entry || entry.decision.kind !== 'allow' || entry.fingerprint !== fingerprint(handOff)) {
      return err(domainError('DELEGATION_UNKNOWN', 'No allowed hand-off matches this task.'));
    }
    return ok(TurnId.assume(entry.turnId));
  }

  recordToolResult(call: Pick<ToolCall, 'id' | 'name' | 'turnId'>, outcome: { ok: boolean; code?: string }, now: number): void {
    if ((this.state.completedToolCallIds ?? []).includes(call.id)) return;
    this.state = { ...this.state, completedToolCallIds: [...(this.state.completedToolCallIds ?? []), call.id].slice(-REMEMBERED_TOOL_RESULTS) };
    this.record({
      type: 'ToolCallCompleted', aggregateId: this.state.id, occurredAt: now, callId: call.id, tool: call.name, turnId: call.turnId,
      ok: outcome.ok, ...(outcome.code !== undefined ? { code: outcome.code } : {}),
    });
  }

  /** Counts the turn and ends the session if it used up its turns. Returns the end reason when it ended. */
  completeTurn(turnId: TurnId, now: number): EndReason | undefined {
    if (!this.isOpenAt(now) || (this.state.completedTurnIds ?? []).includes(turnId)) return undefined;
    // A finished turn's calls are settled, so its review decisions can no longer be replayed.
    const toolDecisions = Object.fromEntries(Object.entries(this.state.toolDecisions ?? {}).filter(([, entry]) => entry.turnId !== turnId));
    this.state = { ...this.state, completedTurnIds: [...(this.state.completedTurnIds ?? []), turnId].slice(-REMEMBERED_TURNS), toolDecisions };
    const toolCalls = Usage.callsSoFar(this.state.usage, turnId);
    this.state = { ...this.state, usage: Usage.withCompletedTurn(this.state.usage) };
    this.record({ type: 'TurnCompleted', aggregateId: this.state.id, occurredAt: now, turnId, toolCalls });
    if (this.state.usage.turns >= this.state.limits.maxTurns) {
      this.end('limit-turns', now);
      return 'limit-turns';
    }
    return undefined;
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
    // Cached decisions are only consulted while active.
    this.state = { ...this.state, status: 'ended', endedAt: now, endReason: reason, pendingConfirmations: [], toolDecisions: {} };
    this.record({ type: 'VoiceSessionEnded', aggregateId: this.state.id, occurredAt: now, reason, durationMs, usage: this.state.usage });
    return true;
  }

  private overdueReason(now: number): EndReason | undefined {
    const deadline = this.deadline();
    if (deadline !== undefined && now >= deadline) return this.state.status === 'granted' ? 'expired' : 'limit-duration';
    return undefined;
  }

  private closedError(): SessionError {
    return domainError('SESSION_CLOSED', 'This voice session has ended. Start a new one.');
  }
}
