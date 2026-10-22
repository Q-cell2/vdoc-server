import type { DocumentToolHost, Tool } from './core';
export type { DocumentToolHost, Tool, ToolContext } from './core';
import { createReadDocumentTool } from './reading/read-document';
export { createReadDocumentTool } from './reading/read-document';
import { createGetContextTool } from './reading/get-context';
export { createGetContextTool } from './reading/get-context';
import { createReadBlocksTool } from './reading/read-blocks';
export { createReadBlocksTool } from './reading/read-blocks';
import { createInsertTextTool } from './text/insert-text';
export { createInsertTextTool } from './text/insert-text';
import { createReplaceTextTool } from './text/replace-text';
export { createReplaceTextTool } from './text/replace-text';
import { createDeleteTextTool } from './text/delete-text';
export { createDeleteTextTool } from './text/delete-text';
import { createMoveBlockTool } from './blocks/move-block';
export { createMoveBlockTool } from './blocks/move-block';
import { createInsertBlockTool } from './blocks/insert-block';
export { createInsertBlockTool } from './blocks/insert-block';
import { createDeleteBlockTool } from './blocks/delete-block';
export { createDeleteBlockTool } from './blocks/delete-block';
import { createInsertTableTool } from './tables/insert-table';
export { createInsertTableTool } from './tables/insert-table';
import { createInsertTableRowTool } from './tables/insert-table-row';
export { createInsertTableRowTool } from './tables/insert-table-row';
import { createDeleteTableRowTool } from './tables/delete-table-row';
export { createDeleteTableRowTool } from './tables/delete-table-row';
import { createUndoTurnTool } from './history/undo-turn';
export { createUndoTurnTool } from './history/undo-turn';
import { createSetTextStyleTool } from './formatting/set-text-style';
export { createSetTextStyleTool } from './formatting/set-text-style';
import { createSetParagraphStyleTool } from './formatting/set-paragraph-style';
export { createSetParagraphStyleTool } from './formatting/set-paragraph-style';

export function createDocumentTools(host: DocumentToolHost): Record<string, Tool> {
  return {
    read_document: createReadDocumentTool(host),
    get_context: createGetContextTool(host),
    read_blocks: createReadBlocksTool(host),
    insert_text: createInsertTextTool(host),
    replace_text: createReplaceTextTool(host),
    delete_text: createDeleteTextTool(host),
    move_block: createMoveBlockTool(host),
    insert_block: createInsertBlockTool(host),
    delete_block: createDeleteBlockTool(host),
    insert_table: createInsertTableTool(host),
    insert_table_row: createInsertTableRowTool(host),
    delete_table_row: createDeleteTableRowTool(host),
    undo_turn: createUndoTurnTool(host),
    set_text_style: createSetTextStyleTool(host),
    set_paragraph_style: createSetParagraphStyleTool(host),
  };
}
