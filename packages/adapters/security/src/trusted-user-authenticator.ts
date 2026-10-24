import type { CallerAuthenticator, CallerCredentials } from '@vdoc-server/application';
import { PrincipalId, type Principal } from '@vdoc-server/domain';
import { utf8 } from './encoding';

/** Only an authenticated application may assert a user. Browser headers are not credentials. */
export class TrustedUserAuthenticator implements CallerAuthenticator {
  constructor(private readonly applications: CallerAuthenticator, private readonly allowClientOnly: boolean) {}

  async authenticate(credentials: CallerCredentials): Promise<Principal | undefined> {
    const application = await this.applications.authenticate(credentials);
    if (!application) return undefined;
    const userId = credentials.trustedUserId;
    if (userId === undefined) return this.allowClientOnly ? application : undefined;
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(userId) || /[^A-Za-z0-9._:-]/.test(userId)) return undefined;
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', utf8(JSON.stringify([application.id, userId]))));
    const id = PrincipalId.assume('usr_' + Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join(''));
    return { id, kind: 'user', name: id, clientId: application.id, userId };
  }
}
