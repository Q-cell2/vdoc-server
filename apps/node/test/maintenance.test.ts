import { loadConfig } from '@vdoc-server/config';
import { describe, expect, it, vi } from 'vitest';
import { harness } from '../../../packages/application/test/fakes';
import { createNodeServer } from '../src/create';
import { startNodeServer } from '../src/node-server';

const key = 'maintenance-node-test-key-not-production';
function config() {
  const loaded = loadConfig({ VDOC_SERVER_ENV: 'test', VDOC_SERVER_MODEL: 'fake', VDOC_SERVER_LOG_LEVEL: 'error', VDOC_SERVER_CLIENTS: `web:${key}` });
  if (!loaded.ok) throw new Error(loaded.errors.join('; '));
  return loaded.value;
}

describe('Node maintenance scheduling', () => {
  it('expires sessions without a query and stops maintenance on shutdown', async () => {
    const h = harness();
    const server = await createNodeServer(config(), { sessions: h.repository, clock: h.clock, subscribers: [h.events] });
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const running = await startNodeServer(server, { port: 0 });
    let closed = false;
    try {
      const granted = await server.application.grantVoiceSession.execute({ credentials: { bearer: key, trustedUserId: 'user' }, documentId: 'idle' });
      if (!granted.ok) throw new Error(granted.error.message);
      const id = granted.value.session.sessionId;
      h.clock.advance(60_001);
      await vi.advanceTimersByTimeAsync(1000);
      expect(h.repository.rows.get(id)).toMatchObject({ status: 'ended', endReason: 'expired' });
      expect(h.events.events.filter(event => event.type === 'VoiceSessionEnded')).toHaveLength(1);
      await running.close();
      closed = true;
      const execute = vi.spyOn(server.application.sessionMaintenance, 'execute');
      await vi.advanceTimersByTimeAsync(3000);
      expect(execute).not.toHaveBeenCalled();
    } finally {
      if (!closed) await running.close();
      vi.useRealTimers();
    }
  });

  it('coalesces timer ticks while a previous maintenance command is pending', async () => {
    const server = await createNodeServer(config());
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    const execute = vi.spyOn(server.application.sessionMaintenance, 'execute').mockReturnValue(pending);
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const running = await startNodeServer(server, { port: 0 });
    try {
      await vi.advanceTimersByTimeAsync(10_000);
      expect(execute).toHaveBeenCalledTimes(1);
      finish();
      await vi.advanceTimersByTimeAsync(1000);
      expect(execute).toHaveBeenCalledTimes(2);
    } finally {
      finish();
      await running.close();
      vi.useRealTimers();
    }
  });
});
