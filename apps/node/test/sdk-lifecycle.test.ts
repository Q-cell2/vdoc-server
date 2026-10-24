import { RecordingEventPublisher } from '@vdoc-server/adapter-memory';
import { ModelRegistry } from '@vdoc-server/adapter-vrt';
import { loadConfig } from '@vdoc-server/config';
import { connect, type ClientSession, type ClientTool, type ToolStreamEvent } from '@vrealtime/client';
import { fakeModel } from '@vrealtime/testing';
import { afterEach, expect, it, vi } from 'vitest';
import { createNodeServer } from '../src/create';
import { startNodeServer } from '../src/node-server';

// Real HTTP, WebSocket, SDK and policy hooks; only the upstream model is scripted.
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function setup(run: ClientTool['run']) {
  const key = 'sdk-lifecycle-client-key-at-least-24-characters';
  const config = loadConfig({ VDOC_SERVER_ENV: 'test', VDOC_SERVER_CLIENTS: `web:${key}`, VDOC_SERVER_MODEL: 'fake', VDOC_SERVER_LOG_LEVEL: 'error' });
  if (!config.ok) throw new Error(config.errors.join('; '));
  const model = fakeModel({ capabilities: { tools: { autoReplyAfterResult: false } } });
  const events = new RecordingEventPublisher();
  const server = await createNodeServer(config.value, {
    models: new ModelRegistry().register({ id: 'fake', create: () => model }),
    subscribers: [events], realtime: { resumeWindowMs: 5000 },
  });
  const running = await startNodeServer(server, { port: 0 });
  cleanups.push(running.close);
  const base = `http://127.0.0.1:${running.port}`;
  const headers = { authorization: `Bearer ${key}` };
  const response = await fetch(`${base}/v1/documents/sdk-document/voice-sessions`, { method: 'POST', headers });
  expect(response.status).toBe(201);
  const created = await response.json() as { sessionId: string; realtimePath: string; grant: { token: string } };
  let initial: string | undefined = created.grant.token;
  const auth = vi.fn(async () => {
    if (initial) { const token = initial; initial = undefined; return token; }
    const renewed = await fetch(`${base}/v1/documents/sdk-document/voice-sessions/${created.sessionId}/grants`, { method: 'POST', headers });
    expect(renewed.status).toBe(201);
    return ((await renewed.json()) as { token: string }).token;
  });
  const sockets: WebSocket[] = [];
  class ObservedSocket extends WebSocket {
    constructor(url: string) { super(url); sockets.push(this); }
  }
  const client: ClientSession = await connect(`ws://127.0.0.1:${running.port}${created.realtimePath}`, {
    auth, WebSocket: ObservedSocket, reconnect: { baseDelayMs: 10, maxDelayMs: 20, maxAttempts: 2 },
    context: { documentId: 'sdk-document', language: 'zh-CN' },
    tools: { read_document: { parameters: { type: 'object' }, run } },
  });
  cleanups.push(() => client.close());
  let turn = 0;
  async function startTurn() {
    const count = ++turn;
    const responses = model.session.commandsOf('respond').length;
    client.sendText(`读文档 ${count}`);
    await expect.poll(() => model.session.commandsOf('respond').length).toBe(responses + 1);
    const responseId = `response-${count}`;
    model.session.emit({ type: 'response.start', responseId });
    return responseId;
  }
  return { model, events, client, sockets, auth, created, startTurn };
}

it('negotiates 0.2 capabilities and separates reused provider tool IDs across responses', async () => {
  const run = vi.fn<ClientTool['run']>(() => ({ text: '中文文档' }));
  const h = await setup(run);
  expect([...h.client.capabilities].sort()).toEqual(['global-tool-ids-v1', 'tool-stream-v1']);
  const stream: ToolStreamEvent[] = [];
  h.client.on('tool.stream', event => stream.push(event));
  for (let turn = 1; turn <= 2; turn++) {
    const responseId = await h.startTurn();
    const tool = { responseId, callId: 'provider-reused-id', name: 'read_document' };
    h.model.session.emit({ type: 'tool.call.delta', ...tool, argumentsDelta: '{}' });
    await expect.poll(() => stream.filter(event => event.phase === 'arguments-delta').length).toBe(turn);
    expect(run).toHaveBeenCalledTimes(turn - 1);
    h.model.session.emit({ type: 'tool.call', ...tool, arguments: {} });
    await expect.poll(() => stream.filter(event => event.phase === 'settled').length).toBe(turn);
    h.model.session.emit({ type: 'response.end', responseId, status: 'done' });
    // The agent asks the model for a follow-up after tool results. Finish that
    // response too, matching providers that speak the result before ending a turn.
    const summaryId = `${responseId}-summary`;
    h.model.session.emit({ type: 'response.start', responseId: summaryId });
    h.model.session.emit({ type: 'response.end', responseId: summaryId, status: 'done' });
    await expect.poll(() => h.events.events.filter(event => event.type === 'TurnCompleted').length).toBe(turn);
  }
  expect(run).toHaveBeenCalledTimes(2);
  const ids = run.mock.calls.map(args => args[1]?.callId);
  expect(new Set(ids).size).toBe(2);
  expect(ids).not.toContain('provider-reused-id');
  for (const id of ids) {
    expect(stream.filter(event => event.callId === id).map(event => event.phase)).toEqual(['start', 'arguments-delta', 'arguments-complete', 'settled']);
  }
  expect(h.model.session.commandsOf('submitToolResult').map(command => command.callId)).toEqual(['provider-reused-id', 'provider-reused-id']);
});

it('renews the HTTP grant and resumes the same model without rerunning an in-flight tool', async () => {
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const run = vi.fn(async () => { await barrier; return { text: 'done' }; });
  const h = await setup(run);
  const ready = vi.fn(); h.client.on('ready', ready);
  const responseId = await h.startTurn();
  h.model.session.emit({ type: 'tool.call', responseId, callId: 'pending', name: 'read_document', arguments: {} });
  await expect.poll(() => run.mock.calls.length).toBe(1);
  const transportId = h.client.sessionId;
  try {
    h.sockets[0]!.close(4000, 'test connection loss');
    await expect.poll(() => ready.mock.calls.length).toBe(1);
    expect(ready).toHaveBeenCalledWith(expect.objectContaining({ resumed: true, sessionId: transportId }));
    expect(h.auth).toHaveBeenCalledTimes(2);
    expect(h.model.sessions).toHaveLength(1);
    expect(run).toHaveBeenCalledTimes(1);
    release();
    await expect.poll(() => h.events.events.filter(event => event.type === 'ToolCallCompleted').length).toBe(1);
    expect(h.model.session.commandsOf('submitToolResult')).toHaveLength(1);
    expect(h.client.capabilities.has('tool-stream-v1')).toBe(true);
  } finally { release(); }
});

it('interrupts the client tool immediately and discards its late successful output', async () => {
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const run = vi.fn<ClientTool['run']>(async (_input, context) => {
    await barrier;
    return { lateSuccess: !context.signal.aborted };
  });
  const h = await setup(run);
  const result = vi.fn(); h.client.on('tool.result', result);
  const responseId = await h.startTurn();
  h.model.session.emit({ type: 'tool.call', responseId, callId: 'interrupt-me', name: 'read_document', arguments: {} });
  await expect.poll(() => run.mock.calls.length).toBe(1);
  try {
    h.client.interrupt('keyboard');
    expect(run.mock.calls[0]![1].signal.aborted).toBe(true);
    await expect.poll(() => result.mock.calls.length).toBe(1);
    expect(result).toHaveBeenCalledWith(expect.objectContaining({ result: expect.objectContaining({ ok: false, code: 'INTERRUPTED' }) }));
    release();
    await barrier; await Promise.resolve();
    expect(result).toHaveBeenCalledTimes(1);
    await expect.poll(() => h.model.session.commandsOf('cancel').length).toBeGreaterThan(0);
    expect(h.model.session.commandsOf('submitToolResult').some(command => JSON.stringify(command.output).includes('lateSuccess'))).toBe(false);
  } finally { release(); }
});
