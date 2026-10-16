import { DocumentId, PrincipalId, SessionGrant, VoiceSessionId } from '@vdoc-server/domain';
import { describe, expect, it } from 'vitest';
import { ApiKeyAuthenticator, HmacGrantSigner } from '../src';

const secret = (seed: string) => new TextEncoder().encode(seed.padEnd(32, '.'));
const grant = SessionGrant.issue({
  sessionId: VoiceSessionId.assume('vs_1'), documentId: DocumentId.assume('doc-1'), principalId: PrincipalId.assume('client'), issuedAt: 1_000, ttlMs: 60_000,
});

describe('HmacGrantSigner', () => {
  it('round-trips a grant', async () => {
    const signer = await HmacGrantSigner.create([{ id: 'k1', secret: secret('one') }]);
    const token = await signer.sign(grant);
    expect(token.split('.')).toHaveLength(4);
    expect((await signer.verify(token))?.toProps()).toEqual(grant.toProps());
  });

  it('rejects tampered, foreign and malformed tokens', async () => {
    const signer = await HmacGrantSigner.create([{ id: 'k1', secret: secret('one') }]);
    const other = await HmacGrantSigner.create([{ id: 'k1', secret: secret('two') }]);
    const token = await signer.sign(grant);
    const [v, k, payload, signature] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ sid: 'vs_2', doc: 'doc-1', sub: 'client', iat: 1, exp: 9e15 })).toString('base64url');
    for (const bad of [`${v}.${k}.${forged}.${signature}`, `${token}x`, await other.sign(grant), 'vg1.k1', 'x'.repeat(5000), `${v}.k9.${payload}.${signature}`]) {
      expect(await signer.verify(bad)).toBeUndefined();
    }
  });

  it('rotates keys: new tokens use the first key, old tokens still verify', async () => {
    const old = await HmacGrantSigner.create([{ id: 'k1', secret: secret('one') }]);
    const rotated = await HmacGrantSigner.create([{ id: 'k2', secret: secret('two') }, { id: 'k1', secret: secret('one') }]);
    expect(await rotated.verify(await old.sign(grant))).toBeDefined();
    expect((await rotated.sign(grant)).startsWith('vg1.k2.')).toBe(true);
  });

  it('refuses weak or ambiguous keys', async () => {
    await expect(HmacGrantSigner.create([])).rejects.toThrow();
    await expect(HmacGrantSigner.create([{ id: 'k1', secret: new Uint8Array(16) }])).rejects.toThrow();
    await expect(HmacGrantSigner.create([{ id: 'k1', secret: secret('a') }, { id: 'k1', secret: secret('b') }])).rejects.toThrow();
  });
});

describe('ApiKeyAuthenticator', () => {
  it('maps a known key to its client principal and nothing else', async () => {
    const auth = await ApiKeyAuthenticator.create([{ id: 'vdoc-web', name: 'vdoc web', key: 'k'.repeat(30) }]);
    expect(await auth.authenticate({ bearer: 'k'.repeat(30) })).toEqual({ id: 'vdoc-web', kind: 'client', name: 'vdoc web' });
    expect(await auth.authenticate({ bearer: 'k'.repeat(29) })).toBeUndefined();
    expect(await auth.authenticate({ bearer: undefined })).toBeUndefined();
  });

  it('refuses short keys and invalid ids at startup', async () => {
    await expect(ApiKeyAuthenticator.create([{ id: 'x', name: 'x', key: 'short' }])).rejects.toThrow();
    await expect(ApiKeyAuthenticator.create([{ id: 'bad id', name: 'x', key: 'k'.repeat(30) }])).rejects.toThrow();
  });
});
