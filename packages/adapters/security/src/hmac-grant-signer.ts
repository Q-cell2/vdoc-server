import type { GrantSigner } from '@vdoc-server/application';
import { SessionGrant } from '@vdoc-server/domain';
import { fromBase64Url, fromUtf8, toBase64Url, utf8 } from './encoding';

export interface SigningKey {
  /** Short public key id carried in the token, so keys can rotate without breaking live grants. */
  readonly id: string;
  /** At least 32 random bytes. */
  readonly secret: Uint8Array;
}

const VERSION = 'vg1';
const KEY_ID = /^[A-Za-z0-9_-]{1,16}$/;

/**
 * Grants as `vg1.<keyId>.<payload>.<signature>` with HMAC-SHA-256 over the first
 * three parts. The first key signs; all keys verify (rotation: add the new key
 * first, keep the old one until its grants have expired).
 */
export class HmacGrantSigner implements GrantSigner {
  private constructor(private readonly active: string, private readonly keys: ReadonlyMap<string, CryptoKey>) {}

  static async create(keys: readonly SigningKey[]): Promise<HmacGrantSigner> {
    if (keys.length === 0) throw new Error('At least one signing key is required.');
    const imported = new Map<string, CryptoKey>();
    for (const key of keys) {
      if (!KEY_ID.test(key.id)) throw new Error(`Invalid signing key id "${key.id}".`);
      if (key.secret.length < 32) throw new Error(`Signing key "${key.id}" must be at least 32 bytes.`);
      if (imported.has(key.id)) throw new Error(`Duplicate signing key id "${key.id}".`);
      imported.set(key.id, await crypto.subtle.importKey('raw', new Uint8Array(key.secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']));
    }
    return new HmacGrantSigner(keys[0]!.id, imported);
  }

  async sign(grant: SessionGrant): Promise<string> {
    const { sessionId, documentId, principalId, issuedAt, expiresAt } = grant.toProps();
    const payload = toBase64Url(utf8(JSON.stringify({ sid: sessionId, doc: documentId, sub: principalId, iat: issuedAt, exp: expiresAt })));
    const signed = `${VERSION}.${this.active}.${payload}`;
    const signature = new Uint8Array(await crypto.subtle.sign('HMAC', this.keys.get(this.active)!, utf8(signed)));
    return `${signed}.${toBase64Url(signature)}`;
  }

  async verify(token: string): Promise<SessionGrant | undefined> {
    if (token.length > 2048) return undefined;
    const [version, keyId, payload, signature, ...rest] = token.split('.');
    if (version !== VERSION || !keyId || !payload || !signature || rest.length > 0) return undefined;
    const key = this.keys.get(keyId);
    const signatureBytes = fromBase64Url(signature);
    const payloadBytes = fromBase64Url(payload);
    if (!key || !signatureBytes || !payloadBytes) return undefined;
    if (!(await crypto.subtle.verify('HMAC', key, signatureBytes, utf8(`${version}.${keyId}.${payload}`)))) return undefined;
    let claims: Record<string, unknown>;
    try {
      claims = JSON.parse(fromUtf8(payloadBytes)) as Record<string, unknown>;
    } catch {
      return undefined;
    }
    const grant = SessionGrant.restore({ sessionId: claims.sid, documentId: claims.doc, principalId: claims.sub, issuedAt: claims.iat, expiresAt: claims.exp });
    return grant.ok ? grant.value : undefined;
  }
}
