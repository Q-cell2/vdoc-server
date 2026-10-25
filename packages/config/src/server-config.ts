import { SessionLimits, type ConcurrencyStrategy, type ModelChoice } from '@vdoc-server/domain';

export type Environment = 'development' | 'test' | 'production';
export type WorkerThinking = 'off' | 'low' | 'medium' | 'high';
const WORKER_THINKING = new Set<string>(['off', 'low', 'medium', 'high']);

/** Everything a composition root needs, already validated. */
export interface ServerConfig {
  readonly environment: Environment;
  readonly allowClientOnly: boolean;
  readonly logLevel: 'debug' | 'info' | 'warn' | 'error';
  /** First key signs; all verify. */
  readonly signingKeys: readonly { readonly id: string; readonly secret: Uint8Array }[];
  readonly clients: readonly { readonly id: string; readonly name: string; readonly key: string }[];
  /** Browser origins allowed to call the HTTP API. Empty means no CORS headers. */
  readonly allowedOrigins: readonly string[];
  readonly model: ModelChoice;
  readonly providerKeys: { readonly boson?: string; readonly openai?: string; readonly anthropic?: string };
  readonly workerAgent: { readonly model: string; readonly thinking: WorkerThinking; readonly prefetch: boolean; readonly timeoutMs: number; readonly maxRequests: number };
  readonly concurrency: ConcurrencyStrategy;
  readonly limits: SessionLimits;
  /** Development-only defaults that were filled in (logged at startup). */
  readonly generated: readonly string[];
}

export type Env = Readonly<Record<string, string | undefined>>;

const DEV_CLIENT_KEY = 'vdoc-dev-client-key-not-for-production';
const MODELS = new Set(['boson', 'boson-worker', 'openai', 'cascade-claude', 'fake']);

/**
 * Parses and validates configuration in one pass and reports every problem at
 * once (fail fast at startup, never at the first request). Development fills in
 * safe throwaway defaults; production requires everything explicitly.
 */
export function loadConfig(env: Env): { ok: true; value: ServerConfig } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const generated: string[] = [];
  const environment = parseEnvironment(env.VDOC_SERVER_ENV ?? env.NODE_ENV, errors);
  const production = environment === 'production';
  const legacy = env.VDOC_SERVER_ALLOW_CLIENT_ONLY;
  if (legacy !== undefined && legacy !== 'true' && legacy !== 'false') errors.push('VDOC_SERVER_ALLOW_CLIENT_ONLY must be true or false.');
  const allowClientOnly = legacy === undefined ? !production : legacy === 'true';

  const signingKeys = parseList(env.VDOC_SERVER_SIGNING_KEYS).map((entry) => {
    const [id, secret] = splitOnce(entry, ':');
    if (!id || !secret || secret.length < 32) errors.push('VDOC_SERVER_SIGNING_KEYS entries must be "id:secret" with a secret of at least 32 characters.');
    return { id: id ?? '', secret: new TextEncoder().encode(secret ?? '') };
  });
  if (signingKeys.length === 0) {
    if (production) errors.push('VDOC_SERVER_SIGNING_KEYS is required in production.');
    else {
      signingKeys.push({ id: 'dev', secret: crypto.getRandomValues(new Uint8Array(32)) });
      generated.push('a random signing key (grants do not survive restarts)');
    }
  }

  const clients = parseList(env.VDOC_SERVER_CLIENTS).map((entry) => {
    const [id, key] = splitOnce(entry, ':');
    if (!id || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id) || /[^A-Za-z0-9._:-]/.test(id) || id.startsWith('usr_') || !key || key.length < 24) errors.push('VDOC_SERVER_CLIENTS entries must be "id:key" with a key of at least 24 characters.');
    return { id: id ?? '', name: id ?? '', key: key ?? '' };
  });
  if (clients.length === 0) {
    if (production) errors.push('VDOC_SERVER_CLIENTS is required in production.');
    else {
      clients.push({ id: 'vdoc-dev', name: 'vdoc (development)', key: DEV_CLIENT_KEY });
      generated.push(`the client key "${DEV_CLIENT_KEY}"`);
    }
  }

  const allowedOrigins = parseList(env.VDOC_SERVER_ALLOWED_ORIGINS);
  for (const origin of allowedOrigins) {
    if (origin === '*' ? production : !/^https?:\/\/[^/]+$/.test(origin)) errors.push(`VDOC_SERVER_ALLOWED_ORIGINS has an invalid origin "${origin}".`);
  }

  const providerKeys = { ...(env.BOSON_API_KEY ? { boson: env.BOSON_API_KEY } : {}), ...(env.OPENAI_API_KEY ? { openai: env.OPENAI_API_KEY } : {}), ...(env.ANTHROPIC_API_KEY ? { anthropic: env.ANTHROPIC_API_KEY } : {}) };
  const [provider, modelName] = splitOnce(env.VDOC_SERVER_MODEL ?? (providerKeys.boson ? providerKeys.anthropic ? 'boson-worker' : 'boson' : production ? '' : 'fake'), ':');
  if (!provider || !MODELS.has(provider)) errors.push(`VDOC_SERVER_MODEL must be one of ${[...MODELS].join(', ')} (optionally "provider:model").`);
  if (provider === 'fake' && production) errors.push('The fake model cannot run in production.');
  if ((provider === 'boson' || provider === 'boson-worker') && !providerKeys.boson) errors.push('BOSON_API_KEY is required for the boson model.');
  if (provider === 'openai' && !providerKeys.openai) errors.push('OPENAI_API_KEY is required for the openai model.');
  if (provider === 'cascade-claude' && !providerKeys.anthropic) errors.push('ANTHROPIC_API_KEY is required for the cascade-claude model.');
  if (provider === 'cascade-claude' && !providerKeys.openai) errors.push('OPENAI_API_KEY is required for the cascade-claude model (speech recognition and synthesis).');
  if (provider === 'boson-worker' && !providerKeys.anthropic) errors.push('ANTHROPIC_API_KEY is required for the boson-worker model.');
  const workerAgent = {
    model: env.VDOC_SERVER_WORKER_MODEL ?? 'claude-haiku-5-5',
    thinking: (env.VDOC_SERVER_WORKER_THINKING ?? 'off') as WorkerThinking,
    prefetch: env.VDOC_SERVER_WORKER_PREFETCH !== 'false',
    timeoutMs: integer(env.VDOC_SERVER_WORKER_TIMEOUT_MS, 90_000, errors, 'VDOC_SERVER_WORKER_TIMEOUT_MS'),
    maxRequests: integer(env.VDOC_SERVER_WORKER_MAX_REQUESTS, 12, errors, 'VDOC_SERVER_WORKER_MAX_REQUESTS'),
  };
  if (!workerAgent.model.trim()) errors.push('VDOC_SERVER_WORKER_MODEL cannot be empty.');
  if (!WORKER_THINKING.has(workerAgent.thinking)) errors.push('VDOC_SERVER_WORKER_THINKING must be off, low, medium or high.');
  const prefetch = env.VDOC_SERVER_WORKER_PREFETCH;
  if (prefetch !== undefined && prefetch !== 'true' && prefetch !== 'false') errors.push('VDOC_SERVER_WORKER_PREFETCH must be true or false.');
  if (workerAgent.timeoutMs > 300_000) errors.push('VDOC_SERVER_WORKER_TIMEOUT_MS cannot exceed 300000.');
  if (workerAgent.maxRequests > 12) errors.push('VDOC_SERVER_WORKER_MAX_REQUESTS cannot exceed 12.');
  const model: ModelChoice = { provider: provider ?? 'fake', ...(modelName ? { model: modelName } : {}) };

  const concurrency = env.VDOC_SERVER_CONCURRENCY ?? 'supersede';
  if (concurrency !== 'supersede' && concurrency !== 'reject') errors.push('VDOC_SERVER_CONCURRENCY must be "supersede" or "reject".');

  const limits = SessionLimits.create({
    grantTtlMs: seconds(env.VDOC_SERVER_GRANT_TTL_SECONDS, SessionLimits.defaults.grantTtlMs, errors, 'VDOC_SERVER_GRANT_TTL_SECONDS'),
    maxDurationMs: seconds(env.VDOC_SERVER_MAX_SESSION_MINUTES, SessionLimits.defaults.maxDurationMs, errors, 'VDOC_SERVER_MAX_SESSION_MINUTES', 60),
    maxTurns: integer(env.VDOC_SERVER_MAX_TURNS, SessionLimits.defaults.maxTurns, errors, 'VDOC_SERVER_MAX_TURNS'),
    maxToolCallsPerTurn: integer(env.VDOC_SERVER_MAX_TOOL_CALLS_PER_TURN, SessionLimits.defaults.maxToolCallsPerTurn, errors, 'VDOC_SERVER_MAX_TOOL_CALLS_PER_TURN'),
  });
  if (!limits.ok) errors.push(limits.error.message);

  const logLevel = env.VDOC_SERVER_LOG_LEVEL ?? 'info';
  if (!['debug', 'info', 'warn', 'error'].includes(logLevel)) errors.push('VDOC_SERVER_LOG_LEVEL must be debug, info, warn or error.');

  if (errors.length > 0 || !limits.ok) return { ok: false, errors: [...new Set(errors)] };
  return {
    ok: true,
    value: {
      environment, allowClientOnly, logLevel: logLevel as ServerConfig['logLevel'], signingKeys, clients, allowedOrigins, model, providerKeys,
      workerAgent, concurrency: concurrency as ConcurrencyStrategy, limits: limits.value, generated,
    },
  };
}

function parseEnvironment(value: string | undefined, errors: string[]): Environment {
  if (value === undefined || value === '' || value === 'development') return 'development';
  if (value === 'test' || value === 'production') return value;
  errors.push('VDOC_SERVER_ENV must be development, test or production.');
  return 'development';
}

const parseList = (value: string | undefined): string[] => (value ?? '').split(',').map((part) => part.trim()).filter(Boolean);

function splitOnce(value: string, separator: string): [string | undefined, string | undefined] {
  const index = value.indexOf(separator);
  return index < 0 ? [value || undefined, undefined] : [value.slice(0, index) || undefined, value.slice(index + 1) || undefined];
}

function integer(value: string | undefined, fallback: number, errors: string[], name: string): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) errors.push(`${name} must be a positive integer.`);
  return parsed;
}

function seconds(value: string | undefined, fallbackMs: number, errors: string[], name: string, unit = 1): number {
  return value === undefined ? fallbackMs : integer(value, 0, errors, name) * unit * 1000;
}
