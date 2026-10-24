import { domainError, err, ok, type DomainError, type Result } from '../shared';

/** Bounds every voice session must stay within. Value object. */
export interface SessionLimits {
  /** How long a grant (and an unconnected session) stays valid. */
  readonly grantTtlMs: number;
  /** Wall-clock cap from the first connection. */
  readonly maxDurationMs: number;
  readonly maxTurns: number;
  /** Stops runaway tool loops inside one turn. */
  readonly maxToolCallsPerTurn: number;
}

const MINUTE = 60_000;

export const SessionLimits = {
  defaults: Object.freeze({ grantTtlMs: MINUTE, maxDurationMs: 30 * MINUTE, maxTurns: 300, maxToolCallsPerTurn: 12 }) as SessionLimits,

  create(input: SessionLimits): Result<SessionLimits, DomainError<'INVALID_LIMITS'>> {
    const values = [input.grantTtlMs, input.maxDurationMs, input.maxTurns, input.maxToolCallsPerTurn];
    if (!values.every((value) => Number.isInteger(value) && value > 0)) {
      return err(domainError('INVALID_LIMITS', 'Session limits must be positive integers.'));
    }
    if (input.grantTtlMs > 10 * MINUTE) return err(domainError('INVALID_LIMITS', 'Grants must expire within 10 minutes.'));
    return ok(Object.freeze({ ...input }));
  },
};
