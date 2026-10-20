import { cascade, type TextPart } from '@vrealtime/cascade';
import type { RealtimeEvent } from '@vrealtime/core';
import { describe, expect, it } from 'vitest';
import { claudeText, createModelRegistry } from '../src';
import { toMessages } from '../src/providers/claude-text';

type Block = Record<string, unknown> & { type: string };

/** A double for `client.beta.messages.stream`: streams text deltas, then resolves the final message. */
function fakeClaude(replies: { content: Block[]; stop_reason?: string }[]) {
  const requests: Record<string, unknown>[] = [];
  const client = {
    beta: {
      messages: {
        stream(params: Record<string, unknown>) {
          requests.push(structuredClone(params));
          const reply = replies.shift() ?? { content: [{ type: 'text', text: 'ok' }] };
          const message = { content: reply.content, stop_reason: reply.stop_reason ?? 'end_turn', usage: { input_tokens: 11, output_tokens: 7 } };
          return {
            async *[Symbol.asyncIterator]() {
              for (const [index, block] of reply.content.entries()) {
                if (block.type === 'text') yield { type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } };
              }
            },
            finalMessage: async () => message,
          };
        },
      },
    },
  };
  return { client: client as never, requests };
}

async function collect(parts: AsyncIterable<TextPart>): Promise<TextPart[]> {
  const out: TextPart[] = [];
  for await (const part of parts) out.push(part);
  return out;
}

const signal = new AbortController().signal;
const tools = [{ name: 'read_document', description: 'Read', parameters: { type: 'object', properties: {} } }];

describe('claudeText', () => {
  it('asks Opus 5.5 with low effort, refusal fallback and drop-on-mismatch thinking, and maps tools', async () => {
    const { client, requests } = fakeClaude([{ content: [{ type: 'thinking', thinking: '', signature: 's1' }, { type: 'text', text: 'Reading.' }, { type: 'tool_use', id: 'toolu_1', name: 'read_document', input: {} }], stop_reason: 'tool_use' }]);
    const parts = await collect(claudeText({ apiKey: 'k', client }).stream({ instructions: 'Be brief.', messages: [{ role: 'user', content: 'read it' }], tools }, { signal }));
    expect(parts).toEqual([
      { type: 'text', delta: 'Reading.' },
      { type: 'tool-call', callId: 'toolu_1', name: 'read_document', arguments: {} },
      { type: 'finish', usage: { inputTokens: 11, outputTokens: 7 } },
    ]);
    expect(requests[0]).toMatchObject({
      model: 'claude-opus-5-5', system: 'Be brief.', fallbacks: 'default',
      betas: ['thinking-binding-controls-2026-08-01', 'server-side-fallback-2026-07-01'],
      thinking: { type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' } },
      output_config: { effort: 'low' },
      tools: [{ name: 'read_document', description: 'Read', input_schema: { type: 'object', properties: {} } }],
      tool_choice: { type: 'auto' },
      messages: [{ role: 'user', content: [{ type: 'text', text: 'read it' }] }],
    });
  });

  it('replays a turn exactly as Claude produced it, thinking included, even after the cascade cut its text', async () => {
    const { client, requests } = fakeClaude([
      { content: [{ type: 'thinking', thinking: '', signature: 's1' }, { type: 'text', text: 'Reading it now.' }, { type: 'tool_use', id: 'toolu_1', name: 'read_document', input: {} }], stop_reason: 'tool_use' },
      { content: [{ type: 'text', text: 'Done.' }] },
    ]);
    const llm = claudeText({ apiKey: 'k', client });
    await collect(llm.stream({ messages: [{ role: 'user', content: 'read it' }], tools }, { signal }));
    await collect(llm.stream({ messages: [
      { role: 'user', content: 'read it' },
      { role: 'assistant', content: 'Reading', toolCalls: [{ callId: 'toolu_1', name: 'read_document', arguments: {} }] },
      { role: 'tool', callId: 'toolu_1', name: 'read_document', output: { ok: true } },
    ], tools }, { signal }));
    expect((requests[1] as { messages: unknown }).messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'read it' }] },
      { role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: 's1' }, { type: 'text', text: 'Reading it now.' }, { type: 'tool_use', id: 'toolu_1', name: 'read_document', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '{"ok":true}' }] },
    ]);
  });

  it('after a mid-output fallback runs only the fallback model’s calls and says something when everything refused', async () => {
    const { client } = fakeClaude([
      { content: [{ type: 'text', text: 'Sure, ' }, { type: 'tool_use', id: 'toolu_x', name: 'read_document', input: {} }, { type: 'fallback' }, { type: 'tool_use', id: 'toolu_2', name: 'read_document', input: {} }], stop_reason: 'tool_use' },
      { content: [], stop_reason: 'refusal' },
    ]);
    const llm = claudeText({ apiKey: 'k', client, model: 'claude-haiku-5-5' });
    const calls = (await collect(llm.stream({ messages: [{ role: 'user', content: 'x' }], tools }, { signal }))).filter((part) => part.type === 'tool-call');
    expect(calls).toEqual([{ type: 'tool-call', callId: 'toolu_2', name: 'read_document', arguments: {} }]);
    expect(await collect(llm.stream({ messages: [{ role: 'user', content: 'y' }], tools: [] }, { signal }))).toContainEqual({ type: 'text', delta: 'Sorry, I can’t help with that.' });
  });

  it('sends no refusal fallback for models that do not take it', async () => {
    const { client, requests } = fakeClaude([]);
    await collect(claudeText({ apiKey: 'k', client, model: 'claude-haiku-5-5' }).stream({ messages: [{ role: 'user', content: 'hi' }], tools: [], toolChoice: 'none' }, { signal }));
    expect(requests[0]).not.toHaveProperty('fallbacks');
    expect(requests[0]).not.toHaveProperty('tools');
    expect(requests[0]).toMatchObject({ model: 'claude-haiku-5-5', betas: ['thinking-binding-controls-2026-08-01'] });
  });
});

describe('toMessages', () => {
  it('returns parallel tool results in one user message', () => {
    expect(toMessages([
      { role: 'user', content: 'go' },
      { role: 'assistant', content: '', toolCalls: [{ callId: 'a', name: 't', arguments: { x: 1 } }, { callId: 'b', name: 't', arguments: {} }] },
      { role: 'tool', callId: 'a', name: 't', output: 'one' },
      { role: 'tool', callId: 'b', name: 't', output: { two: 2 } },
    ])).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'go' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 't', input: { x: 1 } }, { type: 'tool_use', id: 'b', name: 't', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'one' }, { type: 'tool_result', tool_use_id: 'b', content: '{"two":2}' }] },
    ]);
  });
});

describe('cascade with Claude', () => {
  it('turns speech into a Claude tool call and its spoken reply, with fake speech models', async () => {
    const { client } = fakeClaude([{ content: [{ type: 'text', text: 'Reading the document.' }, { type: 'tool_use', id: 'toolu_1', name: 'read_document', input: {} }], stop_reason: 'tool_use' }]);
    const spoken: string[] = [];
    const model = cascade({
      stt: { transcribe: async () => 'read the document' },
      llm: claudeText({ apiKey: 'k', client }),
      tts: { format: { encoding: 'pcm16', sampleRate: 24000, channels: 1 }, async *synthesize(text) { spoken.push(text); yield new Uint8Array(480); } },
    });
    const session = await model.connect({ tools });
    const events: RealtimeEvent[] = [];
    const done = new Promise<void>((resolve) => session.on('response.end', () => resolve()));
    for (const type of ['input.transcript', 'tool.call', 'output.transcript'] as const) session.on(type, (event) => events.push(event));
    session.sendAudio({ data: new Uint8Array(3200), format: { encoding: 'pcm16', sampleRate: 16000, channels: 1 }, durationMs: 100 });
    session.commitAudio();
    session.respond();
    await done;
    await session.close();
    expect(events).toContainEqual(expect.objectContaining({ type: 'input.transcript', text: 'read the document', final: true }));
    expect(events).toContainEqual(expect.objectContaining({ type: 'tool.call', name: 'read_document', arguments: {} }));
    expect(spoken.join(' ')).toContain('Reading the document.');
  });
});

describe('createModelRegistry', () => {
  it('registers cascade-claude only with both the Anthropic and the OpenAI speech keys', () => {
    expect(createModelRegistry({ anthropicApiKey: 'a', openaiApiKey: 'o' }).has('cascade-claude')).toBe(true);
    expect(createModelRegistry({ anthropicApiKey: 'a' }).has('cascade-claude')).toBe(false);
    expect(createModelRegistry({ openaiApiKey: 'o' }).has('cascade-claude')).toBe(false);
  });
});
