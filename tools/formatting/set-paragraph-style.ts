import { operationTool, object, enumeration, integer, type DocumentToolHost } from '../core';

export function createSetParagraphStyleTool(host: DocumentToolHost) {
  return operationTool(host, 'Set paragraph alignment, heading level, spacing or indentation.', { style: { ...object({
    level: integer(0, 6), align: enumeration('left', 'center', 'right', 'justify'),
    direction: enumeration('auto', 'ltr', 'rtl'),
    lineHeight: enumeration('1', '1.15', '1.25', '1.5', '1.75', '2', '2.5', '3'),
    indent: integer(0, 8), spaceBefore: integer(0, 96), spaceAfter: integer(0, 96),
    keepWithNext: { type: 'boolean' }, keepLinesTogether: { type: 'boolean' }, preventSingleLines: { type: 'boolean' },
  }, []), minProperties: 1 } }, input => ({ type: 'paragraph.style', ...(input.style as Record<string, unknown>) }));
}
