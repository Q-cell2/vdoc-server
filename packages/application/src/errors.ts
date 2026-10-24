import type { DomainError } from '@vdoc-server/domain';

export type AppErrorCode =
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'INVALID_INPUT'
  | 'GRANT_INVALID'
  | 'SESSION_CLOSED'
  | 'DOCUMENT_BUSY';

/** Failure a use case reports to its caller. Edges map `code` to HTTP statuses or close codes. */
export interface AppError {
  readonly code: AppErrorCode;
  readonly message: string;
}

export const appError = (code: AppErrorCode, message: string): AppError => ({ code, message });

const FROM_DOMAIN: Record<string, AppErrorCode> = {
  INVALID_ID: 'INVALID_INPUT',
  INVALID_LIMITS: 'INVALID_INPUT',
  INVALID_GRANT: 'GRANT_INVALID',
  GRANT_EXPIRED: 'GRANT_INVALID',
  GRANT_SCOPE_MISMATCH: 'GRANT_INVALID',
  SESSION_CLOSED: 'SESSION_CLOSED',
  DOCUMENT_BUSY: 'DOCUMENT_BUSY',
  DELEGATION_UNKNOWN: 'FORBIDDEN',
};

/** Anti-corruption at the layer boundary: callers never see domain codes they cannot map. */
export function fromDomain(error: DomainError): AppError {
  return { code: FROM_DOMAIN[error.code] ?? 'INVALID_INPUT', message: error.message };
}
