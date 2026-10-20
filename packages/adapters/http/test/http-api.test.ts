import { appError, type Application } from '@vdoc-server/application';
import { describe, expect, it, vi } from 'vitest';
import { HttpApi, Router, closeCodeOf, documentIdOf, matchRealtimeRoute } from '../src';

type App = ConstructorParameters<typeof HttpApi>[0]['app'];
const view = { sessionId: 'vs_1', documentId: 'doc 1', profileId: 'p', status: 'granted', endReason: null, usage: { turns: 0, toolCalls: 0 } } as const;

function api(overrides: Partial<Record<keyof App, unknown>> = {}, origins: string[] = ['https://app.vdoc.test']) {
  const app = {
    grantVoiceSession: { execute: vi.fn(async () => ({ ok: true, value: { session: view, grant: { token: 't', expiresAt: 1 } } })) },
    getVoiceSession: { execute: vi.fn(async () => ({ ok: false, error: appError('NOT_FOUND', 'No such session.') })) },
    renewSessionGrant: { execute: vi.fn(async () => ({ ok: false, error: appError('UNAUTHENTICATED', 'Key required.') })) },
    endVoiceSession: { byClient: vi.fn(async () => ({ ok: true, value: undefined })) },
    ...overrides,
  } as unknown as Pick<Application, keyof App>;
  return { http: new HttpApi({ app, allowedOrigins: origins }), app };
}
const request = (method: string, path: string, init: RequestInit = {}) => new Request(`https://api.test${path}`, { method, ...init });

describe('HttpApi', () => {
  it('creates a session: 201, Location, realtime path, bearer passed through, path decoded', async () => {
    const { http, app } = api();
    const response = await http.handle(request('POST', '/v1/documents/doc%201/voice-sessions', { headers: { authorization: 'Bearer abc', 'content-type': 'application/json' }, body: '{"profileId":"p"}' }));
    expect(response.status).toBe(201);
    expect(response.headers.get('location')).toBe('/v1/documents/doc%201/voice-sessions/vs_1');
    expect(await response.json()).toMatchObject({ sessionId: 'vs_1', grant: { token: 't' }, realtimePath: '/v1/documents/doc%201/voice-sessions/vs_1/realtime' });
    expect(app.grantVoiceSession.execute).toHaveBeenCalledWith({ credentials: { bearer: 'abc', requestId: expect.any(String) }, documentId: 'doc 1', profileId: 'p' });
  });

  it('rejects bad bodies before reaching the use case', async () => {
    const { http, app } = api();
    expect((await http.handle(request('POST', '/v1/documents/d/voice-sessions', { headers: { 'content-type': 'application/json' }, body: '[1]' }))).status).toBe(400);
    expect((await http.handle(request('POST', '/v1/documents/d/voice-sessions', { headers: { 'content-type': 'text/plain' }, body: 'hi' }))).status).toBe(415);
    expect((await http.handle(request('POST', '/v1/documents/d/voice-sessions', { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ x: 'y'.repeat(5000) }) }))).status).toBe(413);
    expect(app.grantVoiceSession.execute).not.toHaveBeenCalled();
  });

  it('refuses a body declared too large without reading it', async () => {
    const { http, app } = api();
    const unread = new ReadableStream({ pull() { throw new Error('the body was read'); } });
    const response = await http.handle(new Request('https://api.test/v1/documents/d/voice-sessions', {
      method: 'POST', headers: { 'content-type': 'application/json', 'content-length': '1000000' }, body: unread, duplex: 'half',
    } as RequestInit));
    expect(response.status).toBe(413);
    expect(app.grantVoiceSession.execute).not.toHaveBeenCalled();
  });

  it('titles quota-unavailable problems', async () => {
    const { http } = api({ getVoiceSession: { execute: vi.fn(async () => ({ ok: false, error: { code: 'QUOTA_UNAVAILABLE', message: 'Try again.', retryAfterSeconds: 1 } })) } });
    const response = await http.handle(request('GET', '/v1/documents/d/voice-sessions/vs_1'));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ title: 'Service Unavailable', code: 'QUOTA_UNAVAILABLE' });
  });

  it('maps application errors to problem+json with stable codes', async () => {
    const { http } = api();
    const missing = await http.handle(request('GET', '/v1/documents/d/voice-sessions/vs_1'));
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ status: 404, code: 'NOT_FOUND' });
    const unauthorized = await http.handle(request('POST', '/v1/documents/d/voice-sessions/vs_1/grants'));
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get('www-authenticate')).toBe('Bearer');
    expect((await http.handle(request('DELETE', '/v1/documents/d/voice-sessions/vs_1'))).status).toBe(204);
  });

  it('handles unknown routes, wrong methods, plain realtime GETs and crashes', async () => {
    const { http } = api({ getVoiceSession: { execute: async () => { throw new Error('boom'); } } });
    expect((await http.handle(request('GET', '/nope'))).status).toBe(404);
    const wrong = await http.handle(request('PUT', '/v1/documents/d/voice-sessions'));
    expect([wrong.status, wrong.headers.get('allow')]).toEqual([405, 'POST']);
    expect((await http.handle(request('GET', '/v1/documents/d/voice-sessions/s/realtime'))).status).toBe(426);
    expect((await http.handle(request('GET', '/v1/documents/d/voice-sessions/s'))).status).toBe(500);
  });

  it('applies CORS only to allowed origins', async () => {
    const { http } = api();
    const allowed = await http.handle(request('GET', '/healthz', { headers: { origin: 'https://app.vdoc.test' } }));
    expect(allowed.headers.get('access-control-allow-origin')).toBe('https://app.vdoc.test');
    expect((await http.handle(request('GET', '/healthz', { headers: { origin: 'https://evil.test' } }))).headers.get('access-control-allow-origin')).toBeNull();
    expect((await http.handle(request('OPTIONS', '/v1/documents/d/voice-sessions', { headers: { origin: 'https://app.vdoc.test' } }))).status).toBe(204);
    expect((await http.handle(request('OPTIONS', '/v1/documents/d/voice-sessions', { headers: { origin: 'https://evil.test' } }))).status).toBe(403);
  });
});

describe('routing helpers', () => {
  it('matches realtime and document routes', () => {
    expect(matchRealtimeRoute('/v1/documents/a%20b/voice-sessions/vs_1/realtime')).toEqual({ documentId: 'a b', sessionId: 'vs_1' });
    expect(matchRealtimeRoute('/v1/documents/a/voice-sessions/vs_1')).toBeUndefined();
    expect(documentIdOf('/v1/documents/doc-7/voice-sessions')).toBe('doc-7');
    expect(documentIdOf('/healthz')).toBeUndefined();
    expect(new Router().on('GET', '/a/:id', async () => new Response()).match('GET', '/a/%E4%B8%AD')).toMatchObject({ kind: 'found', params: { id: '中' } });
  });

  it('maps refusals to WebSocket close codes', () => {
    expect(closeCodeOf('SESSION_CLOSED')).toBe(4410);
    expect(closeCodeOf('NOT_FOUND')).toBe(4404);
  });
});
