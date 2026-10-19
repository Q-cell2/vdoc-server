import { TurnId, VoiceSessionId } from '@vdoc-server/domain';
import type { Clock } from '../ports';
import type { VoiceSessionStore } from '../voice-session-store';
import { parseTurnMetrics } from '../telemetry/turn-metrics';

/** Command: a user→agent exchange finished; count it and enforce the session's limits. */
export class CompleteTurn {
  constructor(private readonly deps: { store: VoiceSessionStore; clock: Clock }) {}

  async execute(input: { sessionId: string; turnId: string; metrics?: unknown }): Promise<void> {
    const id = VoiceSessionId.parse(input.sessionId);
    const turnId = TurnId.parse(input.turnId);
    if (!id.ok || !turnId.ok) return;
    const session = await this.deps.store.findById(id.value);
    if (!session) return;
    session.completeTurn(turnId.value, this.deps.clock.now(), parseTurnMetrics(input.metrics));
    await this.deps.store.commit(session);
  }
}
