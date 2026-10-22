import { InMemoryVoiceSessionRepository, RecordingEventPublisher } from '@vdoc-server/adapter-memory';
import { HmacGrantSigner } from '@vdoc-server/adapter-security';
import { loadConfig } from '@vdoc-server/config';
import { SessionGrant, VoiceSessionId } from '@vdoc-server/domain';
import { createHash } from 'node:crypto';
import { connect } from '@vrealtime/client';
import { afterEach, describe, expect, it } from 'vitest';
import { createNodeServer } from '../src/create';
import { startNodeServer } from '../src/node-server';

const webKey = 'trusted-user-web-client-key-not-for-production';
const otherKey = 'trusted-user-other-client-key-not-for-production';
const closes: (() => Promise<void>)[] = [];
const principalOf = (clientId: string, userId: string) => `usr_${createHash('sha256').update(JSON.stringify([clientId, userId])).digest('hex')}`;
const headersOf = (userId?: string, key: string | undefined = webKey): Record<string, string> => ({
  ...(key === undefined ? {} : { authorization: `Bearer ${key}` }),
  ...(userId === undefined ? {} : { 'x-vdoc-user-id': userId }),
});

async function fixture(options: { allowClientOnly?: boolean } = {}) {
  const config = loadConfig({
    VDOC_SERVER_ENV: 'test', VDOC_SERVER_MODEL: 'fake', VDOC_SERVER_LOG_LEVEL: 'error',
    VDOC_SERVER_CLIENTS: `web:${webKey},other:${otherKey}`,
    VDOC_SERVER_ALLOW_CLIENT_ONLY: String(options.allowClientOnly ?? false),
  });
  if (!config.ok) throw new Error(config.errors.join('; '));
  const sessions = new InMemoryVoiceSessionRepository();
  const events = new RecordingEventPublisher();
  const server = await createNodeServer(config.value, {
    sessions, subscribers: [events],
  });
  const running = await startNodeServer(server, { port: 0 });
  closes.push(running.close);
  const base = `http://127.0.0.1:${running.port}`;
  const url = (documentId: string, sessionId?: string) => `${base}/v1/documents/${documentId}/voice-sessions${sessionId ? `/${sessionId}` : ''}`;
  const signer = await HmacGrantSigner.create(config.value.signingKeys);
  const create = (documentId: string, userId?: string, key = webKey, body?: unknown) => fetch(url(documentId), {
    method: 'POST', headers: { ...headersOf(userId, key), ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { base, url, create, sessions, events, signer };
}

type Granted = { sessionId: string; documentId: string; grant: { token: string; expiresAt: number }; realtimePath: string };
async function granted(response: Response): Promise<Granted> {
  expect(response.status).toBe(201);
  return response.json() as Promise<Granted>;
}

afterEach(async () => { await Promise.all(closes.splice(0).map(close => close())); });

describe('trusted BFF user identity over the Node HTTP transport', () => {
  it('requires both the configured app credential and a valid user header in strict mode', async () => {
    const h = await fixture();
    const cases: Record<string, string>[] = [
      {}, { 'x-vdoc-user-id': 'alice' }, headersOf('alice', 'wrong-client-key'), headersOf(),
      ...['', 'alice bob', 'alice,bob', '@alice', 'a'.repeat(129)].map(user => headersOf(user)),
    ];
    for (const headers of cases) {
      const response = await fetch(h.url('strict-auth'), { method: 'POST', headers });
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ status: 401, code: 'UNAUTHENTICATED' });
    }
    expect(h.events.events).toHaveLength(0);
    await granted(await h.create('strict-auth', 'alice'));
  });

  it('binds the authenticated user to persisted ownership, audit events and signed reconnect grants', async () => {
    const h = await fixture();
    const created = await granted(await h.create('binding', 'alice'));
    const expected = principalOf('web', 'alice');
    const stored = await h.sessions.get(VoiceSessionId.assume(created.sessionId));
    expect(stored?.principalId).toBe(expected);
    expect((await h.signer.verify(created.grant.token))?.principalId).toBe(expected);
    expect(h.events.events).toContainEqual(expect.objectContaining({
      type: 'VoiceSessionGranted', aggregateId: created.sessionId, principalId: expected, clientId: 'web', userId: 'alice',
    }));
    const renewed = await fetch(`${h.url('binding', created.sessionId)}/grants`, { method: 'POST', headers: headersOf('alice') });
    expect(renewed.status).toBe(201);
    const { token } = await renewed.json() as { token: string };
    expect((await h.signer.verify(token))?.principalId).toBe(expected);
    expect((await fetch(h.url('binding', created.sessionId), { method: 'DELETE', headers: headersOf('alice') })).status).toBe(204);
    expect((await h.sessions.get(VoiceSessionId.assume(created.sessionId)))?.status).toBe('ended');
  });

  it('binds real WebSocket connections and completed usage to the user grant, rejecting foreign, expired and ended tokens', async () => {
    const h = await fixture();
    const alice = await granted(await h.create('socket-alice', 'alice'));
    const bob = await granted(await h.create('socket-bob', 'bob'));
    const open = (token: string) => connect(`${h.base.replace('http:', 'ws:')}${alice.realtimePath}`, {
      auth: token, reconnect: false, context: { documentId: 'socket-alice', userId: 'bob', clientId: 'other' }, tools: {},
    });
    await expect(open(bob.grant.token)).rejects.toThrow();
    await expect(open(alice.grant.token + 'x')).rejects.toThrow();
    const verified = await h.signer.verify(alice.grant.token);
    if (!verified) throw new Error('missing grant');
    const expired = SessionGrant.issue({ ...verified.toProps(), issuedAt: Date.now() - 1000, ttlMs: 1 });
    await expect(open(await h.signer.sign(expired))).rejects.toThrow();
    const connection = await open(alice.grant.token);
    try {
      connection.sendText('hello');
      await expect.poll(() => h.events.events.some(event => event.type === 'TurnCompleted' && event.aggregateId === alice.sessionId)).toBe(true);
      expect(h.events.events.find(event => event.type === 'TurnCompleted' && event.aggregateId === alice.sessionId)).toMatchObject({
        principalId: principalOf('web', 'alice'), clientId: 'web', userId: 'alice',
      });
      expect((await fetch(h.url('socket-alice', alice.sessionId), { method: 'DELETE', headers: headersOf('alice') })).status).toBe(204);
    } finally { await connection.close(); }
    await expect(open(alice.grant.token)).rejects.toThrow();
  });

  it('ignores forged body identity and never uses it to fill a missing trusted header', async () => {
    const h = await fixture();
    const forged = { userId: 'bob', principalId: principalOf('web', 'bob'), principal: { id: 'bob', kind: 'user' } };
    const missing = await h.create('body-missing', undefined, webKey, forged);
    expect(missing.status).toBe(401);
    await missing.text();
    const created = await granted(await h.create('body-alice', 'alice', webKey, forged));
    expect((await h.sessions.get(VoiceSessionId.assume(created.sessionId)))?.principalId).toBe(principalOf('web', 'alice'));
    await granted(await h.create('body-alice-two', 'alice'));
    const third = await granted(await h.create('body-alice-three', 'alice', webKey, forged));
    expect((await h.sessions.get(VoiceSessionId.assume(third.sessionId)))?.principalId).toBe(principalOf('web', 'alice'));
    await granted(await h.create('body-bob', 'bob'));
  });

  it('hides another user’s sessions from reads, grant renewal and deletion', async () => {
    const h = await fixture();
    const created = await granted(await h.create('owner', 'alice'));
    for (const headers of [headersOf('bob'), headersOf('alice', otherKey)]) {
      for (const [method, suffix] of [['GET', ''], ['POST', '/grants'], ['DELETE', '']] as const) {
        const response = await fetch(`${h.url('owner', created.sessionId)}${suffix}`, { method, headers });
        expect(response.status).toBe(404);
        expect(await response.json()).toMatchObject({ code: 'NOT_FOUND' });
      }
    }
    for (const [method, suffix] of [['GET', ''], ['POST', '/grants'], ['DELETE', '']] as const) {
      const response = await fetch(`${h.url('owner', created.sessionId)}${suffix}`, { method, headers: headersOf() });
      expect(response.status).toBe(401);
      await response.text();
    }
    expect((await h.sessions.get(VoiceSessionId.assume(created.sessionId)))?.status).toBe('granted');
    expect((await fetch(h.url('owner', created.sessionId), { headers: headersOf('alice') })).status).toBe(200);
  });

  it('namespaces identical user IDs by the verified app client for ownership', async () => {
    const h = await fixture();
    const first = await granted(await h.create('web-one', 'same-user'));
    await granted(await h.create('web-two', 'same-user'));
    await granted(await h.create('web-three', 'same-user'));
    const other = await granted(await h.create('other-one', 'same-user', otherKey));
    expect((await h.sessions.get(VoiceSessionId.assume(first.sessionId)))?.principalId).toBe(principalOf('web', 'same-user'));
    expect((await h.sessions.get(VoiceSessionId.assume(other.sessionId)))?.principalId).toBe(principalOf('other', 'same-user'));
    expect(principalOf('web', 'same-user')).not.toBe(principalOf('other', 'same-user'));
  });

  it('supports explicit legacy client-only mode without accepting malformed present user headers', async () => {
    const h = await fixture({ allowClientOnly: true });
    const legacy = await granted(await h.create('legacy-client'));
    expect((await h.sessions.get(VoiceSessionId.assume(legacy.sessionId)))?.principalId).toBe('web');
    for (const user of ['', 'alice bob', 'alice,bob']) {
      const response = await h.create('legacy-invalid', user);
      expect(response.status).toBe(401);
      await response.text();
    }
    const person = await granted(await h.create('legacy-user', 'alice'));
    expect((await h.sessions.get(VoiceSessionId.assume(person.sessionId)))?.principalId).toBe(principalOf('web', 'alice'));
  });
});
