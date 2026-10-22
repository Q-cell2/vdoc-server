import { HttpApi } from '@vdoc-server/adapter-http';
import { InMemoryAgentProfileRepository } from '@vdoc-server/adapter-memory';
import { ApiKeyAuthenticator, HmacGrantSigner, TrustedUserAuthenticator } from '@vdoc-server/adapter-security';
import { AuditLogPublisher, CompositeEventPublisher, JsonLogger, RandomIdGenerator, TurnMetricsPublisher, RealtimeConnectionEvents, systemClock } from '@vdoc-server/adapter-system';
import { RealtimeHost, type ModelRegistry, type Scheduler } from '@vdoc-server/adapter-vrt';
import { createApplication, type Application, type Clock, type CommandRunner, type EventPublisher, type SessionRepository } from '@vdoc-server/application';
import { editingAssistantProfile, type ServerConfig } from '@vdoc-server/config';
import { DocumentSessionPolicy, ProfileId, RiskAssessor, defaultToolPolicy } from '@vdoc-server/domain';

/** What differs between runtimes; everything else is built here once. */
export interface ServerParts {
  readonly config: ServerConfig;
  readonly sessions: SessionRepository;
  readonly runCommand?: CommandRunner;
  readonly models: ModelRegistry;
  readonly logger?: JsonLogger;
  readonly clock?: Clock;
  readonly scheduler?: Scheduler;
  /** Extra event subscribers (metrics, queues); the audit log is always on. */
  readonly subscribers?: readonly EventPublisher[];
  readonly telemetrySubscribers?: readonly EventPublisher[];
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
  const [signer, applications] = await Promise.all([HmacGrantSigner.create(config.signingKeys), ApiKeyAuthenticator.create(config.clients)]);

  const connections = new RealtimeConnectionEvents();
  // Workers provide a per-document runner. Node serializes this process's commands,
  // including fire-and-forget SDK callbacks, so read/modify/save cannot lose usage.
  let commandTail: Promise<unknown> = Promise.resolve();
  const runCommand: CommandRunner = parts.runCommand ?? ((command) => {
    const next = commandTail.then(command);
    commandTail = next.catch(() => undefined);
    return next;
  });
  const application = createApplication({
    sessions: parts.sessions,
    runCommand,
    profiles,
    authenticator: new TrustedUserAuthenticator(applications, config.allowClientOnly),
    signer,
    clock: parts.clock ?? systemClock,
    ids: new RandomIdGenerator(),
    events: new CompositeEventPublisher([new AuditLogPublisher(logger), new TurnMetricsPublisher(logger), ...(parts.subscribers ?? [])]),
    connections,
    admission: new DocumentSessionPolicy(config.concurrency),
    toolPolicy: defaultToolPolicy(),
    riskAssessor: new RiskAssessor(),
  });

  const realtime = new RealtimeHost({
    handlers: application, models: parts.models, logger,
    telemetry: new CompositeEventPublisher([new TurnMetricsPublisher(logger), ...(parts.telemetrySubscribers ?? [])]),
    ...(parts.scheduler ? { scheduler: parts.scheduler } : {}), ...parts.realtime,
  });
  connections.subscribe((id, reason) => realtime.close(id, reason));

  const http = new HttpApi({ app: application, allowedOrigins: config.allowedOrigins, logger });
  return { application, http, realtime, logger };
}
