import { loadConfig } from '@vdoc-server/config';
import { createNodeServer } from './create';
import { startNodeServer } from './node-server';

const config = loadConfig(process.env);
if (!config.ok) {
  console.error(`vdoc-server: invalid configuration\n  - ${config.errors.join('\n  - ')}`);
  process.exit(1);
}

const server = await createNodeServer(config.value);
const running = await startNodeServer(server, { port: Number(process.env.PORT ?? 8787), host: process.env.HOST ?? '127.0.0.1' });
server.logger.log('info', 'vdoc-server listening', { port: running.port, environment: config.value.environment, model: config.value.model.provider });
for (const generated of config.value.generated) server.logger.log('warn', `development default: ${generated}`);

const shutdown = async (signal: string): Promise<void> => {
  server.logger.log('info', 'shutting down', { signal });
  await running.close();
  process.exit(0);
};
process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
