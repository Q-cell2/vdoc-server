import { expect, it } from 'vitest';
import type { ToolStreamEvent } from '@vrealtime/client';
import { createArticleStream } from '../src/playground/article-stream';
import { createTestDocument } from '../src/playground/document';

const event = (part: Record<string, unknown>, callId = 'write'): ToolStreamEvent => ({ type: 'tool.stream', name: 'insert_structured_article', callId, epoch: 1, turnId: 'turn', ...part }) as ToolStreamEvent;
const setup = () => {
  const doc = createTestDocument(() => {});
  const stream = createArticleStream(() => doc.read(), () => {});
  const input = { expectedSessionId: doc.read().sessionId, expectedRevision: 0, destination: { kind: 'document_end' }, title: '流式文章', blocks: [{ kind: 'paragraph', text: '第一行\n第二行：你好😀' }] };
  return { doc, stream, input };
};

it('shows a title and growing paragraph before the JSON/tool is complete, without writing a revision', () => {
  const { doc, stream, input } = setup();
  const raw = JSON.stringify(input);
  const split = raw.indexOf('第一行') + 2;
  stream.receive(event({ phase: 'arguments-delta', delta: raw.slice(0, split) }));
  expect(stream.view()).toMatchObject({ phase: 'streaming', replaceBlank: true, blocks: [{ kind: 'heading', text: '流式文章' }, { kind: 'paragraph', text: '第一' }] });
  expect(doc.read().revision).toBe(0);
  expect(doc.read().blocks[0]!.text).toBe('');
  stream.receive(event({ phase: 'arguments-delta', delta: raw.slice(split) }));
  expect(stream.view()!.blocks[1]!.text).toBe(input.blocks[0]!.text);
  stream.receive(event({ phase: 'arguments-complete', arguments: input }));
  expect(stream.view()!.phase).toBe('pending');
  doc.tools.insert_structured_article!.run(input, { callId: 'write', epoch: 1, turnId: 'turn', signal: new AbortController().signal });
  stream.finish('write', true);
  stream.receive(event({ phase: 'settled', ok: true }));
  expect(stream.view()).toBeUndefined();
  expect(doc.read().blocks).toHaveLength(2);
  expect(doc.read().revision).toBe(1);
});

it('handles JSON escapes split at any character, nested unknown fields, and displays markup as plain text', () => {
  const { stream, input } = setup();
  input.blocks[0]!.text = '<script>\\"你好\n😀</script>';
  const raw = JSON.stringify({ ...input, ignored: { title: 'must not become another heading' } });
  for (const char of raw) {
    stream.receive(event({ phase: 'arguments-delta', delta: char }));
    expect(() => stream.view()).not.toThrow();
  }
  expect(stream.view()!.blocks).toHaveLength(2);
  expect(stream.view()!.blocks[1]!.text).toBe(input.blocks[0]!.text);
});

it.each(['cancelled', 'failed'] as const)('retains visibly unfinished %s text and ignores late deltas/results', phase => {
  const { doc, stream, input } = setup();
  stream.receive(event({ phase: 'arguments-delta', delta: JSON.stringify(input).slice(0, -3) }));
  stream.receive(event({ phase }));
  const before = stream.view();
  stream.receive(event({ phase: 'arguments-delta', delta: 'late' }));
  stream.finish('write', true);
  expect(stream.view()).toEqual(before);
  expect(stream.view()!.phase).toBe(phase);
  expect(doc.read().revision).toBe(0);
  stream.clear(); expect(stream.view()).toBeUndefined();
});

it('hides a stale preview after a manual edit or document switch and isolates concurrent call ids', () => {
  const { doc, stream, input } = setup();
  stream.receive(event({ phase: 'arguments-delta', delta: JSON.stringify(input) }));
  doc.editBlock(doc.read().blocks[0]!.id, '手动输入必须保留');
  expect(stream.view()).toMatchObject({ stale: true, blocks: [] });
  expect(doc.read().blocks[0]!.text).toBe('手动输入必须保留');
  doc.create(); expect(stream.view()).toBeUndefined();
  const next = { ...input, expectedSessionId: doc.read().sessionId };
  stream.receive(event({ phase: 'arguments-delta', delta: JSON.stringify(next) }, 'write-2'));
  stream.receive(event({ phase: 'cancelled' }, 'write'));
  expect(stream.view()!.callId).toBe('write-2');
  stream.finish('write-2', false);
  expect(stream.view()!.phase).toBe('failed');
});

it('places drafts relative to the requested block and bounds oversized argument streams', () => {
  const { doc, stream, input } = setup();
  const id = doc.read().blocks[0]!.id;
  stream.receive(event({ phase: 'arguments-complete', arguments: { ...input, destination: { kind: 'before_block', blockId: id } } }));
  expect(stream.view()).toMatchObject({ offset: 0, replaceBlank: false });
  stream.clear();
  stream.receive(event({ phase: 'arguments-delta', delta: 'x'.repeat(512_001) }, 'oversized'));
  expect(stream.view()).toMatchObject({ phase: 'failed', blocks: [] });
});


it('previews real table rows and partial cell text before commit, without changing revision', () => {
  const { doc, stream } = setup();
  const input = { expectedSessionId: doc.read().sessionId, expectedRevision: 0, destination: { kind: 'document_end' }, title: '名单', scopeNote: '部分角色示例', columns: ['名称'], rows: [['奥特曼'], ['赛文奥特曼']] };
  const raw = JSON.stringify(input); const split = raw.indexOf('赛文奥特曼') + 2;
  const tableEvent = { ...event({ phase: 'arguments-delta', delta: raw.slice(0, split) }), name: 'insert_test_table' } as ToolStreamEvent;
  stream.receive(tableEvent);
  expect(stream.view()!.blocks[0]).toMatchObject({ kind: 'table', columns: ['名称'], rows: [['奥特曼'], ['赛文']] });
  expect(doc.read().revision).toBe(0);
  stream.receive({ ...tableEvent, phase: 'arguments-delta', delta: raw.slice(split) });
  expect(stream.view()!.blocks[0]!.rows).toEqual(input.rows);
  stream.receive({ ...tableEvent, phase: 'cancelled' });
  expect(stream.view()!.phase).toBe('cancelled');
  expect(doc.read().revision).toBe(0);
});
