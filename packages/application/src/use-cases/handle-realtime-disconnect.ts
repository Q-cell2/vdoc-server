import { VoiceSessionId } from '@vdoc-server/domain';
import type { Clock } from '../ports';
import type { VoiceSessionStore } from '../voice-session-store';
import type { SessionLifecycle } from '../session-lifecycle';
export class HandleRealtimeDisconnect {
  constructor(private readonly deps: { store: VoiceSessionStore; lifecycle: SessionLifecycle; clock: Clock }) {}
  async execute(sessionId: string): Promise<void> {
    const id = VoiceSessionId.parse(sessionId);
    const session = id.ok ? await this.deps.store.findById(id.value) : undefined;
    if (!session) return;
    session.end('disconnected', this.deps.clock.now());
    const result = await this.deps.lifecycle.persistAndDispatch(session);
    if (!result.ok) throw new Error(result.error.message);
  }
}
