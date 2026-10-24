import { updateSession, type SessionCommandDeps } from './session-command';

/** Command: the realtime connection dropped; end the session. */
export class HandleRealtimeDisconnect {
  constructor(private readonly deps: SessionCommandDeps) {}

  async execute(sessionId: string): Promise<void> {
    await updateSession(this.deps, sessionId, (session, now) => session.end('disconnected', now));
  }
}
