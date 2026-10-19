import type { QuotaExceeded, QuotaReservation, Result } from '@vdoc-server/domain';

/** Atomic across all documents for a principal; failures must not fall back to local counters. */
export interface PrincipalQuotaStore {
  reserve(input: QuotaReservation): Promise<Result<void, QuotaExceeded>>;
  confirm(principalId: string, sessionId: string): Promise<void>;
  cancel(principalId: string, sessionId: string): Promise<void>;
  release(principalId: string, sessionId: string): Promise<void>;
}
