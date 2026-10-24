import { InMemoryVoiceSessionRepository } from '@vdoc-server/adapter-memory';
import { createModelRegistry, type FakeResponder } from '@vdoc-server/adapter-vrt';
import { createServer, type Server, type ServerParts } from '@vdoc-server/composition';
import type { ServerConfig } from '@vdoc-server/config';

/** Node composition: in-memory sessions and the models the configuration has keys for. */
export function createNodeServer(config: ServerConfig, overrides: Partial<Omit<ServerParts, 'config'>> & { fakeResponder?: FakeResponder } = {}): Promise<Server> {
  const { fakeResponder, ...parts } = overrides;
  return createServer({
    config,
    sessions: new InMemoryVoiceSessionRepository(),
    models: createModelRegistry({
      bosonApiKey: config.providerKeys.boson,
      openaiApiKey: config.providerKeys.openai,
      anthropicApiKey: config.providerKeys.anthropic,
      workerAgent: config.workerAgent,
      fake: config.environment === 'production' ? false : fakeResponder ? { respond: fakeResponder } : {},
    }),
    ...parts,
  });
}
