import { operationTool, type DocumentToolHost } from '../core';

export function createDeleteTableRowTool(host: DocumentToolHost) {
  return operationTool(host, 'Delete the row addressed by an explicit cell target.', {}, input => { const target = input.target as Record<string, unknown>; if (target.kind !== 'cell' && target.kind !== 'cells') throw new Error('A cell target is required'); return { type: 'table.edit', action: 'deleteRow' }; });
}
