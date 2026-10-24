import type { ProviderSocket } from '@vrealtime/boson';
import { describe, expect, it } from 'vitest';
import { withBosonWebSearch } from '../src';

function fakeSocket() {
  const sent: unknown[] = [];
  const listeners: ((event: { data?: unknown }) => void)[] = [];
  const socket: ProviderSocket = {
    readyState: 1,
    send: (data) => sent.push(JSON.parse(data)),
    close: () => {},
    addEventListener: (type, listener) => { if (type === 'message') listeners.push(listener); },
  };
  return { socket, sent, receive: (message: unknown) => listeners.forEach((listener) => listener({ data: JSON.stringify(message) })) };
}

async function open() {
  const fake = fakeSocket();
  const socket = await withBosonWebSearch(() => fake.socket)('wss://boson.test', {});
  const received: unknown[] = [];
  socket.addEventListener('message', (event) => received.push(JSON.parse(String(event.data))));
  return { ...fake, socket, received };
}

const clientCall = { type: 'function_call', call_id: 'c1', name: 'read_document' };
const serverCall = { type: 'function_call', call_id: 's1', name: 'web_search', executor: 'server' };

describe('withBosonWebSearch', () => {
  it('adds the hosted web_search tool to session updates that list tools, once', async () => {
    const { socket, sent } = await open();
    socket.send(JSON.stringify({ type: 'session.update', session: { tools: [{ type: 'function', name: 'read_document' }] } }));
    socket.send(JSON.stringify({ type: 'session.update', session: { instructions: 'only instructions' } }));
    socket.send(JSON.stringify({ type: 'session.update', session: { tools: [{ type: 'web_search' }] } }));
    socket.send(JSON.stringify({ type: 'response.create' }));
    expect(sent).toEqual([
      { type: 'session.update', session: { tools: [{ type: 'function', name: 'read_document' }, { type: 'web_search' }] } },
      { type: 'session.update', session: { instructions: 'only instructions' } },
      { type: 'session.update', session: { tools: [{ type: 'web_search' }] } },
      { type: 'response.create' },
    ]);
  });

  it('hides the calls Boson runs itself, and only those, from vRealTime', async () => {
    const { receive, received } = await open();
    receive({ type: 'response.output_item.added', item: serverCall });
    receive({ type: 'response.function_call_arguments.delta', call_id: 's1', delta: '{"q' });
    receive({ type: 'response.function_call_arguments.done', call_id: 's1', name: 'web_search', arguments: '{"query":"x"}' });
    receive({ type: 'response.output_item.added', item: clientCall });
    receive({ type: 'response.function_call_arguments.done', call_id: 'c1', name: 'read_document', arguments: '{}' });
    receive({ type: 'response.done', response: { id: 'r1', output: [serverCall, { type: 'message' }, clientCall] } });
    receive({ type: 'response.done', response: { id: 'r2', output: [serverCall] } });
    receive({ type: 'response.output_audio.delta', delta: 'AAAA' });
    expect(received).toEqual([
      { type: 'response.output_item.added', item: clientCall },
      { type: 'response.function_call_arguments.done', call_id: 'c1', name: 'read_document', arguments: '{}' },
      { type: 'response.done', response: { id: 'r1', output: [{ type: 'message' }, clientCall] } },
      { type: 'response.done', response: { id: 'r2', output: [] } },
      { type: 'response.output_audio.delta', delta: 'AAAA' },
    ]);
  });
});
