import { finishWorkerSpeech, INTERJECTION_PREFIX, READ_ALOUD_PREFIX, WORKER_STARTED_TEXT } from '../src/worker/delegated-model';
import { afterEach, expect, it, vi } from 'vitest';
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import { RealtimeError, startSession, type AgentSession, type ToolSpec } from '@vrealtime/core';
import { fakeModel, type FakeModel } from '@vrealtime/testing';
import { HIGH_RISK_CONFIRMATION_MESSAGE } from '@vdoc-server/domain';
import { createPiWorker, delegatedModel, type UtteranceJudge, type WorkerRunner } from '../src';
import { thinkingBetweenToolsOnly } from '../src/worker/pi-worker';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const tools: ToolSpec[] = [
  { name: 'read_document', description: 'Read', parameters: { type: 'object', properties: {} } },
  { name: 'insert_structured_article', description: 'Write', parameters: { type: 'object', required: ['expectedRevision'], properties: { expectedRevision: { type: 'integer' } } } },
];
function scriptedWorker(replies: AssistantMessage['content'][], options: { maxRequests?: number; prefetch?: boolean } = {}) {
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
/** Higgs as a pure speaker: asked to read a message aloud, it says exactly that message. */
function speakerModel(status: 'done' | 'failed' | 'cancelled' = 'done') {
  let number = 0;
  let toRead: string | undefined;
  return fakeModel({ capabilities: { tools: { autoReplyAfterResult: false } }, onCommand(command, session) {
    if (command.type === 'sendText' && command.text.startsWith(READ_ALOUD_PREFIX)) toRead = command.text.slice(READ_ALOUD_PREFIX.length);
    if (command.type !== 'respond') return;
    const quoted = toRead; toRead = undefined;
    const responseId = `speech-${++number}`;
    queueMicrotask(() => {
      session.emit({ type: 'response.start', responseId });
      if (quoted) {
        session.emit({ type: 'output.transcript', responseId, itemId: `${responseId}-voice`, delta: quoted });
        session.emit({ type: 'output.audio', responseId, itemId: `${responseId}-voice`, chunk: { data: new Uint8Array(48), format: { encoding: 'pcm16', sampleRate: 24000, channels: 1 } } });
      }
      session.emit({ type: 'response.end', responseId, status, stopReason: status === 'done' ? 'completed' : status });
    });
  } });
}
async function setup(worker: WorkerRunner, options: { beforeToolCall?: (name: string) => boolean | string; timeout?: number; transcriptTimeout?: number; finishTools?: boolean; judge?: UtteranceJudge; actor?: FakeModel; text?: string | null; tools?: ToolSpec[] } = {}) {
  const actor = options.actor ?? speakerModel();
  const model = delegatedModel(actor, worker, options.timeout ?? 1000, options.transcriptTimeout ?? 1000, options.judge);
  const calls: { name: string; callId: string; args: unknown }[] = [];
  const text: string[] = [];
  const notices: string[] = [];
  const voice: string[] = [];
  const errors: string[] = [];
  const ended = vi.fn();
  let session!: AgentSession;
  session = await startSession({ model, instructions: 'Worker document instructions.', clientTools: 'accept', maxContinuations: 16,
    hooks: {
      beforeToolCall: call => {
        const verdict = options.beforeToolCall?.(call.name);
        return verdict === false ? { action: 'reject', message: 'Denied by policy' } : typeof verdict === 'string' ? { action: 'reject', message: verdict } : { action: 'allow' };
      },
      onTurnEnd: ended,
    },
  }, { clientTools: options.tools ?? tools });
  cleanup.push(() => session.close());
  session.on('tool.call', call => {
    calls.push({ name: call.name, callId: call.callId, args: call.arguments });
    if (options.finishTools !== false) session.submitClientToolResult(call.callId, { ok: true, output: { ok: true, revision: 7 } });
  });
  session.on('text', event => {
    if (event.delta.startsWith(INTERJECTION_PREFIX)) notices.push(event.delta.slice(INTERJECTION_PREFIX.length).trim());
    else if (!event.delta.startsWith('[执行阶段]')) text.push(event.delta);
  });
  session.on('transcript', event => { if (event.role === 'agent' && !event.final) voice.push(event.text); });
  session.on('error', event => errors.push(event.error.message));
  if (options.text !== null) session.sendText(options.text ?? '请读取文档并写入一篇完整文章');
  return { actor, session, calls, text, notices, voice, errors, ended };
}
/** Server-VAD voice input: the provider reports the utterance and its final transcript. */
function speakTo(actor: FakeModel, words: string, itemId = 'utterance') {
  actor.session.emit({ type: 'input.speech.start', atMs: 0 });
  actor.session.emit({ type: 'input.speech.end', atMs: 300 });
  actor.session.emit({ type: 'input.transcript', itemId, text: words, final: true });
}
const read: AssistantMessage['content'] = [{ type: 'toolCall', id: 'same-provider-id', name: 'read_document', arguments: {} }];
const write: AssistantMessage['content'] = [{ type: 'toolCall', id: 'same-provider-id', name: 'insert_structured_article', arguments: { expectedRevision: 7 } }];
const done: AssistantMessage['content'] = [{ type: 'text', text: '文章已写入。' }];
const hanging = (onStart?: (context: Parameters<WorkerRunner['run']>[1]) => void): WorkerRunner => ({ run: async (_request, context) => {
  context.emit({ type: 'start' }); onStart?.(context); return new Promise(() => {});
} });

it('turns thinking off for a model Pi cannot switch off by swapping only the thinking field for between_tools', () => {
  const payload = {
    model: 'claude-sonnet-5-5', max_tokens: 8192, stream: true,
    thinking: { type: 'adaptive', display: 'summarized' }, output_config: { effort: 'high' },
    messages: [{ role: 'user', content: [] }, { role: 'system', content: [], output_config: { effort: 'low' } }],
  };
  expect(thinkingBetweenToolsOnly(payload)).toEqual({ ...payload, thinking: { type: 'between_tools' } });
  expect(payload.thinking.type).toBe('adaptive');
});

it('runs real Pi read/write/final turns through vRT once, streams text, then has Higgs read the reply verbatim', async () => {
  const { worker, requests } = scriptedWorker([read, write, done]);
  const h = await setup(worker);
  await expect.poll(() => h.ended.mock.calls.length).toBe(1);
  expect(h.errors).toEqual([]);
  expect(h.calls.map(call => call.name)).toEqual(['read_document', 'insert_structured_article']);
  expect(new Set(h.calls.map(call => call.callId)).size).toBe(2);
  expect(h.text.join('')).toBe('文章已写入。');
  expect(h.voice).toEqual(['文章已写入。']);
  expect(requests).toHaveLength(3);
  expect(JSON.stringify(requests[1])).toContain('revision');
  // Higgs gets no tools and none of the document instructions: it cannot decide or act.
  const connect = h.actor.session.commandsOf('connect')[0]!.config;
  expect(connect.tools).toEqual([]);
  expect(connect.instructions).not.toContain('Worker document instructions');
  expect(h.actor.session.commandsOf('respond')).toHaveLength(1);
  expect(h.actor.session.commandsOf('sendText').map(command => command.text)).toEqual([`${READ_ALOUD_PREFIX}文章已写入。`]);
  expect(h.actor.session.commandsOf('submitToolResult')).toHaveLength(0);
});

/** The task and system prompt of one scripted provider request. */
const sent = (request: unknown) => {
  const { messages } = request as { messages: { role: string; content: string | { text: string }[] }[] };
  const text = (role: string) => { const content = messages.find(message => message.role === role)!.content; return typeof content === 'string' ? content : content[0]!.text; };
  return { systemPrompt: text('system'), task: JSON.parse(text('user')) as Record<string, unknown> };
};

it('reads the document once before Pi starts and hands it over, so Pi needs no read request of its own', async () => {
  const { worker, requests } = scriptedWorker([write, done], { prefetch: true });
  const h = await setup(worker);
  await expect.poll(() => h.ended.mock.calls.length).toBe(1);
  expect(h.errors).toEqual([]);
  expect(h.calls.map(call => call.name)).toEqual(['read_document', 'insert_structured_article']);
  expect(requests).toHaveLength(2);
  expect(sent(requests[0]).task).toMatchObject({ userRequest: '请读取文档并写入一篇完整文章', document: { ok: true, revision: 7 } });
  expect(sent(requests[0]).systemPrompt).toContain('taken just before this task started');
  expect(h.text.join('')).toBe('文章已写入。');
  expect(h.voice).toEqual(['文章已写入。']);
});

it('also reads the planning context ahead, so Pi spends no request on get_context either', async () => {
  const withContext = [...tools, { name: 'get_context', description: 'Context', parameters: { type: 'object', properties: {} } }];
  const { worker, requests } = scriptedWorker([write, done], { prefetch: true });
  const h = await setup(worker, { tools: withContext });
  await expect.poll(() => h.ended.mock.calls.length).toBe(1);
  expect(h.errors).toEqual([]);
  expect(h.calls.map(call => call.name)).toEqual(['read_document', 'get_context', 'insert_structured_article']);
  expect(requests).toHaveLength(2);
  expect(sent(requests[0]).task).toMatchObject({ document: { ok: true, revision: 7 }, context: { ok: true, revision: 7 } });
  expect(sent(requests[0]).systemPrompt).toContain('Use it instead of calling get_context');

  // A denied context read leaves get_context to Pi and keeps the document.
  const denied = scriptedWorker([write, done], { prefetch: true });
  const g = await setup(denied.worker, { tools: withContext, beforeToolCall: name => name !== 'get_context' });
  await expect.poll(() => g.ended.mock.calls.length).toBe(1);
  expect(sent(denied.requests[0]).task).toHaveProperty('document');
  expect(sent(denied.requests[0]).task).not.toHaveProperty('context');
  expect(sent(denied.requests[0]).systemPrompt).not.toContain('instead of calling get_context');
});

it('leaves the document to Pi when the prefetch read is denied or the option is off', async () => {
  let reads = 0;
  const denied = scriptedWorker([read, write, done], { prefetch: true });
  const h = await setup(denied.worker, { beforeToolCall: name => name !== 'read_document' || ++reads > 1 });
  await expect.poll(() => h.ended.mock.calls.length).toBe(1);
  expect(h.errors).toEqual([]);
  expect(denied.requests).toHaveLength(3);
  expect(sent(denied.requests[0]).task).not.toHaveProperty('document');
  expect(sent(denied.requests[0]).systemPrompt).not.toContain('taken just before this task started');
  expect(h.calls.map(call => call.name)).toEqual(['read_document', 'insert_structured_article']);

  const off = scriptedWorker([read, write, done]);
  const g = await setup(off.worker);
  await expect.poll(() => g.ended.mock.calls.length).toBe(1);
  expect(off.requests).toHaveLength(3);
  expect(sent(off.requests[0]).task).not.toHaveProperty('document');
});

it('starts Pi from the final transcript at once and drops every reply Higgs starts on its own', async () => {
  const prompts: string[] = [];
  const worker: WorkerRunner = { run: async (request, context) => { prompts.push(request.prompt); context.emit({ type: 'start' }); context.emit({ type: 'text', delta: '好的' }); return '好的'; } };
  const h = await setup(worker, { text: null });
  const audio: string[] = []; h.session.on('audio', event => audio.push(event.responseId));
  h.actor.session.emit({ type: 'input.speech.start', atMs: 0 });
  h.actor.session.emit({ type: 'input.speech.end', atMs: 300 });
  // Boson replies to every utterance by itself; that reply must never be heard or decide anything.
  h.actor.session.emit({ type: 'response.start', responseId: 'boson-auto' });
  h.actor.session.emit({ type: 'output.audio', responseId: 'boson-auto', itemId: 'auto', chunk: { data: new Uint8Array(48), format: { encoding: 'pcm16', sampleRate: 24000, channels: 1 } } });
  h.actor.session.emit({ type: 'tool.call', responseId: 'boson-auto', callId: 'x', name: 'insert_structured_article', arguments: { expectedRevision: 7 } });
  h.actor.session.emit({ type: 'response.end', responseId: 'boson-auto', status: 'done', stopReason: 'tool_calls' });
  h.actor.session.emit({ type: 'input.transcript', itemId: 'utterance', text: '把标题改成蓝色', final: true });
  await expect.poll(() => h.ended.mock.calls.length).toBe(1);
  expect(prompts).toHaveLength(1);
  expect(JSON.parse(prompts[0]!)).toMatchObject({ userRequest: '把标题改成蓝色', requestSource: 'final-transcript' });
  expect(h.actor.session.commandsOf('cancel')).toHaveLength(1);
  expect(h.calls).toEqual([]);
  expect(audio).not.toContain('boson-auto');
  expect(h.voice).toEqual(['好的']);
  expect(h.errors).toEqual([]);
});

it('waits for the end of speech when the transcript arrives first', async () => {
  const run = vi.fn(async (_request: unknown, context: Parameters<WorkerRunner['run']>[1]) => { context.emit({ type: 'start' }); return '好'; });
  const h = await setup({ run }, { text: null });
  h.actor.session.emit({ type: 'input.speech.start', atMs: 0 });
  h.actor.session.emit({ type: 'input.transcript', itemId: 'early', text: '你好', final: true });
  expect(run).not.toHaveBeenCalled();
  h.actor.session.emit({ type: 'input.speech.end', atMs: 300 });
  await expect.poll(() => h.ended.mock.calls.length).toBe(1);
  expect(run).toHaveBeenCalledOnce();
});

it('ends the turn quietly for a blank transcript and reports a transcript that never comes', async () => {
  const run = vi.fn(async () => 'unused');
  const h = await setup({ run }, { text: null, transcriptTimeout: 20 });
  speakTo(h.actor, '   ');
  await expect.poll(() => h.ended.mock.calls.length).toBe(1);
  expect(h.errors).toEqual([]);
  h.actor.session.emit({ type: 'input.speech.start', atMs: 0 });
  h.actor.session.emit({ type: 'input.speech.end', atMs: 300 });
  await expect.poll(() => h.ended.mock.calls.length).toBe(2);
  expect(h.errors[0]).toContain('TRANSCRIPTION_TIMEOUT');
  expect(run).not.toHaveBeenCalled();
});

it('reports loud input the provider never hears as speech, and stays quiet for heard speech and low noise', async () => {
  vi.useFakeTimers();
  try {
    const actor = fakeModel();
    const session = await delegatedModel(actor, { run: vi.fn(async () => 'unused') }).connect({ tools });
    cleanup.push(() => session.close());
    const errors: string[] = [];
    session.on('error', event => errors.push(event.error.message));
    const format = { encoding: 'pcm16', sampleRate: 24000, channels: 1 } as const;
    // 100 ms of a square wave at the given amplitude.
    const chunk = (amplitude: number) => { const data = new Int16Array(2400); data.forEach((_, index) => { data[index] = index % 2 ? amplitude : -amplitude; }); return { data: new Uint8Array(data.buffer), format }; };
    for (let index = 0; index < 10; index++) session.sendAudio(chunk(200));
    await vi.advanceTimersByTimeAsync(3000);
    expect(errors).toEqual([]);
    actor.session.emit({ type: 'input.speech.start', atMs: 0 });
    for (let index = 0; index < 10; index++) session.sendAudio(chunk(5000));
    actor.session.emit({ type: 'input.speech.end', atMs: 1000 });
    actor.session.emit({ type: 'input.transcript', itemId: 'noise', text: '', final: true });
    await vi.advanceTimersByTimeAsync(3000);
    expect(errors).toEqual([]);
    for (let index = 0; index < 25; index++) session.sendAudio(chunk(5000));
    await vi.advanceTimersByTimeAsync(3000);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('SPEECH_NOT_DETECTED');
  } finally { vi.useRealTimers(); }
});

it('ignores a delayed transcript of an older utterance once the user has typed', async () => {
  const prompts: string[] = [];
  const h = await setup({ run: async (request, context) => { prompts.push(request.prompt); context.emit({ type: 'start' }); return '好'; } }, { text: '我现在需要一个表格' });
  h.actor.session.emit({ type: 'input.transcript', itemId: 'old-voice', text: '旧语音任务', final: true });
  await expect.poll(() => h.ended.mock.calls.length).toBe(1);
  expect(prompts).toHaveLength(1);
  expect(JSON.parse(prompts[0]!)).toMatchObject({ userRequest: '我现在需要一个表格', requestSource: 'typed' });
});

it('feeds a policy denial back to Pi without executing the client write', async () => {
  const { worker, requests } = scriptedWorker([read, write, [{ type: 'text', text: '写入被拒绝。' }]]);
  const h = await setup(worker, { beforeToolCall: name => name !== 'insert_structured_article' });
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

it('bounds Pi generation and reports failure without a success voice', async () => {
  const { worker } = scriptedWorker([read, read, done], { maxRequests: 1 });
  const h = await setup(worker);
  await expect.poll(() => h.errors.length).toBeGreaterThan(0);
  expect(h.errors[0]).toContain('WORKER_FAILED');
  expect(h.calls).toHaveLength(1);
  expect(h.voice).toEqual([]);
  expect(h.actor.session.commandsOf('respond')).toHaveLength(0);
});

it('cancels a run on Stop and drops its late tool call, text and completion', async () => {
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
  // Only Pi was running: there is no Higgs response to cancel.
  expect(h.actor.session.commandsOf('cancel')).toHaveLength(0);
  expect(h.actor.session.commandsOf('respond')).toHaveLength(0);
});

it('times out a hanging worker and ends the active turn', async () => {
  const h = await setup({ run: async () => new Promise(() => {}) }, { timeout: 20 });
  await expect.poll(() => h.errors.length).toBeGreaterThan(0);
  await expect.poll(() => h.ended.mock.calls.length).toBe(1);
  expect(h.calls).toEqual([]);
  expect(h.actor.session.commandsOf('respond')).toHaveLength(0);
});

it('keeps Higgs without tools or document instructions on context updates', async () => {
  const actor = speakerModel();
  const session = await delegatedModel(actor, { run: async () => 'ok' }).connect({ tools });
  cleanup.push(() => session.close());
  await session.update({ tools, instructions: 'worker only' });
  expect(actor.session.commandsOf('update')[0]!.config.tools).toEqual([]);
  expect(actor.session.commandsOf('update')[0]!.config.instructions).not.toContain('worker only');
});

it('aborts real Pi during a client tool and starts a clean next task without replaying the write', async () => {
  const { worker, requests } = scriptedWorker([read, [{ type: 'text', text: '改为回答。' }]]);
  const h = await setup(worker, { finishTools: false });
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
});

it('pads a paused utterance with silence until the provider ends it, then starts Pi from its transcript', async () => {
  const actor = fakeModel();
  const worker = { run: vi.fn(async (_request, context) => { context.emit({ type: 'start' }); return '完成'; }) } satisfies WorkerRunner;
  const session = await delegatedModel(actor, worker, 1000, 2000).connect({ tools });
  cleanup.push(() => session.close());
  const progress: string[] = [];
  session.on('output.text', event => progress.push(event.delta));
  actor.session.emit({ type: 'input.speech.start', atMs: 0 });
  session.sendAudio({ data: new Uint8Array([1, 2]), format: { encoding: 'pcm16', sampleRate: 24000, channels: 1 } });
  expect(finishWorkerSpeech(session, 'pause-1')).toBe(true);
  finishWorkerSpeech(session, 'pause-1');
  finishWorkerSpeech(session, 'pause-2');
  await expect.poll(() => actor.session.commandsOf('sendAudio').length).toBeGreaterThan(1);
  expect(actor.session.commandsOf('commitAudio')).toHaveLength(0);
  expect(actor.session.commandsOf('connect')[0]!.config.turnDetection).toBe('server');
  actor.session.emit({ type: 'input.speech.end', atMs: 300 });
  actor.session.emit({ type: 'input.transcript', itemId: 'utterance', text: '写文章', final: true });
  expect(worker.run).toHaveBeenCalledTimes(1);
  expect(progress).toContain(WORKER_STARTED_TEXT);
  expect(actor.session.commandsOf('respond')).toHaveLength(0);
});

it('does not pad, recommit or restart Pi when the user pauses after work has begun', async () => {
  let aborted = false;
  let started = false;
  const actor = speakerModel();
  const session = await delegatedModel(actor, hanging(context => { started = true; context.signal.addEventListener('abort', () => { aborted = true; }); }), 1000).connect({ tools });
  cleanup.push(() => session.close());
  session.sendText('写文章'); session.respond();
  await expect.poll(() => started).toBe(true);
  finishWorkerSpeech(session, 'pause-during-worker');
  expect(actor.session.commandsOf('commitAudio')).toHaveLength(0);
  expect(actor.session.commandsOf('sendAudio')).toHaveLength(0);
  expect(actor.session.commandsOf('respond')).toHaveLength(0);
  expect(aborted).toBe(false);
});

it.each(['response_not_active', 'response_cancel_not_active', 'some_recoverable_voice_error'])('keeps Pi working through a recoverable %s voice error', async providerCode => {
  let release!: () => void;
  let aborted = false;
  const worker: WorkerRunner = { run: async (_request, context) => {
    context.emit({ type: 'start' });
    context.signal.addEventListener('abort', () => { aborted = true; });
    await new Promise<void>(resolve => { release = resolve; });
    await context.execute('write-after-race', 'insert_structured_article', { expectedRevision: 7 });
    context.emit({ type: 'turn-end', usage: { inputTokens: 1, outputTokens: 1 } });
    context.emit({ type: 'start' }); context.emit({ type: 'text', delta: '写入成功' });
    return '写入成功';
  } };
  const h = await setup(worker);
  await expect.poll(() => release !== undefined).toBe(true);
  h.actor.session.emit({ type: 'error', error: new RealtimeError('invalid_request', 'No active response to cancel.', { provider: 'boson', providerCode }), recoverable: true });
  release();
  await expect.poll(() => h.ended.mock.calls.length).toBe(1);
  expect(aborted).toBe(false);
  expect(h.errors).toEqual([]);
  expect(h.calls.map(call => call.name)).toEqual(['insert_structured_article']);
  expect(h.text.join('')).toBe('写入成功');
});

it('ends the task on a fatal voice error and reports it', async () => {
  let aborted = false;
  let started = false;
  const h = await setup(hanging(context => { started = true; context.signal.addEventListener('abort', () => { aborted = true; }); }));
  await expect.poll(() => started).toBe(true);
  h.actor.session.emit({ type: 'error', error: new RealtimeError('auth', 'Authentication failed'), recoverable: false });
  await expect.poll(() => aborted).toBe(true);
  expect(h.errors).toContain('Authentication failed');
});

it('keeps Pi running when the user speaks after it has written, and hands it the words as an update', async () => {
  let release: (() => void) | undefined;
  let aborted = false;
  const updates: string[] = [];
  const worker: WorkerRunner = { run: async (_request, context) => {
    context.emit({ type: 'start' });
    context.signal.addEventListener('abort', () => { aborted = true; });
    context.onSteer?.(message => updates.push(message));
    await context.execute('write', 'insert_structured_article', { expectedRevision: 7 });
    await new Promise<void>(resolve => { release = resolve; });
    context.emit({ type: 'turn-end', usage: { inputTokens: 1, outputTokens: 1 } });
    context.emit({ type: 'start' }); context.emit({ type: 'text', delta: '已删除第二部分' }); return '已删除第二部分';
  } };
  const h = await setup(worker);
  await expect.poll(() => release !== undefined).toBe(true);
  const transcripts: string[] = []; h.session.on('transcript', event => { if (event.role === 'user') transcripts.push(event.text); });
  h.actor.session.emit({ type: 'input.speech.start', atMs: 10 });
  h.actor.session.emit({ type: 'input.speech.end', atMs: 20 });
  // Boson starts its own reply to the utterance; it must not reach the user or run a second task.
  h.actor.session.emit({ type: 'response.start', responseId: 'auto-reply' });
  h.actor.session.emit({ type: 'response.end', responseId: 'auto-reply', status: 'done', stopReason: 'completed' });
  h.actor.session.emit({ type: 'input.transcript', itemId: 'repeat', text: ' Delete the second part. ', final: true });
  expect(aborted).toBe(false);
  expect(updates).toEqual([JSON.stringify({ userUpdate: 'Delete the second part.' })]);
  expect(h.notices).toEqual(['added']);
  expect(transcripts).toContain(' Delete the second part. ');
  expect(h.actor.session.commandsOf('cancel')).toHaveLength(1);
  release!();
  await expect.poll(() => h.ended.mock.calls.length).toBe(1);
  expect(h.text.join('')).toBe('已删除第二部分');
  expect(h.calls.map(call => call.name)).toEqual(['insert_structured_article']);
  expect(h.errors).toEqual([]);
});

it('drops silence or noise heard mid-task without touching the running task', async () => {
  let aborted = false;
  let started = false;
  const updates: string[] = [];
  const h = await setup(hanging(context => { started = true; context.signal.addEventListener('abort', () => { aborted = true; }); context.onSteer?.(message => updates.push(message)); }));
  await expect.poll(() => started).toBe(true);
  speakTo(h.actor, '  ', 'noise');
  expect(updates).toEqual([]);
  expect(aborted).toBe(false);
  // Stop still cancels at once.
  h.session.interrupt('keyboard');
  expect(aborted).toBe(true);
});

it('stops the running task at once when the user says stop, says so, and starts nothing else', async () => {
  let runs = 0;
  let aborted = false;
  const judge = { judge: vi.fn(async () => 'continue' as const) };
  const worker: WorkerRunner = { run: async (_request, context) => {
    runs++; context.emit({ type: 'start' });
    context.signal.addEventListener('abort', () => { aborted = true; });
    return new Promise(() => {});
  } };
  const h = await setup(worker, { judge });
  await expect.poll(() => runs).toBe(1);
  const interrupted = vi.fn(); h.session.on('interrupted', interrupted);
  speakTo(h.actor, '停！', 'stop');
  await expect.poll(() => aborted).toBe(true);
  expect(judge.judge).not.toHaveBeenCalled();
  expect(interrupted).toHaveBeenCalled();
  await expect.poll(() => h.voice).toEqual(['好的，已停止。']);
  expect(h.notices).toEqual(['stopped']);
  expect(runs).toBe(1);
  expect(h.errors).toEqual([]);
});

it('replaces the running task when the words ask to redo it or for a new task', async () => {
  const prompts: string[] = [];
  let oldAborted = false;
  const worker: WorkerRunner = { run: async (request, context) => {
    prompts.push(request.prompt); context.emit({ type: 'start' });
    if (prompts.length === 1) { context.signal.addEventListener('abort', () => { oldAborted = true; }); return new Promise(() => {}); }
    context.emit({ type: 'text', delta: '新文章已写入' }); return '新文章已写入';
  } };
  const judge = { judge: vi.fn(async () => 'replace' as const) };
  const h = await setup(worker, { judge });
  await expect.poll(() => prompts.length).toBe(1);
  speakTo(h.actor, '重写，改成写关于火星的', 'redo');
  await expect.poll(() => h.text.join('')).toBe('新文章已写入');
  expect(oldAborted).toBe(true);
  expect(judge.judge).toHaveBeenCalledWith('请读取文档并写入一篇完整文章', '重写，改成写关于火星的', expect.any(AbortSignal));
  expect(prompts).toHaveLength(2);
  expect(JSON.parse(prompts[1]!)).toMatchObject({ userRequest: '重写，改成写关于火星的', requestSource: 'final-transcript' });
  expect(h.notices).toEqual(['replaced']);
  expect(h.errors).toEqual([]);
});

it('restarts a task that has written nothing yet with a continuation, so the words apply at once', async () => {
  const prompts: string[] = [];
  let oldAborted = false;
  const worker: WorkerRunner = { run: async (request, context) => {
    prompts.push(request.prompt); context.emit({ type: 'start' });
    if (prompts.length === 1) { context.signal.addEventListener('abort', () => { oldAborted = true; }); return new Promise(() => {}); }
    context.emit({ type: 'text', delta: '已写入' }); return '已写入';
  } };
  const h = await setup(worker, { judge: { judge: async () => 'continue' } });
  await expect.poll(() => prompts.length).toBe(1);
  h.actor.session.emit({ type: 'input.speech.start', atMs: 10 });
  h.actor.session.emit({ type: 'input.transcript', itemId: 'detail', text: '再加一段结论', final: true });
  await expect.poll(() => h.text.join('')).toBe('已写入');
  expect(oldAborted).toBe(true);
  expect(JSON.parse(prompts[1]!)).toMatchObject({ userRequest: '请读取文档并写入一篇完整文章', userUpdates: ['再加一段结论'] });
  expect(h.notices).toEqual(['restarted']);
  expect(h.errors).toEqual([]);
});
it('restarts on a new request when the judge cannot answer', async () => {
  const prompts: string[] = [];
  const worker: WorkerRunner = { run: async (request, context) => {
    prompts.push(request.prompt); context.emit({ type: 'start' });
    if (prompts.length === 1) { await context.execute('write', 'insert_structured_article', { expectedRevision: 7 }); return new Promise(() => {}); }
    context.emit({ type: 'text', delta: '好' }); return '好';
  } };
  const h = await setup(worker, { judge: { judge: async () => { throw new Error('down'); } } });
  await expect.poll(() => h.calls.length).toBe(1);
  speakTo(h.actor, '把标题改成蓝色', 'new');
  await expect.poll(() => prompts.length).toBe(2);
  expect(JSON.parse(prompts[1]!)).toMatchObject({ userRequest: '把标题改成蓝色' });
  expect(h.notices).toEqual(['replaced']);
});

it('lets real Pi read a mid-task update before its next model request', async () => {
  let steer!: (message: string) => void;
  const { worker, requests } = scriptedWorker([read, done]);
  const result = worker.run({ instructions: 'Work.', prompt: '{"userRequest":"删除第二部分"}', tools }, {
    signal: new AbortController().signal, emit: () => {},
    onSteer: listener => { steer = listener; return () => {}; },
    execute: async () => { steer(JSON.stringify({ userUpdate: '是 The Problem 那一节' })); return { ok: true }; },
  });
  await expect(result).resolves.toBe('文章已写入。');
  expect(requests).toHaveLength(2);
  expect(JSON.stringify(requests[1])).toContain('The Problem');
});

it('treats the user talking over the spoken reply as an interruption, not a failure', async () => {
  const h = await setup({ async run(_request, context) { context.emit({ type: 'start' }); context.emit({ type: 'text', delta: '文章已写入' }); return '文章已写入'; } }, { actor: speakerModel('cancelled') });
  await expect.poll(() => h.ended.mock.calls.length).toBe(1);
  expect(h.errors).toEqual([]);
});

it('labels a voice-only failure after a successful write with its reason and never replays the write', async () => {
  let runs = 0;
  const worker: WorkerRunner = { async run(_request, context) {
    runs++; context.emit({ type: 'start' });
    await context.execute('write', 'insert_structured_article', { expectedRevision: 7 });
    context.emit({ type: 'turn-end', usage: { inputTokens: 1, outputTokens: 1 } });
    context.emit({ type: 'start' }); context.emit({ type: 'text', delta: '文档已修改' }); return '文档已修改';
  } };
  const h = await setup(worker, { actor: speakerModel('failed') });
  await expect.poll(() => h.ended.mock.calls.length).toBe(1);
  expect(h.errors[0]).toContain('VOICE_REPLY_FAILED');
  expect(h.errors[0]).toContain('文档已有成功修改');
  expect(h.errors[0]).toContain('[status=failed, stopReason=failed]');
  expect(h.calls).toHaveLength(1); expect(runs).toBe(1);
});

it('reports already completed edits if Pi fails after applying a write, without retrying the task', async () => {
  let runs = 0;
  const worker: WorkerRunner = { run: async (_request, context) => {
    runs++; context.emit({ type: 'start' });
    await context.execute('write', 'insert_structured_article', { expectedRevision: 7 });
    throw new Error('private provider error details');
  } };
  const h = await setup(worker);
  await expect.poll(() => h.ended.mock.calls.length).toBe(1);
  expect(h.errors[0]).toContain('WORKER_FAILED_AFTER_WRITE');
  expect(h.errors[0]).not.toContain('private provider error details');
  expect(runs).toBe(1);
  expect(h.voice).toEqual([]);
});

it('carries an edit held for confirmation into the next task with its exact arguments', async () => {
  const prompts: string[] = [];
  const replace = { expectedSessionId: 's', expectedRevision: 3, operations: [{ type: 'text.findReplace', find: '足球鞋', replace: 'football boots' }] };
  let confirmed = false;
  const worker: WorkerRunner = { async run(request, context) {
    prompts.push(request.prompt); context.emit({ type: 'start' });
    if (prompts.length === 1) {
      await context.execute('replace', 'insert_structured_article', replace);
      context.emit({ type: 'turn-end', usage: { inputTokens: 1, outputTokens: 1 } });
      context.emit({ type: 'start' }); context.emit({ type: 'text', delta: '要全部替换吗？' }); return '要全部替换吗？';
    }
    context.emit({ type: 'text', delta: '好的' }); return '好的';
  } };
  // The first attempt is held for confirmation, exactly as the governance policy answers it.
  const h = await setup(worker, { beforeToolCall: () => confirmed ? true : HIGH_RISK_CONFIRMATION_MESSAGE, text: '把足球鞋换成英文' });
  await expect.poll(() => h.ended.mock.calls.length).toBe(1);
  confirmed = true;
  h.session.sendText('可以，确认');
  await expect.poll(() => prompts.length).toBe(2);
  const previous = JSON.parse(prompts[1]!).previousTasks as { awaitingConfirmation?: unknown }[];
  expect(previous.at(-1)).toMatchObject({ request: '把足球鞋换成英文', reply: '要全部替换吗？', awaitingConfirmation: { tool: 'insert_structured_article', arguments: replace } });
});

it('replays a confirmed edit against the revision this task read, not the one it was held with', async () => {
  const held = { expectedSessionId: 's', expectedRevision: 3, operations: [{ type: 'block.delete' }] };
  const other = { expectedSessionId: 's', expectedRevision: 3, operations: [{ type: 'text.style' }] };
  let runs = 0;
  let confirmed = false;
  const worker: WorkerRunner = { async run(_request, context) {
    runs++; context.emit({ type: 'start' });
    if (runs === 1) {
      await context.execute('held', 'insert_structured_article', held);
      context.emit({ type: 'turn-end', usage: { inputTokens: 1, outputTokens: 1 } });
      context.emit({ type: 'start' }); context.emit({ type: 'text', delta: '要删除吗？' }); return '要删除吗？';
    }
    // Pi rereads (the test client reports revision 7) and copies the held call verbatim, old revision included.
    await context.execute('read', 'read_document', {});
    await context.execute('replay', 'insert_structured_article', held);
    await context.execute('unrelated', 'insert_structured_article', other);
    context.emit({ type: 'text', delta: '已删除' }); return '已删除';
  } };
  const h = await setup(worker, { beforeToolCall: () => confirmed ? true : HIGH_RISK_CONFIRMATION_MESSAGE, text: '删掉这一节' });
  await expect.poll(() => h.ended.mock.calls.length).toBe(1);
  confirmed = true;
  h.session.sendText('对，确认');
  await expect.poll(() => h.calls.length).toBe(3);
  expect(h.calls[1]).toMatchObject({ name: 'insert_structured_article', args: { ...held, expectedRevision: 7 } });
  // Only the held call is refreshed; any other edit keeps the precondition Pi gave it.
  expect(h.calls[2]).toMatchObject({ args: other });
});

it('does not carry an ordinary rejection forward as awaiting confirmation', async () => {
  const prompts: string[] = [];
  const worker: WorkerRunner = { async run(request, context) {
    prompts.push(request.prompt); context.emit({ type: 'start' });
    if (prompts.length === 1) { await context.execute('w', 'insert_structured_article', { expectedRevision: 1 }); context.emit({ type: 'turn-end', usage: { inputTokens: 1, outputTokens: 1 } }); context.emit({ type: 'start' }); }
    context.emit({ type: 'text', delta: '好' }); return '好';
  } };
  const h = await setup(worker, { beforeToolCall: () => false });
  await expect.poll(() => h.ended.mock.calls.length).toBe(1);
  h.session.sendText('下一件事');
  await expect.poll(() => prompts.length).toBe(2);
  expect(JSON.parse(prompts[1]!).previousTasks.at(-1)).not.toHaveProperty('awaitingConfirmation');
});
