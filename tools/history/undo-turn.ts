import { tool, object, string, type DocumentToolHost } from '../core';

export function createUndoTurnTool(host: DocumentToolHost) {
  return tool('Undo changes made by this agent in one earlier turn. The host must enforce ownership.', object({ turnId: string() }), (input, context) => host.undoTurn(input.turnId as string, context));
}
