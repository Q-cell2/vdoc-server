import { err, ok, type Principal, type Result } from '@vdoc-server/domain';
import { appError, type AppError } from '../errors';
import type { CallerAuthenticator, CallerCredentials } from '../ports';

export async function authenticateCaller(authenticator: CallerAuthenticator, credentials: CallerCredentials): Promise<Result<Principal, AppError>> {
  const principal = credentials.bearer ? await authenticator.authenticate(credentials) : undefined;
  return principal ? ok(principal) : err(appError('UNAUTHENTICATED', 'A valid application credential and permitted caller identity are required.'));
}
