import { updateSession, type SessionCommandDeps } from './session-command';

/** Command: the user spoke; keep the session's activity clock current. */
export class RecordUserInput {
  constructor(private readonly deps: SessionCommandDeps) {}

  async execute(input: { sessionId: string }): Promise<void> {
    await updateSession(this.deps, input.sessionId, (session, now) => session.recordUserInput(now));
  }
}
