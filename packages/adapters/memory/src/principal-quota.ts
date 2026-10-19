import type { PrincipalQuotaStore } from '@vdoc-server/application';
import { PrincipalQuota, ok, type PrincipalQuotaLimits, type PrincipalQuotaState, type QuotaExceeded, type QuotaReservation, type Result } from '@vdoc-server/domain';

/** One process only. No awaits between reading and updating a principal's counters. */
export class InMemoryPrincipalQuotaStore implements PrincipalQuotaStore {
  readonly #states = new Map<string, PrincipalQuotaState>();
  readonly #policy: PrincipalQuota;

  constructor(limits: PrincipalQuotaLimits = PrincipalQuota.defaults, private readonly now: () => number = Date.now) {
    this.#policy = new PrincipalQuota(limits);
  }

  async reserve(input: QuotaReservation): Promise<Result<void, QuotaExceeded>> {
    const result = this.#policy.reserve(this.#states.get(input.principalId) ?? PrincipalQuota.empty, input, this.now());
    if (!result.ok) return result;
    this.#states.set(input.principalId, result.value);
    return ok(undefined);
  }

  async confirm(principalId: string, sessionId: string): Promise<void> {
    this.#states.set(principalId, this.#policy.confirm(this.#states.get(principalId) ?? PrincipalQuota.empty, sessionId, this.now()));
  }

  async cancel(principalId: string, sessionId: string): Promise<void> {
    this.#states.set(principalId, this.#policy.cancel(this.#states.get(principalId) ?? PrincipalQuota.empty, sessionId, this.now()));
  }

  async release(principalId: string, sessionId: string): Promise<void> {
    const state = this.#policy.release(this.#states.get(principalId) ?? PrincipalQuota.empty, sessionId, this.now());
    if (!state.slots.length && !state.starts.length) this.#states.delete(principalId);
    else this.#states.set(principalId, state);
  }
}
