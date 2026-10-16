import {
  ToolCallId, TurnId, VoiceSessionId,
  type AgentProfileRepository, type RiskAssessor, type ToolDecision, type ToolPolicy,
} from '@vdoc-server/domain';
import type { Clock } from '../ports';
import type { VoiceSessionStore } from '../voice-session-store';

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
  constructor(private readonly deps: { store: VoiceSessionStore; profiles: AgentProfileRepository; policy: ToolPolicy; assessor: RiskAssessor; clock: Clock }) {}

  async execute(input: ToolCallInput): Promise<ToolDecision> {
    const { store, profiles, policy, assessor, clock } = this.deps;
    const id = VoiceSessionId.parse(input.sessionId);
    const callId = ToolCallId.parse(input.callId);
    const turnId = TurnId.parse(input.turnId);
    if (!id.ok || !callId.ok || !turnId.ok) return closed('Malformed tool call.');
    const session = await store.findById(id.value);
    const profile = session && await profiles.get(session.profileId);
    if (!session || !profile) return closed('This voice session has ended.');

    const now = clock.now();
    session.expireIfOverdue(now);
    const decision = session.reviewToolCall(
      { id: callId.value, name: input.name, arguments: input.arguments, turnId: turnId.value },
      { policy, assessor, allowedTools: profile.allowedTools },
      now,
    );
    await store.commit(session);
    return decision;
  }
}
