import { operationTool, integer, type DocumentToolHost } from '../core';

export function createInsertTableTool(host: DocumentToolHost) {
  return operationTool(host, 'Insert a table at the explicit target.', { rows: integer(1, 30), cols: integer(1, 20), header: { type: 'boolean' } }, input => ({ type: 'table.insert', rows: input.rows, cols: input.cols, header: input.header }));
}
