import { ModelRegistry } from '@vdoc-server/adapter-vrt';
import { loadConfig } from '@vdoc-server/config';
import { connect } from '@vrealtime/client';
import { fakeModel } from '@vrealtime/testing';
import { expect, it } from 'vitest';
import { createNodeServer } from '../src/create';
import { startNodeServer } from '../src/node-server';

it('forwards client setContext to its live model and keeps voice sessions isolated', async () => {
  const key = 'context-test-client-key-at-least-24-characters';
  const config = loadConfig({ VDOC_SERVER_ENV: 'test', VDOC_SERVER_CLIENTS: `web:${key}`, VDOC_SERVER_LOG_LEVEL: 'error' });
  if (!config.ok) throw new Error(config.errors.join('; '));
  const model = fakeModel();
  const server = await createNodeServer(config.value, { models: new ModelRegistry().register({ id: 'fake', create: () => model }) });
  const running = await startNodeServer(server, { port: 0 });
  const base = `http://127.0.0.1:${running.port}`;
  const sessions: Awaited<ReturnType<typeof connect>>[] = [];
  try {
    for (const doc of ['context-a', 'context-b']) {
      const response = await fetch(`${base}/v1/documents/${doc}/voice-sessions`, { method: 'POST', headers: { authorization: `Bearer ${key}` } });
      expect(response.status).toBe(201);
      const grant = await response.json() as { realtimePath: string; grant: { token: string } };
      sessions.push(await connect(`ws://127.0.0.1:${running.port}${grant.realtimePath}`, { auth: grant.grant.token, reconnect: false, context: { documentId: doc, title: doc, language: 'en' } }));
    }
    sessions[0]!.setContext({ documentId: 'context-a', title: 'Updated\nplan', language: 'zh-CN', vocabulary: ['vdoc', 'vdoc'] });
    await expect.poll(() => model.sessions[0]!.config.instructions).toContain('Updated plan');
    expect(model.sessions[0]!.config.inputTranscription).toEqual({ language: 'zh', vocabulary: ['vdoc'] });
    expect(model.sessions[1]!.config.instructions).toContain('context-b');
    expect(model.sessions[1]!.config.instructions).not.toContain('Updated plan');
  } finally {
    await Promise.all(sessions.map((session) => session.close()));
    await running.close();
  }
});
