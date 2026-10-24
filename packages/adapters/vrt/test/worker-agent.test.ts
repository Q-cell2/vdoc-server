import { finishWorkerSpeech, WORKER_STARTED_TEXT } from '../src/worker/delegated-model';
import { afterEach, expect, it, vi } from 'vitest';
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import { RealtimeError, startSession, type AgentSession, type RealtimeEvent, type ToolSpec } from '@vrealtime/core';
import { fakeModel } from '@vrealtime/testing';
import { createPiWorker, delegatedModel, DELEGATE_TOOL, type WorkerRunner } from '../src';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const tools: ToolSpec[] = [
  { name: 'read_document', description: 'Read', parameters: { type: 'object', properties: {} } },
  { name: 'insert_structured_article', description: 'Write', parameters: { type: 'object', required: ['expectedRevision'], properties: { expectedRevision: { type: 'integer' } } } },
];
function scriptedWorker(replies: AssistantMessage['content'][], options: { maxRequests?: number } = {}) {
  const requests: unknown[] = [];
  const streamFn: StreamFn = (_model, context) => {
    requests.push(structuredClone(context));
    const content = replies.shift() ?? [{ type: 'text', text: '完成。' }];
    const message: AssistantMessage = { role: 'assistant', api: 'anthropic-messages', provider: 'anthropic', model: 'claude-sonnet-5-5', content,
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: content.some(block => block.type === 'toolCall') ? 'toolUse' : 'stop', timestamp: Date.now() };
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      stream.push({ type: 'start', partial: message });
      content.forEach((block, index) => {
        if (block.type === 'text') {
          stream.push({ type: 'text_delta', contentIndex: index, delta: block.text.slice(0, 2), partial: message });
          stream.push({ type: 'text_delta', contentIndex: index, delta: block.text.slice(2), partial: message });
        } else if (block.type === 'toolCall') {
          stream.push({ type: 'toolcall_delta', contentIndex: index, delta: JSON.stringify(block.arguments), partial: message });
        }
      });
      stream.push({ type: 'done', reason: message.stopReason as 'stop' | 'toolUse', message });
    });
    return stream;
  };
  return { worker: createPiWorker({ apiKey: 'test', streamFn, ...options }), requests };
}
function actorModel() {
  let speak = false;
  let number = 0;
  return fakeModel({ capabilities: { tools: { autoReplyAfterResult: false } }, onCommand(command, session) {
    if (command.type === 'submitToolResult') speak = (command.output as { ok?: boolean })?.ok === true;
    if (command.type !== 'respond') return;
    const speaking = speak; speak = false;
    const responseId = `actor-${++number}`;
    queueMicrotask(() => {
      session.emit({ type: 'response.start', responseId });
      if (speaking) {
        session.emit({ type: 'output.transcript', responseId, itemId: `${responseId}-voice`, delta: '任务完成。' });
        session.emit({ type: 'output.audio', responseId, itemId: `${responseId}-voice`, chunk: { data: new Uint8Array(48), format: { encoding: 'pcm16', sampleRate: 24000, channels: 1 } } });
      } else {
        // Unauthorized factual speech before delegation must be suppressed.
        session.emit({ type: 'output.transcript', responseId, itemId: 'untrusted', delta: 'I already edited it.' });
        session.emit({ type: 'tool.call', responseId, callId: `delegate-${number}`, name: DELEGATE_TOOL, arguments: { request: '写一篇文章' } });
      }
      session.emit({ type: 'response.end', responseId, status: 'done', stopReason: speaking ? 'completed' : 'tool_calls' });
    });
  } });
}
async function setup(worker: WorkerRunner, beforeToolCall?: (name: string) => boolean, timeout = 1000, finishTools = true) {
  const actor = actorModel();
  const model = delegatedModel(actor, worker, timeout);
  const calls: { name: string; callId: string; args: unknown }[] = [];
  const text: string[] = [];
  const voice: string[] = [];
  const errors: string[] = [];
  const ended = vi.fn();
  let session!: AgentSession;
  session = await startSession({ model, instructions: 'Worker document instructions.', clientTools: 'accept', maxContinuations: 16,
    hooks: {
      beforeToolCall: call => beforeToolCall?.(call.name) === false ? { action: 'reject', message: 'Denied by policy' } : { action: 'allow' },
      onTurnEnd: ended,
    },
  }, { clientTools: tools });
  cleanup.push(() => session.close());
  session.on('tool.call', call => {
    calls.push({ name: call.name, callId: call.callId, args: call.arguments });
    if (finishTools) session.submitClientToolResult(call.callId, { ok: true, output: { ok: true, revision: 7 } });
  });
  session.on('text', event => { if (!event.delta.startsWith('[执行阶段]')) text.push(event.delta); });
  session.on('transcript', event => { if (event.role === 'agent' && !event.final) voice.push(event.text); });
  session.on('error', event => errors.push(event.error.message));
  session.sendText('请读取文档并写入一篇完整文章');
  return { actor, session, calls, text, voice, errors, ended };
}
const read: AssistantMessage['content'] = [{ type: 'toolCall', id: 'same-provider-id', name: 'read_document', arguments: {} }];
const write: AssistantMessage['content'] = [{ type: 'toolCall', id: 'same-provider-id', name: 'insert_structured_article', arguments: { expectedRevision: 7 } }];
const done: AssistantMessage['content'] = [{ type: 'text', text: '文章已写入。' }];

it('runs real Pi read/write/final turns through vRT once, streams text, then lets the one-tool actor speak', async () => {
  const { worker, requests } = scriptedWorker([read, write, done]);
  const h = await setup(worker);
  await expect.poll(() => h.ended.mock.calls.length).toBe(1);
  expect(h.errors).toEqual([]);
  expect(h.calls.map(call => call.name)).toEqual(['read_document', 'insert_structured_article']);
  expect(new Set(h.calls.map(call => call.callId)).size).toBe(2);
  expect(h.text.join('')).toBe('文章已写入。');
  expect(h.voice).toEqual(['任务完成。']);
  expect(requests).toHaveLength(3);
  expect(JSON.stringify(requests[1])).toContain('revision');
  expect(h.actor.session.commandsOf('connect')[0]!.config.tools?.map(tool => tool.name)).toEqual([DELEGATE_TOOL]);
  expect(h.actor.session.commandsOf('connect')[0]!.config.instructions).not.toContain('Worker document instructions');
  const results = h.actor.session.commandsOf('submitToolResult');
  expect(results).toHaveLength(1);
  expect(results[0]!.output).toEqual({ ok: true, spokenReply: '文章已写入。' });
  expect(h.actor.session.commandsOf('respond')).toHaveLength(2);
});

it('feeds a policy denial back to Pi without executing the client write', async () => {
  const { worker, requests } = scriptedWorker([read, write, [{ type: 'text', text: '写入被拒绝。' }]]);
  const h = await setup(worker, name => name !== 'insert_structured_article');
  await expect.poll(() => h.ended.mock.calls.length).toBe(1);
  expect(h.calls.map(call => call.name)).toEqual(['read_document']);
  expect(JSON.stringify(requests[2])).toContain('REJECTED');
});

it('validates Pi arguments before dispatch and does not apply partial JSON', async () => {
  const bad: AssistantMessage['content'] = [{ type: 'toolCall', id: 'invalid', name: 'insert_structured_article', arguments: { expectedRevision: 'wrong' } }];
  const { worker } = scriptedWorker([bad, done]);
  const h = await setup(worker);
  await expect.poll(() => h.ended.mock.calls.length).toBe(1);
  expect(h.calls).toEqual([]);
  expect(h.errors).toEqual([]);
});

it('bounds Pi generation independently of the performer and reports failure without a success voice', async () => {
  const { worker } = scriptedWorker([read, read, done], { maxRequests: 1 });
  const h = await setup(worker);
  await expect.poll(() => h.errors.length).toBeGreaterThan(0);
  expect(h.calls).toHaveLength(1);
  expect(h.voice).toEqual([]);
  expect(h.actor.session.commandsOf('respond')).toHaveLength(1);
});

it('cancels a delegated run and drops its late tool call, text, and completion', async () => {
  let release!: () => void;
  let started = false;
  let aborted = false;
  const worker: WorkerRunner = { async run(_request, context) {
    context.emit({ type: 'start' }); started = true;
    context.signal.addEventListener('abort', () => { aborted = true; });
    await new Promise<void>(resolve => { release = resolve; });
    context.emit({ type: 'text', delta: 'late' });
    await context.execute('late', 'insert_structured_article', { expectedRevision: 7 }).catch(() => undefined);
    return 'late success';
  } };
  const h = await setup(worker);
  await expect.poll(() => started).toBe(true);
  h.session.interrupt('keyboard');
  release();
  await expect.poll(() => aborted).toBe(true);
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(h.calls).toEqual([]);
  expect(h.text).toEqual([]);
  expect(h.actor.session.commandsOf('submitToolResult').map(call => call.output)).toEqual([{ ok: false, code: 'INTERRUPTED' }]);
});

it('times out a hanging worker and ends the active turn', async () => {
  const h = await setup({ run: async () => new Promise(() => {}) }, undefined, 20);
  await expect.poll(() => h.errors.length).toBeGreaterThan(0);
  await expect.poll(() => h.ended.mock.calls.length).toBe(1);
  expect(h.calls).toEqual([]);
  expect(h.actor.session.commandsOf('respond')).toHaveLength(1);
});

it('keeps exactly one actor tool on context/tool updates', async () => {
  const actor = actorModel();
  const model = delegatedModel(actor, { run: async () => 'ok' });
  const session = await model.connect({ tools });
  cleanup.push(() => session.close());
  const seen: RealtimeEvent[] = [];
  session.on('output.text', event => seen.push(event));
  await session.update({ tools, instructions: 'worker only' });
  expect(actor.session.commandsOf('update')[0]!.config.tools?.map(tool => tool.name)).toEqual([DELEGATE_TOOL]);
  expect(actor.session.commandsOf('update')[0]!.config.instructions).not.toContain('worker only');
});


it('blocks an actor trying to bypass delegation with a document tool', async () => {
  const actor = fakeModel();
  const run = vi.fn(async () => 'should not run');
  const session = await delegatedModel(actor, { run }).connect({ tools });
  cleanup.push(() => session.close());
  const failures: string[] = [];
  const calls: unknown[] = [];
  session.on('error', event => failures.push(event.error.message));
  session.on('tool.call', event => calls.push(event));
  actor.session.emit({ type: 'response.start', responseId: 'bypass' });
  actor.session.emit({ type: 'tool.call', responseId: 'bypass', callId: 'bad', name: 'insert_structured_article', arguments: { expectedRevision: 7 } });
  actor.session.emit({ type: 'response.end', responseId: 'bypass', status: 'done', stopReason: 'tool_calls' });
  expect(run).not.toHaveBeenCalled();
  expect(calls).toEqual([]);
  expect(failures).toHaveLength(1);
});


it('aborts real Pi during a client tool and starts a clean next task without replaying the write', async () => {
  const { worker, requests } = scriptedWorker([read, [{ type: 'text', text: '改为回答。' }]]);
  const h = await setup(worker, undefined, 1000, false);
  await expect.poll(() => h.calls.length).toBe(1);
  const oldCallId = h.calls[0]!.callId;
  h.session.interrupt('keyboard');
  h.session.sendText('改为只回答，不写文章');
  await expect.poll(() => h.text.join('')).toBe('改为回答。');
  await expect.poll(() => h.voice.length).toBe(1);
  // The cancelled browser result cannot revive the first worker or run its queued write.
  h.session.submitClientToolResult(oldCallId, { ok: true, output: { ok: true, revision: 99 } });
  expect(h.calls).toHaveLength(1);
  expect(requests).toHaveLength(2);
  expect(h.actor.session.commandsOf('submitToolResult').map(call => call.output)).toEqual([
    { ok: false, code: 'INTERRUPTED' }, { ok: true, spokenReply: '改为回答。' },
  ]);
});


it('ends paused audio using acknowledged server VAD, requests a missing response after transcription, and starts the worker', async () => {
  const actor = fakeModel();
  const worker = { run: vi.fn(async (_request, context) => { context.emit({ type: 'start' }); return '完成'; }) } satisfies WorkerRunner;
  const session = await delegatedModel(actor, worker, 1000, 2000).connect({ tools });
  cleanup.push(() => session.close());
  const progress: string[] = [];
  session.on('output.text', event => progress.push(event.delta));
  actor.session.emit({ type: 'input.speech.start', atMs: 0 });
  expect(finishWorkerSpeech(session, 'pause-1')).toBe(true);
  finishWorkerSpeech(session, 'pause-1');
  finishWorkerSpeech(session, 'pause-2');
  await expect.poll(() => actor.session.commandsOf('sendAudio').length).toBeGreaterThan(0);
  expect(actor.session.commandsOf('commitAudio')).toHaveLength(0);
  expect(actor.session.commandsOf('connect')[0]!.config.turnDetection).toBe('server');
  actor.session.emit({ type: 'input.speech.end', atMs: 300 });
  actor.session.emit({ type: 'input.transcript', itemId: 'utterance', text: '写文章', final: true });
  await expect.poll(() => actor.session.commandsOf('respond').length).toBe(1);
  actor.session.emit({ type: 'response.start', responseId: 'delegate' });
  actor.session.emit({ type: 'tool.call', responseId: 'delegate', callId: 'delegation', name: DELEGATE_TOOL, arguments: { request: '写文章' } });
  actor.session.emit({ type: 'response.end', responseId: 'delegate', status: 'done', stopReason: 'tool_calls' });
  session.respond();
  expect(worker.run).toHaveBeenCalledTimes(1);
  expect(progress).toContain(WORKER_STARTED_TEXT);
});

it('does not recommit an automatically ended utterance or duplicate its automatic response', async () => {
  const actor = fakeModel();
  const session = await delegatedModel(actor, { run: async () => 'done' }, 1000, 2000).connect({ tools });
  cleanup.push(() => session.close());
  actor.session.emit({ type: 'input.speech.start', atMs: 0 });
  actor.session.emit({ type: 'input.speech.end', atMs: 200 });
  actor.session.emit({ type: 'input.transcript', itemId: 'u', text: '测试', final: true });
  finishWorkerSpeech(session, 'pause');
  actor.session.emit({ type: 'response.start', responseId: 'auto' });
  await new Promise(resolve => setTimeout(resolve, 650));
  expect(actor.session.commandsOf('commitAudio')).toHaveLength(0);
  expect(actor.session.commandsOf('respond')).toHaveLength(0);
});

it.each([false, true])('bounds a stalled delegation (response started=%s), ignores late tools, and permits a clean retry', async started => {
  const actor = fakeModel();
  const run = vi.fn(async () => 'must not run');
  const session = await delegatedModel(actor, { run }, 1000, 20).connect({ tools });
  cleanup.push(() => session.close());
  const failures: string[] = [];
  const ended: RealtimeEvent[] = [];
  session.on('error', event => failures.push(event.error.message));
  session.on('response.end', event => ended.push(event));
  session.sendText('写文章'); session.respond();
  if (started) actor.session.emit({ type: 'response.start', responseId: 'stalled' });
  await expect.poll(() => failures.length).toBe(1);
  expect(failures[0]).toContain('DELEGATION_TIMEOUT');
  expect(ended).toContainEqual(expect.objectContaining({ status: 'failed' }));
  if (!started) actor.session.emit({ type: 'response.start', responseId: 'stalled' });
  session.sendText('重试');
  actor.session.emit({ type: 'response.start', responseId: 'stalled' });
  actor.session.emit({ type: 'tool.call', responseId: 'stalled', callId: 'late', name: DELEGATE_TOOL, arguments: { request: 'late' } });
  actor.session.emit({ type: 'response.end', responseId: 'stalled', status: 'done', stopReason: 'tool_calls' });
  session.respond();
  expect(run).not.toHaveBeenCalled();
});


it('reports a delegation timeout through the real runtime and ends thinking even before any response starts', async () => {
  const actor = fakeModel();
  const ended = vi.fn();
  const session = await startSession({ model: delegatedModel(actor, { run: async () => 'unused' }, 1000, 20), instructions: '', hooks: { onTurnEnd: ended } });
  cleanup.push(() => session.close());
  const errors: string[] = [];
  session.on('error', event => errors.push(event.error.message));
  session.sendText('请求');
  await expect.poll(() => ended.mock.calls.length).toBe(1);
  expect(errors.some(error => error.includes('DELEGATION_TIMEOUT'))).toBe(true);
});

it('does not pad, recommit or restart a worker when the user pauses after work has already begun', async () => {
  const actor = actorModel();
  let started = false;
  let aborted = false;
  const worker: WorkerRunner = { run: async (_request, context) => {
    started = true;
    context.signal.addEventListener('abort', () => { aborted = true; });
    return new Promise(() => {});
  } };
  const model = delegatedModel(actor, worker, 1000);
  const session = await model.connect({ tools }); cleanup.push(() => session.close());
  session.sendText('写文章'); session.respond();
  await expect.poll(() => actor.session.commandsOf('respond').length).toBe(1);
  // Direct model use: resume after the actor's completed delegate response.
  session.respond();
  await expect.poll(() => started).toBe(true);
  const responses = actor.session.commandsOf('respond').length;
  finishWorkerSpeech(session, 'pause-during-worker');
  expect(actor.session.commandsOf('commitAudio')).toHaveLength(0);
  expect(actor.session.commandsOf('sendAudio')).toHaveLength(0);
  expect(actor.session.commandsOf('respond')).toHaveLength(responses);
  expect(aborted).toBe(false);
});


it('does not send performer cancellation when only Pi is running', async () => {
  let started = false;
  let aborted = false;
  let release!: () => void;
  const worker: WorkerRunner = { run: async (_request, context) => {
    context.emit({ type: 'start' }); started = true;
    context.signal.addEventListener('abort', () => { aborted = true; });
    await new Promise<void>(resolve => { release = resolve; });
    return 'cancelled';
  } };
  const h = await setup(worker);
  await expect.poll(() => started).toBe(true);
  h.session.interrupt('keyboard'); release();
  expect(aborted).toBe(true);
  expect(h.actor.session.commandsOf('cancel')).toHaveLength(0);
  expect(h.errors).toEqual([]);
});

it.each(['response_not_active', 'response_cancel_not_active'])('ignores a delayed benign %s error without aborting the new worker', async providerCode => {
  let started = false;
  let aborted = false;
  let release!: () => void;
  const worker: WorkerRunner = { run: async (_request, context) => {
    context.emit({ type: 'start' }); started = true;
    context.signal.addEventListener('abort', () => { aborted = true; });
    await new Promise<void>(resolve => { release = resolve; });
    await context.execute('write-after-race', 'insert_structured_article', { expectedRevision: 7 });
    context.emit({ type: 'turn-end', usage: { inputTokens: 1, outputTokens: 1 } });
    context.emit({ type: 'start' }); context.emit({ type: 'text', delta: '写入成功' });
    return '写入成功';
  } };
  const h = await setup(worker);
  await expect.poll(() => started).toBe(true);
  h.actor.session.emit({ type: 'error', error: new RealtimeError('invalid_request', 'No active response to cancel.', { provider: 'boson', providerCode }), recoverable: true });
  release();
  await expect.poll(() => h.ended.mock.calls.length).toBe(1);
  expect(aborted).toBe(false);
  expect(h.errors).toEqual([]);
  expect(h.calls.map(call => call.name)).toEqual(['insert_structured_article']);
  expect(h.text.join('')).toBe('写入成功');
});

it('still cancels an active performer, tolerates its cancel race, and reports genuine provider errors', async () => {
  const actor = fakeModel();
  const session = await delegatedModel(actor, { run: async () => 'unused' }).connect({ tools });
  cleanup.push(() => session.close());
  const errors: string[] = []; session.on('error', event => errors.push(event.error.message));
  actor.session.emit({ type: 'response.start', responseId: 'speaking' });
  session.cancel(); session.cancel();
  expect(actor.session.commandsOf('cancel')).toHaveLength(1);
  actor.session.emit({ type: 'error', error: new Error('No active response to cancel.'), recoverable: true });
  expect(errors).toEqual([]);
  actor.session.emit({ type: 'error', error: new RealtimeError('auth', 'Authentication failed'), recoverable: false });
  expect(errors).toEqual(['Authentication failed']);
});


it('stops the old Pi on provider-side speech barge-in and accepts the next voice delegation', async () => {
  let runs = 0;
  let release!: () => void;
  let oldAborted = false;
  const worker: WorkerRunner = { run: async (_request, context) => {
    context.emit({ type: 'start' });
    if (++runs === 1) {
      context.signal.addEventListener('abort', () => { oldAborted = true; });
      await new Promise<void>(resolve => { release = resolve; });
      await context.execute('old-late-write', 'insert_structured_article', { expectedRevision: 7 }).catch(() => undefined);
      return 'old';
    }
    await context.execute('new-write', 'insert_structured_article', { expectedRevision: 7 });
    context.emit({ type: 'turn-end', usage: { inputTokens: 1, outputTokens: 1 } });
    context.emit({ type: 'start' }); context.emit({ type: 'text', delta: '新任务完成' }); return '新任务完成';
  } };
  const h = await setup(worker);
  await expect.poll(() => runs).toBe(1);
  h.actor.session.emit({ type: 'input.speech.start', atMs: 10 });
  expect(oldAborted).toBe(true); release();
  h.actor.session.emit({ type: 'input.speech.end', atMs: 20 });
  h.actor.session.emit({ type: 'input.transcript', itemId: 'new-utterance', text: '改写新文章', final: true });
  h.actor.session.emit({ type: 'response.start', responseId: 'new-voice-delegate' });
  h.actor.session.emit({ type: 'tool.call', responseId: 'new-voice-delegate', callId: 'new-delegation', name: DELEGATE_TOOL, arguments: { request: '改写新文章' } });
  h.actor.session.emit({ type: 'response.end', responseId: 'new-voice-delegate', status: 'done', stopReason: 'tool_calls' });
  await expect.poll(() => h.text.join('')).toBe('新任务完成');
  expect(runs).toBe(2);
  expect(h.calls.map(call => call.name)).toEqual(['insert_structured_article']);
  expect(h.errors).toEqual([]);
});


it.each(['typed', 'voice'])('uses only the authoritative %s request when Higgs delegates an unrelated task', async source => {
  const actor = fakeModel();
  const requests: string[] = [];
  const worker: WorkerRunner = { run: async (request, context) => { requests.push(request.prompt); context.emit({ type: 'start' }); return 'done'; } };
  const session = await delegatedModel(actor, worker, 1000, 1000).connect({ tools }); cleanup.push(() => session.close());
  const userRequest = '我现在需要你列一个表格，里面是所有奥特曼的名字。';
  if (source === 'typed') {
    session.sendText(userRequest);
    // A delayed transcript from a past utterance cannot override typed input.
    actor.session.emit({ type: 'input.transcript', itemId: 'old-voice', text: '旧语音任务', final: true });
  } else {
    actor.session.emit({ type: 'input.speech.start', atMs: 0 });
    actor.session.emit({ type: 'input.speech.end', atMs: 10 });
  }
  actor.session.emit({ type: 'response.start', responseId: 'conflicting-delegate' });
  actor.session.emit({ type: 'tool.call', responseId: 'conflicting-delegate', callId: 'delegate', name: DELEGATE_TOOL, arguments: { request: '列一个电影票房前十的表格' } });
  actor.session.emit({ type: 'response.end', responseId: 'conflicting-delegate', status: 'done', stopReason: 'tool_calls' });
  session.respond();
  if (source === 'voice') {
    expect(requests).toHaveLength(0);
    actor.session.emit({ type: 'input.transcript', itemId: 'current-voice', text: userRequest, final: true });
  }
  expect(requests).toHaveLength(1);
  expect(JSON.parse(requests[0]!)).toMatchObject({ userRequest, requestSource: source === 'typed' ? 'typed' : 'final-transcript' });
  expect(requests[0]).not.toContain('电影票房');
  expect(requests[0]).not.toContain('delegatedRequest');
});

it('fails closed when a voice delegation has no final transcript, without running an invented actor task', async () => {
  const actor = fakeModel();
  const run = vi.fn(async () => 'unused');
  const session = await delegatedModel(actor, { run }, 1000, 20).connect({ tools }); cleanup.push(() => session.close());
  const failures: string[] = []; session.on('error', event => failures.push(event.error.message));
  actor.session.emit({ type: 'input.speech.start', atMs: 0 });
  actor.session.emit({ type: 'response.start', responseId: 'no-transcript' });
  actor.session.emit({ type: 'tool.call', responseId: 'no-transcript', callId: 'delegate', name: DELEGATE_TOOL, arguments: { request: 'invented task' } });
  actor.session.emit({ type: 'response.end', responseId: 'no-transcript', status: 'done', stopReason: 'tool_calls' });
  session.respond();
  await expect.poll(() => failures.length).toBe(1);
  expect(failures[0]).toContain('TRANSCRIPTION_TIMEOUT');
  actor.session.emit({ type: 'input.transcript', itemId: 'late', text: '迟到的语音', final: true });
  expect(run).not.toHaveBeenCalled();
});


it.each(['missing', 'wrong-tool'])('repairs a %s delegation once before any worker edit, then writes only once', async failure => {
  let replies = false;
  let responses = 0;
  const actor = fakeModel({ onCommand(command, session) {
    if (command.type === 'submitToolResult') replies = true;
    if (command.type !== 'respond') return;
    const number = ++responses; const speaking = replies;
    queueMicrotask(() => {
      const responseId = `repair-${number}`;
      session.emit({ type: 'response.start', responseId });
      if (!speaking && number === 1 && failure === 'wrong-tool') session.emit({ type: 'tool.call', responseId, callId: 'bad', name: 'insert_structured_article', arguments: {} });
      if (!speaking && number > 1) session.emit({ type: 'tool.call', responseId, callId: 'delegate', name: DELEGATE_TOOL, arguments: { request: 'ignored rewrite' } });
      session.emit({ type: 'response.end', responseId, status: 'done', stopReason: !speaking && number > 1 ? 'tool_calls' : 'completed' });
    });
  } });
  let runs = 0;
  const worker: WorkerRunner = { async run(request, context) {
    runs++; expect(JSON.parse(request.prompt).userRequest).toBe('删除关于鲁迅的文章');
    context.emit({ type: 'start' });
    await context.execute('write-once', 'insert_structured_article', { expectedRevision: 7 });
    context.emit({ type: 'turn-end', usage: { inputTokens: 1, outputTokens: 1 } });
    context.emit({ type: 'start' }); context.emit({ type: 'text', delta: '完成' }); return '完成';
  } };
  const ended = vi.fn();
  const session = await startSession({ model: delegatedModel(actor, worker), instructions: '', clientTools: 'accept', hooks: { onTurnEnd: ended } }, { clientTools: tools });
  cleanup.push(() => session.close());
  let writes = 0; const errors: string[] = [];
  session.on('tool.call', call => { writes++; session.submitClientToolResult(call.callId, { ok: true, output: { ok: true, revision: 8 } }); });
  session.on('error', event => errors.push(event.error.message));
  session.sendText('删除关于鲁迅的文章');
  await expect.poll(() => ended.mock.calls.length).toBe(1);
  expect(errors).toEqual([]); expect(writes).toBe(1); expect(runs).toBe(1);
  expect(actor.session.commandsOf('respond')).toHaveLength(3);
  expect(actor.session.commandsOf('respond')[1]!.options?.instructions).toContain('删除关于鲁迅的文章');
});

it('stops after one unsuccessful delegation repair and reports the real reason without dispatching tools', async () => {
  let responses = 0;
  const actor = fakeModel({ onCommand(command, session) {
    if (command.type !== 'respond') return;
    const responseId = `still-missing-${++responses}`;
    queueMicrotask(() => {
      session.emit({ type: 'response.start', responseId });
      session.emit({ type: 'response.end', responseId, status: 'done', stopReason: 'completed' });
    });
  } });
  const run = vi.fn(async () => 'must not run'); const ended = vi.fn();
  const session = await startSession({ model: delegatedModel(actor, { run }), instructions: '', hooks: { onTurnEnd: ended } });
  cleanup.push(() => session.close());
  const errors: string[] = []; session.on('error', event => errors.push(event.error.message));
  session.sendText('任务');
  await expect.poll(() => ended.mock.calls.length).toBe(1);
  expect(responses).toBe(2); expect(run).not.toHaveBeenCalled();
  expect(errors[0]).toContain('ACTOR_DELEGATION_FAILED');
  expect(errors.at(-1)).toBe('Generation stopped: failed');
});

it('labels voice-only failure after a successful write and never replays that write', async () => {
  let speaking = false; let responses = 0;
  const actor = fakeModel({ onCommand(command, session) {
    if (command.type === 'submitToolResult') speaking = true;
    if (command.type !== 'respond') return;
    const isVoice = speaking; const responseId = `voice-fail-${++responses}`;
    queueMicrotask(() => {
      session.emit({ type: 'response.start', responseId });
      if (!isVoice) session.emit({ type: 'tool.call', responseId, callId: 'delegate', name: DELEGATE_TOOL, arguments: { request: '任务' } });
      session.emit({ type: 'response.end', responseId, status: isVoice ? 'failed' : 'done', stopReason: isVoice ? 'failed' : 'tool_calls' });
    });
  } });
  let runs = 0;
  const worker: WorkerRunner = { async run(_request, context) {
    runs++; context.emit({ type: 'start' });
    await context.execute('write', 'insert_structured_article', { expectedRevision: 7 });
    context.emit({ type: 'turn-end', usage: { inputTokens: 1, outputTokens: 1 } });
    context.emit({ type: 'start' }); context.emit({ type: 'text', delta: '文档已修改' }); return '文档已修改';
  } };
  const ended = vi.fn();
  const session = await startSession({ model: delegatedModel(actor, worker), instructions: '', clientTools: 'accept', hooks: { onTurnEnd: ended } }, { clientTools: tools });
  cleanup.push(() => session.close());
  let writes = 0; const errors: string[] = [];
  session.on('tool.call', call => { writes++; session.submitClientToolResult(call.callId, { ok: true, output: { ok: true, revision: 8 } }); });
  session.on('error', event => errors.push(event.error.message));
  session.sendText('任务');
  await expect.poll(() => ended.mock.calls.length).toBe(1);
  expect(errors[0]).toContain('VOICE_REPLY_FAILED');
  expect(errors[0]).toContain('文档已有成功修改');
  expect(writes).toBe(1); expect(runs).toBe(1); expect(responses).toBe(2);
});

it('reports already completed edits if Pi fails after applying a write, without an unsafe full-task retry', async () => {
  const worker: WorkerRunner = { run: async (_request, context) => {
    context.emit({ type: 'start' });
    await context.execute('write', 'insert_structured_article', { expectedRevision: 7 });
    throw new Error('private provider error details');
  } };
  const h = await setup(worker);
  await expect.poll(() => h.ended.mock.calls.length).toBe(1);
  expect(h.calls).toHaveLength(1);
  expect(h.errors[0]).toContain('WORKER_FAILED_AFTER_WRITE');
  expect(h.errors.join('')).not.toContain('private provider error details');
  expect(h.actor.session.commandsOf('respond')).toHaveLength(1);
});
