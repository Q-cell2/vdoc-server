/**
 * Reproduce the actual BFF -> Node HTTP identity/quota contract without secrets,
 * a database, a provider connection or deployment. Run from this repository:
 *
 * VDOC_APP_CHECKOUT=/absolute/path/to/vdoc node --import tsx scripts/check-trusted-identity.mjs
 *
 * The app checkout must have its dependencies installed and contain the trusted
 * user header implementation. Authentication and ACL callbacks are test fixtures;
 * the BFF request handling and every upstream HTTP request use the real code.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const appCheckout = process.env.VDOC_APP_CHECKOUT;
if (!appCheckout) throw new Error('Set VDOC_APP_CHECKOUT to the vdoc app checkout with dependencies installed.');
const { proxyVoiceSession } = await import(pathToFileURL(resolve(appCheckout, 'lib/infrastructure/realtime/voice-session-proxy.ts')).href);
const { loadConfig } = await import('../packages/config/src/index.ts');
const { InMemoryVoiceSessionRepository, RecordingEventPublisher } = await import('../packages/adapters/memory/src/index.ts');
const { VoiceSessionId } = await import('../packages/domain/src/index.ts');
const { createNodeServer } = await import('../apps/node/src/create.ts');
const { startNodeServer } = await import('../apps/node/src/node-server.ts');

const key = 'bff-node-integration-client-key-not-production';
const config = loadConfig({
  VDOC_SERVER_ENV: 'test', VDOC_SERVER_MODEL: 'fake', VDOC_SERVER_LOG_LEVEL: 'error',
  VDOC_SERVER_CLIENTS: `web:${key}`, VDOC_SERVER_ALLOW_CLIENT_ONLY: 'false',
  VDOC_SERVER_MAX_CONCURRENT_SESSIONS_PER_PRINCIPAL: '1', VDOC_SERVER_MAX_SESSIONS_PER_HOUR: '3',
});
if (!config.ok) throw new Error(config.errors.join('; '));
const sessions = new InMemoryVoiceSessionRepository();
const events = new RecordingEventPublisher();
const server = await createNodeServer(config.value, { sessions, subscribers: [events] });
const node = await startNodeServer(server, { port: 0 });
let unavailable;
let upstreamRequests = 0;
const requestIds = new Set();

try {
  const run = (action, user, documentId, sessionId, port = node.port) => proxyVoiceSession(new Request('https://vdoc.ink/api/voice-sessions', {
    method: action === 'end' ? 'DELETE' : 'POST',
    headers: {
      Origin: 'https://vdoc.ink', 'Content-Type': 'application/json',
      'X-Vdoc-User-Id': 'forged-browser-user', Authorization: 'Bearer forged-browser-key', Cookie: 'private-cookie',
    },
    body: JSON.stringify({ documentId }),
  }), action, sessionId, {
    getUser: async () => ({ userId: user }), serverUrl: `http://127.0.0.1:${port}`, clientKey: key,
    authorizeDocument: async (owner, id) => ['doc-a', 'doc-b'].includes(id) ? `u_${owner}_${id}` : null,
    fetch: async (url, options) => {
      const headers = new Headers(options.headers);
      assert.equal(headers.get('x-vdoc-user-id'), user);
      assert.equal(headers.get('authorization'), `Bearer ${key}`);
      assert.equal(headers.has('cookie'), false);
      assert.match(headers.get('x-request-id'), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      requestIds.add(headers.get('x-request-id'));
      upstreamRequests++;
      return fetch(url, options);
    },
  });

  let response = await run('create', 'alice', 'doc-a');
  assert.equal(response.status, 201);
  const alice = await response.json();
  assert.equal(alice.documentId, 'doc-a');
  assert.equal(alice.transportDocumentId, 'u_alice_doc-a');
  const principal = `usr_${createHash('sha256').update(JSON.stringify(['web', 'alice'])).digest('hex')}`;
  assert.equal((await sessions.get(VoiceSessionId.assume(alice.sessionId))).principalId, principal);

  response = await run('create', 'alice', 'doc-b');
  assert.equal(response.status, 429);
  const quota = await response.json();
  assert.equal(quota.error.code, 'QUOTA_EXCEEDED');
  assert.equal(quota.error.quotaKind, 'concurrency');
  assert.ok(quota.error.retryAfterSeconds > 0);
  assert.ok(Number(response.headers.get('retry-after')) > 0);

  response = await run('create', 'bob', 'doc-a');
  assert.equal(response.status, 201);
  const bob = await response.json();
  response = await run('grant', 'alice', 'doc-a', alice.sessionId);
  assert.equal(response.status, 201);
  response = await run('grant', 'bob', 'doc-a', alice.sessionId);
  assert.equal(response.status, 404);
  await response.text();
  response = await run('end', 'alice', 'doc-a', alice.sessionId);
  assert.equal(response.status, 204);

  for (let index = 0; index < 2; index++) {
    response = await run('create', 'alice', 'doc-b');
    assert.equal(response.status, 201);
    const created = await response.json();
    assert.equal((await sessions.get(VoiceSessionId.assume(created.sessionId))).principalId, principal);
    response = await run('end', 'alice', 'doc-b', created.sessionId);
    assert.equal(response.status, 204);
  }
  response = await run('create', 'alice', 'doc-b');
  assert.equal(response.status, 429);
  const rate = await response.json();
  assert.equal(rate.error.code, 'QUOTA_EXCEEDED');
  assert.equal(rate.error.quotaKind, 'rate');
  assert.ok(rate.error.retryAfterSeconds > 3500);
  assert.equal(events.events.filter(event => event.type === 'VoiceSessionGranted' && event.principalId === principal).length, 3);
  response = await run('end', 'bob', 'doc-a', bob.sessionId);
  assert.equal(response.status, 204);

  const broken = await createNodeServer(config.value, {
    quotas: {
      async reserve() { throw new Error('test quota infrastructure unavailable'); },
      async confirm() {}, async cancel() {}, async release() {},
    },
  });
  unavailable = await startNodeServer(broken, { port: 0 });
  response = await run('create', 'alice', 'doc-a', undefined, unavailable.port);
  assert.equal(response.status, 503);
  const unavailableProblem = await response.json();
  assert.equal(unavailableProblem.error.code, 'QUOTA_UNAVAILABLE');
  assert.equal(unavailableProblem.error.retryAfterSeconds, 1);
  assert.equal(response.headers.get('retry-after'), '1');
  assert.equal(requestIds.size, upstreamRequests);

  console.log(JSON.stringify({
    result: 'passed', transport: 'real BFF handler -> Node HTTP', upstreamRequests,
    checks: ['trusted identity overrides browser headers', 'owner-scoped transport ID', 'principal persistence and audit',
      'concurrency and hourly quota propagation', 'user isolation', 'renew/end ownership', 'hangup releases concurrency',
      'quota unavailable fails closed', 'unique request IDs'],
  }));
} finally {
  await Promise.all([node.close(), unavailable?.close()]);
}
