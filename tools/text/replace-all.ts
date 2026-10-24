import { tool, object, version, string, type DocumentToolHost } from '../core';

export function createReplaceAllTool(host: DocumentToolHost) {
  return tool('Replace every match of the query in the whole document. Read first and supply the current session and revision; search first if unsure how many matches there are.', object({ ...version, query: string(1000), replacement: { type: 'string', maxLength: 100000 }, caseSensitive: { type: 'boolean' }, wholeWord: { type: 'boolean' } }, ['expectedSessionId', 'expectedRevision', 'query', 'replacement']), (input, context) => host.applyOperations({
    id: context.callId, expectedSessionId: input.expectedSessionId, expectedRevision: input.expectedRevision,
    // text.findReplace ignores the target, but agent requests must name one explicitly.
    target: { kind: 'range', from: 0, to: 0 },
    operations: [{ type: 'text.findReplace', query: input.query, replacement: input.replacement, caseSensitive: input.caseSensitive ?? false, wholeWord: input.wholeWord ?? false }],
  }, context));
}
