import { afterEach, expect, it, vi } from 'vitest';
import { cascade } from '@vrealtime/cascade';
import { connect } from '@vrealtime/client';
import { claudeText, ModelRegistry } from '@vdoc-server/adapter-vrt';
import { loadConfig } from '@vdoc-server/config';
import { createNodeServer } from '../src/create';
import { startNodeServer } from '../src/node-server';
import { createArticleStream } from '../src/playground/article-stream';
import { createTestDocument } from '../src/playground/document';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });

it.each(['complete', 'interrupt', 'failure', 'fallback'] as const)(
  'streams Claude arguments through real WebSocket before completion and handles %s without partial writes', async outcome => {
    const doc = createTestDocument(() => {});
    const preview = createArticleStream(() => doc.read(), () => {});
    const input = { expectedSessionId: doc.read().sessionId, expectedRevision: 0,
      destination: { kind: 'document_end' }, title: '流式文章', blocks: [{ kind: 'paragraph', text: '第一段正在实时生成。' }] };
    const raw = JSON.stringify(input);
    const split = raw.indexOf('第一段正在') + 3;
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    let requestCount = 0;
    let providerSignal: AbortSignal | undefined;
    const finalMessage = vi.fn();
    const upstream = { beta: { messages: {
      stream(_request: unknown, options: { signal: AbortSignal }) {
        providerSignal = options.signal;
        const first = ++requestCount === 1;
        const tool = { type: 'tool_use', id: 'write', name: 'insert_structured_article', input };
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: first ? '正在写作。' : '已写入。' } };
            if (!first) return;
            yield { type: 'content_block_start', index: 1, content_block: { ...tool, input: {} } };
            yield { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: raw.slice(0, split) } };
            await barrier;
            if (outcome === 'failure') throw new Error('Upstream stream failed');
            // Deliberately emit late events even after cancellation to test the adapter's guard.
            yield { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: raw.slice(split) } };
            yield { type: 'content_block_stop', index: 1 };
            if (outcome === 'fallback') {
              yield { type: 'content_block_start', index: 2, content_block: { type: 'fallback' } };
              yield { type: 'content_block_start', index: 3, content_block: { ...tool, id: 'replacement', input: {} } };
              yield { type: 'content_block_delta', index: 3, delta: { type: 'input_json_delta', partial_json: raw } };
            }
          },
          async finalMessage() {
            finalMessage();
            return { content: first
              ? outcome === 'fallback' ? [tool, { type: 'fallback' }, { ...tool, id: 'replacement' }] : [tool]
              : [{ type: 'text', text: '已写入。' }],
            stop_reason: first ? 'tool_use' : 'end_turn', usage: { input_tokens: 10, output_tokens: 20 } };
          },
        };
      },
    } } };
    const model = cascade({ llm: claudeText({ apiKey: 'test', client: upstream as never }) });
    const key = 'cascade-stream-test-client-key-at-least-24';
    const config = loadConfig({ VDOC_SERVER_ENV: 'test', VDOC_SERVER_MODEL: 'cascade-claude',
      ANTHROPIC_API_KEY: 'test', OPENAI_API_KEY: 'test', VDOC_SERVER_CLIENTS: `web:${key}`, VDOC_SERVER_LOG_LEVEL: 'error' });
    if (!config.ok) throw new Error(config.errors.join('; '));
    const app = await createNodeServer(config.value, { models: new ModelRegistry().register({ id: 'cascade-claude', create: () => model }) });
    const running = await startNodeServer(app, { port: 0 }); cleanups.push(running.close);
    const grant = await (await fetch(`http://127.0.0.1:${running.port}/v1/documents/cascade-doc/voice-sessions`,
      { method: 'POST', headers: { Authorization: `Bearer ${key}` } })).json() as { realtimePath: string; grant: { token: string } };
    const write = vi.fn(doc.tools.insert_structured_article!.run);
    const client = await connect(`ws://127.0.0.1:${running.port}${grant.realtimePath}`, {
      auth: grant.grant.token, reconnect: false, audio: { input: false, output: false },
      tools: { ...doc.tools, insert_structured_article: { ...doc.tools.insert_structured_article!, run: write } },
    });
    cleanups.push(() => client.close());
    const text: string[] = [];
    const errors: string[] = [];
    client.on('text', event => text.push(event.delta));
    client.on('error', event => errors.push(event.message));
    client.on('tool.stream', event => preview.receive(event));
    client.on('tool.result', event => preview.finish(event.callId, event.result.ok));
    client.sendText('写一篇文章');
    try {
      await expect.poll(() => preview.view()?.blocks[1]?.text).toBe('第一段');
      expect(text.join('')).toBe('正在写作。');
      expect(finalMessage).not.toHaveBeenCalled();
      expect(write).not.toHaveBeenCalled();
      expect(doc.read().revision).toBe(0);
      if (outcome === 'interrupt') {
        client.interrupt('keyboard');
        await expect.poll(() => providerSignal?.aborted).toBe(true);
        expect(preview.view()?.phase).toBe('cancelled');
      }
      release();
      if (outcome === 'complete' || outcome === 'fallback') {
        await expect.poll(() => client.state).toBe('idle');
        expect(doc.read().revision).toBe(1);
        expect(write).toHaveBeenCalledTimes(1);
        expect(preview.view()).toBeUndefined();
        expect(text.join('')).toBe('正在写作。已写入。');
        expect(errors).toEqual([]);
      } else {
        if (outcome === 'failure') await expect.poll(() => preview.view()?.phase).toBe('failed');
        await expect.poll(() => client.state).toBe('idle');
        expect(doc.read().revision).toBe(0);
        expect(write).not.toHaveBeenCalled();
        expect(finalMessage).not.toHaveBeenCalled();
      }
    } finally { release(); }
  },
);
