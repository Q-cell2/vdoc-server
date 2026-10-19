import { PrincipalQuota, SessionLimits, type ConcurrencyStrategy, type ModelChoice, type PrincipalQuotaLimits } from '@vdoc-server/domain';

export type Environment = 'development' | 'test' | 'production';

/** Everything a composition root needs, already validated. */
export interface ServerConfig {
  readonly environment: Environment;
  readonly logLevel: 'debug' | 'info' | 'warn' | 'error';
  /** First key signs; all verify. */
  readonly signingKeys: readonly { readonly id: string; readonly secret: Uint8Array }[];
  readonly clients: readonly { readonly id: string; readonly name: string; readonly key: string }[];
  /** Browser origins allowed to call the HTTP API. Empty means no CORS headers. */
  readonly allowedOrigins: readonly string[];
  readonly model: ModelChoice;
  readonly providerKeys: { readonly boson?: string; readonly openai?: string };
  readonly concurrency: ConcurrencyStrategy;
  readonly limits: SessionLimits;
  readonly quotas: PrincipalQuotaLimits;
  /** Development-only defaults that were filled in (logged at startup). */
  readonly generated: readonly string[];
}

export type Env = Readonly<Record<string, string | undefined>>;

const DEV_CLIENT_KEY = 'vdoc-dev-client-key-not-for-production';
const MODELS = new Set(['boson', 'openai', 'fake']);

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
    if (!id || !key || key.length < 24) errors.push('VDOC_SERVER_CLIENTS entries must be "id:key" with a key of at least 24 characters.');
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

  const providerKeys = { ...(env.BOSON_API_KEY ? { boson: env.BOSON_API_KEY } : {}), ...(env.OPENAI_API_KEY ? { openai: env.OPENAI_API_KEY } : {}) };
  const [provider, modelName] = splitOnce(env.VDOC_SERVER_MODEL ?? (providerKeys.boson ? 'boson' : production ? '' : 'fake'), ':');
  if (!provider || !MODELS.has(provider)) errors.push(`VDOC_SERVER_MODEL must be one of ${[...MODELS].join(', ')} (optionally "provider:model").`);
  if (provider === 'fake' && production) errors.push('The fake model cannot run in production.');
  if (provider === 'boson' && !providerKeys.boson) errors.push('BOSON_API_KEY is required for the boson model.');
  if (provider === 'openai' && !providerKeys.openai) errors.push('OPENAI_API_KEY is required for the openai model.');
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
  const quotas = parsePrincipalQuotaLimits(env, errors);
  if (!['debug', 'info', 'warn', 'error'].includes(logLevel)) errors.push('VDOC_SERVER_LOG_LEVEL must be debug, info, warn or error.');

  if (errors.length > 0 || !limits.ok) return { ok: false, errors: [...new Set(errors)] };
  return {
    ok: true,
    value: {
      environment, logLevel: logLevel as ServerConfig['logLevel'], signingKeys, clients, allowedOrigins, model, providerKeys,
      concurrency: concurrency as ConcurrencyStrategy, limits: limits.value, quotas, generated,
    },
  };
}

/** Also used by the principal DO, which does not create model/signing infrastructure. */
export function parsePrincipalQuotaLimits(env: Env, errors: string[]): PrincipalQuotaLimits {
  const maxConcurrentSessions = integer(env.VDOC_SERVER_MAX_CONCURRENT_SESSIONS_PER_PRINCIPAL, PrincipalQuota.defaults.maxConcurrentSessions, errors, 'VDOC_SERVER_MAX_CONCURRENT_SESSIONS_PER_PRINCIPAL');
  const maxSessionsPerHour = integer(env.VDOC_SERVER_MAX_SESSIONS_PER_HOUR, PrincipalQuota.defaults.maxSessionsPerHour, errors, 'VDOC_SERVER_MAX_SESSIONS_PER_HOUR');
  if (![maxConcurrentSessions, maxSessionsPerHour].every(Number.isSafeInteger)) errors.push('Principal quota limits must be safe integers.');
  return { maxConcurrentSessions, maxSessionsPerHour };
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
