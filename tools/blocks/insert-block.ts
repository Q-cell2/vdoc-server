import { tool, object, version, string, type DocumentToolHost } from '../core';

export function createInsertBlockTool(host: DocumentToolHost) {
  return tool('Insert a plain paragraph before a stable block ID; null appends at the document end. Read first and supply the current session and revision.', object({ ...version, ...{ beforeId: { oneOf: [string(), { enum: [null] }] }, text: { type: 'string', maxLength: 100000 } } }), (input, context) => host.insertBlock(input, context));
}
