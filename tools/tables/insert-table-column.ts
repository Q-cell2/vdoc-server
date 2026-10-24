import { operationTool, enumeration, type DocumentToolHost } from '../core';

export function createInsertTableColumnTool(host: DocumentToolHost) {
  return operationTool(host, 'Insert one column before or after the targeted cell column. Use an explicit cell or cells target.', { position: enumeration('before', 'after') }, input => { const target = input.target as Record<string, unknown>; if (target.kind !== 'cell' && target.kind !== 'cells') throw new Error('A cell target is required'); return { type: 'table.edit', action: input.position === 'before' ? 'columnBefore' : 'columnAfter' }; });
}
