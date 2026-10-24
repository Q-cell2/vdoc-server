import type { SessionLifecycle } from '../session-lifecycle';
import { TurnId, VoiceSessionId } from '@vdoc-server/domain';
import type { Clock } from '../ports';
import type { VoiceSessionStore } from '../voice-session-store';

/** Command: a user→agent exchange finished; count it and enforce the session's limits. */
export class CompleteTurn {
  constructor(private readonly deps: { store: VoiceSessionStore; lifecycle: SessionLifecycle; clock: Clock }) {}

  async execute(input: { sessionId: string; turnId: string }): Promise<void> {
    const id = VoiceSessionId.parse(input.sessionId);
    const turnId = TurnId.parse(input.turnId);
    if (!id.ok || !turnId.ok) return;
    const session = await this.deps.store.findById(id.value);
    if (!session) return;
    session.completeTurn(turnId.value, this.deps.clock.now());
    const committed = await this.deps.lifecycle.persistAndDispatch(session);
    if (!committed.ok) throw new Error(committed.error.message);
  }
}
