import type { ProviderSocket, SocketFactory } from '@vrealtime/boson';

type Listener = Parameters<ProviderSocket['addEventListener']>[1];
type Message = Record<string, unknown>;

/** The protocol's own default, used when the deployment does not supply a socket. */
const defaultSocket: SocketFactory = (url, headers) => new WebSocket(url, { headers } as unknown as string[]) as unknown as ProviderSocket;

/**
 * Turns on Boson's hosted web search for a session.
 *
 * vRealTime declares every tool as a function, so the `{ type: "web_search" }`
 * tool is added to each outgoing `session.update` that lists tools. Boson runs
 * the search itself and continues the response on its own; its `function_call`
 * items carry `executor: "server"` and must never reach vRealTime, which would
 * treat them as client calls and wait for results. They are removed from the
 * incoming events, including the finished response's output.
 */
export function withBosonWebSearch(base: SocketFactory = defaultSocket): SocketFactory {
  return async (url, headers) => {
    const socket = await base(url, headers);
    const serverCalls = new Set<string>();
    return {
      get readyState() { return socket.readyState; },
      send: (data) => socket.send(addWebSearch(data)),
      close: (code, reason) => socket.close(code, reason),
      addEventListener: (type, listener: Listener) => {
        if (type !== 'message') return socket.addEventListener(type, listener);
        socket.addEventListener('message', (event) => {
          const data = withoutServerCalls(event.data, serverCalls);
          if (data !== undefined) listener({ ...event, data });
        });
      },
    };
  };
}

function addWebSearch(data: string): string {
  const message = parse(data);
  const session = message?.['session'] as Message | undefined;
  if (message?.['type'] !== 'session.update' || !Array.isArray(session?.['tools'])) return data;
  const tools = session['tools'] as Message[];
  if (tools.some((tool) => tool['type'] === 'web_search')) return data;
  return JSON.stringify({ ...message, session: { ...session, tools: [...tools, { type: 'web_search' }] } });
}

/** `undefined` drops the event; anything else is passed on. */
function withoutServerCalls(data: unknown, serverCalls: Set<string>): unknown {
  if (typeof data !== 'string') return data;
  const message = parse(data);
  if (!message) return data;
  switch (message['type']) {
    case 'response.output_item.added':
    case 'response.output_item.done': {
      const item = message['item'] as Message | undefined;
      if (!isServerCall(item)) return data;
      serverCalls.add(String(item!['call_id']));
      return undefined;
    }
    case 'response.function_call_arguments.delta':
    case 'response.function_call_arguments.done':
      return serverCalls.has(String(message['call_id'])) || message['name'] === 'web_search' ? undefined : data;
    case 'response.done': {
      const response = message['response'] as Message | undefined;
      const output = response?.['output'];
      if (!Array.isArray(output)) return data;
      const kept = output.filter((item: Message) => !isServerCall(item));
      for (const item of output as Message[]) if (isServerCall(item)) serverCalls.delete(String(item['call_id']));
      return kept.length === output.length ? data : JSON.stringify({ ...message, response: { ...response, output: kept } });
    }
    default:
      return data;
  }
}

function isServerCall(item: Message | undefined): boolean {
  return item?.['type'] === 'function_call' && (item['executor'] === 'server' || item['name'] === 'web_search');
}

function parse(data: string): Message | undefined {
  try {
    const value: unknown = JSON.parse(data);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Message : undefined;
  } catch {
    return undefined;
  }
}
