import { afterEach, expect, it, vi } from 'vitest';
import { RecordingEventPublisher } from '@vdoc-server/adapter-memory';
import { delegatedModel, ModelRegistry, type WorkerRunner } from '@vdoc-server/adapter-vrt';
import { loadConfig } from '@vdoc-server/config';
import { connect } from '@vrealtime/client';
import { fakeModel, type FakeModelOptions } from '@vrealtime/testing';
import { createNodeServer } from '../src/create';
import { startNodeServer } from '../src/node-server';
import { createArticleStream } from '../src/playground/article-stream';
import { createTestDocument } from '../src/playground/document';
import { createPausableMicrophone } from '../src/playground/microphone';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });

/** Higgs as a pure speaker: it has no tools and only reads aloud the reply it is asked to speak. */
function speaker(onAudio?: NonNullable<FakeModelOptions['onCommand']>) {
  let count = 0;
  return fakeModel({ onCommand(command, session) {
    onAudio?.(command, session);
    if (command.type !== 'respond') return;
    const responseId = `speaker-${++count}`;
    queueMicrotask(() => {
      session.emit({ type: 'response.start', responseId });
      session.emit({ type: 'output.transcript', responseId, itemId: responseId, delta: '收到后台结果。' });
      session.emit({ type: 'response.end', responseId, status: 'done', stopReason: 'completed' });
    });
  } });
}

it.each([12, 1])('routes the worker through real HTTP/WS, SDK and the %i-call policy without exposing document tools to Higgs', async limit => {
  const actor = speaker();
  const results: unknown[] = [];
  const worker: WorkerRunner = { async run(request, context) {
    expect(request.tools.map(tool => tool.name)).toEqual(['read_document', 'insert_structured_article']);
    expect(request.prompt).toContain('用户的完整请求');
    for (const [callId, name, args] of [
      ['read', 'read_document', {}],
      ['write', 'insert_structured_article', { expectedRevision: 7, title: '文章', blocks: [{ kind: 'paragraph', text: '正文' }] }],
    ] as const) {
      context.emit({ type: 'start' });
      const result = await context.execute(callId, name, args);
      results.push(result);
      context.emit({ type: 'turn-end', usage: { inputTokens: 10, outputTokens: 5 } });
    }
    context.emit({ type: 'start' });
    context.emit({ type: 'text', delta: limit === 1 ? '写入受限。' : '已写入。' });
    return limit === 1 ? '写入受限。' : '已写入。';
  } };
  const key = 'worker-test-client-key-at-least-24-characters';
  const loaded = loadConfig({ VDOC_SERVER_ENV: 'test', VDOC_SERVER_MODEL: 'boson-worker', BOSON_API_KEY: 'b', ANTHROPIC_API_KEY: 'a', VDOC_SERVER_CLIENTS: `web:${key}`, VDOC_SERVER_LOG_LEVEL: 'error', VDOC_SERVER_MAX_TOOL_CALLS_PER_TURN: String(limit) });
  if (!loaded.ok) throw new Error(loaded.errors.join('; '));
  const events = new RecordingEventPublisher();
  const server = await createNodeServer(loaded.value, { models: new ModelRegistry().register({ id: 'boson-worker', create: () => delegatedModel(actor, worker) }), subscribers: [events] });
  const running = await startNodeServer(server, { port: 0 });
  cleanups.push(running.close);
  const response = await fetch(`http://127.0.0.1:${running.port}/v1/documents/worker-doc/voice-sessions`, { method: 'POST', headers: { authorization: `Bearer ${key}` } });
  const created = await response.json() as { realtimePath: string; grant: { token: string } };
  const read = vi.fn(() => ({ ok: true, revision: 7 }));
  const write = vi.fn(() => ({ ok: true, revision: 8 }));
  const client = await connect(`ws://127.0.0.1:${running.port}${created.realtimePath}`, { auth: created.grant.token, reconnect: false, tools: {
    read_document: { parameters: { type: 'object' }, run: read },
    insert_structured_article: { parameters: { type: 'object' }, run: write },
  } });
  cleanups.push(() => client.close());
  const text: string[] = [];
  client.on('text', event => { if (!event.delta.startsWith('[执行阶段]')) text.push(event.delta); });
  client.sendText('用户的完整请求');
  await expect.poll(() => events.events.filter(event => event.type === 'TurnCompleted').length).toBe(1);
  expect(read).toHaveBeenCalledTimes(1);
  expect(write).toHaveBeenCalledTimes(limit === 1 ? 0 : 1);
  expect(results).toHaveLength(2);
  if (limit === 1) expect(results[1]).toMatchObject({ error: { code: 'REJECTED' } });
  expect(text.join('')).toBe(limit === 1 ? '写入受限。' : '已写入。');
  expect(actor.session.commandsOf('connect')[0]!.config.tools).toEqual([]);
  expect(actor.session.commandsOf('submitToolResult')).toHaveLength(0);
});


it('continues the same worker write after pausing capture, despite late background voice frames', async () => {
  const actor = speaker((command, session) => {
    if (command.type === 'sendAudio' && command.chunk.data.some(byte => byte !== 0)) session.emit({ type: 'input.speech.start', atMs: 1 });
  });
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  let started = false;
  let aborted = false;
  const worker: WorkerRunner = { async run(_request, context) {
    context.signal.addEventListener('abort', () => { aborted = true; });
    context.emit({ type: 'start' }); started = true;
    await barrier; context.signal.throwIfAborted();
    await context.execute('write', 'insert_structured_article', { expectedRevision: 0 });
    context.emit({ type: 'turn-end', usage: { inputTokens: 1, outputTokens: 1 } });
    context.emit({ type: 'start' }); context.emit({ type: 'text', delta: '写入完成' });
    return '写入完成';
  } };
  const key = 'muted-microphone-local-test-client-key';
  const config = loadConfig({ VDOC_SERVER_ENV: 'test', VDOC_SERVER_MODEL: 'boson-worker', BOSON_API_KEY: 'b', ANTHROPIC_API_KEY: 'a', VDOC_SERVER_CLIENTS: `web:${key}`, VDOC_SERVER_LOG_LEVEL: 'error' });
  if (!config.ok) throw new Error();
  const app = await createNodeServer(config.value, { models: new ModelRegistry().register({ id: 'boson-worker', create: () => delegatedModel(actor, worker) }) });
  const running = await startNodeServer(app, { port: 0 }); cleanups.push(running.close);
  const grant = await (await fetch(`http://127.0.0.1:${running.port}/v1/documents/muted/voice-sessions`, { method: 'POST', headers: { Authorization: `Bearer ${key}` } })).json() as { realtimePath: string; grant: { token: string } };
  let capturedFrame!: (frame: Uint8Array) => void;
  const microphoneStopped = vi.fn(async () => {});
  const microphone = createPausableMicrophone(() => {}, async (_rate, frame) => { capturedFrame = frame; return { stop: microphoneStopped }; });
  const write = vi.fn(() => ({ ok: true }));
  const client = await connect(`ws://127.0.0.1:${running.port}${grant.realtimePath}`, { auth: grant.grant.token, reconnect: false,
    audio: { input: microphone.input, output: false }, tools: { insert_structured_article: { parameters: { type: 'object' }, run: write } },
  });
  cleanups.push(() => client.close());
  const interrupted = vi.fn(); client.on('interrupted', interrupted);
  const text: string[] = []; client.on('text', event => { if (!event.delta.startsWith('[执行阶段]')) text.push(event.delta); });
  client.sendText('请继续完成任务');
  try {
    await expect.poll(() => started).toBe(true);
    const before = interrupted.mock.calls.length;
    await microphone.pause();
    capturedFrame(new Uint8Array([99, 0])); // A queued frame from another voice must not reach the server.
    await expect.poll(() => actor.session.commandsOf('sendAudio').length).toBeGreaterThan(0);
    expect(actor.session.commandsOf('sendAudio').every(command => command.chunk.data.every(byte => byte === 0))).toBe(true);
    release();
    await expect.poll(() => write.mock.calls.length).toBe(1);
    await expect.poll(() => text.join('')).toBe('写入完成');
    expect(interrupted).toHaveBeenCalledTimes(before);
    expect(aborted).toBe(false);
    expect(microphoneStopped).toHaveBeenCalledTimes(1);
    expect(client.connected).toBe(true);
  } finally { release(); }
});


it('renders article deltas in the document before a complete tool call, then commits exactly once over real HTTP/WS', async () => {
  const actor = speaker();
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const worker: WorkerRunner = { async run(_request, context) {
    context.emit({ type: 'start' });
    const before = await context.execute('read', 'read_document', {}) as { sessionId: string; revision: number };
    context.emit({ type: 'turn-end', usage: { inputTokens: 1, outputTokens: 1 } });
    context.emit({ type: 'start' });
    const input = { expectedSessionId: before.sessionId, expectedRevision: before.revision, destination: { kind: 'document_end' }, title: '流水文章', blocks: [{ kind: 'paragraph', text: '正在逐步生成的正文。' }] };
    const raw = JSON.stringify(input);
    const split = raw.indexOf('正在逐步生成') + 4;
    context.emit({ type: 'arguments', callId: 'write', name: 'insert_structured_article', delta: raw.slice(0, split) });
    await barrier; context.signal.throwIfAborted();
    context.emit({ type: 'arguments', callId: 'write', name: 'insert_structured_article', delta: raw.slice(split) });
    await context.execute('write', 'insert_structured_article', input);
    context.emit({ type: 'turn-end', usage: { inputTokens: 1, outputTokens: 1 } });
    context.emit({ type: 'start' }); context.emit({ type: 'text', delta: '已写入' });
    return '已写入';
  } };
  const key = 'streaming-document-test-client-key';
  const config = loadConfig({ VDOC_SERVER_ENV: 'test', VDOC_SERVER_MODEL: 'boson-worker', BOSON_API_KEY: 'b', ANTHROPIC_API_KEY: 'a', VDOC_SERVER_CLIENTS: `web:${key}`, VDOC_SERVER_LOG_LEVEL: 'error' });
  if (!config.ok) throw new Error();
  const app = await createNodeServer(config.value, { models: new ModelRegistry().register({ id: 'boson-worker', create: () => delegatedModel(actor, worker) }) });
  const running = await startNodeServer(app, { port: 0 }); cleanups.push(running.close);
  const grant = await (await fetch(`http://127.0.0.1:${running.port}/v1/documents/streamed/voice-sessions`, { method: 'POST', headers: { Authorization: `Bearer ${key}` } })).json() as { realtimePath: string; grant: { token: string } };
  const doc = createTestDocument(() => {});
  const preview = createArticleStream(() => doc.read(), () => {});
  const client = await connect(`ws://127.0.0.1:${running.port}${grant.realtimePath}`, { auth: grant.grant.token, reconnect: false, audio: { input: false, output: false }, tools: doc.tools });
  cleanups.push(() => client.close());
  client.on('tool.stream', event => preview.receive(event));
  client.on('tool.result', event => preview.finish(event.callId, event.result.ok));
  client.sendText('写文章');
  try {
    await expect.poll(() => preview.view()?.blocks[1]?.text).toBe('正在逐步');
    expect(doc.read().revision).toBe(0);
    expect(doc.read().blocks[0]!.text).toBe('');
    release();
    await expect.poll(() => doc.read().revision).toBe(1);
    await expect.poll(() => preview.view()).toBeUndefined();
    expect(doc.read().blocks.map(block => block.text)).toEqual(['流水文章', '正在逐步生成的正文。']);
  } finally { release(); }
});


it('finishes speech immediately on pause over the authenticated context channel, then streams and writes without more audio', async () => {
  let heard = false;
  let speechEnded = false;
  const actor = speaker((command, session) => {
    if (command.type === 'sendAudio' && !heard) { heard = true; session.emit({ type: 'input.speech.start', atMs: 0 }); }
    if (command.type === 'sendAudio' && heard && !speechEnded && command.chunk.data.every(byte => byte === 0)) {
      speechEnded = true;
      session.emit({ type: 'input.speech.end', atMs: 100 });
      session.emit({ type: 'input.transcript', itemId: 'u', text: '写一篇关于 Python 的文章', final: true });
      // No reply from Higgs is needed: the server starts Pi from this transcript.
    }
  });
  const worker: WorkerRunner = { async run(_request, context) {
    context.emit({ type: 'start' });
    const doc = await context.execute('read', 'read_document', {}) as { sessionId: string; revision: number };
    context.emit({ type: 'turn-end', usage: { inputTokens: 1, outputTokens: 1 } });
    context.emit({ type: 'start' });
    const args = { expectedSessionId: doc.sessionId, expectedRevision: doc.revision, destination: { kind: 'document_end' }, title: 'Python', blocks: [{ kind: 'paragraph', text: 'Python 是一种编程语言。' }] };
    context.emit({ type: 'arguments', callId: 'write', name: 'insert_structured_article', delta: JSON.stringify(args) });
    await context.execute('write', 'insert_structured_article', args);
    context.emit({ type: 'turn-end', usage: { inputTokens: 1, outputTokens: 1 } });
    context.emit({ type: 'start' }); context.emit({ type: 'text', delta: '文章已写入' }); return '文章已写入';
  } };
  const key = 'speech-pause-context-test-client-key';
  const config = loadConfig({ VDOC_SERVER_ENV: 'test', VDOC_SERVER_MODEL: 'boson-worker', BOSON_API_KEY: 'b', ANTHROPIC_API_KEY: 'a', VDOC_SERVER_CLIENTS: `web:${key}`, VDOC_SERVER_LOG_LEVEL: 'error' });
  if (!config.ok) throw new Error();
  const app = await createNodeServer(config.value, { models: new ModelRegistry().register({ id: 'boson-worker', create: () => delegatedModel(actor, worker) }) });
  const running = await startNodeServer(app, { port: 0 }); cleanups.push(running.close);
  const grant = await (await fetch(`http://127.0.0.1:${running.port}/v1/documents/speech-doc/voice-sessions`, { method: 'POST', headers: { Authorization: `Bearer ${key}` } })).json() as { realtimePath: string; grant: { token: string } };
  let captured!: (frame: Uint8Array) => void;
  let client!: Awaited<ReturnType<typeof connect>>;
  const control = { documentId: 'speech-doc', voiceControl: { type: 'finish-speech', id: 'pause-one' } };
  const microphone = createPausableMicrophone(() => {}, async (_rate, frame) => { captured = frame; return { stop: async () => {} }; }, () => { client.setContext(control); client.setContext(control); });
  const doc = createTestDocument(() => {});
  client = await connect(`ws://127.0.0.1:${running.port}${grant.realtimePath}`, { auth: grant.grant.token, reconnect: false, audio: { input: microphone.input, output: false }, tools: doc.tools });
  cleanups.push(() => client.close());
  const progress: string[] = []; client.on('text', event => progress.push(event.delta));
  captured(new Uint8Array([1, 0]));
  await expect.poll(() => heard).toBe(true);
  await microphone.pause();
  captured(new Uint8Array([99, 0]));
  await expect.poll(() => doc.read().revision).toBe(1);
  expect(doc.read().blocks.map(block => block.text)).toEqual(['Python', 'Python 是一种编程语言。']);
  expect(actor.session.commandsOf('commitAudio')).toHaveLength(0);
  expect(actor.session.commandsOf('sendAudio').filter(command => command.chunk.data.some(byte => byte !== 0))).toHaveLength(1);
  expect(speechEnded).toBe(true);
  expect(progress.some(text => text.startsWith('[执行阶段]'))).toBe(true);
  expect(microphone.state).toBe('paused');
});


it.each(['development', 'test'])('governs partial deletion in %s over real HTTP/WS and preserves all unselected content', async environment => {
  const actor = speaker();
  let deletion: unknown;
  const worker: WorkerRunner = { async run(_request, context) {
    context.emit({ type: 'start' });
    const before = await context.execute('read', 'read_document', {}) as { sessionId: string; revision: number; blocks: { id: string; kind: string }[] };
    context.emit({ type: 'turn-end', usage: { inputTokens: 1, outputTokens: 1 } });
    context.emit({ type: 'start' });
    deletion = await context.execute('delete', 'delete_test_blocks', { expectedSessionId: before.sessionId, expectedRevision: before.revision, blockIds: before.blocks.filter(block => block.kind === 'paragraph').slice(-2).map(block => block.id) });
    context.emit({ type: 'turn-end', usage: { inputTokens: 1, outputTokens: 1 } });
    context.emit({ type: 'start' }); context.emit({ type: 'text', delta: '测试结束' }); return '测试结束';
  } };
  const key = 'partial-delete-local-test-client-key';
  const config = loadConfig({ VDOC_SERVER_ENV: environment, VDOC_SERVER_MODEL: 'boson-worker', BOSON_API_KEY: 'b', ANTHROPIC_API_KEY: 'a', VDOC_SERVER_CLIENTS: `web:${key}`, VDOC_SERVER_LOG_LEVEL: 'error' });
  if (!config.ok) throw new Error();
  const app = await createNodeServer(config.value, { models: new ModelRegistry().register({ id: 'boson-worker', create: () => delegatedModel(actor, worker) }) });
  const running = await startNodeServer(app, { port: 0 }); cleanups.push(running.close);
  const doc = createTestDocument(() => {});
  doc.tools.insert_structured_article!.run({ expectedSessionId: doc.read().sessionId, expectedRevision: 0, destination: { kind: 'document_end' }, title: '保留的标题', blocks: ['第一段', '第二段', '第三段', '第四段'].map(text => ({ kind: 'paragraph', text })) }, { callId: 'seed', turnId: 'seed-turn', epoch: 0, signal: new AbortController().signal });
  const before = doc.read();
  const grant = await (await fetch(`http://127.0.0.1:${running.port}/v1/documents/delete-doc/voice-sessions`, { method: 'POST', headers: { Authorization: `Bearer ${key}` } })).json() as { realtimePath: string; grant: { token: string } };
  const client = await connect(`ws://127.0.0.1:${running.port}${grant.realtimePath}`, { auth: grant.grant.token, reconnect: false, audio: { input: false, output: false }, tools: doc.tools });
  cleanups.push(() => client.close());
  let done = false; client.on('text', event => { if (event.delta === '测试结束') done = true; });
  client.sendText('只删除最后两段');
  await expect.poll(() => done).toBe(true);
  if (environment === 'development') {
    expect(deletion).toMatchObject({ ok: true, deletedCount: 2 });
    expect(doc.read().blocks.map(block => block.id)).toEqual(before.blocks.slice(0, 3).map(block => block.id));
    expect(doc.read().revision).toBe(2);
  } else {
    expect(deletion).toMatchObject({ error: { code: 'REJECTED' } });
    expect(doc.read()).toEqual(before);
  }
});
