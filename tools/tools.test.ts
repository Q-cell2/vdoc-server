import { describe, expect, it, vi } from 'vitest';
import { createDocumentTools, type DocumentToolHost, type ToolContext } from './index';
function setup() {
  const host: DocumentToolHost = {
    readDocument: vi.fn(() => ({ revision: 2 })), readBlocks: vi.fn(), getContext: vi.fn(), searchText: vi.fn(), listOutline: vi.fn(),
    applyOperations: vi.fn(() => ({ ok: true, revision: 3 })),
    insertBlock: vi.fn(), deleteBlock: vi.fn(), duplicateBlock: vi.fn(), undoTurn: vi.fn(),
  };
  const controller = new AbortController();
  const context: ToolContext = { signal: controller.signal, callId: 'call-1', turnId: 'turn-1', epoch: 0 };
  return { host, context, controller, tools: createDocumentTools(host) };
}
const base = { expectedSessionId: 'editor-1', expectedRevision: 2, target: { kind: 'block', id: 'b1' } };
describe('document tools', () => {
  it('registers all twenty-four concrete tools', () => { expect(Object.keys(setup().tools)).toHaveLength(24); });
  it.each([
    ['insert_text', { text: 'hello' }, { type: 'text.insert', text: 'hello' }],
    ['replace_text', { text: '' }, { type: 'text.replace', text: '' }],
    ['delete_text', {}, { type: 'text.delete' }],
    ['move_block', { id: 'b1', beforeId: null }, { type: 'block.move', id: 'b1', beforeId: null }],
    ['set_text_style', { style: { bold: false } }, { type: 'text.style', style: { bold: false } }],
    ['set_paragraph_style', { style: { align: 'center' } }, { type: 'paragraph.style', align: 'center' }],
    ['insert_table', { rows: 2, cols: 3, header: true }, { type: 'table.insert', rows: 2, cols: 3, header: true }],
    ['set_block_type', { kind: 'heading', level: 2 }, { type: 'paragraph.style', level: 2 }],
    ['set_block_type', { kind: 'paragraph' }, { type: 'paragraph.style', level: 0 }],
    ['set_block_type', { kind: 'ordered' }, { type: 'list.toggle', kind: 'ordered' }],
    ['set_block_type', { kind: 'quote' }, { type: 'block.quote' }],
    ['set_link', { href: 'https://example.com' }, { type: 'link.set', href: 'https://example.com' }],
    ['set_link', { href: null }, { type: 'link.unset' }],
  ])('%s emits the concrete operation with version and call identity', async (name, fields, operation) => {
    const { tools, host, context } = setup();
    await expect(tools[name]!.run({ ...base, ...fields }, context)).resolves.toEqual({ ok: true, revision: 3 });
    expect(host.applyOperations).toHaveBeenCalledWith({ ...base, id: context.callId, operations: [operation] }, context);
  });
  it.each([['before', 'rowBefore'], ['after', 'rowAfter']])('inserts a row %s', async (position, action) => {
    const { tools, host, context } = setup();
    await tools.insert_table_row!.run({ ...base, target: { kind: 'cell', tableId: 't1', cellId: 'c1' }, position }, context);
    expect(host.applyOperations).toHaveBeenCalledWith(expect.objectContaining({ operations: [{ type: 'table.edit', action }] }), context);
  });
  it.each([['insert_table_column', { position: 'before' }, 'columnBefore'], ['insert_table_column', { position: 'after' }, 'columnAfter'], ['delete_table_column', {}, 'deleteColumn']])('%s emits %s', async (name, fields, action) => {
    const { tools, host, context } = setup();
    await tools[name]!.run({ ...base, target: { kind: 'cell', tableId: 't1', cellId: 'c1' }, ...fields }, context);
    expect(host.applyOperations).toHaveBeenCalledWith(expect.objectContaining({ operations: [{ type: 'table.edit', action }] }), context);
  });
  it('replaces a single cell text and rejects ranges', async () => {
    const { tools, host, context } = setup();
    await tools.set_table_cell!.run({ ...base, target: { kind: 'cells', tableId: 't1', row: 1, col: 2 }, text: '50' }, context);
    expect(host.applyOperations).toHaveBeenCalledWith(expect.objectContaining({ operations: [{ type: 'text.replace', text: '50' }] }), context);
    await expect(tools.set_table_cell!.run({ ...base, target: { kind: 'cells', tableId: 't1', row: 1, col: 2, endRow: 3 }, text: '' }, context)).rejects.toThrow();
    await expect(tools.set_table_cell!.run({ ...base, text: '' }, context)).rejects.toThrow();
  });
  it('replaces all matches document-wide with defaults', async () => {
    const { tools, host, context } = setup();
    await tools.replace_all!.run({ expectedSessionId: 'editor-1', expectedRevision: 2, query: 'A', replacement: 'B' }, context);
    expect(host.applyOperations).toHaveBeenCalledWith({ id: context.callId, expectedSessionId: 'editor-1', expectedRevision: 2, target: { kind: 'range', from: 0, to: 0 }, operations: [{ type: 'text.findReplace', query: 'A', replacement: 'B', caseSensitive: false, wholeWord: false }] }, context);
  });
  it('rejects mismatched heading levels and unsafe links', async () => {
    const { tools, host, context } = setup();
    await expect(tools.set_block_type!.run({ ...base, kind: 'heading' }, context)).rejects.toThrow();
    await expect(tools.set_block_type!.run({ ...base, kind: 'quote', level: 1 }, context)).rejects.toThrow();
    await expect(tools.set_link!.run({ ...base, href: 'javascript:alert(1)' }, context)).rejects.toThrow();
    expect(host.applyOperations).not.toHaveBeenCalled();
  });
  it('deletes a targeted row', async () => {
    const { tools, host, context } = setup();
    await tools.delete_table_row!.run({ ...base, target: { kind: 'cell', tableId: 't1', cellId: 'c1' } }, context);
    expect(host.applyOperations).toHaveBeenCalledWith(expect.objectContaining({ operations: [{ type: 'table.edit', action: 'deleteRow' }] }), context);
  });
  it('delegates reads, block lifecycle and undo to explicit host capabilities', async () => {
    const { tools, host, context } = setup();
    await tools.read_document!.run({}, context);
    await tools.read_blocks!.run({ ids: ['b1'] }, context);
    await tools.get_context!.run({}, context);
    const version = { expectedSessionId: 'editor-1', expectedRevision: 2 };
    await tools.insert_block!.run({ ...version, beforeId: null, text: 'hello' }, context);
    await tools.delete_block!.run({ ...version, id: 'b1' }, context);
    await tools.undo_turn!.run({ turnId: 'earlier' }, context);
    await tools.search_text!.run({ query: '上季度', limit: 5 }, context);
    await tools.list_outline!.run({}, context);
    await tools.duplicate_block!.run({ ...version, id: 'b1' }, context);
    expect(host.readDocument).toHaveBeenCalledWith(context);
    expect(host.readBlocks).toHaveBeenCalledWith(['b1'], context);
    expect(host.getContext).toHaveBeenCalledWith(context);
    expect(host.insertBlock).toHaveBeenCalledWith({ ...version, beforeId: null, text: 'hello' }, context);
    expect(host.deleteBlock).toHaveBeenCalledWith({ ...version, id: 'b1' }, context);
    expect(host.undoTurn).toHaveBeenCalledWith('earlier', context);
    expect(host.searchText).toHaveBeenCalledWith({ query: '上季度', limit: 5 }, context);
    expect(host.listOutline).toHaveBeenCalledWith(context);
    expect(host.duplicateBlock).toHaveBeenCalledWith({ ...version, id: 'b1' }, context);
  });
  it('rejects missing versions, unknown fields, empty styles and reversed ranges before writing', async () => {
    const { tools, host, context } = setup();
    for (const input of [{ target: base.target }, { ...base, extra: true }, { ...base, target: { kind: 'text', blockId: 'b1', start: 9, end: 2 } }]) {
      await expect(tools.delete_text!.run(input, context)).rejects.toThrow();
    }
    await expect(tools.set_text_style!.run({ ...base, style: {} }, context)).rejects.toThrow();
    await expect(tools.delete_table_row!.run(base, context)).rejects.toThrow();
    expect(host.applyOperations).not.toHaveBeenCalled();
  });
  it('does not execute a cancelled call or hide a stale result', async () => {
    const { tools, host, controller, context } = setup();
    vi.mocked(host.applyOperations).mockReturnValue({ ok: false, code: 'STALE' });
    await expect(tools.delete_text!.run(base, context)).resolves.toEqual({ ok: false, code: 'STALE' });
    controller.abort();
    await expect(tools.delete_text!.run(base, context)).rejects.toThrow();
    expect(host.applyOperations).toHaveBeenCalledTimes(1);
  });
});
