import { RecordingEventPublisher } from '@vdoc-server/adapter-memory';
import { ModelRegistry } from '@vdoc-server/adapter-vrt';
import { loadConfig } from '@vdoc-server/config';
import { boson, type ProviderSocket } from '@vrealtime/boson';
import { connect } from '@vrealtime/client';
import { expect, it, vi } from 'vitest';
import { createNodeServer } from '../src/create';
import { startNodeServer } from '../src/node-server';

/** Real HTTP/WebSocket/client and provider adapter; only the upstream socket is simulated. */
it('continues a raw truncated response, runs a client read, and finishes one turn with complete metrics', async () => {
  const listeners: ((event: { data?: unknown }) => void)[] = [];
  const sent: Record<string, unknown>[] = [];
  const socket: ProviderSocket = {
    readyState: 1,
    addEventListener(type, listener) { if (type === 'message') listeners.push(listener); },
    send(data) { sent.push(JSON.parse(data) as Record<string, unknown>); },
    close() {},
  };
  const upstream = (message: Record<string, unknown>) => {
    for (const listener of listeners) listener({ data: JSON.stringify(message) });
  };
  const model = boson({ apiKey: 'test-key', socket: () => socket });
  const key = 'continuation-test-client-key-at-least-24';
  const config = loadConfig({ VDOC_SERVER_ENV: 'test', VDOC_SERVER_CLIENTS: `web:${key}`, VDOC_SERVER_MODEL: 'fake', VDOC_SERVER_LOG_LEVEL: 'error' });
  if (!config.ok) throw new Error(config.errors.join('; '));
  const events = new RecordingEventPublisher();
  const telemetry = new RecordingEventPublisher();
  const server = await createNodeServer(config.value, {
    models: new ModelRegistry().register({ id: 'fake', create: () => model }),
    subscribers: [events], telemetrySubscribers: [telemetry],
  });
  const running = await startNodeServer(server, { port: 0 });
  try {
    const grant = await fetch(`http://127.0.0.1:${running.port}/v1/documents/continuation-doc/voice-sessions`, { method: 'POST', headers: { authorization: `Bearer ${key}` } });
    expect(grant.status).toBe(201);
    const created = await grant.json() as { sessionId: string; realtimePath: string; grant: { token: string } };
    const run = vi.fn(() => ({ text: 'document contents' }));
    const client = await connect(`ws://127.0.0.1:${running.port}${created.realtimePath}`, {
      auth: created.grant.token, reconnect: false,
      context: { documentId: 'continuation-doc' },
      tools: { read_document: { parameters: { type: 'object' }, run } },
    });
    try {
      const respondCount = () => sent.filter(message => message.type === 'response.create').length;
      client.sendText('read the document and finish');
      await expect.poll(respondCount).toBe(1);
      upstream({ type: 'response.created', response: { id: 'r1' } });
      upstream({ type: 'response.output_text.delta', response_id: 'r1', delta: 'I will read' });
      const truncated = { type: 'response.done', response: { id: 'r1', status: 'incomplete', status_details: { reason: 'max_output_tokens' }, usage: { input_tokens: 3, output_tokens: 2 } } };
      upstream(truncated);
      upstream(truncated);
      await expect.poll(respondCount).toBe(2);
      expect(events.events.filter(e => e.type === 'TurnCompleted')).toHaveLength(0);
      upstream({ type: 'response.created', response: { id: 'r2' } });
      upstream({ type: 'response.function_call_arguments.done', response_id: 'r2', call_id: 'read-1', name: 'read_document', arguments: '{}' });
      upstream({ type: 'response.done', response: { id: 'r2', status: 'completed', output: [{ type: 'function_call' }], usage: { input_tokens: 4, output_tokens: 2 } } });
      await expect.poll(respondCount).toBe(3);
      expect(run).toHaveBeenCalledTimes(1);
      expect(sent.filter(message => message.type === 'conversation.item.create' && (message.item as { type: string }).type === 'function_call_output')).toHaveLength(1);
      upstream({ type: 'response.created', response: { id: 'r3' } });
      const done = { type: 'response.done', response: { id: 'r3', status: 'completed', usage: { input_tokens: 5, output_tokens: 1 } } };
      upstream(done);
      upstream(done);
      await expect.poll(() => events.events.filter(e => e.type === 'TurnCompleted').length).toBe(1);
      await expect.poll(() => telemetry.events.filter(e => e.type === 'TurnTelemetry').length).toBe(1);
      expect(telemetry.events[0]).toMatchObject({ aggregateId: created.sessionId, modelToolCalls: 1, continuations: 2, stopReason: 'completed' });
      expect(telemetry.events[0]).not.toHaveProperty('rawStopReason');
      expect(respondCount()).toBe(3);
    } finally { await client.close(); }
  } finally { await running.close(); }
});
