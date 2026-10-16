import type { CallerCredentials } from '@vdoc-server/application';

export function credentialsOf(request: Request): CallerCredentials {
  const header = request.headers.get('authorization') ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return { bearer: match?.[1]?.trim() || undefined };
}

export type JsonBody =
  | { readonly ok: true; readonly value: Readonly<Record<string, unknown>> }
  | { readonly ok: false; readonly status: 400 | 413 | 415; readonly message: string };

/** Optional JSON object body, bounded in size. An empty body is `{}`. */
export async function readJsonObject(request: Request, maxBytes = 4096): Promise<JsonBody> {
  const text = await request.text();
  if (text.length === 0) return { ok: true, value: {} };
  if (new TextEncoder().encode(text).length > maxBytes) return { ok: false, status: 413, message: 'The request body is too large.' };
  if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) return { ok: false, status: 415, message: 'Send JSON.' };
  try {
    const value: unknown = JSON.parse(text);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return { ok: false, status: 400, message: 'The body must be a JSON object.' };
    return { ok: true, value: value as Record<string, unknown> };
  } catch {
    return { ok: false, status: 400, message: 'The body is not valid JSON.' };
  }
}
