export type Params = Readonly<Record<string, string>>;
export type Handler = (request: Request, params: Params) => Promise<Response>;

interface Route {
  readonly method: string;
  readonly pattern: RegExp;
  readonly keys: readonly string[];
  readonly handler: Handler;
}

export type RouteMatch =
  | { readonly kind: 'found'; readonly handler: Handler; readonly params: Params }
  | { readonly kind: 'method-not-allowed'; readonly allow: readonly string[] }
  | { readonly kind: 'not-found' };

/** Path patterns like `/v1/documents/:documentId`; segments are URL-decoded. */
export class Router {
  readonly #routes: Route[] = [];

  on(method: string, path: string, handler: Handler): this {
    const keys: string[] = [];
    const source = path.split('/').map((segment) => {
      if (!segment.startsWith(':')) return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      keys.push(segment.slice(1));
      return '([^/]+)';
    }).join('/');
    this.#routes.push({ method, pattern: new RegExp(`^${source}$`), keys, handler });
    return this;
  }

  match(method: string, pathname: string): RouteMatch {
    const allow: string[] = [];
    for (const route of this.#routes) {
      const found = route.pattern.exec(pathname);
      if (!found) continue;
      if (route.method !== method) {
        allow.push(route.method);
        continue;
      }
      const params: Record<string, string> = {};
      route.keys.forEach((key, index) => {
        params[key] = safeDecode(found[index + 1]!);
      });
      return { kind: 'found', handler: route.handler, params };
    }
    return allow.length > 0 ? { kind: 'method-not-allowed', allow } : { kind: 'not-found' };
  }
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
