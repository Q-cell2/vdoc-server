import type { AgentProfileRepository, DocumentSessionPolicy, RiskAssessor, ToolPolicy, VoiceSessionRepository } from '@vdoc-server/domain';
import type { CallerAuthenticator, Clock, EventPublisher, GrantSigner, IdGenerator, PrincipalQuotaStore, RealtimeConnections } from './ports';
import { AuthorizeRealtimeConnection } from './use-cases/authorize-realtime-connection';
import { CompleteTurn } from './use-cases/complete-turn';
import { ConfigureRealtimeSession } from './use-cases/configure-realtime-session';
import { EndVoiceSession } from './use-cases/end-voice-session';
import { GetVoiceSession } from './use-cases/get-voice-session';
import { GrantVoiceSession } from './use-cases/grant-voice-session';
import { RecordToolResult } from './use-cases/record-tool-result';
import { RenewSessionGrant } from './use-cases/renew-session-grant';
import { ResolveRealtimeRoute } from './use-cases/resolve-realtime-route';
import { ReviewToolCall } from './use-cases/review-tool-call';
import { VoiceSessionStore } from './voice-session-store';

export type CommandRunner = <T>(command: () => Promise<T>) => Promise<T>;

/** Everything the use cases need; supplied by a composition root. */
export interface ApplicationDependencies {
  /** Runtime scope decides which commands must run sequentially (one document on Workers). */
  readonly runCommand?: CommandRunner;
  readonly sessions: VoiceSessionRepository;
  readonly quotas: PrincipalQuotaStore;
  readonly profiles: AgentProfileRepository;
  readonly authenticator: CallerAuthenticator;
  readonly signer: GrantSigner;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly events: EventPublisher;
  readonly connections: RealtimeConnections;
  readonly admission: DocumentSessionPolicy;
  readonly toolPolicy: ToolPolicy;
  readonly riskAssessor: RiskAssessor;
}

/** The application's public surface: one object per use case. */
export interface Application {
  readonly grantVoiceSession: Pick<GrantVoiceSession, keyof GrantVoiceSession>;
  readonly renewSessionGrant: Pick<RenewSessionGrant, keyof RenewSessionGrant>;
  readonly getVoiceSession: Pick<GetVoiceSession, keyof GetVoiceSession>;
  readonly endVoiceSession: Pick<EndVoiceSession, keyof EndVoiceSession>;
  readonly resolveRealtimeRoute: Pick<ResolveRealtimeRoute, keyof ResolveRealtimeRoute>;
  readonly authorizeRealtimeConnection: Pick<AuthorizeRealtimeConnection, keyof AuthorizeRealtimeConnection>;
  readonly configureRealtimeSession: Pick<ConfigureRealtimeSession, keyof ConfigureRealtimeSession>;
  readonly reviewToolCall: Pick<ReviewToolCall, keyof ReviewToolCall>;
  readonly recordToolResult: Pick<RecordToolResult, keyof RecordToolResult>;
  readonly completeTurn: Pick<CompleteTurn, keyof CompleteTurn>;
}

/** Factory: wires use cases to their ports. Composition roots call this once. */
export function createApplication(deps: ApplicationDependencies): Application {
  const store = new VoiceSessionStore(deps.sessions, deps.events, deps.connections, deps.quotas);
  const { profiles, authenticator, signer, clock, ids, admission } = deps;
  const app: Application = {
    grantVoiceSession: new GrantVoiceSession({ store, profiles, authenticator, signer, clock, ids, admission }),
    renewSessionGrant: new RenewSessionGrant({ store, authenticator, signer, clock }),
    getVoiceSession: new GetVoiceSession({ store, authenticator, clock }),
    endVoiceSession: new EndVoiceSession({ store, authenticator, clock }),
    resolveRealtimeRoute: new ResolveRealtimeRoute({ store, profiles, clock }),
    authorizeRealtimeConnection: new AuthorizeRealtimeConnection({ store, signer, clock }),
    configureRealtimeSession: new ConfigureRealtimeSession({ store, profiles, clock }),
    reviewToolCall: new ReviewToolCall({ store, profiles, policy: deps.toolPolicy, assessor: deps.riskAssessor, clock }),
    recordToolResult: new RecordToolResult({ store, clock }),
    completeTurn: new CompleteTurn({ store, clock }),
  };
  if (!deps.runCommand) return app;
  const run = deps.runCommand;
  const wrap = <Args extends unknown[], Value>(fn: (...args: Args) => Promise<Value>) =>
    (...args: Args): Promise<Value> => run(() => fn(...args));
  return {
    grantVoiceSession: { execute: wrap(app.grantVoiceSession.execute.bind(app.grantVoiceSession)) },
    renewSessionGrant: { execute: wrap(app.renewSessionGrant.execute.bind(app.renewSessionGrant)) },
    getVoiceSession: { execute: wrap(app.getVoiceSession.execute.bind(app.getVoiceSession)) },
    endVoiceSession: {
      byClient: wrap(app.endVoiceSession.byClient.bind(app.endVoiceSession)),
      bySystem: wrap(app.endVoiceSession.bySystem.bind(app.endVoiceSession)),
      expireIfOverdue: wrap(app.endVoiceSession.expireIfOverdue.bind(app.endVoiceSession)),
    },
    resolveRealtimeRoute: { execute: wrap(app.resolveRealtimeRoute.execute.bind(app.resolveRealtimeRoute)) },
    authorizeRealtimeConnection: { execute: wrap(app.authorizeRealtimeConnection.execute.bind(app.authorizeRealtimeConnection)) },
    configureRealtimeSession: { execute: wrap(app.configureRealtimeSession.execute.bind(app.configureRealtimeSession)) },
    reviewToolCall: { execute: wrap(app.reviewToolCall.execute.bind(app.reviewToolCall)) },
    recordToolResult: { execute: wrap(app.recordToolResult.execute.bind(app.recordToolResult)) },
    completeTurn: { execute: wrap(app.completeTurn.execute.bind(app.completeTurn)) },
  };
}
