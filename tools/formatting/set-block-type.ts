import { operationTool, enumeration, integer, type DocumentToolHost } from '../core';

const toggles: Record<string, Record<string, unknown>> = {
  bullet: { type: 'list.toggle', kind: 'bullet' }, ordered: { type: 'list.toggle', kind: 'ordered' }, task: { type: 'list.toggle', kind: 'task' },
  quote: { type: 'block.quote' }, code: { type: 'block.code' },
};

export function createSetBlockTypeTool(host: DocumentToolHost) {
  return operationTool(host, 'Turn the target into a paragraph, heading (level 1-6), list, quote or code block. List, quote and code toggle: applying the current type removes it, so read first.', { kind: enumeration('paragraph', 'heading', 'bullet', 'ordered', 'task', 'quote', 'code'), level: integer(1, 6) }, input => {
    if ((input.kind === 'heading') !== (input.level !== undefined)) throw new Error('Supply level only for headings');
    if (input.kind === 'paragraph') return { type: 'paragraph.style', level: 0 };
    if (input.kind === 'heading') return { type: 'paragraph.style', level: input.level };
    return toggles[input.kind as string]!;
  }, ['level']);
}
