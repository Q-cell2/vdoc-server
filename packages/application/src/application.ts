import type { AgentProfileRepository, DocumentSessionPolicy, RiskAssessor, ToolPolicy, VoiceSessionRepository } from '@vdoc-server/domain';
import type { CallerAuthenticator, Clock, EventPublisher, GrantSigner, IdGenerator, RealtimeConnections } from './ports';
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

/** Everything the use cases need; supplied by a composition root. */
export interface ApplicationDependencies {
  readonly sessions: VoiceSessionRepository;
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
  readonly grantVoiceSession: GrantVoiceSession;
  readonly renewSessionGrant: RenewSessionGrant;
  readonly getVoiceSession: GetVoiceSession;
  readonly endVoiceSession: EndVoiceSession;
  readonly resolveRealtimeRoute: ResolveRealtimeRoute;
  readonly authorizeRealtimeConnection: AuthorizeRealtimeConnection;
  readonly configureRealtimeSession: ConfigureRealtimeSession;
  readonly reviewToolCall: ReviewToolCall;
  readonly recordToolResult: RecordToolResult;
  readonly completeTurn: CompleteTurn;
}

/** Factory: wires use cases to their ports. Composition roots call this once. */
export function createApplication(deps: ApplicationDependencies): Application {
  const store = new VoiceSessionStore(deps.sessions, deps.events, deps.connections);
  const { profiles, authenticator, signer, clock, ids, admission } = deps;
  return {
    grantVoiceSession: new GrantVoiceSession({ store, profiles, authenticator, signer, clock, ids, admission }),
    renewSessionGrant: new RenewSessionGrant({ store, authenticator, signer, clock }),
    getVoiceSession: new GetVoiceSession({ store, authenticator, clock }),
    endVoiceSession: new EndVoiceSession({ store, authenticator, clock }),
    resolveRealtimeRoute: new ResolveRealtimeRoute({ store, profiles, clock }),
    authorizeRealtimeConnection: new AuthorizeRealtimeConnection({ store, signer, clock }),
    configureRealtimeSession: new ConfigureRealtimeSession({ store, profiles }),
    reviewToolCall: new ReviewToolCall({ store, profiles, policy: deps.toolPolicy, assessor: deps.riskAssessor, clock }),
    recordToolResult: new RecordToolResult({ store, clock }),
    completeTurn: new CompleteTurn({ store, clock }),
  };
}
