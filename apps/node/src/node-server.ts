import { closeCodeOf, isWebSocketUpgrade, matchRealtimeRoute } from '@vdoc-server/adapter-http';
import type { WebSocketLike } from '@vdoc-server/adapter-vrt';
import type { Server } from '@vdoc-server/composition';
import { createServer as createHttpServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer } from 'ws';

const MAX_BODY = 64 * 1024;

/** Adapts Node's http module to the Web-standard `HttpApi` and the realtime host. */
export function startNodeServer(server: Server, options: { port: number; host?: string }): Promise<{ http: HttpServer; port: number; close(): Promise<void> }> {
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  const http = createHttpServer((req, res) => {
    void handleRequest(server, req, res);
  });

  http.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    void handleUpgrade(server, sockets, req, socket, head);
  });

  return new Promise((resolve, reject) => {
    http.once('error', reject);
    http.listen(options.port, options.host ?? '127.0.0.1', () => {
      const address = http.address();
      const port = typeof address === 'object' && address ? address.port : options.port;
      resolve({
        http,
        port,
        close: async () => {
          await server.realtime.closeAll();
          for (const client of sockets.clients) client.terminate();
          await new Promise<void>((done) => http.close(() => done()));
        },
      });
    });
  });
}

async function handleRequest(server: Server, req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const request = await toWebRequest(req);
    if (!request) {
      res.writeHead(413).end();
      return;
    }
    const response = await server.http.handle(request);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    server.logger.log('error', 'node request failed', { error: String(error) });
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }
}

async function handleUpgrade(server: Server, sockets: WebSocketServer, req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const route = matchRealtimeRoute(url.pathname);
  const headers = toHeaders(req);
  if (!route || !isWebSocketUpgrade(new Request(url, { headers }))) return refuse(socket, 404);
  const room = await server.realtime.open(route);
  sockets.handleUpgrade(req, socket, head, (ws) => {
    // Clients cannot read a failed handshake's status, so a well-formed route is refused after accepting, with a close code.
    if (!room.ok) return ws.close(closeCodeOf(room.error.code), room.error.code);
    // `ws` sockets are event-target style at runtime, which is all vRealTime needs; its typings are just stricter.
    room.value.attach(ws as unknown as WebSocketLike, headers);
  });
}

function refuse(socket: Duplex, status: number): void {
  socket.end(`HTTP/1.1 ${status} ${status === 404 ? 'Not Found' : 'Refused'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function toHeaders(req: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
  }
  return headers;
}

async function toWebRequest(req: IncomingMessage): Promise<Request | undefined> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const method = req.method ?? 'GET';
  if (method === 'GET' || method === 'HEAD') return new Request(url, { method, headers: toHeaders(req) });
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) return undefined;
    chunks.push(chunk as Buffer);
  }
  return new Request(url, { method, headers: toHeaders(req), body: Buffer.concat(chunks) });
}
