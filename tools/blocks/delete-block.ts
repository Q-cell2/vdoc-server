import { tool, object, version, string, type DocumentToolHost } from '../core';

export function createDeleteBlockTool(host: DocumentToolHost) {
  return tool('Delete one complete block by stable ID. Read first and supply the current session and revision.', object({ ...version, ...{ id: string() } }), (input, context) => host.deleteBlock(input, context));
}
