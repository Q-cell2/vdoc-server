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
/** Cross-field rules a schema cannot express; kept beside the schema, out of the JSON sent to models. */
const refinements = new WeakMap<Schema, (value: Input) => string | undefined>();
const refine = (schema: Schema, rule: (value: Input) => string | undefined): Schema => (refinements.set(schema, rule), schema);
const ordered = (...pairs: [string, string][]) => (value: Input) =>
  pairs.some(([low, high]) => value[high] !== undefined && Number(value[low]) > Number(value[high])) ? 'invalid bounds' : undefined;
export const target: Schema = { oneOf: [
  object({ kind: enumeration('block'), id: string() }),
  refine(object({ kind: enumeration('text'), blockId: string(), start: integer(), end: integer() }), ordered(['start', 'end'])),
  refine(object({ kind: enumeration('range'), from: integer(), to: integer() }), ordered(['from', 'to'])),
  object({ kind: enumeration('cell'), tableId: string(), cellId: string() }),
  refine(object({ kind: enumeration('cells'), tableId: string(), row: integer(), col: integer(), endRow: integer(), endCol: integer() }, ['kind', 'tableId', 'row', 'col']), ordered(['row', 'endRow'], ['col', 'endCol'])),
] };
export const version = { expectedSessionId: string(), expectedRevision: integer() };

type Checker = (value: unknown, schema: Schema, path: string) => void;
const checkObject: Checker = (value, schema, path) => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${path}: expected object`);
  const record = value as Input;
  for (const key of schema.required ?? []) if (!Object.hasOwn(record, key)) throw new Error(`${path}.${key}: required`);
  if (Object.keys(record).length < (schema.minProperties ?? 0)) throw new Error(`${path}: empty object`);
  for (const [key, child] of Object.entries(record)) {
    const property = Object.hasOwn(schema.properties ?? {}, key) ? schema.properties![key] : undefined;
    if (property) validate(child, property, `${path}.${key}`);
    else if (schema.additionalProperties === false) throw new Error(`${path}.${key}: unknown field`);
  }
};
const checkArray: Checker = (value, schema, path) => {
  if (!Array.isArray(value) || value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? Infinity)) throw new Error(`${path}: invalid array`);
  for (const child of value) validate(child, schema.items!, path);
};
const checkString: Checker = (value, schema, path) => {
  if (typeof value !== 'string' || value.length < (schema.minLength ?? 0) || value.length > (schema.maxLength ?? Infinity)) throw new Error(`${path}: invalid string`);
};
const checkNumber: Checker = (value, schema, path) => {
  const valid = typeof value === 'number' && Number.isFinite(value)
    && (schema.type !== 'integer' || Number.isInteger(value))
    && value >= (schema.minimum ?? -Infinity) && value <= (schema.maximum ?? Infinity);
  if (!valid) throw new Error(`${path}: invalid number`);
};
const checkBoolean: Checker = (value, _schema, path) => {
  if (typeof value !== 'boolean') throw new Error(`${path}: expected boolean`);
};
const checkers: Record<string, Checker> = { object: checkObject, array: checkArray, string: checkString, integer: checkNumber, number: checkNumber, boolean: checkBoolean };

function matchesShape(value: unknown, schema: Schema, path: string): boolean {
  try { validateShape(value, schema, path); return true; } catch { return false; }
}
function validateShape(value: unknown, schema: Schema, path: string): void {
  if (schema.oneOf) {
    const matches = schema.oneOf.filter(option => matchesShape(value, option, path));
    if (matches.length !== 1) throw new Error(`${path}: invalid target`);
    return validate(value, matches[0]!, path);
  }
  if (schema.enum && !schema.enum.includes(value)) throw new Error(`${path}: unsupported value`);
  if (schema.type) checkers[schema.type]?.(value, schema, path);
}
/** Checks shape first, then the schema's cross-field rule, so a oneOf picks its branch by shape alone. */
export function validate(value: unknown, schema: Schema, path = 'arguments'): void {
  validateShape(value, schema, path);
  const problem = refinements.get(schema)?.(value as Input);
  if (problem) throw new Error(`${path}: ${problem}`);
}
export function tool(description: string, parameters: Schema, execute: (input: Input, context: ToolContext) => unknown | Promise<unknown>): Tool {
  return { description, parameters, async run(raw, context) {
    context.signal.throwIfAborted();
    validate(raw, parameters);
    context.signal.throwIfAborted();
    return execute(raw as Input, context);
  } };
}
export function operationTool(host: DocumentToolHost, description: string, fields: Record<string, Schema>, operation: (input: Input) => Input, optional: readonly string[] = []): Tool {
  const parameters = { ...version, target, ...fields };
  return tool(description + ' Read first; supply the current session and revision. Stale edits require rereading.', object(parameters, Object.keys(parameters).filter(key => !optional.includes(key))), (input, context) => host.applyOperations({
    id: context.callId, expectedSessionId: input.expectedSessionId, expectedRevision: input.expectedRevision,
    target: input.target, operations: [operation(input)],
  }, context));
}
