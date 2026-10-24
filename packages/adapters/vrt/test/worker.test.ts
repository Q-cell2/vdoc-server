import { appError, type ToolCallInput } from '@vdoc-server/application';
import { err, ok, type ToolDecision } from '@vdoc-server/domain';
import { describe, expect, it } from 'vitest';
import { ClaudeWorker, type WorkerHandlers } from '../src';

type Block = Record<string, unknown> & { type: string };
type Reply = { content: Block[]; stop_reason?: string } | Error;

/** A double for `client.beta.messages.stream(...).finalMessage()`. */
function fakeClaude(replies: Reply[]) {
  const requests: Record<string, unknown>[] = [];
  const client = {
    beta: {
      messages: {
        stream(params: Record<string, unknown>) {
          requests.push(structuredClone(params));
          const reply = replies.shift() ?? { content: [{ type: 'text', text: 'Done.' }] };
          return {
            finalMessage: async () => {
              if (reply instanceof Error) throw reply;
              return { content: reply.content, stop_reason: reply.stop_reason ?? 'end_turn' };
            },
          };
        },
      },
    },
  };
  return { client: client as never, requests };
}

function fakeHandlers(review: (call: ToolCallInput) => ToolDecision = () => ({ kind: 'allow', risk: 'low' })) {
  const reviewed: ToolCallInput[] = [];
  const recorded: unknown[] = [];
  const handlers = {
    authorizeDelegatedTask: {
      execute: async (input: { callId: string; arguments: unknown }) => input.callId.startsWith('call_')
        ? ok({ sessionId: 'vs_1', turnId: `turn-${input.callId}`, request: (input.arguments as { request: string }).request })
        : err(appError('FORBIDDEN', 'No allowed hand-off matches this task.')),
    },
    getVoiceSession: { execute: async () => ok({ sessionId: 'vs_1', status: 'active' }) },
    reviewToolCall: { execute: async (call: ToolCallInput) => { reviewed.push(call); return review(call); } },
    recordToolResult: { execute: async (result: unknown) => { recorded.push(result); } },
  } as unknown as WorkerHandlers;
  return { handlers, reviewed, recorded };
}

const tools = [{ name: 'get_context', description: 'Context', parameters: { type: 'object', properties: {} } }];
const credentials = { bearer: 'k' };
const start = (callId = 'call_1', request = 'add ten Ultraman names') => ({ credentials, documentId: 'doc-1', sessionId: 'vs_1', callId, arguments: { request }, tools });
const submit = (taskId: string, results: { callId: string; ok: boolean; output: unknown }[]) => ({ credentials, documentId: 'doc-1', sessionId: 'vs_1', taskId, results });
let n = 0;
const ids = () => `task_${++n}`;

describe('ClaudeWorker', () => {
  it('searches and plans with Claude, hands reviewed calls to the client, and replies when done', async () => {
    const { client, requests } = fakeClaude([
      {
        content: [
          { type: 'thinking', thinking: '', signature: 's' },
          { type: 'server_tool_use', id: 'srv_1', name: 'web_search', input: { query: 'Ultraman' } },
          { type: 'web_search_tool_result', tool_use_id: 'srv_1', content: [] },
          { type: 'tool_use', id: 'toolu_1', name: 'get_context', input: {} },
        ],
        stop_reason: 'tool_use',
      },
      { content: [{ type: 'text', text: 'Added ten names.' }] },
    ]);
    const { handlers, reviewed, recorded } = fakeHandlers();
    const worker = new ClaudeWorker({ apiKey: 'k', client, handlers, instructions: 'Work.', ids });

    const first = await worker.start(start());
    expect(first).toEqual({ ok: true, value: { taskId: expect.any(String), status: 'calls', calls: [{ callId: 'toolu_1', name: 'get_context', arguments: {} }] } });
    expect(reviewed).toEqual([{ sessionId: 'vs_1', callId: 'toolu_1', name: 'get_context', arguments: {}, turnId: 'turn-call_1' }]);
    expect(requests[0]).toMatchObject({
      model: 'claude-opus-5-5', system: 'Work.', fallbacks: 'default', output_config: { effort: 'medium' },
      thinking: { type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' } },
      tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 5 }, { name: 'get_context', input_schema: { type: 'object', properties: {} } }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'add ten Ultraman names' }] }],
    });

    if (!first.ok || first.value.status !== 'calls') throw new Error('expected calls');
    const done = await worker.submit(submit(first.value.taskId, [{ callId: 'toolu_1', ok: true, output: { ok: true, revision: 3 } }]));
    expect(done).toEqual({ ok: true, value: { taskId: first.value.taskId, status: 'done', reply: 'Added ten names.' } });
    const messages = requests[1]!['messages'] as { role: string; content: Block[] }[];
    // The whole assistant turn, search and thinking included, is replayed before the result.
    expect(messages[1]!.content.map((block) => block.type)).toEqual(['thinking', 'server_tool_use', 'web_search_tool_result', 'tool_use']);
    expect(messages[2]).toEqual({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '{"ok":true,"revision":3}' }] });
    expect(recorded).toEqual([{ sessionId: 'vs_1', callId: 'toolu_1', name: 'get_context', turnId: 'turn-call_1', ok: true }]);
    expect((await worker.submit(submit(first.value.taskId, []))).ok).toBe(false);
  });

  it('answers refused calls itself, so a confirmation question reaches the speaker without a client round trip', async () => {
    const { client, requests } = fakeClaude([
      { content: [{ type: 'tool_use', id: 'toolu_1', name: 'apply_document_operations', input: { operations: [{ type: 'block.delete' }] } }], stop_reason: 'tool_use' },
      { content: [{ type: 'text', text: 'Delete that paragraph?' }] },
    ]);
    const { handlers } = fakeHandlers(() => ({ kind: 'confirm', risk: 'high', message: 'Ask the user first.' }));
    const worker = new ClaudeWorker({ apiKey: 'k', client, handlers, instructions: 'Work.', ids });
    expect(await worker.start(start())).toMatchObject({ ok: true, value: { status: 'done', reply: 'Delete that paragraph?' } });
    const messages = requests[1]!['messages'] as { content: Block[] }[];
    expect(messages[2]!.content).toEqual([{ type: 'tool_result', tool_use_id: 'toolu_1', is_error: true, content: JSON.stringify({ ok: false, code: 'CONFIRMATION_REQUIRED', message: 'Ask the user first.' }) }]);
  });

  it('keeps one conversation per session, closing calls a new request makes moot', async () => {
    const { client, requests } = fakeClaude([
      { content: [{ type: 'tool_use', id: 'toolu_1', name: 'get_context', input: {} }], stop_reason: 'tool_use' },
      { content: [{ type: 'text', text: 'OK.' }] },
    ]);
    const { handlers } = fakeHandlers();
    const worker = new ClaudeWorker({ apiKey: 'k', client, handlers, instructions: 'Work.', ids });
    const first = await worker.start(start('call_1', 'add a table'));
    await worker.start(start('call_2', 'never mind, add a list'));
    const messages = requests[1]!['messages'] as { role: string; content: Block[] }[];
    expect(messages.map((message) => message.role)).toEqual(['user', 'assistant', 'user']);
    expect(messages[2]!.content).toEqual([
      { type: 'tool_result', tool_use_id: 'toolu_1', is_error: true, content: expect.stringContaining('SUPERSEDED') },
      { type: 'text', text: 'never mind, add a list' },
    ]);
    if (!first.ok) throw new Error('expected a task');
    expect(await worker.submit(submit(first.value.taskId, []))).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
  });

  it('resumes paused server-side searches and turns API failures into a spoken apology', async () => {
    const { client, requests } = fakeClaude([
      { content: [{ type: 'server_tool_use', id: 'srv_1', name: 'web_search', input: { query: 'q' } }], stop_reason: 'pause_turn' },
      { content: [{ type: 'text', text: 'Found it.' }] },
      new Error('overloaded'),
    ]);
    const { handlers } = fakeHandlers();
    const worker = new ClaudeWorker({ apiKey: 'k', client, handlers, instructions: 'Work.', ids });
    expect(await worker.start(start())).toMatchObject({ ok: true, value: { status: 'done', reply: 'Found it.' } });
    expect(requests).toHaveLength(2);
    expect(await worker.start(start('call_2'))).toMatchObject({ ok: true, value: { status: 'done', reply: 'Sorry, the assistant could not finish that.' } });
  });

  it('uses the worker model the agent of the session asks for, falling back to the default', async () => {
    const { client, requests } = fakeClaude([]);
    const { handlers } = fakeHandlers();
    const authorize = handlers.authorizeDelegatedTask.execute;
    (handlers.authorizeDelegatedTask as { execute: unknown }).execute = async (input: Parameters<typeof authorize>[0]) => {
      const result = await authorize(input);
      return result.ok && input.sessionId === 'vs_fast' ? ok({ ...result.value, sessionId: 'vs_fast', workerModel: 'claude-sonnet-5-5' }) : result;
    };
    const worker = new ClaudeWorker({ apiKey: 'k', client, handlers, instructions: 'Work.', ids });
    await worker.start({ ...start(), sessionId: 'vs_fast' });
    await worker.start(start('call_2'));
    expect(requests.map((request) => request['model'])).toEqual(['claude-sonnet-5-5', 'claude-opus-5-5']);
    expect(requests[0]).toMatchObject({ fallbacks: 'default' });
  });

  it('starts nothing for an unauthorized hand-off or malformed tools', async () => {
    const { client, requests } = fakeClaude([]);
    const { handlers } = fakeHandlers();
    const worker = new ClaudeWorker({ apiKey: 'k', client, handlers, instructions: 'Work.', ids });
    expect(await worker.start(start('forged'))).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(await worker.start({ ...start(), tools: [{ name: 'bad name!', description: '', parameters: {} }] })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(requests).toEqual([]);
  });
});
