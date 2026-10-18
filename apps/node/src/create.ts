import { InMemoryVoiceSessionRepository } from '@vdoc-server/adapter-memory';
import { PostgresVoiceSessionRepository } from '@vdoc-server/adapter-postgres';
import { createModelRegistry, type FakeResponder } from '@vdoc-server/adapter-vrt';
import { createServer, type Server, type ServerParts } from '@vdoc-server/composition';
import type { ServerConfig } from '@vdoc-server/config';
import pg from 'pg';

/** Opens the session store: PostgreSQL (schema migrated) when a URL is given, otherwise memory. `close` releases the pool. */
export async function openSessionStore(databaseUrl: string | undefined): Promise<{ sessions: ServerParts['sessions']; close: () => Promise<void> }> {
  if (!databaseUrl) return { sessions: new InMemoryVoiceSessionRepository(), close: async () => {} };
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const sessions = new PostgresVoiceSessionRepository(pool);
  try {
    await sessions.migrate();
  } catch (error) {
    await pool.end();
    throw error;
  }
  return { sessions, close: () => pool.end() };
}

/** Node composition: in-memory sessions unless overridden, and the models the configuration has keys for. */
export function createNodeServer(config: ServerConfig, overrides: Partial<Omit<ServerParts, 'config'>> & { fakeResponder?: FakeResponder } = {}): Promise<Server> {
  const { fakeResponder, ...parts } = overrides;
  return createServer({
    config,
    sessions: new InMemoryVoiceSessionRepository(),
    models: createModelRegistry({
      bosonApiKey: config.providerKeys.boson,
      openaiApiKey: config.providerKeys.openai,
      fake: config.environment === 'production' ? false : fakeResponder ? { respond: fakeResponder } : {},
    }),
    ...parts,
  });
}
