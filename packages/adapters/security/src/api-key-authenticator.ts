import type { CallerAuthenticator, CallerCredentials } from '@vdoc-server/application';
import { PrincipalId, type Principal } from '@vdoc-server/domain';
import { timingSafeEqual, utf8 } from './encoding';

export interface ApiClient {
  readonly id: string;
  readonly name: string;
  /** The bearer key this client presents. Kept only as a SHA-256 digest. */
  readonly key: string;
}

const sha256 = async (text: string): Promise<Uint8Array> => new Uint8Array(await crypto.subtle.digest('SHA-256', utf8(text)));

/** Authenticates installations of the vdoc app by API key (Strategy for `CallerAuthenticator`). */
export class ApiKeyAuthenticator implements CallerAuthenticator {
  private constructor(private readonly clients: readonly { digest: Uint8Array; principal: Principal }[]) {}

  static async create(clients: readonly ApiClient[]): Promise<ApiKeyAuthenticator> {
    const entries = [];
    for (const client of clients) {
      const id = PrincipalId.parse(client.id);
      if (!id.ok) throw new Error(`Invalid client id "${client.id}".`);
      if (client.key.length < 24) throw new Error(`Client key for "${client.id}" must be at least 24 characters.`);
      entries.push({ digest: await sha256(client.key), principal: { id: id.value, kind: 'client' as const, name: client.name } });
    }
    return new ApiKeyAuthenticator(entries);
  }

  async authenticate({ bearer }: CallerCredentials): Promise<Principal | undefined> {
    if (!bearer || bearer.length > 512) return undefined;
    const digest = await sha256(bearer);
    let match: Principal | undefined;
    // Compare against every client so timing does not reveal which one matched.
    for (const client of this.clients) if (timingSafeEqual(digest, client.digest)) match = client.principal;
    return match;
  }
}
