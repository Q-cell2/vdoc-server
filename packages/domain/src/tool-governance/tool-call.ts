import type { ToolCallId, TurnId } from '../shared';

/** A model's request to run one tool. Value object. */
export interface ToolCall {
  readonly id: ToolCallId;
  readonly name: string;
  readonly arguments: unknown;
  readonly turnId: TurnId;
}

/** Fields that legitimately change when the model repeats the same edit after rereading. */
const VOLATILE_KEYS = new Set(['id', 'expectedRevision', 'expectedSessionId', 'expectedBlocks']);

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !VOLATILE_KEYS.has(key))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, inner]) => `${JSON.stringify(key)}:${canonical(inner)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** 64-bit FNV-1a as two 32-bit halves; enough to recognise "the same request" within a session. */
function fnv1a64(text: string): string {
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x01000193 ^ 0x5bd1e995) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

/** Identifies a call by tool and meaningful arguments, ignoring ids and version preconditions. */
export function fingerprint(call: Pick<ToolCall, 'name' | 'arguments'>): string {
  return `${call.name}:${fnv1a64(canonical(call.arguments))}`;
}
