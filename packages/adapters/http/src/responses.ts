import type { AppError, AppErrorCode } from '@vdoc-server/application';

const STATUS: Record<AppErrorCode, number> = {
  UNAUTHENTICATED: 401,
  GRANT_INVALID: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  INVALID_INPUT: 400,
  DOCUMENT_BUSY: 409,
  SESSION_CLOSED: 410,
  QUOTA_EXCEEDED: 429,
  QUOTA_UNAVAILABLE: 503,
};

export const statusOf = (code: AppErrorCode): number => STATUS[code];

/**
 * WebSocket close codes for refusing an accepted realtime connection. Browsers do
 * not expose the HTTP status of a failed handshake, so known-but-unusable
 * sessions are accepted and closed with one of these instead.
 */
export function closeCodeOf(code: AppErrorCode): number {
  return 4000 + (STATUS[code] ?? 400);
}

export function json(body: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } });
}

/** RFC 9457 problem details; `code` is the stable machine-readable part. */
export function problem(status: number, code: string, detail: string, headers: HeadersInit = {}, extensions: Readonly<Record<string, unknown>> = {}): Response {
  return new Response(JSON.stringify({ ...extensions, type: 'about:blank', title: TITLES[status] ?? 'Error', status, code, detail }), {
    status, headers: { 'content-type': 'application/problem+json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

export function fromAppError(error: AppError): Response {
  const status = statusOf(error.code);
  return problem(status, error.code, error.message, {
    ...(status === 401 ? { 'www-authenticate': 'Bearer' } : {}),
    ...(error.retryAfterSeconds !== undefined ? { 'retry-after': String(error.retryAfterSeconds) } : {}),
  }, { ...(error.quotaKind ? { quotaKind: error.quotaKind } : {}), ...(error.retryAfterSeconds !== undefined ? { retryAfterSeconds: error.retryAfterSeconds } : {}) });
}

const TITLES: Record<number, string> = {
  400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 405: 'Method Not Allowed',
  409: 'Conflict', 410: 'Gone', 413: 'Content Too Large', 415: 'Unsupported Media Type', 426: 'Upgrade Required', 429: 'Too Many Requests', 500: 'Internal Server Error',
};
