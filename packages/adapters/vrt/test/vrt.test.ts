import { describe, expect, it, vi } from 'vitest';
import { ModelRegistry, createModelRegistry, fakeProvider, toSessionConfig, withLifecycle } from '../src';

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
});

describe('toSessionConfig', () => {
  it('maps settings to vRealTime config with ISO 639-1 language codes', () => {
    expect(toSessionConfig({ model: { provider: 'boson' }, instructions: 'i', voice: 'default', turnDetection: 'semantic', language: 'zh-CN', vocabulary: ['vdoc'] }))
      .toEqual({ instructions: 'i', turnDetection: 'semantic', voice: 'default', inputTranscription: { language: 'zh', vocabulary: ['vdoc'] } });
    expect(toSessionConfig({ model: { provider: 'fake' }, instructions: 'i', voice: undefined, turnDetection: 'server', language: 'en', vocabulary: [] }))
      .toEqual({ instructions: 'i', turnDetection: 'server', inputTranscription: { language: 'en' } });
  });
});
