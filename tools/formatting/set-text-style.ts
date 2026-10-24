import { operationTool, object, enumeration, integer, type DocumentToolHost } from '../core';

export function createSetTextStyleTool(host: DocumentToolHost) {
  return operationTool(host, 'Set explicit text style properties on the target.', { style: { ...object({
    bold: { type: 'boolean' }, italic: { type: 'boolean' }, underline: { type: 'boolean' }, strike: { type: 'boolean' },
    color: { oneOf: [{ type: 'string', minLength: 7, maxLength: 7 }, { enum: [null] }] },
    highlight: { oneOf: [{ type: 'string', minLength: 7, maxLength: 7 }, { enum: [null] }] },
    fontFamily: enumeration('Arial', 'Georgia', 'Times New Roman', 'Noto Sans SC', 'monospace'),
    fontSize: integer(8, 96), script: enumeration('normal', 'superscript', 'subscript'),
  }, []), minProperties: 1 } }, input => {
    const style = input.style as Record<string, unknown>;
    for (const key of ['color', 'highlight']) if (typeof style[key] === 'string' && !/^#[0-9a-f]{6}$/i.test(style[key])) throw new Error('Use a six-digit hexadecimal color');
    return { type: 'text.style', style };
  });
}
