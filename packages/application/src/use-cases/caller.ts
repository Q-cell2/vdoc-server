import { err, ok, type Principal, type Result, type VoiceSession } from '@vdoc-server/domain';
import { appError, type AppError } from '../errors';
import type { CallerAuthenticator, CallerCredentials } from '../ports';
import type { VoiceSessionStore } from '../voice-session-store';

export async function authenticateCaller(authenticator: CallerAuthenticator, credentials: CallerCredentials): Promise<Result<Principal, AppError>> {
  const principal = credentials.bearer ? await authenticator.authenticate(credentials) : undefined;
  return principal ? ok(principal) : err(appError('UNAUTHENTICATED', 'A valid application credential and permitted caller identity are required.'));
}

export interface OwnedSessionRequest {
  readonly credentials: CallerCredentials;
  readonly documentId: string;
  readonly sessionId: string;
}

/** Authenticates the caller and loads a session of the document that the caller owns. */
export async function loadOwnedSession(deps: { authenticator: CallerAuthenticator; store: VoiceSessionStore }, request: OwnedSessionRequest): Promise<Result<VoiceSession, AppError>> {
  const principal = await authenticateCaller(deps.authenticator, request.credentials);
  if (!principal.ok) return principal;
  return deps.store.findOwned(request.documentId, request.sessionId, principal.value);
}
