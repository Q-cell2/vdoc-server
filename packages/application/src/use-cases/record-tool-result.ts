import type { SessionLifecycle } from '../session-lifecycle';
import { ToolCallId, TurnId, VoiceSessionId } from '@vdoc-server/domain';
import type { Clock } from '../ports';
import type { VoiceSessionStore } from '../voice-session-store';

export interface RecordToolResultInput {
  readonly sessionId: string;
  readonly callId: string;
  readonly name: string;
  readonly turnId: string;
  readonly ok: boolean;
  readonly code?: string | undefined;
}

/** Command: the app finished (or refused) a tool call; keep the audit trail complete. */
export class RecordToolResult {
  constructor(private readonly deps: { store: VoiceSessionStore; lifecycle: SessionLifecycle; clock: Clock }) {}

  async execute(input: RecordToolResultInput): Promise<void> {
    const id = VoiceSessionId.parse(input.sessionId);
    const callId = ToolCallId.parse(input.callId);
    const turnId = TurnId.parse(input.turnId);
    if (!id.ok || !callId.ok || !turnId.ok) return;
    const session = await this.deps.store.findById(id.value);
    if (!session) return;
    session.recordToolResult({ id: callId.value, name: input.name, turnId: turnId.value }, { ok: input.ok, ...(input.code !== undefined ? { code: input.code } : {}) }, this.deps.clock.now());
    const committed = await this.deps.lifecycle.persistAndDispatch(session);
    if (!committed.ok) throw new Error(committed.error.message);
  }
}
