import { loadConfig } from '@vdoc-server/config';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createNodeServer } from '../src/create';
import { startNodeServer } from '../src/node-server';

const key = 'quota-node-test-client-key-not-production';
let base: string;
let close: () => Promise<void>;
const headers = { authorization: `Bearer ${key}`, origin: 'https://vdoc.test' };
beforeAll(async () => {
  const config = loadConfig({ VDOC_SERVER_ENV: 'test', VDOC_SERVER_MODEL: 'fake', VDOC_SERVER_CLIENTS: `quota:${key}`,
    VDOC_SERVER_LOG_LEVEL: 'error', VDOC_SERVER_MAX_CONCURRENT_SESSIONS_PER_PRINCIPAL: '2', VDOC_SERVER_MAX_SESSIONS_PER_HOUR: '4', VDOC_SERVER_ALLOWED_ORIGINS: 'https://vdoc.test' });
  if (!config.ok) throw new Error(config.errors.join('; '));
  const running = await startNodeServer(await createNodeServer(config.value), { port: 0 });
  base = `http://127.0.0.1:${running.port}`;
  close = running.close;
});
afterAll(() => close?.());
const grant = (doc: string) => fetch(`${base}/v1/documents/${doc}/voice-sessions`, { method: 'POST', headers });
async function end(doc: string, response: Response) {
  const { sessionId } = await response.json() as { sessionId: string };
  expect((await fetch(`${base}/v1/documents/${doc}/voice-sessions/${sessionId}`, { method: 'DELETE', headers })).status).toBe(204);
}

it('atomically enforces cross-document concurrency and keeps hourly usage after hangup over HTTP', async () => {
  const results = await Promise.all(Array.from({ length: 8 }, async (_, index) => ({ doc: `quota-${index}`, response: await grant(`quota-${index}`) })));
  expect(results.filter(({ response }) => response.status === 201)).toHaveLength(2);
  const rejected = results.filter(({ response }) => response.status === 429);
  expect(rejected).toHaveLength(6);
  for (const { response } of rejected) {
    expect(response.headers.get('retry-after')).toMatch(/^\d+$/);
    expect(response.headers.get('access-control-expose-headers')).toContain('retry-after');
    expect(await response.json()).toMatchObject({ code: 'QUOTA_EXCEEDED', status: 429 });
  }
  for (const { doc, response } of results.filter(({ response }) => response.status === 201)) await end(doc, response);
  for (const doc of ['third', 'fourth']) await end(doc, await grant(doc));
  const limited = await grant('fifth');
  expect(limited.status).toBe(429);
  expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(3500);
  expect(await limited.json()).toMatchObject({ code: 'QUOTA_EXCEEDED' });
});
