import type { PrincipalQuotaStore } from '@vdoc-server/application';
import { PrincipalQuota, ok, type PrincipalQuotaLimits, type PrincipalQuotaState, type QuotaExceeded, type QuotaReservation, type Result } from '@vdoc-server/domain';
import type { KeyValueStorage, StorageTransaction } from './index';

/** A single principal's durable counters. The whole decision and alarm are one storage transaction. */
export class DurablePrincipalQuotaStore implements PrincipalQuotaStore {
  readonly #policy: PrincipalQuota;
  constructor(private readonly storage: KeyValueStorage, limits: PrincipalQuotaLimits, private readonly now: () => number = Date.now) {
    this.#policy = new PrincipalQuota(limits);
  }

  reserve(input: QuotaReservation): Promise<Result<void, QuotaExceeded>> {
    return this.storage.transaction(async (tx) => {
      const now = this.now();
      const state = await tx.get<PrincipalQuotaState>('quota') ?? PrincipalQuota.empty;
      const reserved = this.#policy.reserve(state, input, now);
      await this.#save(tx, reserved.ok ? reserved.value : this.#policy.prune(state, now));
      return reserved.ok ? ok(undefined) : reserved;
    });
  }

  async confirm(_principalId: string, sessionId: string): Promise<void> { await this.#change('confirm', sessionId); }
  async cancel(_principalId: string, sessionId: string): Promise<void> { await this.#change('cancel', sessionId); }

  async #change(action: 'confirm' | 'cancel', sessionId: string): Promise<void> {
    await this.storage.transaction(async (tx) => {
      const state = await tx.get<PrincipalQuotaState>('quota') ?? PrincipalQuota.empty;
      await this.#save(tx, this.#policy[action](state, sessionId, this.now()));
    });
  }

  async release(_principalId: string, sessionId: string): Promise<void> {
    await this.storage.transaction(async (tx) => {
      const state = await tx.get<PrincipalQuotaState>('quota') ?? PrincipalQuota.empty;
      await this.#save(tx, this.#policy.release(state, sessionId, this.now()));
    });
  }

  async prune(): Promise<void> {
    await this.storage.transaction(async (tx) => {
      const state = await tx.get<PrincipalQuotaState>('quota') ?? PrincipalQuota.empty;
      await this.#save(tx, this.#policy.prune(state, this.now()));
    });
  }

  async #save(tx: StorageTransaction, state: PrincipalQuotaState): Promise<void> {
    const deadlines = [...state.slots.map((slot) => slot.expiresAt), ...state.starts.map((start) => start.at + PrincipalQuota.windowMs)];
    if (!deadlines.length) {
      await tx.delete(['quota']);
      await tx.deleteAlarm();
    } else {
      await tx.put('quota', state);
      await tx.setAlarm(Math.max(this.now(), deadlines.reduce((earliest, deadline) => Math.min(earliest, deadline), Infinity)));
    }
  }
}

/** Structural binding interface: Cloudflare types stay at the runtime edge. */
export class PrincipalQuotaBinding<Id> implements PrincipalQuotaStore {
  constructor(private readonly namespace: { idFromName(name: string): Id; get(id: Id): PrincipalQuotaStore }) {}
  reserve(input: QuotaReservation): Promise<Result<void, QuotaExceeded>> {
    return this.namespace.get(this.namespace.idFromName(input.principalId)).reserve(input);
  }
  confirm(principalId: string, sessionId: string): Promise<void> {
    return this.namespace.get(this.namespace.idFromName(principalId)).confirm(principalId, sessionId);
  }
  cancel(principalId: string, sessionId: string): Promise<void> {
    return this.namespace.get(this.namespace.idFromName(principalId)).cancel(principalId, sessionId);
  }
  release(principalId: string, sessionId: string): Promise<void> {
    return this.namespace.get(this.namespace.idFromName(principalId)).release(principalId, sessionId);
  }
}
