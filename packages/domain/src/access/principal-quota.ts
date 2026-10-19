import { err, ok, type DomainError, type Result } from '../shared';

export interface PrincipalQuotaLimits {
  readonly maxConcurrentSessions: number;
  readonly maxSessionsPerHour: number;
}

export interface QuotaSlot {
  readonly sessionId: string;
  readonly expiresAt: number;
  /** Provisional replacement credit; the old slot survives until its session ends. */
  readonly supersedes: readonly string[];
}

export interface PrincipalQuotaState {
  readonly slots: readonly QuotaSlot[];
  readonly starts: readonly { readonly sessionId: string; readonly at: number; readonly confirmed?: boolean }[];
}

export interface QuotaExceeded extends DomainError<'QUOTA_EXCEEDED'> {
  readonly retryAfterSeconds: number;
  readonly quotaKind: 'concurrency' | 'rate';
}

export interface QuotaReservation {
  readonly principalId: string;
  readonly sessionId: string;
  readonly expiresAt: number;
  readonly supersedes?: readonly string[];
}

/** Pure sliding-window policy. Its caller must atomically read, decide and persist per principal. */
export class PrincipalQuota {
  static readonly defaults: PrincipalQuotaLimits = { maxConcurrentSessions: 3, maxSessionsPerHour: 60 };
  static readonly windowMs = 3_600_000;
  static readonly empty: PrincipalQuotaState = { slots: [], starts: [] };

  constructor(readonly limits: PrincipalQuotaLimits) {
    if (Object.values(limits).some((value) => !Number.isSafeInteger(value) || value <= 0)) {
      throw new Error('Principal quota limits must be positive safe integers.');
    }
  }

  prune(state: PrincipalQuotaState, now: number): PrincipalQuotaState {
    return {
      slots: state.slots.filter((slot) => slot.expiresAt > now),
      starts: state.starts.filter((start) => start.at > now - PrincipalQuota.windowMs && (start.confirmed !== false || state.slots.some((slot) => slot.sessionId === start.sessionId && slot.expiresAt > now))),
    };
  }

  reserve(state: PrincipalQuotaState, input: QuotaReservation, now: number): Result<PrincipalQuotaState, QuotaExceeded> {
    const current = this.prune(state, now);
    const existing = current.slots.find((slot) => slot.sessionId === input.sessionId);
    if (existing) {
      // Renewal/reconnect updates a lease, never consumes another session or rate token.
      return ok({ ...current, slots: current.slots.map((slot) => slot === existing ? { ...slot, expiresAt: Math.max(slot.expiresAt, input.expiresAt) } : slot) });
    }
    const supersedes = (input.supersedes ?? []).filter((id) => current.slots.some((slot) => slot.sessionId === id));
    const replaced = new Set([...supersedes, ...current.slots.flatMap((slot) => slot.supersedes)]);
    const counted = current.slots.filter((slot) => !replaced.has(slot.sessionId));
    let retryAt = now;
    let quotaKind: QuotaExceeded['quotaKind'] = 'concurrency';
    if (counted.length >= this.limits.maxConcurrentSessions) {
      retryAt = [...counted].sort((a, b) => a.expiresAt - b.expiresAt)[counted.length - this.limits.maxConcurrentSessions]!.expiresAt;
    }
    const alreadyStarted = current.starts.some((start) => start.sessionId === input.sessionId);
    if (!alreadyStarted && current.starts.length >= this.limits.maxSessionsPerHour) {
      const deadlines = current.starts.map((start) => start.confirmed === false
        ? Math.min(start.at + PrincipalQuota.windowMs, current.slots.find((slot) => slot.sessionId === start.sessionId)!.expiresAt)
        : start.at + PrincipalQuota.windowMs).sort((a, b) => a - b);
      const deadline = deadlines[current.starts.length - this.limits.maxSessionsPerHour]!;
      if (deadline >= retryAt) quotaKind = 'rate';
      retryAt = Math.max(retryAt, deadline);
    }
    if (retryAt > now) return err({ code: 'QUOTA_EXCEEDED', message: 'The principal has reached its voice session quota.', quotaKind, retryAfterSeconds: Math.max(1, Math.ceil((retryAt - now) / 1000)) });
    return ok({
      slots: [...current.slots, { sessionId: input.sessionId, expiresAt: input.expiresAt, supersedes }],
      starts: alreadyStarted ? current.starts : [...current.starts, { sessionId: input.sessionId, at: now, confirmed: false }],
    });
  }

  confirm(state: PrincipalQuotaState, sessionId: string, now: number): PrincipalQuotaState {
    const current = this.prune(state, now);
    return { ...current, starts: current.starts.map((start) => start.sessionId === sessionId ? { ...start, confirmed: true } : start) };
  }

  cancel(state: PrincipalQuotaState, sessionId: string, now: number): PrincipalQuotaState {
    const current = this.prune(state, now);
    if (current.starts.some((start) => start.sessionId === sessionId && start.confirmed !== false)) return current;
    return { slots: current.slots.filter((slot) => slot.sessionId !== sessionId), starts: current.starts.filter((start) => start.sessionId !== sessionId) };
  }

  release(state: PrincipalQuotaState, sessionId: string, now: number): PrincipalQuotaState {
    const current = this.prune(state, now);
    return { ...current, slots: current.slots.filter((slot) => slot.sessionId !== sessionId) };
  }
}
