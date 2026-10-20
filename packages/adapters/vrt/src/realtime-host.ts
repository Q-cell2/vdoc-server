import type { AgentSessionSettings, AppError, Application, RealtimeConnections } from '@vdoc-server/application';
import { err, ok, type EndReason, type Result, type VoiceSessionId } from '@vdoc-server/domain';
import { defineAgent, type AgentDefinition, type SessionConfig } from '@vrealtime/core';
import { Hub, type Connection, type WebSocketLike } from '@vrealtime/server';
import { withLifecycle } from './lifecycle-model';
import type { ModelRegistry } from './model-registry';
import { ContextUpdates } from './context-updates';
import { observeErrors, type ProtocolError } from './protocol-errors';

/** The use cases the realtime edge drives. */
export type RealtimeHandlers = Pick<Application,
  'resolveRealtimeRoute' | 'authorizeRealtimeConnection' | 'configureRealtimeSession' |
  'reviewToolCall' | 'recordToolResult' | 'completeTurn' | 'endVoiceSession'>;

export interface RealtimeLogger {
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string, fields?: Readonly<Record<string, unknown>>): void;
}

export interface Scheduler {
  set(run: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface RealtimeHostOptions {
  /** Resolved lazily: the application needs this host as its `RealtimeConnections`. */
  readonly handlers: () => RealtimeHandlers;
  readonly models: ModelRegistry;
  readonly logger?: RealtimeLogger;
  readonly scheduler?: Scheduler;
  /** How long a dropped connection may resume before the session ends. Default 30 s. */
  readonly resumeWindowMs?: number;
  readonly heartbeatTimeoutMs?: number;
  /** Client tool calls without a result in this time fail as TIMEOUT. Default 15 s. */
  readonly clientToolTimeoutMs?: number;
  /** A room nobody ever connected to is dropped after this long. Default 2 min. */
  readonly unusedRoomMs?: number;
}

export interface RealtimeRouteInput {
  readonly documentId: string;
  readonly sessionId: string;
}

const MAX_LOGGED_MESSAGE = 200;

const defaultScheduler: Scheduler = {
  set: (run, ms) => {
    const handle = setTimeout(run, ms);
    (handle as { unref?: () => void }).unref?.();
    return handle;
  },
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** One voice session's realtime runtime: its own hub, model and hooks. */
export class RealtimeRoom {
  #liveModels = 0;
  #everOpened = false;
  #disposed = false;
  #userInputs = 0;
  readonly #reportedErrors = new Set<string>();

  constructor(
    readonly sessionId: string,
    readonly hub: Hub,
    private readonly onEmpty: (room: RealtimeRoom) => void,
    private readonly context: ContextUpdates,
    private readonly onProtocolError: (error: ProtocolError) => void,
  ) {}

  /** Event-style sockets (`ws`, browsers, Deno, Workers). Error frames sent on them are reported. */
  attach(socket: WebSocketLike, headers?: Headers): Connection {
    return this.hub.attach(observeErrors(socket, (error) => this.protocolError(error)), headers ? { headers } : {});
  }

  get disposed(): boolean { return this.#disposed; }
  get everOpened(): boolean { return this.#everOpened; }
  /** User utterances and text messages across this room's model sessions. In memory: a restart starts again at 0, which only makes pending confirmations ask again. */
  get userInputs(): number { return this.#userInputs; }

  /** @internal */ userInput(): void {
    this.#userInputs++;
  }

  /** @internal */ modelOpened(): void {
    this.#liveModels++;
    this.#everOpened = true;
  }

  /** @internal */ modelClosed(): void {
    this.#liveModels = Math.max(0, this.#liveModels - 1);
    if (this.#liveModels === 0) this.onEmpty(this);
  }

  /** @internal Each code once per session: a client streaming bad audio frames is one report, not one per frame. */
  protocolError(error: ProtocolError): void {
    if (this.#reportedErrors.has(error.code)) return;
    this.#reportedErrors.add(error.code);
    this.onProtocolError(error);
  }

  /** @internal */ markDisposed(): void {
    this.#disposed = true;
    this.context.close();
  }
}

/**
 * Adapter between vRealTime and the application. Each voice session gets its own
 * `Hub` and agent definition whose hooks are bound to that session, so every
 * hook call is attributed without trusting anything the client sends.
 * Implements the `RealtimeConnections` port so use cases can hang up sessions.
 */
export class RealtimeHost implements RealtimeConnections {
  readonly #rooms = new Map<string, RealtimeRoom>();
  readonly #scheduler: Scheduler;

  constructor(private readonly options: RealtimeHostOptions) {
    this.#scheduler = options.scheduler ?? defaultScheduler;
  }

  get size(): number {
    return this.#rooms.size;
  }

  /** Checks the route against an open session, then returns its room (created on first use). */
  async open(route: RealtimeRouteInput): Promise<Result<RealtimeRoom, AppError>> {
    const resolved = await this.options.handlers().resolveRealtimeRoute.execute(route);
    if (!resolved.ok) return resolved;
    const existing = this.#rooms.get(resolved.value.sessionId);
    if (existing && !existing.disposed) return ok(existing);
    try {
      return ok(this.#createRoom(route, resolved.value.model));
    } catch (error) {
      this.#log('error', 'realtime room could not start', { sessionId: route.sessionId, error: String(error) });
      return err({ code: 'SESSION_CLOSED', message: 'The voice model is not available.' });
    }
  }

  async close(sessionId: VoiceSessionId, reason: EndReason): Promise<void> {
    const room = this.#rooms.get(sessionId);
    if (!room) return;
    this.#dispose(room);
    this.#log('info', 'realtime session closed by server', { sessionId, reason });
    await room.hub.close();
  }

  /** Closes every room, e.g. on shutdown. */
  async closeAll(): Promise<void> {
    await Promise.all([...this.#rooms.values()].map((room) => {
      this.#dispose(room);
      return room.hub.close();
    }));
  }

  #createRoom(route: RealtimeRouteInput, choice: Parameters<ModelRegistry['create']>[0]): RealtimeRoom {
    const { sessionId, documentId } = route;
    const handlers = this.options.handlers;
    let room!: RealtimeRoom;
    const context = new ContextUpdates(
      (value) => handlers().configureRealtimeSession.execute({ sessionId, context: value }),
      (code) => this.#log('warn', 'context update refused', { sessionId, code }),
    );
    const created = this.options.models.create(choice);
    const model = withLifecycle(created, {
      opened: (session) => { context.add(session); room.modelOpened(); },
      closed: (session) => { context.remove(session); room.modelClosed(); },
      // Same report as the START_FAILED frame that follows, which a client that already left never gets.
      failed: (error) => room.protocolError({ code: 'START_FAILED', message: error instanceof Error ? error.message : String(error), recoverable: false }),
      userInput: () => room.userInput(),
    });
    const agent: AgentDefinition = defineAgent({
      model,
      instructions: '',
      clientTools: 'accept',
      clientToolTimeoutMs: this.options.clientToolTimeoutMs ?? 15_000,
      hooks: {
        beforeToolCall: async (call) => {
          const decision = await handlers().reviewToolCall.execute({
            sessionId, callId: call.callId, name: call.name, arguments: call.arguments, turnId: call.turn.id, userInputs: room.userInputs,
          });
          return decision.kind === 'allow' ? { action: 'allow' } : { action: 'reject', message: decision.message };
        },
        afterToolCall: (call, result) => {
          void handlers().recordToolResult.execute({
            sessionId, callId: call.callId, name: call.name, turnId: call.turn.id, ok: result.ok, code: result.ok ? undefined : result.code,
          }).catch((error: unknown) => this.#log('error', 'recording a tool result failed', { sessionId, error: String(error) }));
        },
        onTurnEnd: (turn, metrics) => {
          void handlers().completeTurn.execute({ sessionId, turnId: turn.id, metrics })
            .catch((error: unknown) => this.#log('error', 'completing a turn failed', { sessionId, error: String(error) }));
        },
        onError: (error, recoverable) => this.#log(recoverable ? 'warn' : 'error', 'realtime model error', { sessionId, error: error.message }),
      },
    });
    const hub = new Hub(agent, {
      authenticate: async ({ token }) => {
        const identity = await handlers().authorizeRealtimeConnection.execute({ token, documentId, sessionId });
        if (!identity.ok) {
          this.#log('warn', 'realtime connection refused', { sessionId, code: identity.error.code });
          return null;
        }
        return { ...identity.value, id: identity.value.sessionId };
      },
      configure: async (_principal, hello) => {
        const settings = await handlers().configureRealtimeSession.execute({ sessionId, context: hello.context });
        if (!settings.ok) throw new Error(settings.error.message);
        return toSessionConfig(settings.value);
      },
      onContext: (value, session) => { if (!session.closed) context.schedule(value); },
      ...(this.options.resumeWindowMs !== undefined ? { resumeWindowMs: this.options.resumeWindowMs } : {}),
      ...(this.options.heartbeatTimeoutMs !== undefined ? { heartbeatTimeoutMs: this.options.heartbeatTimeoutMs } : {}),
    });
    room = new RealtimeRoom(sessionId, hub, (empty) => this.#onRoomEmpty(empty), context, (error) => {
      // AGENT_ERROR frames carry model errors, already logged by `onError`.
      if (error.code === 'AGENT_ERROR') return;
      this.#log(error.recoverable ? 'warn' : 'error', 'realtime protocol error', {
        sessionId, code: error.code, recoverable: error.recoverable,
        // Decode errors echo client input (`Unknown message type: …`); keep only the start.
        error: error.message.slice(0, MAX_LOGGED_MESSAGE),
        provider: created.provider, model: created.id,
      });
    });
    this.#rooms.set(sessionId, room);
    this.#scheduler.set(() => {
      if (!room.everOpened && !room.disposed) {
        this.#dispose(room);
        void hub.close();
      }
    }, this.options.unusedRoomMs ?? 120_000);
    return room;
  }

  /** The last model session closed: nobody resumed in time, or the server hung up. */
  #onRoomEmpty(room: RealtimeRoom): void {
    const serverClosed = room.disposed;
    this.#dispose(room);
    if (serverClosed) return;
    void this.options.handlers().endVoiceSession.bySystem(room.sessionId, 'disconnected')
      .catch((error: unknown) => this.#log('error', 'ending a disconnected session failed', { sessionId: room.sessionId, error: String(error) }));
  }

  #dispose(room: RealtimeRoom): void {
    room.markDisposed();
    if (this.#rooms.get(room.sessionId) === room) this.#rooms.delete(room.sessionId);
  }

  #log(level: 'debug' | 'info' | 'warn' | 'error', message: string, fields: Record<string, unknown>): void {
    this.options.logger?.log(level, message, fields);
  }
}

/** Application settings → vRealTime session config. Providers want ISO 639-1 language codes. */
export function toSessionConfig(settings: AgentSessionSettings): Partial<SessionConfig> {
  return {
    instructions: settings.instructions,
    turnDetection: settings.turnDetection,
    ...(settings.voice ? { voice: settings.voice } : {}),
    inputTranscription: { language: settings.language.split('-')[0]!.toLowerCase(), ...(settings.vocabulary.length > 0 ? { vocabulary: settings.vocabulary } : {}) },
  };
}
