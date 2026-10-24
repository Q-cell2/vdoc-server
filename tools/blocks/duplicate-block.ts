import { tool, object, version, string, type DocumentToolHost } from '../core';

export function createDuplicateBlockTool(host: DocumentToolHost) {
  return tool('Copy a block with its formatting directly after itself. Read first and supply the current session and revision.', object({ ...version, id: string() }), (input, context) => host.duplicateBlock(input, context));
}
