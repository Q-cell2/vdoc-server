import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { VoiceSessionSnapshot } from '@vdoc-server/domain';
import type { AuditPage } from '@vdoc-server/adapter-cloudflare';

let mf: Miniflare;
let options: Parameters<typeof convertV4MiniflareOptions>[0];
let persist: string;
const clientKey = 'runtime-test-client-key-not-for-production';
const headers = { authorization: `Bearer ${clientKey}`, 'content-type': 'application/json' };
// Only this test bundle exposes direct storage inspection/seeding. The production
// Worker has no test routes. Inherit its real constructor/alarm and internal audit RPC.
const harness = `
import worker, { DocumentVoiceRoom } from './apps/worker/src/index.ts';
export default worker;
export class TestRoom extends DocumentVoiceRoom {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.searchParams.has('__inspect')) return Response.json({ snapshot: await this.ctx.storage.get('voice-session:' + url.searchParams.get('__inspect')), alarm: await this.ctx.storage.getAlarm() });
    if (url.searchParams.has('__audit')) return Response.json(this.auditEvents(url.searchParams.get('__audit')));
    if (url.searchParams.has('__seed')) { const snapshot = await request.json(); await this.ctx.storage.put('voice-session:' + snapshot.id, snapshot); await this.ctx.storage.setAlarm(Date.now()); return new Response(null, { status: 204 }); }
    return super.fetch(request);
  }
}
`;
async function room(documentId: string) {
  const base = `https://voice.test/v1/documents/${documentId}/voice-sessions`;
  return {
    inspect: async (id: string) => (await mf.dispatchFetch(`${base}?__inspect=${id}`)).json() as Promise<{ snapshot?: VoiceSessionSnapshot; alarm: number | null }>,
    audit: async (id: string) => (await mf.dispatchFetch(`${base}?__audit=${id}`)).json() as Promise<AuditPage>,
    seed: async (snapshot: VoiceSessionSnapshot) => { const response = await mf.dispatchFetch(`${base}?__seed=1`, { method: 'POST', body: JSON.stringify(snapshot) }); expect(response.status).toBe(204); },
  };
}
async function grant(documentId: string) {
  return mf.dispatchFetch(`https://voice.test/v1/documents/${documentId}/voice-sessions`, { method: 'POST', headers, body: '{}' });
}
beforeAll(async () => {
  const bundled = await build({ stdin: { contents: harness, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022', external: ['cloudflare:workers'] });
  persist = await mkdtemp(join(tmpdir(), 'vdoc-do-runtime-'));
  options = { resourcePersistencePath: persist, name: 'voice-runtime-test', modules: true, script: bundled.outputFiles[0]!.text,
    compatibilityDate: '2026-09-01', durableObjects: { VOICE_ROOMS: { className: 'TestRoom', useSQLite: true } },
    bindings: { VDOC_SERVER_ENV: 'test', VDOC_SERVER_MODEL: 'fake', VDOC_SERVER_LOG_LEVEL: 'error',
      VDOC_SERVER_SIGNING_KEYS: 'test:runtime-only-signing-secret-at-least-32-characters',
      VDOC_SERVER_CLIENTS: `web:${clientKey}`, VDOC_SERVER_GRANT_TTL_SECONDS: '60', VDOC_SERVER_CONCURRENCY: 'reject' },
  };
  mf = new Miniflare(convertV4MiniflareOptions(options));
  await mf.ready;
}, 30000);
afterAll(async () => { await mf?.dispose(); if (persist) await rm(persist, { recursive: true, force: true }); });

describe('SQLite Durable Objects in real workerd', () => {
  it('serializes concurrent admissions and preserves the grant across a runtime restart', async () => {
    const responses = await Promise.all(Array.from({ length: 6 }, () => grant('concurrent')));
    expect(responses.filter(r => r.status === 201)).toHaveLength(1);
    expect(responses.filter(r => r.status === 409)).toHaveLength(5);
    const granted = await responses.find(r => r.status === 201)!.json() as { sessionId: string };
    await Promise.all(responses.filter(r => r.status !== 201).map(r => r.text()));
    const before = await (await room('concurrent')).inspect(granted.sessionId);
    expect(before.snapshot?.status).toBe('granted'); expect(before.alarm).not.toBeNull();
    const audit = await (await room('concurrent')).audit(granted.sessionId);
    expect(audit.events.map((row) => row.event.type)).toEqual(['VoiceSessionGranted']);
    await mf.dispose();
    mf = new Miniflare(convertV4MiniflareOptions(options)); await mf.ready;
    const after = await (await room('concurrent')).inspect(granted.sessionId);
    expect(after.snapshot).toEqual(before.snapshot);
    expect(await (await room('concurrent')).audit(granted.sessionId)).toEqual(audit);
    const wrong = await mf.dispatchFetch(`https://voice.test/v1/documents/another-doc/voice-sessions/${granted.sessionId}`, { headers });
    expect(wrong.status).toBe(404); await wrong.text();
  });
  it('publishes grant and end events through normal Worker requests without exposing public audit routes', async () => {
    const response = await grant('audit');
    const { sessionId } = await response.json() as { sessionId: string };
    const ended = await mf.dispatchFetch(`https://voice.test/v1/documents/audit/voice-sessions/${sessionId}`, { method: 'DELETE', headers });
    expect(ended.status).toBe(204);
    const page = await (await room('audit')).audit(sessionId);
    expect(page.events.map((row) => row.event.type)).toEqual(['VoiceSessionGranted', 'VoiceSessionEnded']);
    const publicRoute = await mf.dispatchFetch(`https://voice.test/v1/documents/audit/voice-sessions/${sessionId}/events`, { headers });
    expect(publicRoute.status).toBe(404); await publicRoute.text();
    expect((await (await room('another-doc')).audit(sessionId)).events).toEqual([]);
  });
  it('expires an abandoned grant through its alarm without a session API request', async () => {
    const response = await grant('expires'); expect(response.status).toBe(201);
    const { sessionId } = await response.json() as { sessionId: string };
    const stub = await room('expires');
    const snapshot = (await stub.inspect(sessionId)).snapshot!;
    await stub.seed({ ...snapshot, connectDeadline: Date.now() + 100 });
    await expect.poll(async () => (await (await room('expires')).inspect(sessionId)).snapshot?.status, { timeout: 7000, interval: 100 }).toBe('ended');
    const state = await (await room('expires')).inspect(sessionId);
    expect(state.snapshot?.endReason).toBe('expired');
    expect(state.alarm).toBeGreaterThan(Date.now() + 6 * 86400000);
  });
  it('expires active snapshots and removes old ended data without new saves', async () => {
    const response = await grant('cleanup'); const { sessionId } = await response.json() as { sessionId: string };
    const stub = await room('cleanup'); const original = (await stub.inspect(sessionId)).snapshot!;
    await stub.seed({ ...original, status: 'active', startedAt: Date.now() - original.limits.maxDurationMs - 1000 });
    await expect.poll(async () => (await stub.inspect(sessionId)).snapshot?.endReason, { timeout: 5000 }).toBe('limit-duration');
    const ended = (await stub.inspect(sessionId)).snapshot!;
    await stub.seed({ ...ended, endedAt: Date.now() - 8 * 86400000 });
    await expect.poll(async () => (await stub.inspect(sessionId)).snapshot, { timeout: 5000 }).toBeUndefined();
    expect((await stub.inspect(sessionId)).alarm).toBeNull();
  });
});
