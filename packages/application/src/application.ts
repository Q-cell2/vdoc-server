import type { SessionRepository } from './session-record';
import { RelaySessionOutbox, DisconnectEventHandler } from './session-events';
import { SessionLifecycle } from './session-lifecycle';
import { ExpireVoiceSession, SessionMaintenance } from './session-maintenance';
import { RecordUserInput } from './use-cases/record-user-input';
import { HandleRealtimeDisconnect } from './use-cases/handle-realtime-disconnect';
import type { AgentProfileRepository, DocumentSessionPolicy, RiskAssessor, ToolPolicy } from '@vdoc-server/domain';
import type { CallerAuthenticator, Clock, EventPublisher, GrantSigner, IdGenerator, RealtimeConnections } from './ports';
import { AuthorizeDelegatedTask } from './use-cases/authorize-delegated-task';
import { ConnectRealtime } from './use-cases/connect-realtime';
import { CompleteTurn } from './use-cases/complete-turn';
import { ConfigureRealtimeSession } from './use-cases/configure-realtime-session';
import { EndVoiceSession } from './use-cases/end-voice-session';
import { GetVoiceSession } from './use-cases/get-voice-session';
import { GrantVoiceSession } from './use-cases/grant-voice-session';
import { RecordToolResult } from './use-cases/record-tool-result';
import { RenewSessionGrant } from './use-cases/renew-session-grant';
import { GetRealtimeSessionDescriptor } from './use-cases/get-realtime-session-descriptor';
import { ReviewToolCall } from './use-cases/review-tool-call';
import { VoiceSessionStore } from './voice-session-store';

export type CommandRunner = <T>(command: () => Promise<T>) => Promise<T>;

/** Everything the use cases need; supplied by a composition root. */
export interface ApplicationDependencies {
  /** Runtime scope decides which commands must run sequentially (one document on Workers). */
  readonly runCommand?: CommandRunner;
  readonly sessions: SessionRepository;
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
  readonly recordUserInput: Pick<RecordUserInput, keyof RecordUserInput>;
  readonly handleRealtimeDisconnect: Pick<HandleRealtimeDisconnect, keyof HandleRealtimeDisconnect>;
  readonly expireVoiceSession: Pick<ExpireVoiceSession, keyof ExpireVoiceSession>;
  readonly relaySessionOutbox: Pick<RelaySessionOutbox, 'execute'>;
  readonly sessionMaintenance: Pick<SessionMaintenance, 'execute'>;
  readonly grantVoiceSession: Pick<GrantVoiceSession, keyof GrantVoiceSession>;
  readonly renewSessionGrant: Pick<RenewSessionGrant, keyof RenewSessionGrant>;
  readonly getVoiceSession: Pick<GetVoiceSession, keyof GetVoiceSession>;
  readonly endVoiceSession: Pick<EndVoiceSession, keyof EndVoiceSession>;
  readonly getRealtimeSessionDescriptor: Pick<GetRealtimeSessionDescriptor, keyof GetRealtimeSessionDescriptor>;
  readonly connectRealtime: Pick<ConnectRealtime, keyof ConnectRealtime>;
  readonly configureRealtimeSession: Pick<ConfigureRealtimeSession, keyof ConfigureRealtimeSession>;
  readonly reviewToolCall: Pick<ReviewToolCall, keyof ReviewToolCall>;
  readonly recordToolResult: Pick<RecordToolResult, keyof RecordToolResult>;
  readonly completeTurn: Pick<CompleteTurn, keyof CompleteTurn>;
  readonly authorizeDelegatedTask: Pick<AuthorizeDelegatedTask, keyof AuthorizeDelegatedTask>;
}

/** Factory: wires use cases to their ports. Composition roots call this once. */
export function createApplication(deps: ApplicationDependencies): Application {
  const store = new VoiceSessionStore(deps.sessions, deps.clock);
  const relay = new RelaySessionOutbox(deps.sessions, [new DisconnectEventHandler(deps.connections)], deps.events, deps.clock);
  const lifecycle = new SessionLifecycle(store, relay);
  const expire = new ExpireVoiceSession(store, lifecycle, deps.clock);
  const { profiles, authenticator, signer, clock, ids, admission } = deps;
  const app: Application = {
    recordUserInput: new RecordUserInput({ store, lifecycle, clock }),
    handleRealtimeDisconnect: new HandleRealtimeDisconnect({ store, lifecycle, clock }),
    expireVoiceSession: expire,
    relaySessionOutbox: relay,
    sessionMaintenance: new SessionMaintenance(deps.sessions, expire, relay, clock),
    grantVoiceSession: new GrantVoiceSession({ store, lifecycle, profiles, authenticator, signer, clock, ids, admission }),
    renewSessionGrant: new RenewSessionGrant({ store, lifecycle, authenticator, signer, clock }),
    getVoiceSession: new GetVoiceSession({ store, authenticator, clock }),
    endVoiceSession: new EndVoiceSession({ store, lifecycle, authenticator, clock }),
    getRealtimeSessionDescriptor: new GetRealtimeSessionDescriptor({ store, profiles, clock }),
    connectRealtime: new ConnectRealtime({ store, lifecycle, signer, clock }),
    configureRealtimeSession: new ConfigureRealtimeSession({ store, profiles, clock }),
    reviewToolCall: new ReviewToolCall({ store, lifecycle, profiles, policy: deps.toolPolicy, assessor: deps.riskAssessor, clock }),
    recordToolResult: new RecordToolResult({ store, lifecycle, clock }),
    completeTurn: new CompleteTurn({ store, lifecycle, clock }),
    authorizeDelegatedTask: new AuthorizeDelegatedTask({ store, profiles, authenticator, clock }),
  };
  if (!deps.runCommand) return app;
  return Object.fromEntries(Object.entries(app).map(([name, command]) => [name, {
    execute: (...args: unknown[]) => deps.runCommand!(() => (command.execute as (...args: unknown[]) => Promise<unknown>).apply(command, args)),
  }])) as unknown as Application;
}
