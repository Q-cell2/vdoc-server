/** Explicit origin allow-list; no wildcard credentials. */
export class CorsPolicy {
  readonly #origins: ReadonlySet<string>;
  readonly #any: boolean;

  constructor(origins: readonly string[]) {
    this.#any = origins.includes('*');
    this.#origins = new Set(origins);
  }

  allows(origin: string | null): boolean {
    return origin !== null && (this.#any || this.#origins.has(origin));
  }

  /** Headers to add to a response for this request's origin. */
  headersFor(origin: string | null): Record<string, string> {
    if (!this.allows(origin)) return {};
    return { 'access-control-allow-origin': origin!, vary: 'Origin', 'access-control-expose-headers': 'location' };
  }

  preflight(origin: string | null): Response {
    if (!this.allows(origin)) return new Response(null, { status: 403 });
    return new Response(null, {
      status: 204,
      headers: {
        ...this.headersFor(origin),
        'access-control-allow-methods': 'GET, POST, DELETE',
        'access-control-allow-headers': 'authorization, content-type',
        'access-control-max-age': '600',
      },
    });
  }
}
