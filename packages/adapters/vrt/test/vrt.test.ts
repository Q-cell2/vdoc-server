import { describe, expect, it, vi } from 'vitest';
import { VirtualClock, fakeModel } from '@vrealtime/testing';
import { ModelRegistry, createModelRegistry, fakeProvider, observeErrors, toSessionConfig, withLifecycle } from '../src';

describe('ModelRegistry', () => {
  it('creates models by provider id and refuses unknown or duplicate providers', () => {
    const registry = new ModelRegistry().register(fakeProvider());
    expect(registry.create({ provider: 'fake' }).provider).toBe('fake');
    expect(() => registry.create({ provider: 'nope' })).toThrow(/nope/);
    expect(() => registry.register(fakeProvider())).toThrow(/already/);
  });

  it('registers only providers that have keys', () => {
    const registry = createModelRegistry({ bosonApiKey: 'b', fake: false });
    expect([registry.has('boson'), registry.has('openai'), registry.has('fake')]).toEqual([true, false, false]);
  });
});

describe('withLifecycle', () => {
  it('reports open and a single close, and leaves everything else to the wrapped session', async () => {
    const lifecycle = { opened: vi.fn(), closed: vi.fn() };
    const model = withLifecycle(new ModelRegistry().register(fakeProvider()).create({ provider: 'fake' }), lifecycle);
    const session = await model.connect({});
    expect(lifecycle.opened).toHaveBeenCalledTimes(1);
    expect(session.capabilities).toEqual(model.capabilities);
    await session.close();
    await session.close();
    expect(lifecycle.closed).toHaveBeenCalledTimes(1);
  });

  it('reports user input on committed audio, sent text and provider speech end, never on transcripts', async () => {
    const clock = new VirtualClock();
    const userInput = vi.fn();
    const model = withLifecycle(fakeModel({ clock, script: [
      { at: 5, event: { type: 'input.speech.end', atMs: 5 } },
      { at: 6, event: { type: 'input.transcript', itemId: 'u1', text: 'yes', final: true } },
      { at: 20, event: { type: 'input.speech.end', atMs: 20 } },
    ] }), { opened: vi.fn(), closed: vi.fn(), userInput });
    const session = await model.connect({});
    session.commitAudio();
    session.sendText('yes');
    expect(userInput).toHaveBeenCalledTimes(2);
    clock.advance(10);
    expect(userInput).toHaveBeenCalledTimes(3);
    await session.close();
    clock.advance(20);
    expect(userInput).toHaveBeenCalledTimes(3);
  });

  it('reports a failed connect and rethrows it', async () => {
    const refused = new Error('key refused');
    const lifecycle = { opened: vi.fn(), closed: vi.fn(), failed: vi.fn() };
    const { provider, id, capabilities } = fakeModel();
    const model = withLifecycle({ provider, id, capabilities, connect: () => Promise.reject(refused) }, lifecycle);
    await expect(model.connect({})).rejects.toBe(refused);
    expect(lifecycle.failed).toHaveBeenCalledExactlyOnceWith(refused);
    expect(lifecycle.opened).not.toHaveBeenCalled();
  });
});

describe('observeErrors', () => {
  function socket() {
    return { send: vi.fn(), close: vi.fn(), addEventListener: vi.fn(), bufferedAmount: 12 };
  }

  it('reports error frames and sends every frame unchanged', () => {
    const inner = socket();
    const report = vi.fn();
    const observed = observeErrors(inner, report);
    const audio = new Uint8Array([2, 0, 0, 0, 1, 9]);
    const error = JSON.stringify({ v: 1, seq: 3, type: 'error', code: 'MALFORMED', message: 'Invalid audio frame', recoverable: true });
    observed.send(audio);
    observed.send(JSON.stringify({ v: 1, seq: 1, type: 'transcript', role: 'user', itemId: 'u1', text: 'an "error" here', final: true }));
    observed.send(error);
    expect(inner.send.mock.calls).toEqual([[audio], [expect.stringContaining('transcript')], [error]]);
    expect(report).toHaveBeenCalledExactlyOnceWith({ code: 'MALFORMED', message: 'Invalid audio frame', recoverable: true });
  });

  it('passes the rest of the socket through', () => {
    const inner = socket();
    const observed = observeErrors(inner, vi.fn());
    const listener = vi.fn();
    observed.addEventListener?.('message', listener);
    observed.close(1011, 'session start failed');
    expect(inner.addEventListener).toHaveBeenCalledWith('message', listener);
    expect(inner.close).toHaveBeenCalledWith(1011, 'session start failed');
    expect(observed.bufferedAmount).toBe(12);
    inner.bufferedAmount = 0;
    expect(observed.bufferedAmount).toBe(0);
  });
});

describe('toSessionConfig', () => {
  it('maps settings to vRealTime config with ISO 639-1 language codes', () => {
    expect(toSessionConfig({ model: { provider: 'boson' }, instructions: 'i', voice: 'default', turnDetection: 'semantic', language: 'zh-CN', vocabulary: ['vdoc'] }))
      .toEqual({ instructions: 'i', turnDetection: 'semantic', voice: 'default', inputTranscription: { language: 'zh', vocabulary: ['vdoc'] } });
    expect(toSessionConfig({ model: { provider: 'fake' }, instructions: 'i', voice: undefined, turnDetection: 'server', language: 'en', vocabulary: [] }))
      .toEqual({ instructions: 'i', turnDetection: 'server', inputTranscription: { language: 'en', vocabulary: [] } });
  });
});
