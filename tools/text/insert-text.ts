import { operationTool, string, type DocumentToolHost } from '../core';

export function createInsertTextTool(host: DocumentToolHost) {
  return operationTool(host, 'Insert text at the explicit target.', { text: string(100000) }, input => ({ type: 'text.insert', text: input.text }));
}
