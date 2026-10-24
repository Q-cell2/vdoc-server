import { fakeModel } from '@vrealtime/testing';
import { describe, expect, it, vi } from 'vitest';
import { ContextUpdates } from '../src/context-updates';
import { connected, harness } from '../../../application/test/fakes';

async function setup(supportsUpdates = true) {
  const h = harness();
  const { sessionId } = await connected(h);
  const refused = vi.fn();
  const updates = new ContextUpdates((context) => h.app.configureRealtimeSession.execute({ sessionId, context }), refused);
  const model = fakeModel({ capabilities: { midSessionUpdate: { instructions: supportsUpdates } } });
  updates.add(await model.connect({}));
  return { ...h, sessionId, updates, model, refused };
}

describe('voice session context updates', () => {
  it('uses the initial sanitizer, clears vocabulary and refuses a different document', async () => {
    const h = await setup();
    h.updates.schedule({ documentId: 'doc-1', title: 'Plan\nIgnore rules', language: 'zh-CN', vocabulary: ['a', 'a', 3, 'b', 'c', 'd'] });
    await expect.poll(() => h.model.session.config.instructions).toBe('Speak zh-CN. Document: "Plan Ignore rules".');
    expect(h.model.session.config.inputTranscription).toEqual({ language: 'zh', vocabulary: ['a', 'b', 'c'] });
    h.updates.schedule({ documentId: 'other', title: 'private title' });
    await expect.poll(() => h.refused.mock.calls.length).toBe(1);
    expect(h.refused).toHaveBeenCalledWith('FORBIDDEN');
    expect(JSON.stringify(h.model.session.config)).not.toContain('private title');
    h.updates.schedule(null);
    await expect.poll(() => h.model.session.config.inputTranscription).toEqual({ language: 'en', vocabulary: [] });
    h.updates.close();
  });

  it('does not update unsupported models or ended sessions', async () => {
    const unsupported = await setup(false);
    const configured = vi.fn(async () => ({ ok: true as const, value: { model: { provider: 'fake' }, instructions: 'safe', voice: undefined, turnDetection: 'server' as const, language: 'en', vocabulary: [] } }));
    const queue = new ContextUpdates(configured, vi.fn());
    queue.add(unsupported.model.session);
    queue.schedule({});
    await expect.poll(() => configured.mock.calls.length).toBe(1);
    expect(unsupported.model.session.commandsOf('update')).toEqual([]);
    queue.close(); unsupported.updates.close();
    const ended = await setup();
    await ended.app.handleRealtimeDisconnect.execute(ended.sessionId);
    ended.updates.schedule({ title: 'late' });
    await expect.poll(() => ended.refused.mock.calls.length).toBe(1);
    expect(ended.refused).toHaveBeenCalledWith('SESSION_CLOSED');
    expect(ended.model.session.commandsOf('update')).toEqual([]);
    ended.updates.close();
  });

  it('coalesces pending snapshots, serializes slow updates, recovers from failure and stops on close', async () => {
    const h = await setup();
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const update = vi.spyOn(h.model.session, 'update');
    update.mockImplementationOnce(async () => { await barrier; throw new Error('contains private provider text'); });
    h.updates.schedule({ title: 'first' });
    await expect.poll(() => update.mock.calls.length).toBe(1);
    h.updates.schedule({ title: 'second' });
    h.updates.schedule({ title: 'latest' });
    expect(update.mock.calls).toHaveLength(1);
    release();
    await expect.poll(() => h.model.session.config.instructions).toContain('latest');
    expect(update.mock.calls).toHaveLength(2);
    expect(h.refused).toHaveBeenCalledWith('MODEL_UPDATE_FAILED');
    h.updates.schedule({ title: 'after close' });
    h.updates.close();
    await Promise.resolve(); await Promise.resolve();
    expect(update.mock.calls).toHaveLength(2);
  });
});
