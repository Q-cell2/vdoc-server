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
import { createSearchTextTool } from './reading/search-text';
export { createSearchTextTool } from './reading/search-text';
import { createListOutlineTool } from './reading/list-outline';
export { createListOutlineTool } from './reading/list-outline';
import { createReplaceAllTool } from './text/replace-all';
export { createReplaceAllTool } from './text/replace-all';
import { createDuplicateBlockTool } from './blocks/duplicate-block';
export { createDuplicateBlockTool } from './blocks/duplicate-block';
import { createInsertTableColumnTool } from './tables/insert-table-column';
export { createInsertTableColumnTool } from './tables/insert-table-column';
import { createDeleteTableColumnTool } from './tables/delete-table-column';
export { createDeleteTableColumnTool } from './tables/delete-table-column';
import { createSetTableCellTool } from './tables/set-table-cell';
export { createSetTableCellTool } from './tables/set-table-cell';
import { createSetBlockTypeTool } from './formatting/set-block-type';
export { createSetBlockTypeTool } from './formatting/set-block-type';
import { createSetLinkTool } from './formatting/set-link';
export { createSetLinkTool } from './formatting/set-link';

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
    search_text: createSearchTextTool(host),
    list_outline: createListOutlineTool(host),
    replace_all: createReplaceAllTool(host),
    duplicate_block: createDuplicateBlockTool(host),
    insert_table_column: createInsertTableColumnTool(host),
    delete_table_column: createDeleteTableColumnTool(host),
    set_table_cell: createSetTableCellTool(host),
    set_block_type: createSetBlockTypeTool(host),
    set_link: createSetLinkTool(host),
  };
}
