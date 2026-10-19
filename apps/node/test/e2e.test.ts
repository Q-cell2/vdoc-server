import { RecordingEventPublisher } from '@vdoc-server/adapter-memory';
import type { FakeResponder } from '@vdoc-server/adapter-vrt';
import { loadConfig } from '@vdoc-server/config';
import { connect, type ClientSession } from '@vrealtime/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeServer } from '../src/create';
import { startNodeServer } from '../src/node-server';

const CLIENT_KEY = 'test-client-key-0123456789abcdef';
const deleteTable = { target: { kind: 'block', id: 'table-1' }, operations: [{ type: 'table.edit', action: 'deleteTable' }] };

/** Scripted model: "read" reads the document, "delete the table" asks to delete it, anything else is echoed. */
const respond: FakeResponder = (text) => {
  if (text.includes('delete the table')) return { say: 'Deleting the table.', toolCalls: [{ name: 'apply_document_operations', arguments: deleteTable }] };
  if (text.includes('read')) return { say: 'Reading.', toolCalls: [{ name: 'read_document', arguments: {} }] };
  return { say: text ? `You said ${text}` : 'Done.' };
};

let base = '';
let wsBase = '';
let close: () => Promise<void>;
const events = new RecordingEventPublisher();

beforeAll(async () => {
  const config = loadConfig({ VDOC_SERVER_ENV: 'test', VDOC_SERVER_CLIENTS: `vdoc-web:${CLIENT_KEY}`, VDOC_SERVER_MODEL: 'fake', VDOC_SERVER_LOG_LEVEL: 'error', VDOC_SERVER_MAX_CONCURRENT_SESSIONS_PER_PRINCIPAL: '100' });
  if (!config.ok) throw new Error(config.errors.join('; '));
  const server = await createNodeServer(config.value, { subscribers: [events], fakeResponder: respond, realtime: { resumeWindowMs: 150 } });
  const running = await startNodeServer(server, { port: 0 });
  base = `http://127.0.0.1:${running.port}`;
  wsBase = `ws://127.0.0.1:${running.port}`;
  close = running.close;
});
afterAll(() => close());

const auth = { authorization: `Bearer ${CLIENT_KEY}` };

async function grant(documentId: string): Promise<{ sessionId: string; grant: { token: string }; realtimePath: string }> {
  const response = await fetch(`${base}/v1/documents/${documentId}/voice-sessions`, { method: 'POST', headers: auth });
  expect(response.status).toBe(201);
  return response.json() as Promise<{ sessionId: string; grant: { token: string }; realtimePath: string }>;
}

async function status(documentId: string, sessionId: string): Promise<{ status: string; endReason: string | null; usage: { toolCalls: number } }> {
  const response = await fetch(`${base}/v1/documents/${documentId}/voice-sessions/${sessionId}`, { headers: auth });
  return response.json() as Promise<{ status: string; endReason: string | null; usage: { toolCalls: number } }>;
}

async function until(check: () => boolean | Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function openRealtime(documentId: string, granted: { realtimePath: string; grant: { token: string } }, calls: string[]): Promise<ClientSession> {
  const record = (name: string) => () => {
    calls.push(name);
    return { ok: true };
  };
  return connect(`${wsBase}${granted.realtimePath}`, {
    auth: granted.grant.token,
    reconnect: false,
    context: { documentId, title: 'Project plan', language: 'en', vocabulary: ['vdoc'] },
    tools: {
      read_document: { parameters: { type: 'object' }, run: record('read_document') },
      apply_document_operations: { parameters: { type: 'object' }, run: record('apply_document_operations') },
    },
  });
}

describe('HTTP API', () => {
  it('requires a client key', async () => {
    const response = await fetch(`${base}/v1/documents/doc-a/voice-sessions`, { method: 'POST' });
    expect(response.status).toBe(401);
    expect(response.headers.get('content-type')).toContain('application/problem+json');
    expect(await response.json()).toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('grants a session and reports it to its owner only', async () => {
    const granted = await grant('doc-b');
    expect(granted.grant.token).toMatch(/^vg1\./);
    expect(await status('doc-b', granted.sessionId)).toMatchObject({ status: 'granted' });
    const stranger = await fetch(`${base}/v1/documents/doc-other/voice-sessions/${granted.sessionId}`, { headers: auth });
    expect(stranger.status).toBe(404);
  });

  it('answers unknown routes and plain GETs of the realtime route with problems', async () => {
    expect((await fetch(`${base}/nope`)).status).toBe(404);
    const granted = await grant('doc-c');
    expect((await fetch(`${base}${granted.realtimePath}`)).status).toBe(426);
  });
});

describe('realtime voice session', () => {
  it('runs app-side tools through the policy and records them', async () => {
    const granted = await grant('doc-d');
    const calls: string[] = [];
    const session = await openRealtime('doc-d', granted, calls);
    session.sendText('please read it');
    await until(() => calls.includes('read_document'));
    await until(() => events.types().includes('ToolCallCompleted'));
    await until(() => events.events.some((event) => event.type === 'TurnCompleted' && event.aggregateId === granted.sessionId));
    expect(events.events.find((event) => event.type === 'TurnCompleted' && event.aggregateId === granted.sessionId)).toMatchObject({ modelToolCalls: 1 });
    expect(events.events.find((e) => e.type === 'ToolCallReviewed')).toMatchObject({ tool: 'read_document', decision: 'allow' });
    expect(await status('doc-d', granted.sessionId)).toMatchObject({ status: 'active' });
    await session.close();
  });

  it('asks before a destructive edit and runs it only when repeated in a later turn', async () => {
    const granted = await grant('doc-e');
    const calls: string[] = [];
    const session = await openRealtime('doc-e', granted, calls);
    session.sendText('delete the table');
    await until(() => events.events.some((e) => e.aggregateId === granted.sessionId && e.type === 'ToolCallReviewed'));
    expect(calls).toEqual([]);
    expect(events.events.filter((e) => e.aggregateId === granted.sessionId && e.type === 'ToolCallReviewed').at(-1)).toMatchObject({ decision: 'confirm', risk: 'high' });

    await until(async () => (await status('doc-e', granted.sessionId)).usage.toolCalls >= 1);
    await new Promise((resolve) => setTimeout(resolve, 150));
    session.sendText('yes, delete the table');
    await until(() => calls.includes('apply_document_operations'));
    await session.close();
  });

  it('refuses a connection with a bad grant', async () => {
    const granted = await grant('doc-f');
    await expect(openRealtime('doc-f', { ...granted, grant: { token: `${granted.grant.token}x` } }, [])).rejects.toThrow();
    const other = await grant('doc-g');
    await expect(openRealtime('doc-f', { ...granted, grant: other.grant }, [])).rejects.toThrow();
  });

  it('ends a session when its owner hangs up, and refuses to reconnect to it', async () => {
    const granted = await grant('doc-h');
    const session = await openRealtime('doc-h', granted, []);
    const closed = new Promise((resolve) => session.on('closed', resolve));
    const response = await fetch(`${base}/v1/documents/doc-h/voice-sessions/${granted.sessionId}`, { method: 'DELETE', headers: auth });
    expect(response.status).toBe(204);
    await closed;
    expect(await status('doc-h', granted.sessionId)).toMatchObject({ status: 'ended', endReason: 'client' });
    await expect(openRealtime('doc-h', granted, [])).rejects.toThrow(/4410/);
  });

  it('supersedes the previous session of the same document', async () => {
    const first = await grant('doc-i');
    const second = await grant('doc-i');
    expect(await status('doc-i', first.sessionId)).toMatchObject({ status: 'ended', endReason: 'superseded' });
    expect(await status('doc-i', second.sessionId)).toMatchObject({ status: 'granted' });
  });

  it('ends a session when nobody reconnects within the resume window', async () => {
    const granted = await grant('doc-j');
    const session = await openRealtime('doc-j', granted, []);
    await session.close();
    await until(async () => (await status('doc-j', granted.sessionId)).status === 'ended');
    expect(await status('doc-j', granted.sessionId)).toMatchObject({ endReason: 'disconnected' });
  });
});
