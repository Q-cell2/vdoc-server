export { withLifecycle, type ModelLifecycle } from './lifecycle-model';
export { ModelRegistry, type ModelProvider } from './model-registry';
export { createModelRegistry, type ModelRegistryOptions } from './models';
export { bosonProvider } from './providers/boson';
export { cascadeClaudeProvider } from './providers/cascade';
export { DEFAULT_CLAUDE_MODEL, claudeText, type ClaudeTextOptions } from './providers/claude-text';
export { echoResponder, fakeProvider, type FakeReply, type FakeResponder } from './providers/fake';
export { openaiProvider } from './providers/openai';
export {
  RealtimeHost, RealtimeRoom, toSessionConfig,
  type RealtimeHandlers, type RealtimeHostOptions, type RealtimeLogger, type RealtimeRouteInput, type Scheduler,
} from './realtime-host';
export type { Connection, WebSocketLike } from '@vrealtime/server';
/** Workers' WebSocket cannot send auth headers; providers connect through a fetch upgrade instead. */
export { fetchSocket } from '@vrealtime/boson';
