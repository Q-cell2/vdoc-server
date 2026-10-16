import type { Application } from '@vdoc-server/application';
import { CorsPolicy } from './cors';
import { isWebSocketUpgrade, matchRealtimeRoute } from './realtime-route';
import { json, problem } from './responses';
import { Router } from './router';
import { VoiceSessionController } from './voice-session-controller';

export interface HttpLogger {
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string, fields?: Readonly<Record<string, unknown>>): void;
}

export interface HttpApiOptions {
  readonly app: Pick<Application, 'grantVoiceSession' | 'getVoiceSession' | 'renewSessionGrant' | 'endVoiceSession'>;
  readonly allowedOrigins: readonly string[];
  readonly logger?: HttpLogger;
}

/**
 * The HTTP surface of vdoc-server on Web-standard `Request`/`Response`, so the same
 * code serves Node and Cloudflare Workers. WebSocket upgrades are runtime-specific
 * and handled by each app before calling `handle()`.
 */
export class HttpApi {
  readonly #router: Router;
  readonly #cors: CorsPolicy;

  constructor(private readonly options: HttpApiOptions) {
    const sessions = new VoiceSessionController(options.app);
    this.#cors = new CorsPolicy(options.allowedOrigins);
    this.#router = new Router()
      .on('GET', '/healthz', async () => json({ status: 'ok' }))
      .on('POST', '/v1/documents/:documentId/voice-sessions', sessions.create)
      .on('GET', '/v1/documents/:documentId/voice-sessions/:sessionId', sessions.get)
      .on('DELETE', '/v1/documents/:documentId/voice-sessions/:sessionId', sessions.end)
      .on('POST', '/v1/documents/:documentId/voice-sessions/:sessionId/grants', sessions.renewGrant);
  }

  async handle(request: Request): Promise<Response> {
    const origin = request.headers.get('origin');
    if (request.method === 'OPTIONS') return this.#cors.preflight(origin);
    const response = await this.#route(request);
    const cors = this.#cors.headersFor(origin);
    if (Object.keys(cors).length === 0) return response;
    const headers = new Headers(response.headers);
    for (const [name, value] of Object.entries(cors)) headers.set(name, value);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }

  async #route(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (matchRealtimeRoute(pathname)) {
      return isWebSocketUpgrade(request)
        ? problem(500, 'INTERNAL', 'This runtime did not handle the WebSocket upgrade.')
        : problem(426, 'UPGRADE_REQUIRED', 'Connect with a WebSocket.', { upgrade: 'websocket' });
    }
    const match = this.#router.match(request.method, pathname);
    if (match.kind === 'not-found') return problem(404, 'NOT_FOUND', 'No such resource.');
    if (match.kind === 'method-not-allowed') return problem(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.', { allow: match.allow.join(', ') });
    try {
      return await match.handler(request, match.params);
    } catch (error) {
      this.options.logger?.log('error', 'unhandled request error', { method: request.method, path: pathname, error: String(error) });
      return problem(500, 'INTERNAL', 'Something went wrong.');
    }
  }
}
