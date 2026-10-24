import { expect, it, vi } from 'vitest';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { createUtteranceJudge, quickIntent } from '../src';

const reply = (text: string): AssistantMessage => ({ role: 'assistant', api: 'anthropic-messages', provider: 'anthropic', model: 'claude-haiku-5-5', content: [{ type: 'text', text }],
  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: 0 });
const signal = new AbortController().signal;

it.each(['停', '停止。', 'Stop!', 'cancel', '算了', 'never mind'])('stops at once on "%s" without a model call', async words => {
  expect(quickIntent(words)).toBe('stop');
  const completeFn = vi.fn();
  expect(await createUtteranceJudge({ apiKey: 'k', completeFn }).judge('写文章', words, signal)).toBe('stop');
  expect(completeFn).not.toHaveBeenCalled();
});
it('leaves longer sentences that merely contain a stop word to the model', () => {
  expect(quickIntent('先别停，继续写')).toBeUndefined();
  expect(quickIntent("don't stop")).toBeUndefined();
});
it.each(['嗯', '好的。', 'OK', '继续'])('keeps the task on filler "%s" without a model call', async words => {
  expect(quickIntent(words)).toBe('continue');
  const completeFn = vi.fn();
  expect(await createUtteranceJudge({ apiKey: 'k', completeFn }).judge('写文章', words, signal)).toBe('continue');
  expect(completeFn).not.toHaveBeenCalled();
});
it.each([['replace', 'replace'], ['Stop.', 'stop'], ['continue', 'continue'], ['maybe', 'replace']])('reads the model answer "%s" as %s', async (answer, intent) => {
  const completeFn = vi.fn(async (_context: unknown, _signal: AbortSignal) => reply(answer));
  expect(await createUtteranceJudge({ apiKey: 'k', completeFn }).judge('写文章', '重写一篇', signal)).toBe(intent);
  expect(JSON.stringify(completeFn.mock.calls[0]![0])).toContain('重写一篇');
});
it('acts on the new words when the model call fails or times out', async () => {
  expect(await createUtteranceJudge({ apiKey: 'k', completeFn: async () => { throw new Error('down'); } }).judge('写文章', '换一个', signal)).toBe('replace');
  const slow = createUtteranceJudge({ apiKey: 'k', timeoutMs: 10, completeFn: (_context, aborted) => new Promise((_resolve, reject) => aborted.addEventListener('abort', () => reject(new Error('timeout')))) });
  expect(await slow.judge('写文章', '换一个', signal)).toBe('replace');
});
