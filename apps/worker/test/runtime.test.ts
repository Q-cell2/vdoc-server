import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { VoiceSessionSnapshot } from '@vdoc-server/domain';

let mf: Miniflare;
let options: Parameters<typeof convertV4MiniflareOptions>[0];
let persist: string;
const clientKey = 'runtime-test-client-key-not-for-production';
const headers = { authorization: `Bearer ${clientKey}`, 'content-type': 'application/json' };
// Only this test bundle exposes direct storage inspection/seeding. The production
// Worker has no test routes or RPC methods. Inherit its real constructor/alarm.
const harness = `
import worker, { DocumentVoiceRoom, PrincipalQuotaRoom } from './apps/worker/src/index.ts';
export class TestQuotaRoom extends PrincipalQuotaRoom {
  async fetch(request) {
    if (request.method === 'POST') {
      await this.ctx.storage.put('quota', await request.json());
      await this.ctx.storage.setAlarm(Date.now());
      return new Response(null, { status: 204 });
    }
    return Response.json({ state: await this.ctx.storage.get('quota'), alarm: await this.ctx.storage.getAlarm() });
  }
}
export default worker;
export class TestRoom extends DocumentVoiceRoom {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.searchParams.has('__quota')) return this.env.PRINCIPAL_QUOTAS.get(this.env.PRINCIPAL_QUOTAS.idFromName(url.searchParams.get('__quota'))).fetch(request);
    if (url.searchParams.has('__inspect')) return Response.json({ snapshot: await this.ctx.storage.get('voice-session:' + url.searchParams.get('__inspect')), alarm: await this.ctx.storage.getAlarm() });
    if (url.searchParams.has('__seed')) { const snapshot = await request.json(); await this.ctx.storage.put('voice-session:' + snapshot.id, snapshot); await this.ctx.storage.setAlarm(Date.now()); return new Response(null, { status: 204 }); }
    return super.fetch(request);
  }
}
`;
async function room(documentId: string) {
  const base = `https://voice.test/v1/documents/${documentId}/voice-sessions`;
  return {
    inspect: async (id: string) => (await mf.dispatchFetch(`${base}?__inspect=${id}`)).json() as Promise<{ snapshot?: VoiceSessionSnapshot; alarm: number | null }>,
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
    compatibilityDate: '2026-09-01', durableObjects: { VOICE_ROOMS: { className: 'TestRoom', useSQLite: true }, PRINCIPAL_QUOTAS: { className: 'TestQuotaRoom', useSQLite: true } },
    bindings: { VDOC_SERVER_ENV: 'test', VDOC_SERVER_MODEL: 'fake', VDOC_SERVER_LOG_LEVEL: 'error',
      VDOC_SERVER_SIGNING_KEYS: 'test:runtime-only-signing-secret-at-least-32-characters',
      VDOC_SERVER_CLIENTS: `web:${clientKey},quota:runtime-quota-key-not-for-production`, VDOC_SERVER_GRANT_TTL_SECONDS: '60', VDOC_SERVER_CONCURRENCY: 'reject' },
  };
  mf = new Miniflare(convertV4MiniflareOptions(options));
  await mf.ready;
}, 30000);
afterAll(async () => { await mf?.dispose(); if (persist) await rm(persist, { recursive: true, force: true }); });

describe('SQLite Durable Objects in real workerd', () => {
  it('reclaims expired principal leases and hourly records through the quota alarm', async () => {
    const url = 'https://voice.test/v1/documents/quota-alarm/voice-sessions?__quota=alarm-only';
    const response = await mf.dispatchFetch(url, { method: 'POST', body: JSON.stringify({
      slots: [{ sessionId: 'abandoned', expiresAt: Date.now() - 1000, supersedes: [] }],
      starts: [{ sessionId: 'abandoned', at: Date.now() - 3_601_000 }],
    }) });
    expect(response.status).toBe(204);
    await expect.poll(async () => (await (await mf.dispatchFetch(url)).json() as { state?: unknown; alarm: number | null }), { timeout: 5000 }).toEqual({ alarm: null });
  });
  it('keeps principal quotas atomic across document DOs and durable across runtime restart', async () => {
    const quotaHeaders = { authorization: 'Bearer runtime-quota-key-not-for-production' };
    const post = (doc: string) => mf.dispatchFetch(`https://voice.test/v1/documents/${doc}/voice-sessions`, { method: 'POST', headers: quotaHeaders });
    const responses = await Promise.all(Array.from({ length: 8 }, async (_, index) => ({ doc: `principal-${index}`, response: await post(`principal-${index}`) })));
    const admitted: { doc: string; sessionId: string }[] = [];
    for (const { doc, response } of responses) {
      if (response.status === 201) admitted.push({ doc, ...(await response.json() as { sessionId: string }) });
      else { expect(response.status).toBe(429); await response.text(); }
    }
    expect(admitted).toHaveLength(3);
    await mf.dispose(); mf = new Miniflare(convertV4MiniflareOptions(options)); await mf.ready;
    const blocked = await post('principal-after-restart');
    expect(blocked.status).toBe(429); await blocked.text();
    const first = admitted[0]!;
    expect((await mf.dispatchFetch(`https://voice.test/v1/documents/${first.doc}/voice-sessions/${first.sessionId}`, { method: 'DELETE', headers: quotaHeaders })).status).toBe(204);
    const released = await post('principal-released');
    expect(released.status).toBe(201); await released.text();
  });
  it('serializes concurrent admissions and preserves the grant across a runtime restart', async () => {
    const responses = await Promise.all(Array.from({ length: 6 }, () => grant('concurrent')));
    expect(responses.filter(r => r.status === 201)).toHaveLength(1);
    expect(responses.filter(r => r.status === 409)).toHaveLength(5);
    const granted = await responses.find(r => r.status === 201)!.json() as { sessionId: string };
    await Promise.all(responses.filter(r => r.status !== 201).map(r => r.text()));
    const before = await (await room('concurrent')).inspect(granted.sessionId);
    expect(before.snapshot?.status).toBe('granted'); expect(before.alarm).not.toBeNull();
    await mf.dispose();
    mf = new Miniflare(convertV4MiniflareOptions(options)); await mf.ready;
    const after = await (await room('concurrent')).inspect(granted.sessionId);
    expect(after.snapshot).toEqual(before.snapshot);
    const wrong = await mf.dispatchFetch(`https://voice.test/v1/documents/another-doc/voice-sessions/${granted.sessionId}`, { headers });
    expect(wrong.status).toBe(404); await wrong.text();
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
