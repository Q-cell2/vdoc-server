import {
  AgentProfile, DocumentId, InstructionTemplate, PrincipalId, ProfileId, RiskAssessor, SessionLimits,
  ToolCallId, TurnId, VoiceSession, VoiceSessionId, defaultToolPolicy, type Principal, type ToolCall, type ToolGovernance,
} from '../src';

export const principal: Principal = { id: PrincipalId.assume('client-web'), kind: 'client', name: 'vdoc web' };

export function profile(limits: Partial<SessionLimits> = {}): AgentProfile {
  return new AgentProfile({
    id: ProfileId.assume('editor'), name: 'Editor', model: { provider: 'fake' }, turnDetection: 'semantic',
    instructions: new InstructionTemplate('Reply in {{language}} about "{{documentTitle}}".'), defaultLanguage: 'en',
    allowedTools: ['read_document', 'apply_document_operations', 'undo_turn'], maxVocabulary: 20,
    limits: { ...SessionLimits.defaults, ...limits },
  });
}

export function grantedSession(now = 1_000, limits: Partial<SessionLimits> = {}): VoiceSession {
  return VoiceSession.grant({ id: VoiceSessionId.assume('vs-1'), documentId: DocumentId.assume('doc-1'), principal, profile: profile(limits), now });
}

export function activeSession(now = 1_000, limits: Partial<SessionLimits> = {}): VoiceSession {
  const session = grantedSession(now, limits);
  session.connect(now);
  session.pullEvents();
  return session;
}

export function governance(allowed = ['read_document', 'apply_document_operations', 'undo_turn']): ToolGovernance {
  return { policy: defaultToolPolicy(), assessor: new RiskAssessor(), allowedTools: new Set(allowed) };
}

let counter = 0;
export function call(name: string, args: unknown, turn = 't1'): ToolCall {
  return { id: ToolCallId.assume(`c${++counter}`), name, arguments: args, turnId: TurnId.assume(turn) };
}

export const ops = (...types: string[]) => ({ operations: types.map((type) => {
  const [kind, action] = type.split(':');
  return action ? { type: kind, action } : { type: kind };
}) });
