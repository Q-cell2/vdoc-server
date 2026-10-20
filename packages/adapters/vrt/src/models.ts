import type { BosonOptions } from '@vrealtime/boson';
import { ModelRegistry } from './model-registry';
import { bosonProvider } from './providers/boson';
import { cascadeClaudeProvider } from './providers/cascade';
import { fakeProvider, type FakeResponder } from './providers/fake';
import { openaiProvider } from './providers/openai';

export interface ModelRegistryOptions {
  readonly bosonApiKey?: string | undefined;
  readonly bosonSocket?: BosonOptions['socket'];
  readonly openaiApiKey?: string | undefined;
  /** With `openaiApiKey` (speech), registers `cascade-claude`. */
  readonly anthropicApiKey?: string | undefined;
  /** Registers the scripted dev model. Never in production. */
  readonly fake?: false | { respond?: FakeResponder };
}

/** The providers a deployment can use, given the keys it has. */
export function createModelRegistry(options: ModelRegistryOptions): ModelRegistry {
  const registry = new ModelRegistry();
  if (options.bosonApiKey) registry.register(bosonProvider({ apiKey: options.bosonApiKey, ...(options.bosonSocket ? { socket: options.bosonSocket } : {}) }));
  if (options.openaiApiKey) registry.register(openaiProvider({ apiKey: options.openaiApiKey }));
  if (options.anthropicApiKey && options.openaiApiKey) registry.register(cascadeClaudeProvider({ anthropicApiKey: options.anthropicApiKey, openaiApiKey: options.openaiApiKey }));
  if (options.fake) registry.register(fakeProvider(options.fake.respond ? { respond: options.fake.respond } : {}));
  return registry;
}
