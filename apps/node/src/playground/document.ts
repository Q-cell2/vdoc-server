import { tableCaption } from './table';
import type { ClientTool } from '@vrealtime/client';

type Block = { id: string; kind: 'paragraph' | 'heading' | 'table'; text: string; level?: number; columns?: string[]; rows?: string[][]; caption?: string };
const empty = { type: 'object', properties: {}, additionalProperties: false };
const version = { expectedSessionId: { type: 'string' }, expectedRevision: { type: 'integer', minimum: 0 } };
const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const string = { type: 'string', minLength: 1 };

/** Isolated test document, with atomic revision checks and call-id deduplication. */
export function createTestDocument(changed: (renderContent?: boolean) => void) {
  let sessionId: string = crypto.randomUUID();
  let revision = 0;
  const blank = (): Block[] => [{ id: crypto.randomUUID(), kind: 'paragraph', text: '' }];
  let blocks: Block[] = blank();
  let documentId: string = crypto.randomUUID();
  let title = '未命名文档 1';
  let documentNumber = 1;
  let edits: { turnId: string; blockIds: string[] }[] = [];
  const undo: { turnId: string; before: Block[] }[] = [];
  const results = new Map<string, unknown>();
  type Snapshot = { id: string; title: string; sessionId: string; revision: number; blocks: Block[]; edits: typeof edits; undo: typeof undo };
  const documents = new Map<string, Snapshot>();
  const save = () => documents.set(documentId, { id: documentId, title, sessionId, revision, blocks: structuredClone(blocks), edits: structuredClone(edits), undo: structuredClone(undo) });
  const notify = (renderContent = true) => { save(); changed(renderContent); };
  const cache = (id: string, result: unknown) => { results.set(id, result); if (results.size > 128) results.delete(results.keys().next().value!); };
  const create = (name?: string) => {
    if (documents.size >= 20) throw new Error('本页最多创建 20 个测试文档。');
    save(); documentNumber++; documentId = crypto.randomUUID(); sessionId = crypto.randomUUID(); revision = 0;
    title = name?.trim() || `未命名文档 ${documentNumber}`;
    blocks = blank(); edits = []; undo.length = 0; notify();
  };
  save();
  const read = () => ({ ok: true, sessionId, expectedSessionId: sessionId, revision, blocks: blocks.map(block => ({ ...block, version: revision })),
    docId: documentId, title, selection: null, recentEdits: edits,
    document: { type: 'doc', content: blocks.map(block => block.kind === 'table' ? { type: 'table', caption: block.caption, content: [block.columns ?? [], ...(block.rows ?? [])].map((row, index) => ({ type: 'tableRow', content: row.map(text => ({ type: index === 0 ? 'tableHeader' : 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] })) })) } : ({ type: block.kind, ...(block.level ? { attrs: { level: block.level } } : {}), content: [{ type: 'text', text: block.text }] })) } });
  const check = (input: Record<string, unknown>) => { if (input.expectedSessionId !== sessionId || input.expectedRevision !== revision) throw new Error('STALE: Read the document and use its current sessionId and revision. This call did not apply an edit.'); };
  const insert = (input: Record<string, unknown>, article: Block[], context: Parameters<ClientTool['run']>[1]) => {
    check(input);
    if (blocks.length + article.length > 500) throw new Error('INVALID: test document block limit exceeded.');
    const destination = input.destination as { kind?: string; blockId?: string } | undefined;
      let offset = blocks.length;
      if (destination?.kind !== 'document_end') {
        if (!destination || !['before_block', 'after_block'].includes(destination.kind ?? '')) throw new Error('INVALID: explicit destination required.');
        offset = blocks.findIndex(block => block.id === destination.blockId);
        if (offset < 0) throw new Error('STALE: destination no longer exists.');
        if (destination.kind === 'after_block') offset++;
      }
      context.signal.throwIfAborted();
      undo.push({ turnId: context.turnId, before: structuredClone(blocks) }); if (undo.length > 10) undo.shift();
      blocks = destination?.kind === 'document_end' && blocks.length === 1 && blocks[0]!.kind === 'paragraph' && !blocks[0]!.text
        ? article : [...blocks.slice(0, offset), ...article, ...blocks.slice(offset)]; revision++;
      edits = [{ turnId: context.turnId, blockIds: article.map(block => block.id) }, ...edits].slice(0, 10);
      const result = { ok: true, revision, sessionId, insertedBlockIds: article.map(block => block.id) };
      cache(context.callId, result);
    notify(); return result;
  };
  const tool = (description: string, parameters: Record<string, unknown>, run: ClientTool['run']): ClientTool => ({ description, parameters, run });
  const tools: Record<string, ClientTool> = {
    create_test_document: tool('Create and switch to a NEW blank local test document. Preserve the previous document in the page document list. Read current session/revision first. This creates a document, not article content; only generate an article when the user asks for content.', object({ ...version, title: { type: 'string', maxLength: 200 } }, ['expectedSessionId', 'expectedRevision']), (raw, context) => {
      context.signal.throwIfAborted(); if (results.has(context.callId)) return results.get(context.callId);
      const input = raw as Record<string, unknown>; check(input);
      if (input.title !== undefined && (typeof input.title !== 'string' || input.title.length > 200)) throw new Error('INVALID: document title must be at most 200 characters.');
      create(input.title as string | undefined);
      const result = { ok: true, docId: documentId, title, sessionId, revision, blocks: structuredClone(blocks) };
      cache(context.callId, result); return result;
    }),
    read_document: tool('Read the isolated local test document, sessionId, revision, stable blocks and recentEdits.', empty, (_input, context) => { context.signal.throwIfAborted(); return read(); }),
    get_context: tool('Read the test document outline and recent agent edits. No cursor or selection is implied.', empty, (_input, context) => { context.signal.throwIfAborted(); return { ...read(), outline: blocks.filter(block => block.kind === 'heading'), documentEnd: true }; }),
    read_blocks: tool('Read specific test blocks by their stable ids.', object({ ids: { type: 'array', items: string, minItems: 1, maxItems: 200 } }), (raw, context) => {
      context.signal.throwIfAborted(); const input = raw as { ids?: unknown };
      if (!Array.isArray(input.ids) || input.ids.length > 200 || input.ids.some(id => typeof id !== 'string')) throw new Error('INVALID: ids must be an array of block ids.');
      const ids = input.ids;
      return { ...read(), blocks: blocks.filter(block => ids.includes(block.id)) };
    }),
    insert_structured_article: tool('Atomically insert a COMPLETE article into the local test document. Read first. Use plain text; paragraph blocks have kind paragraph; H2/H3 blocks have kind heading and level 2 or 3. destination document_end appends. For partial deletion use delete_test_blocks; this insertion tool cannot delete or replace existing content.', object({ ...version,
      destination: object({ kind: { enum: ['document_end', 'before_block', 'after_block'] }, blockId: string }, ['kind']),
      title: { ...string, maxLength: 200 }, blocks: { type: 'array', minItems: 1, maxItems: 120, items: object({ kind: { enum: ['paragraph', 'heading'] }, text: { ...string, maxLength: 4000 }, level: { enum: [2, 3] } }, ['kind', 'text']) },
    }), (raw, context) => {
      context.signal.throwIfAborted();
      if (results.has(context.callId)) return results.get(context.callId);
      const input = raw as Record<string, unknown>; check(input);
      if (typeof input.title !== 'string' || !input.title.trim() || input.title.length > 200 || !Array.isArray(input.blocks) || !input.blocks.length || input.blocks.length > 120) throw new Error('INVALID: title and 1–120 body blocks are required.');
      const article: Block[] = [{ id: crypto.randomUUID(), kind: 'heading', level: 1, text: input.title }];
      for (const item of input.blocks) {
        if (!item || !['paragraph', 'heading'].includes(item.kind) || typeof item.text !== 'string' || !item.text.trim() || item.text.length > 4000 || (item.kind === 'heading' && ![2, 3].includes(item.level))) throw new Error('INVALID: malformed article block; nothing was written.');
        article.push({ id: crypto.randomUUID(), kind: item.kind, text: item.text, ...(item.kind === 'heading' ? { level: item.level } : {}) });
      }
      if (article.reduce((n, block) => n + block.text.length, 0) > 60000 || blocks.length + article.length > 500) throw new Error('INVALID: test document size limit exceeded.');
      return insert(input, article, context);
    }),
    insert_test_table: tool('Insert a REAL table into the local document. For a table request use this tool, not prose or Markdown pipes. Read current session/revision first. Supply title, explicit factual scopeNote, column headers and rectangular rows. Without research tools this is an unverified draft, not a complete/official/latest factual list. The editor always displays that limitation. Preserve existing content; choose an explicit destination.', object({ ...version,
      destination: object({ kind: { enum: ['document_end', 'before_block', 'after_block'] }, blockId: string }, ['kind']),
      title: { ...string, maxLength: 200 }, scopeNote: { ...string, maxLength: 1000 },
      columns: { type: 'array', minItems: 1, maxItems: 12, items: { ...string, maxLength: 100 } },
      rows: { type: 'array', minItems: 1, maxItems: 200, items: { type: 'array', minItems: 1, maxItems: 12, items: { type: 'string', maxLength: 1000 } } },
    }), (raw, context) => {
      context.signal.throwIfAborted(); if (results.has(context.callId)) return results.get(context.callId);
      const input = raw as Record<string, unknown>; check(input);
      const { title: name, scopeNote, columns, rows } = input;
      if (typeof name !== 'string' || !name.trim() || name.length > 200 || typeof scopeNote !== 'string' || !scopeNote.trim() || scopeNote.length > 1000
        || !Array.isArray(columns) || !columns.length || columns.length > 12 || columns.some(cell => typeof cell !== 'string' || !cell.trim() || cell.length > 100)
        || !Array.isArray(rows) || !rows.length || rows.length > 200 || rows.some(row => !Array.isArray(row) || row.length !== columns.length || row.some(cell => typeof cell !== 'string' || cell.length > 1000))) throw new Error('INVALID: title, scopeNote, 1-12 columns and 1-200 rectangular rows are required. Nothing was written.');
      const caption = tableCaption(name, scopeNote);
      const text = [caption, columns.join('\t'), ...rows.map(row => row.join('\t'))].join('\n');
      if (text.length > 60000) throw new Error('INVALID: table text exceeds 60000 characters.');
      return insert(input, [{ id: crypto.randomUUID(), kind: 'table', text, caption, columns: [...columns], rows: rows.map(row => [...row]) }], context);
    }),
    delete_test_blocks: tool('Delete ONLY specified stable block ids from the local test document. Read first, identify exactly the paragraphs the user requested (for last two paragraphs select the last two paragraph blocks, not headings), then submit one atomic call. Preserve all other blocks. NEVER undo an entire article to remove only a few paragraphs. Deletion is undoable with undo_turn.', object({ ...version,
      blockIds: { type: 'array', items: string, minItems: 1, maxItems: 20, uniqueItems: true },
    }), (raw, context) => {
      context.signal.throwIfAborted();
      if (results.has(context.callId)) return results.get(context.callId);
      const input = raw as Record<string, unknown>; check(input);
      const ids = input.blockIds;
      if (!Array.isArray(ids) || !ids.length || ids.length > 20 || ids.some(id => typeof id !== 'string' || !id) || new Set(ids).size !== ids.length) throw new Error('INVALID: choose 1–20 unique block ids from the latest read. Nothing was deleted.');
      const selected = new Set(ids);
      if (ids.some(id => !blocks.some(block => block.id === id))) throw new Error('STALE: a target block no longer exists. Reread before retrying; nothing was deleted.');
      context.signal.throwIfAborted();
      const removed = blocks.filter(block => selected.has(block.id));
      const remaining = blocks.filter(block => !selected.has(block.id));
      undo.push({ turnId: context.turnId, before: structuredClone(blocks) }); if (undo.length > 10) undo.shift();
      blocks = remaining.length ? remaining : blank(); revision++;
      edits = [{ turnId: context.turnId, blockIds: removed.map(block => block.id) }, ...edits].slice(0, 10);
      const result = { ok: true, sessionId, revision, deletedBlockIds: removed.map(block => block.id), deletedCount: removed.length };
      cache(context.callId, result); notify(); return result;
    }),
    undo_turn: tool('Undo the latest whole agent edit (insertion or deletion) only. NEVER use this for partial deletion; use delete_test_blocks to delete only requested paragraphs. Use targetTurnId from recentEdits. This simplified editor does not support selective historical undo.', object({ ...version, targetTurnId: string }), (raw, context) => {
      context.signal.throwIfAborted(); if (results.has(context.callId)) return results.get(context.callId);
      const input = raw as Record<string, unknown>; check(input);
      const last = undo.at(-1); if (!last || last.turnId !== input.targetTurnId) throw new Error('INVALID: only the latest agent edit can be undone in this test editor.');
      blocks = last.before; undo.pop(); revision++; edits = edits.filter(edit => edit.turnId !== last.turnId);
      const result = { ok: true, revision, sessionId }; cache(context.callId, result); notify(); return result;
    }),
  };
  return {
    tools, read, reset: create, create,
    list: () => [...documents.values()].map(doc => ({ id: doc.id, title: doc.title })),
    switchDocument(id: string) {
      const next = documents.get(id); if (!next || id === documentId) return;
      save(); documentId = next.id; title = next.title; sessionId = next.sessionId; revision = next.revision;
      blocks = structuredClone(next.blocks); edits = structuredClone(next.edits); undo.splice(0, undo.length, ...structuredClone(next.undo)); notify();
    },
    rename(name: string) {
      if (!name.trim() || name.length > 200) throw new Error('文档名称需为 1～200 个字符。');
      if (name === title) return;
      title = name.trim(); revision++; undo.length = 0; notify(false);
    },
    editBlock(id: string, text: string) {
      const block = blocks.find(block => block.id === id); if (!block || block.text === text) return;
      if (block.kind === 'table') throw new Error('Use a table tool to edit table cells.');
      if (text.length > 4000) throw new Error('单段最多输入 4000 个字符。');
      block.text = text; revision++; undo.length = 0; notify(false);
    },
  };
}
