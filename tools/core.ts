/** Structural equivalent of vRT ClientTool; no runtime SDK dependency. */
export interface ToolContext { signal: AbortSignal; callId: string; turnId: string; epoch: number }
export interface Tool { description: string; parameters: Schema; run(args: unknown, context: ToolContext): Promise<unknown> }
export interface Schema {
  type?: string; properties?: Record<string, Schema>; required?: readonly string[];
  additionalProperties?: boolean; items?: Schema; enum?: readonly unknown[];
  minimum?: number; maximum?: number; minLength?: number; maxLength?: number;
  minItems?: number; maxItems?: number; minProperties?: number; oneOf?: readonly Schema[];
}
export type Input = Record<string, unknown>;
/** Host methods must enforce version checks and cancellation before committing writes.
 * Deduplicate writes by callId and group undo by turnId. Returned failures must stay failures.
 */
export interface DocumentToolHost {
  readDocument(context: ToolContext): unknown | Promise<unknown>;
  readBlocks(ids: readonly string[], context: ToolContext): unknown | Promise<unknown>;
  getContext(context: ToolContext): unknown | Promise<unknown>;
  searchText(request: Input, context: ToolContext): unknown | Promise<unknown>;
  listOutline(context: ToolContext): unknown | Promise<unknown>;
  applyOperations(request: Input, context: ToolContext): unknown | Promise<unknown>;
  insertBlock(request: Input, context: ToolContext): unknown | Promise<unknown>;
  deleteBlock(request: Input, context: ToolContext): unknown | Promise<unknown>;
  duplicateBlock(request: Input, context: ToolContext): unknown | Promise<unknown>;
  undoTurn(turnId: string, context: ToolContext): unknown | Promise<unknown>;
}
export const string = (maxLength = 128): Schema => ({ type: 'string', minLength: 1, maxLength });
export const integer = (minimum = 0, maximum = Number.MAX_SAFE_INTEGER): Schema => ({ type: 'integer', minimum, maximum });
export const enumeration = (...values: string[]): Schema => ({ type: 'string', enum: values });
export const object = (properties: Record<string, Schema>, required = Object.keys(properties)): Schema => ({ type: 'object', properties, required, additionalProperties: false });
export const target: Schema = { oneOf: [
  object({ kind: enumeration('block'), id: string() }),
  object({ kind: enumeration('text'), blockId: string(), start: integer(), end: integer() }),
  object({ kind: enumeration('range'), from: integer(), to: integer() }),
  object({ kind: enumeration('cell'), tableId: string(), cellId: string() }),
  object({ kind: enumeration('cells'), tableId: string(), row: integer(), col: integer(), endRow: integer(), endCol: integer() }, ['kind', 'tableId', 'row', 'col']),
] };
export const version = { expectedSessionId: string(), expectedRevision: integer() };
export function validate(value: unknown, schema: Schema, path = 'arguments'): void {
  if (schema.oneOf) {
    const matches = schema.oneOf.filter(s => { try { validate(value, s, path); return true; } catch { return false; } });
    if (matches.length !== 1) throw new Error(`${path}: invalid target`);
    return;
  }
  if (schema.enum && !schema.enum.includes(value)) throw new Error(`${path}: unsupported value`);
  if (schema.type === 'object') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${path}: expected object`);
    const record = value as Input;
    for (const key of schema.required ?? []) if (!Object.hasOwn(record, key)) throw new Error(`${path}.${key}: required`);
    if (Object.keys(record).length < (schema.minProperties ?? 0)) throw new Error(`${path}: empty object`);
    for (const [key, child] of Object.entries(record)) {
      const property = Object.hasOwn(schema.properties ?? {}, key) ? schema.properties![key] : undefined;
      if (!property) { if (schema.additionalProperties === false) throw new Error(`${path}.${key}: unknown field`); }
      else validate(child, property, `${path}.${key}`);
    }
  } else if (schema.type === 'array') {
    if (!Array.isArray(value) || value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? Infinity)) throw new Error(`${path}: invalid array`);
    for (const child of value) validate(child, schema.items!, path);
  } else if (schema.type === 'string') {
    if (typeof value !== 'string' || value.length < (schema.minLength ?? 0) || value.length > (schema.maxLength ?? Infinity)) throw new Error(`${path}: invalid string`);
  } else if (schema.type === 'integer' || schema.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value) || (schema.type === 'integer' && !Number.isInteger(value)) || value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity)) throw new Error(`${path}: invalid number`);
  } else if (schema.type === 'boolean' && typeof value !== 'boolean') throw new Error(`${path}: expected boolean`);
}
export function tool(description: string, parameters: Schema, execute: (input: Input, context: ToolContext) => unknown | Promise<unknown>): Tool {
  return { description, parameters, async run(raw, context) {
    context.signal.throwIfAborted();
    validate(raw, parameters);
    const input = raw as Input;
    const t = input.target as Input | undefined;
    if (t && ((t.kind === 'text' && Number(t.start) > Number(t.end)) || (t.kind === 'range' && Number(t.from) > Number(t.to)) || (t.kind === 'cells' && ((t.endRow !== undefined && Number(t.endRow) < Number(t.row)) || (t.endCol !== undefined && Number(t.endCol) < Number(t.col)))))) throw new Error('Invalid target bounds');
    context.signal.throwIfAborted();
    return execute(input, context);
  } };
}
export function operationTool(host: DocumentToolHost, description: string, fields: Record<string, Schema>, operation: (input: Input) => Input, optional: readonly string[] = []): Tool {
  const parameters = { ...version, target, ...fields };
  return tool(description + ' Read first; supply the current session and revision. Stale edits require rereading.', object(parameters, Object.keys(parameters).filter(key => !optional.includes(key))), (input, context) => host.applyOperations({
    id: context.callId, expectedSessionId: input.expectedSessionId, expectedRevision: input.expectedRevision,
    target: input.target, operations: [operation(input)],
  }, context));
}
