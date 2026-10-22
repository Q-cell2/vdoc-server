import { operationTool, string, type DocumentToolHost } from '../core';

export function createMoveBlockTool(host: DocumentToolHost) {
  return operationTool(host, 'Move an existing block before another block, or to the end when beforeId is null.', { id: string(), beforeId: { oneOf: [{ type: 'string', minLength: 1 }, { enum: [null] }] } }, input => ({ type: 'block.move', id: input.id, beforeId: input.beforeId }));
}
