import { operationTool, type DocumentToolHost } from '../core';

export function createReplaceTextTool(host: DocumentToolHost) {
  return operationTool(host, 'Replace text at the explicit target.', { text: { type: 'string', maxLength: 100000 } }, input => ({ type: 'text.replace', text: input.text }));
}
