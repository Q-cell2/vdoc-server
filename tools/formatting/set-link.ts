import { operationTool, type DocumentToolHost } from '../core';

export function createSetLinkTool(host: DocumentToolHost) {
  return operationTool(host, 'Link the target text to an https, http or mailto address; null removes the link.', { href: { oneOf: [{ type: 'string', minLength: 1, maxLength: 2048 }, { enum: [null] }] } }, input => {
    if (input.href === null) return { type: 'link.unset' };
    if (!/^(https?:\/\/|mailto:)/i.test(input.href as string)) throw new Error('Links must start with https://, http:// or mailto:');
    return { type: 'link.set', href: input.href };
  });
}
