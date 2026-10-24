import { operationTool, type DocumentToolHost } from '../core';

export function createSetTableCellTool(host: DocumentToolHost) {
  return operationTool(host, 'Replace the whole text of one table cell. Use an explicit cell target, or a cells target without endRow and endCol.', { text: { type: 'string', maxLength: 10000 } }, input => { const target = input.target as Record<string, unknown>; if (target.kind !== 'cell' && !(target.kind === 'cells' && target.endRow === undefined && target.endCol === undefined)) throw new Error('A single cell target is required'); return { type: 'text.replace', text: input.text }; });
}
