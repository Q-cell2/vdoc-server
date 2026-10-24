import { ToolCallId, TurnId } from '@vdoc-server/domain';
import { updateSession, type SessionCommandDeps } from './session-command';

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
  constructor(private readonly deps: SessionCommandDeps) {}

  async execute(input: RecordToolResultInput): Promise<void> {
    const callId = ToolCallId.parse(input.callId);
    const turnId = TurnId.parse(input.turnId);
    if (!callId.ok || !turnId.ok) return;
    const call = { id: callId.value, name: input.name, turnId: turnId.value };
    const outcome = { ok: input.ok, ...(input.code !== undefined ? { code: input.code } : {}) };
    await updateSession(this.deps, input.sessionId, (session, now) => session.recordToolResult(call, outcome, now));
  }
}
