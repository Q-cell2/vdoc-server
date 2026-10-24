/** `/v1/documents/{documentId}/voice-sessions/{sessionId}/realtime`, shared by every runtime's upgrade path. */
const REALTIME = /^\/v1\/documents\/([^/]+)\/voice-sessions\/([^/]+)\/realtime$/;
const DOCUMENT = /^\/v1\/documents\/([^/]+)\//;

export interface RealtimeRouteMatch {
  readonly documentId: string;
  readonly sessionId: string;
}

export function matchRealtimeRoute(pathname: string): RealtimeRouteMatch | undefined {
  const match = REALTIME.exec(pathname);
  if (!match) return undefined;
  try {
    return { documentId: decodeURIComponent(match[1]!), sessionId: decodeURIComponent(match[2]!) };
  } catch {
    return undefined;
  }
}

/** The document a request is about; used to route it to that document's Durable Object. */
export function documentIdOf(pathname: string): string | undefined {
  const match = DOCUMENT.exec(pathname);
  if (!match) return undefined;
  try {
    return decodeURIComponent(match[1]!);
  } catch {
    return undefined;
  }
}

export const realtimePath = (documentId: string, sessionId: string): string =>
  `/v1/documents/${encodeURIComponent(documentId)}/voice-sessions/${encodeURIComponent(sessionId)}/realtime`;

export const isWebSocketUpgrade = (request: Request): boolean => request.headers.get('upgrade')?.toLowerCase() === 'websocket';
