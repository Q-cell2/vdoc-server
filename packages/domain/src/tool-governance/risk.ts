import type { ToolCall } from './tool-call';

export type RiskLevel = 'low' | 'medium' | 'high';

const ORDER: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2 };
export const maxRisk = (a: RiskLevel, b: RiskLevel): RiskLevel => (ORDER[a] >= ORDER[b] ? a : b);

/** Risk of one call, plus a content-free summary of what it does (safe to audit). */
export interface RiskAssessment {
  readonly risk: RiskLevel;
  readonly operations: readonly string[];
}

/** Data, not code: changing what counts as risky never touches the assessor. */
export interface OperationRiskTable {
  /** Base risk per tool; tools not listed are `medium`. */
  readonly tools: Readonly<Record<string, RiskLevel>>;
  /** Tools whose `arguments.operations` are assessed one by one. */
  readonly batchTools: readonly string[];
  /** Per operation, keyed `type:action` or `type`; unlisted operations are `high` until someone rates them. */
  readonly operations: Readonly<Record<string, RiskLevel>>;
  /** A batch this large is `high` whatever it contains. */
  readonly highRiskBatchSize: number;
}

/** What counts as risky in vdoc's document operations (lib/domain/entities/operation.ts in vdoc). */
export const VDOC_RISK_TABLE: OperationRiskTable = Object.freeze<OperationRiskTable>({
  tools: { insert_test_table: 'low', delete_test_blocks: 'medium', create_test_document: 'low', insert_structured_article: 'low', read_document: 'low', read_blocks: 'low', get_context: 'low', apply_document_operations: 'low', undo_turn: 'medium' },
  batchTools: ['apply_document_operations'],
  operations: {
    'text.findReplace': 'high', 'table.edit:deleteTable': 'high', 'block.delete': 'high',
    'text.delete': 'medium', 'text.replace': 'medium', 'text.clear': 'medium', 'block.move': 'medium',
    'table.edit:deleteRow': 'medium', 'table.edit:deleteColumn': 'medium', 'table.sort': 'medium', 'table.move': 'medium',
    'document.layout': 'medium', 'document.language': 'medium',
    // Adds or removes marks on matched text; never changes the text itself, however many matches.
    'text.styleMatches': 'low',
    'text.style': 'low', 'text.toggle': 'low', 'text.insert': 'low', 'format.apply': 'low', 'link.set': 'low', 'link.unset': 'low',
    'paragraph.style': 'low', 'paragraph.indent': 'low', 'paragraph.adjustIndent': 'low', 'paragraph.border': 'low',
    'list.toggle': 'low', 'list.style': 'low', 'list.marker': 'low', 'list.indent': 'low', 'list.restart': 'low', 'list.continue': 'low', 'list.checklistStyle': 'low',
    'table.insert': 'low', 'table.edit': 'low', 'table.style': 'low', 'table.border': 'low', 'table.background': 'low', 'table.layout': 'low',
    'table.widths': 'low', 'table.columnWidth': 'low', 'table.rowHeight': 'low', 'table.distributeRows': 'low', 'table.split': 'low',
    'table.direction': 'low', 'table.pinRows': 'low', 'table.rowBreak': 'low',
    'image.insert': 'low', 'image.update': 'low', 'footnote.insert': 'low', 'footnote.update': 'low',
    'block.code': 'low', 'block.quote': 'low', 'block.rule': 'low', 'block.toc': 'low', 'block.pageBreak': 'low', 'block.insert': 'low',
  },
  highRiskBatchSize: 25,
});

/** Domain service: classifies a call using an `OperationRiskTable`. */
export class RiskAssessor {
  constructor(private readonly table: OperationRiskTable = VDOC_RISK_TABLE) {}

  assess(call: Pick<ToolCall, 'name' | 'arguments'>): RiskAssessment {
    let risk: RiskLevel = this.table.tools[call.name] ?? 'medium';
    if (!this.table.batchTools.includes(call.name)) return { risk, operations: [] };
    const list = (call.arguments as { operations?: unknown } | null)?.operations;
    const operations = Array.isArray(list) ? list.map(describe) : [];
    for (const operation of operations) risk = maxRisk(risk, this.table.operations[operation] ?? this.table.operations[operation.split(':')[0]!] ?? 'high');
    if (operations.length >= this.table.highRiskBatchSize) risk = 'high';
    return { risk, operations };
  }
}

function describe(operation: unknown): string {
  const { type, action } = (operation ?? {}) as { type?: unknown; action?: unknown };
  if (typeof type !== 'string') return 'unknown';
  return typeof action === 'string' ? `${type}:${action}` : type;
}
