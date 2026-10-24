import { VoiceSessionId } from '@vdoc-server/domain';
import type { Clock } from '../ports';
import type { VoiceSessionStore } from '../voice-session-store';
import type { SessionLifecycle } from '../session-lifecycle';
export class RecordUserInput {
  constructor(private readonly deps: { store: VoiceSessionStore; lifecycle: SessionLifecycle; clock: Clock }) {}
  async execute(input: { sessionId: string }): Promise<void> {
    const id = VoiceSessionId.parse(input.sessionId);
    const session = id.ok ? await this.deps.store.findById(id.value) : undefined;
    if (!session) return;
    session.recordUserInput(this.deps.clock.now());
    const result = await this.deps.lifecycle.persistAndDispatch(session);
    if (!result.ok) throw new Error(result.error.message);
  }
}
