import { TurnId } from '@vdoc-server/domain';
import { updateSession, type SessionCommandDeps } from './session-command';

/** Command: a user→agent exchange finished; count it and enforce the session's limits. */
export class CompleteTurn {
  constructor(private readonly deps: SessionCommandDeps) {}

  async execute(input: { sessionId: string; turnId: string }): Promise<void> {
    const turnId = TurnId.parse(input.turnId);
    if (!turnId.ok) return;
    await updateSession(this.deps, input.sessionId, (session, now) => session.completeTurn(turnId.value, now));
  }
}
