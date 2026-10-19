import { describe, expect, it } from 'vitest';
import { PrincipalQuota, type PrincipalQuotaState, type QuotaReservation } from '../src';

const reservation = (sessionId: string, expiresAt = 60_001, supersedes: string[] = []): QuotaReservation => ({ principalId: 'alice', sessionId, expiresAt, supersedes });
function reserve(policy: PrincipalQuota, state: PrincipalQuotaState, id: string, now = 0, supersedes: string[] = []) {
  const result = policy.reserve(state, reservation(id, now + 60_001, supersedes), now);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

describe('PrincipalQuota', () => {
  it('limits concurrent sessions, reports seconds rounded up, and recovers at the deadline', () => {
    const policy = new PrincipalQuota({ maxConcurrentSessions: 1, maxSessionsPerHour: 10 });
    const state = reserve(policy, PrincipalQuota.empty, 'first');
    expect(policy.reserve(state, reservation('second'), 1)).toMatchObject({ ok: false, error: { code: 'QUOTA_EXCEEDED', retryAfterSeconds: 60 } });
    expect(policy.reserve(state, reservation('second'), 60_001).ok).toBe(true);
  });
  it('retains rate tokens after release, uses a sliding hour and permits exact window boundary', () => {
    const policy = new PrincipalQuota({ maxConcurrentSessions: 1, maxSessionsPerHour: 2 });
    let state = reserve(policy, PrincipalQuota.empty, 'first');
    state = policy.release(state, 'first', 1);
    state = reserve(policy, state, 'second', 1000);
    state = policy.release(state, 'second', 1001);
    expect(policy.reserve(state, reservation('third'), 1001)).toMatchObject({ ok: false, error: { retryAfterSeconds: 3599 } });
    expect(policy.reserve(state, reservation('third', 3_660_000), 3_600_000).ok).toBe(true);
  });
  it('renews/reconnects idempotently even at the rate cap', () => {
    const policy = new PrincipalQuota({ maxConcurrentSessions: 1, maxSessionsPerHour: 1 });
    const state = reserve(policy, PrincipalQuota.empty, 'first');
    const result = policy.reserve(state, reservation('first', 100_000), 1000);
    expect(result).toMatchObject({ ok: true, value: { starts: [{ sessionId: 'first', at: 0 }], slots: [{ expiresAt: 100_000 }] } });
  });
  it('credits replacement slots without deleting the old reservation before it ends', () => {
    const policy = new PrincipalQuota({ maxConcurrentSessions: 1, maxSessionsPerHour: 10 });
    let state = reserve(policy, PrincipalQuota.empty, 'first');
    state = reserve(policy, state, 'second', 100, ['first']);
    expect(state.slots).toHaveLength(2);
    expect(policy.reserve(state, reservation('third'), 101).ok).toBe(false);
    // A failed/expired replacement cannot release the still-live original's slot.
    state = policy.release(state, 'second', 102);
    expect(policy.reserve(state, reservation('third'), 103).ok).toBe(false);
    state = policy.release(state, 'first', 104);
    expect(policy.reserve(state, reservation('third'), 105).ok).toBe(true);
  });
  it('does not mutate stored snapshots and rejects invalid limits', () => {
    const policy = new PrincipalQuota(PrincipalQuota.defaults);
    const state = structuredClone(PrincipalQuota.empty);
    reserve(policy, state, 'first');
    expect(state).toEqual(PrincipalQuota.empty);
    expect(() => new PrincipalQuota({ maxConcurrentSessions: 0, maxSessionsPerHour: 1 })).toThrow();
  });
});
