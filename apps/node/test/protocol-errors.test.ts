import { JsonLogger } from '@vdoc-server/adapter-system';
import { ModelRegistry, type ModelProvider } from '@vdoc-server/adapter-vrt';
import { loadConfig } from '@vdoc-server/config';
import { connect } from '@vrealtime/client';
import { fakeModel } from '@vrealtime/testing';
import { afterEach, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { createNodeServer } from '../src/create';
import { startNodeServer } from '../src/node-server';

const KEY = 'protocol-errors-client-key-0123456789';
const running: { close: () => Promise<void> }[] = [];
afterEach(async () => { await Promise.all(running.splice(0).map((server) => server.close())); });

/** A Node server whose log lines are kept in `lines`. */
async function start(provider?: ModelProvider) {
  const config = loadConfig({ VDOC_SERVER_ENV: 'test', VDOC_SERVER_CLIENTS: `web:${KEY}`, VDOC_SERVER_LOG_LEVEL: 'error' });
  if (!config.ok) throw new Error(config.errors.join('; '));
  const lines: string[] = [];
  const server = await createNodeServer(config.value, {
    logger: new JsonLogger('debug', (line) => lines.push(line)),
    ...(provider ? { models: new ModelRegistry().register(provider) } : {}),
  });
  const started = await startNodeServer(server, { port: 0 });
  running.push(started);
  const grant = async (documentId: string) => {
    const response = await fetch(`http://127.0.0.1:${started.port}/v1/documents/${documentId}/voice-sessions`, { method: 'POST', headers: { authorization: `Bearer ${KEY}` } });
    expect(response.status).toBe(201);
    const granted = await response.json() as { sessionId: string; realtimePath: string; grant: { token: string } };
    return { ...granted, url: `ws://127.0.0.1:${started.port}${granted.realtimePath}` };
  };
  const protocolErrors = () => lines.map((line) => JSON.parse(line) as Record<string, unknown>).filter((entry) => entry['message'] === 'realtime protocol error');
  return { lines, grant, protocolErrors };
}

it('logs a stream of invalid audio frames once, without the grant or the audio', async () => {
  const { lines, grant, protocolErrors } = await start();
  const granted = await grant('doc-malformed');
  const socket = new WebSocket(granted.url);
  const received: { type: string; code?: string }[] = [];
  socket.on('message', (data, binary) => { if (!binary) received.push(JSON.parse(String(data)) as { type: string; code?: string }); });
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  try {
    socket.send(JSON.stringify({ v: 1, seq: 0, type: 'hello', tools: [], auth: granted.grant.token }));
    await expect.poll(() => received.some((message) => message.type === 'ready')).toBe(true);
    for (let i = 0; i < 50; i++) socket.send(new Uint8Array([7, 0, 0, 0, i, 0xde, 0xad]));
    await expect.poll(() => received.filter((message) => message.code === 'MALFORMED').length).toBe(50);

    expect(protocolErrors()).toEqual([expect.objectContaining({
      level: 'warn', sessionId: granted.sessionId, code: 'MALFORMED', recoverable: true, error: 'Invalid audio frame', provider: 'fake',
    })]);
    expect(lines.join('\n')).not.toContain(granted.grant.token);
  } finally {
    socket.close();
  }
});

it('logs a model that fails to start once, as an error', async () => {
  const base = fakeModel();
  const failing = { provider: base.provider, id: base.id, capabilities: base.capabilities, connect: () => Promise.reject(new Error('provider refused the key')) };
  const { lines, grant, protocolErrors } = await start({ id: 'fake', create: () => failing });
  const granted = await grant('doc-start-failed');

  await expect(connect(granted.url, { auth: granted.grant.token, reconnect: false, context: { documentId: 'doc-start-failed', title: 'Plan', language: 'en' } })).rejects.toThrow();

  // Reported by the model wrapper and again by the START_FAILED frame the client just got: one line.
  expect(protocolErrors()).toEqual([expect.objectContaining({
    level: 'error', sessionId: granted.sessionId, code: 'START_FAILED', recoverable: false, error: 'provider refused the key',
  })]);
  expect(lines.join('\n')).not.toContain(granted.grant.token);
});
