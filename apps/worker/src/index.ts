import { DurableObjectAuditPublisher, DurableObjectVoiceSessionRepository, SerialCommandQueue, type AuditPage } from '@vdoc-server/adapter-cloudflare';
import { closeCodeOf, documentIdOf, isWebSocketUpgrade, json, matchRealtimeRoute, problem } from '@vdoc-server/adapter-http';
import { createModelRegistry, fetchSocket, type WebSocketLike } from '@vdoc-server/adapter-vrt';
import { createServer, type Server } from '@vdoc-server/composition';
import { loadConfig, type Env as ConfigEnv } from '@vdoc-server/config';
import { DurableObject } from 'cloudflare:workers';

export interface Env {
  readonly VOICE_ROOMS: DurableObjectNamespace<DocumentVoiceRoom>;
  readonly [variable: string]: unknown;
}

/** Edge entry: everything about a document goes to that document's Durable Object. */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === '/healthz') return json({ status: 'ok' });
    const documentId = documentIdOf(pathname);
    if (!documentId) return problem(404, 'NOT_FOUND', 'No such resource.');
    return env.VOICE_ROOMS.get(env.VOICE_ROOMS.idFromName(documentId)).fetch(request);
  },
} satisfies ExportedHandler<Env>;

/** Composition root per document: storage is this object's, everything else is shared code. */
export class DocumentVoiceRoom extends DurableObject<Env> {
  #server: Promise<Server> | undefined;
  readonly #commands = new SerialCommandQueue();
  readonly #sessions: DurableObjectVoiceSessionRepository;
  readonly #audit: DurableObjectAuditPublisher;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#sessions = new DurableObjectVoiceSessionRepository(ctx.storage);
    this.#audit = new DurableObjectAuditPublisher(ctx.storage);
    // Only storage initialization belongs in blockConcurrencyWhile; commands may perform external I/O.
    void ctx.blockConcurrencyWhile(() => this.#sessions.ensureAlarm());
  }

  /** Internal binding RPC only. The public HTTP router does not expose an audit endpoint. */
  auditEvents(sessionId: string, after = 0, limit = 100): AuditPage {
    return this.#audit.list(sessionId, after, limit);
  }

  override async alarm(): Promise<void> {
    const server = await this.#start();
    const overdue = await this.#commands.run(() => this.#sessions.findOverdue());
    for (const id of overdue) await server.application.endVoiceSession.expireIfOverdue(id);
    await this.#commands.run(() => this.#sessions.pruneAndSchedule());
  }

  override async fetch(request: Request): Promise<Response> {
    let server: Server;
    try {
      server = await this.#start();
    } catch (error) {
      console.error(JSON.stringify({ level: 'error', message: 'vdoc-server failed to start', error: String(error) }));
      this.#server = undefined;
      return problem(500, 'MISCONFIGURED', 'The voice server is not configured.');
    }
    const route = matchRealtimeRoute(new URL(request.url).pathname);
    if (route && isWebSocketUpgrade(request)) return this.#upgrade(server, route, request);
    return server.http.handle(request);
  }

  async #upgrade(server: Server, route: { documentId: string; sessionId: string }, request: Request): Promise<Response> {
    const room = await server.realtime.open(route);
    const pair = new WebSocketPair();
    const [client, socket] = [pair[0], pair[1]];
    socket.accept();
    if (room.ok) room.value.attach(socket as unknown as WebSocketLike, request.headers);
    else socket.close(closeCodeOf(room.error.code), room.error.code);
    return new Response(null, { status: 101, webSocket: client });
  }

  #start(): Promise<Server> {
    this.#server ??= (async () => {
      const variables: ConfigEnv = Object.fromEntries(Object.entries(this.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
      const config = loadConfig(variables);
      if (!config.ok) throw new Error(config.errors.join('; '));
      return createServer({
        config: config.value,
        sessions: this.#sessions,
        subscribers: [this.#audit],
        runCommand: (command) => this.#commands.run(command),
        models: createModelRegistry({
          bosonApiKey: config.value.providerKeys.boson,
          bosonSocket: fetchSocket(),
          openaiApiKey: config.value.providerKeys.openai,
          fake: config.value.environment === 'production' ? false : {},
        }),
      });
    })();
    return this.#server;
  }
}
