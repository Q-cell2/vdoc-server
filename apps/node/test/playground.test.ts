import { request } from 'node:http';
import { afterEach, expect, it } from 'vitest';
import { loadConfig } from '@vdoc-server/config';
import type { ClientToolContext } from '@vrealtime/client';
import { createNodeServer } from '../src/create';
import { startNodeServer } from '../src/node-server';
import { createTestDocument } from '../src/playground/document';

const context = (callId = 'write-1', signal = new AbortController().signal): ClientToolContext => ({ callId, turnId: 'turn-test', epoch: 1, signal });
const docInput = (doc: ReturnType<typeof createTestDocument>) => ({ expectedSessionId: doc.read().sessionId, expectedRevision: doc.read().revision,
  destination: { kind: 'document_end' }, title: '测试文章', blocks: [{ kind: 'paragraph', text: '完整正文' }] });

it('commits atomically, deduplicates a repeated call and rejects a stale new call', () => {
  const doc = createTestDocument(() => {});
  const input = docInput(doc);
  doc.tools.insert_structured_article!.run(input, context());
  expect(doc.read().revision).toBe(1);
  expect(doc.read().blocks).toHaveLength(2);
  doc.tools.insert_structured_article!.run(input, context());
  expect(doc.read().blocks).toHaveLength(2);
  expect(() => doc.tools.insert_structured_article!.run(input, context('write-2'))).toThrow('STALE');
  expect(doc.read().revision).toBe(1);
});

it('rejects malformed and interrupted writes without partial title insertion', () => {
  const doc = createTestDocument(() => {});
  expect(() => doc.tools.insert_structured_article!.run({ ...docInput(doc), blocks: [{ kind: 'heading', level: 9, text: 'bad' }] }, context())).toThrow('INVALID');
  const controller = new AbortController(); controller.abort();
  expect(() => doc.tools.insert_structured_article!.run(docInput(doc), context('cancelled', controller.signal))).toThrow();
  expect(doc.read().revision).toBe(0);
  expect(doc.read().blocks).toEqual([expect.objectContaining({ kind: 'paragraph', text: '' })]);
});

it('requires current revision and matching turn for undo, then invalidates old preconditions on reset', () => {
  const doc = createTestDocument(() => {});
  const oldInput = docInput(doc);
  doc.tools.insert_structured_article!.run(oldInput, context());
  const preconditions = { expectedSessionId: doc.read().sessionId, expectedRevision: 1 };
  expect(() => doc.tools.undo_turn!.run({ ...preconditions, targetTurnId: 'other-turn' }, context('undo'))).toThrow('INVALID');
  doc.tools.undo_turn!.run({ ...preconditions, targetTurnId: 'turn-test' }, context('undo'));
  expect(doc.read().blocks).toEqual([expect.objectContaining({ kind: 'paragraph', text: '' })]);
  expect(doc.read().revision).toBe(2);
  doc.reset();
  expect(() => doc.tools.insert_structured_article!.run(oldInput, context('write-2'))).toThrow('STALE');
});

it('creates visible blank documents without discarding previous content, and restores them on switch', () => {
  const doc = createTestDocument(() => {});
  const first = doc.read();
  expect(first.blocks).toHaveLength(1);
  doc.editBlock(first.blocks[0]!.id, '用户输入的正文');
  doc.rename('第一份文档');
  const savedRevision = doc.read().revision;
  doc.create();
  const second = doc.read();
  expect(second.docId).not.toBe(first.docId);
  expect(second.sessionId).not.toBe(first.sessionId);
  expect(second.blocks).toEqual([expect.objectContaining({ kind: 'paragraph', text: '' })]);
  expect(doc.list()).toHaveLength(2);
  doc.switchDocument(first.docId);
  expect(doc.read()).toMatchObject({ title: '第一份文档', revision: savedRevision });
  expect(doc.read().blocks[0]!.text).toBe('用户输入的正文');
});

it('deduplicates agent document creation and rejects outdated requests after a manual edit', () => {
  const doc = createTestDocument(() => {});
  const input = { ...docInput(doc), title: 'Agent 新建文档' };
  const create = doc.tools.create_test_document!;
  create.run(input, context('create-1'));
  const next = doc.read();
  create.run(input, context('create-1'));
  expect(doc.read().docId).toBe(next.docId);
  expect(doc.list()).toHaveLength(2);
  expect(doc.read().title).toBe('Agent 新建文档');
  const stale = docInput(doc);
  doc.editBlock(next.blocks[0]!.id, '手动修改');
  expect(() => doc.tools.insert_structured_article!.run(stale, context('stale'))).toThrow('STALE');
  expect(doc.read().blocks[0]!.text).toBe('手动修改');
});

const closes: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); });
it('serves the page and browser bundle only when enabled, for a loopback same-origin host', async () => {
  const config = loadConfig({ VDOC_SERVER_ENV: 'test', VDOC_SERVER_MODEL: 'fake', VDOC_SERVER_LOG_LEVEL: 'error' });
  if (!config.ok) throw new Error();
  for (const enabled of [false, true]) {
    const app = await createNodeServer(config.value);
    const running = await startNodeServer(app, { port: 0, developmentPage: enabled }); closes.push(running.close);
    const base = `http://127.0.0.1:${running.port}`;
    const response = await fetch(base);
    expect(response.status).toBe(enabled ? 200 : 404);
    if (enabled) {
      expect(await response.text()).toContain('Higgs × Pi');
      const bundle = await fetch(base + '/dev/playground.js');
      expect(bundle.status).toBe(200);
      const js = await bundle.text();
      expect(js).toContain('insert_structured_article');
      expect(js).not.toContain('ANTHROPIC_API_KEY');
      expect(js).not.toContain('BOSON_API_KEY');
      expect((await fetch(base, { headers: { Origin: 'https://external.invalid' } })).status).toBe(404);
      const foreignHostStatus = await new Promise<number | undefined>((resolve, reject) => {
        const req = request(base, { headers: { Host: 'external.invalid' } }, response => { response.resume(); resolve(response.statusCode); });
        req.on('error', reject); req.end();
      });
      expect(foreignHostStatus).toBe(404);
      expect((await fetch(base + '/.env')).status).toBe(404);
    } else expect((await fetch(base + '/dev/playground.js')).status).toBe(404);
  }
});


it('deletes exactly the last two paragraphs, preserves stable ids, deduplicates, and undoes just that deletion', () => {
  const doc = createTestDocument(() => {});
  doc.tools.insert_structured_article!.run({ ...docInput(doc), blocks: ['第一段', '第二段', '第三段', '第四段'].map(text => ({ kind: 'paragraph', text })) }, context());
  const before = doc.read();
  const targets = before.blocks.filter(block => block.kind === 'paragraph').slice(-2).map(block => block.id);
  const input = { expectedSessionId: before.sessionId, expectedRevision: before.revision, blockIds: targets };
  const deletion = { ...context('delete-two'), turnId: 'deletion-turn' };
  const result = doc.tools.delete_test_blocks!.run(input, deletion);
  expect(result).toMatchObject({ ok: true, deletedCount: 2, deletedBlockIds: targets });
  expect(doc.read().blocks).toEqual(before.blocks.slice(0, -2).map(block => ({ ...block, version: 2 })));
  doc.tools.delete_test_blocks!.run(input, deletion);
  expect(doc.read().revision).toBe(2);
  doc.tools.undo_turn!.run({ expectedSessionId: before.sessionId, expectedRevision: 2, targetTurnId: 'deletion-turn' }, context('undo-delete'));
  expect(doc.read().blocks.map(block => block.text)).toEqual(before.blocks.map(block => block.text));
  expect(doc.read().revision).toBe(3);
});

it('rejects stale, unknown, duplicate and aborted deletion targets atomically', () => {
  const doc = createTestDocument(() => {});
  doc.tools.insert_structured_article!.run(docInput(doc), context());
  const before = doc.read();
  const valid = { expectedSessionId: before.sessionId, expectedRevision: before.revision, blockIds: [before.blocks[1]!.id] };
  const del = doc.tools.delete_test_blocks!;
  for (const [index, input] of [
    { ...valid, expectedRevision: 0 }, { ...valid, blockIds: [before.blocks[1]!.id, 'missing'] },
    { ...valid, blockIds: [before.blocks[1]!.id, before.blocks[1]!.id] }, { ...valid, blockIds: [] },
  ].entries()) expect(() => del.run(input, context('bad-delete-' + index))).toThrow();
  const abort = new AbortController(); abort.abort();
  expect(() => del.run(valid, context('cancelled-delete', abort.signal))).toThrow();
  expect(doc.read()).toEqual(before);
  doc.editBlock(before.blocks[1]!.id, '用户修改必须保留');
  expect(() => del.run(valid, context('after-edit'))).toThrow('STALE');
  expect(doc.read().blocks[1]!.text).toBe('用户修改必须保留');
});

it('keeps one editable blank paragraph when all blocks are deleted and restores the original on undo', () => {
  const doc = createTestDocument(() => {});
  doc.tools.insert_structured_article!.run(docInput(doc), context());
  const before = doc.read();
  doc.tools.delete_test_blocks!.run({ expectedSessionId: before.sessionId, expectedRevision: 1, blockIds: before.blocks.map(block => block.id) }, { ...context('delete-all'), turnId: 'delete-all-turn' });
  expect(doc.read().blocks).toEqual([expect.objectContaining({ kind: 'paragraph', text: '' })]);
  doc.tools.undo_turn!.run({ expectedSessionId: before.sessionId, expectedRevision: 2, targetTurnId: 'delete-all-turn' }, context('undo-all'));
  expect(doc.read().blocks.map(block => block.id)).toEqual(before.blocks.map(block => block.id));
});


const tableInput = (doc: ReturnType<typeof createTestDocument>) => ({ expectedSessionId: doc.read().sessionId, expectedRevision: doc.read().revision,
  destination: { kind: 'document_end' }, title: '角色名单草稿', scopeNote: '常见角色示例，非完整名单', columns: ['姓名', '说明'], rows: [['初代奥特曼', '示例'], ['赛文奥特曼', '<b>纯文本</b>']] });
it('inserts an actual structured table, labels its unverified scope, deduplicates and supports undo', () => {
  const doc = createTestDocument(() => {}); const input = tableInput(doc);
  doc.tools.insert_test_table!.run(input, context('table'));
  expect(doc.read().revision).toBe(1);
  const block = doc.read().blocks[0]!;
  expect(block).toMatchObject({ kind: 'table', columns: input.columns, rows: input.rows });
  expect(block.caption).toContain('非完整名单');
  expect(block.caption).toContain('未联网核验');
  expect(block.text).toContain('姓名\t说明');
  expect(doc.read().document.content[0]).toMatchObject({ type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableHeader' }, { type: 'tableHeader' }] }, { type: 'tableRow' }, { type: 'tableRow' }] });
  doc.tools.insert_test_table!.run(input, context('table'));
  expect(doc.read().blocks).toHaveLength(1);
  doc.tools.undo_turn!.run({ expectedSessionId: doc.read().sessionId, expectedRevision: 1, targetTurnId: 'turn-test' }, context('undo-table'));
  expect(doc.read().blocks).toEqual([expect.objectContaining({ kind: 'paragraph', text: '' })]);
});

it('rejects malformed, stale, or cancelled tables without touching prior content', () => {
  const doc = createTestDocument(() => {});
  const first = doc.read(); doc.editBlock(first.blocks[0]!.id, '必须保留的原文');
  const before = doc.read(); const input = tableInput(doc);
  for (const [index, value] of [ { ...input, rows: [['one']] }, { ...input, columns: [] }, { ...input, scopeNote: '' }, { ...input, expectedRevision: 0 } ].entries()) {
    expect(() => doc.tools.insert_test_table!.run(value, context('bad-table-' + index))).toThrow();
    expect(doc.read()).toEqual(before);
  }
  const controller = new AbortController(); controller.abort();
  expect(() => doc.tools.insert_test_table!.run(input, context('cancel-table', controller.signal))).toThrow();
  expect(doc.read()).toEqual(before);
});
