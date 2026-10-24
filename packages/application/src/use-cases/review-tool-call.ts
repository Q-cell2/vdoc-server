import {
  ToolCallId, TurnId, VoiceSessionId,
  type AgentProfileRepository, type RiskAssessor, type ToolDecision, type ToolPolicy,
} from '@vdoc-server/domain';
import { commitSession, loadSession, type SessionCommandDeps } from './session-command';

export interface ToolCallInput {
  readonly sessionId: string;
  readonly callId: string;
  readonly name: string;
  readonly arguments: unknown;
  readonly turnId: string;
}

const closed = (message: string): ToolDecision => ({ kind: 'deny', risk: 'low', code: 'SESSION_CLOSED', message });

/** Command: the model wants to run a tool; decide before the app ever sees the call. */
export class ReviewToolCall {
  constructor(private readonly deps: SessionCommandDeps & { profiles: AgentProfileRepository; policy: ToolPolicy; assessor: RiskAssessor }) {}

  async execute(input: ToolCallInput): Promise<ToolDecision> {
    const { profiles, policy, assessor, clock } = this.deps;
    const callId = ToolCallId.parse(input.callId);
    const turnId = TurnId.parse(input.turnId);
    if (!VoiceSessionId.parse(input.sessionId).ok || !callId.ok || !turnId.ok) return closed('Malformed tool call.');
    const session = await loadSession(this.deps, input.sessionId);
    const profile = session && await profiles.get(session.profileId);
    if (!session || !profile) return closed('This voice session has ended.');

    const decision = session.reviewToolCall(
      { id: callId.value, name: input.name, arguments: input.arguments, turnId: turnId.value },
      { policy, assessor, allowedTools: profile.allowedTools },
      clock.now(),
    );
    await commitSession(this.deps, session);
    return decision;
  }
}
