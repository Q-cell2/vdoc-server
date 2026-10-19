import { HttpApi } from '@vdoc-server/adapter-http';
import { InMemoryAgentProfileRepository, InMemoryPrincipalQuotaStore } from '@vdoc-server/adapter-memory';
import { ApiKeyAuthenticator, HmacGrantSigner } from '@vdoc-server/adapter-security';
import { AuditLogPublisher, CompositeEventPublisher, JsonLogger, RandomIdGenerator, TurnMetricsPublisher, systemClock } from '@vdoc-server/adapter-system';
import { RealtimeHost, type ModelRegistry, type Scheduler } from '@vdoc-server/adapter-vrt';
import { createApplication, type Application, type Clock, type CommandRunner, type EventPublisher, type PrincipalQuotaStore } from '@vdoc-server/application';
import { editingAssistantProfile, type ServerConfig } from '@vdoc-server/config';
import { DocumentSessionPolicy, ProfileId, RiskAssessor, defaultToolPolicy, type VoiceSessionRepository } from '@vdoc-server/domain';

/** What differs between runtimes; everything else is built here once. */
export interface ServerParts {
  readonly config: ServerConfig;
  readonly sessions: VoiceSessionRepository;
  readonly quotas?: PrincipalQuotaStore;
  readonly runCommand?: CommandRunner;
  readonly models: ModelRegistry;
  readonly logger?: JsonLogger;
  readonly clock?: Clock;
  readonly scheduler?: Scheduler;
  /** Extra event subscribers (metrics, queues); the audit log is always on. */
  readonly subscribers?: readonly EventPublisher[];
  readonly realtime?: { resumeWindowMs?: number; heartbeatTimeoutMs?: number; clientToolTimeoutMs?: number };
}

export interface Server {
  readonly application: Application;
  readonly http: HttpApi;
  readonly realtime: RealtimeHost;
  readonly logger: JsonLogger;
}

/**
 * Composition root. The only place that knows concrete classes; every other
 * module depends on ports. Runtimes call this once per process (Node) or per
 * Durable Object instance (Workers).
 */
export async function createServer(parts: ServerParts): Promise<Server> {
  const { config } = parts;
  const logger = parts.logger ?? new JsonLogger(config.logLevel);
  if (!parts.models.has(config.model.provider)) throw new Error(`The configured model provider "${config.model.provider}" is not registered.`);

  const profile = editingAssistantProfile(config.model, config.limits);
  const profiles = new InMemoryAgentProfileRepository([profile], ProfileId.assume(profile.id));
  const [signer, authenticator] = await Promise.all([HmacGrantSigner.create(config.signingKeys), ApiKeyAuthenticator.create(config.clients)]);

  let application: Application | undefined;
  const realtime = new RealtimeHost({
    handlers: () => {
      if (!application) throw new Error('The application is not ready yet.');
      return application;
    },
    models: parts.models,
    logger,
    ...(parts.scheduler ? { scheduler: parts.scheduler } : {}),
    ...parts.realtime,
  });

  application = createApplication({
    sessions: parts.sessions,
    quotas: parts.quotas ?? new InMemoryPrincipalQuotaStore(config.quotas, () => (parts.clock ?? systemClock).now()),
    ...(parts.runCommand ? { runCommand: parts.runCommand } : {}),
    profiles,
    authenticator,
    signer,
    clock: parts.clock ?? systemClock,
    ids: new RandomIdGenerator(),
    events: new CompositeEventPublisher([new AuditLogPublisher(logger), new TurnMetricsPublisher(logger), ...(parts.subscribers ?? [])]),
    connections: realtime,
    admission: new DocumentSessionPolicy(config.concurrency),
    toolPolicy: defaultToolPolicy(),
    riskAssessor: new RiskAssessor(),
  });

  const http = new HttpApi({ app: application, allowedOrigins: config.allowedOrigins, logger });
  return { application, http, realtime, logger };
}
