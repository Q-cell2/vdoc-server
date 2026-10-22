import { operationTool, type DocumentToolHost } from '../core';

export function createDeleteTextTool(host: DocumentToolHost) {
  return operationTool(host, 'Delete text at the explicit target.', {}, _input => ({ type: 'text.delete' }));
}
