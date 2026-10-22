import { err, ok, type AgentProfileRepository, type ModelChoice, type Result } from '@vdoc-server/domain';
import { appError, type AppError } from '../errors';
import type { Clock } from '../ports';
import type { VoiceSessionStore } from '../voice-session-store';

export interface RealtimeSessionDescriptor {
  readonly sessionId: string;
  readonly model: ModelChoice;
}

/**
 * Query the model descriptor of an open session belonging to the document.
 * The realtime adapter uses it before allocating connection resources.
 * Route parsing belongs to the transport; authentication happens on `hello`.
 */
export class GetRealtimeSessionDescriptor {
  constructor(private readonly deps: { store: VoiceSessionStore; profiles: AgentProfileRepository; clock: Clock }) {}

  async execute(input: { documentId: string; sessionId: string }): Promise<Result<RealtimeSessionDescriptor, AppError>> {
    const session = await this.deps.store.find(input.documentId, input.sessionId);
    if (!session.ok) return session;
    if (!session.value.isOpenAt(this.deps.clock.now())) return err(appError('SESSION_CLOSED', 'This voice session has ended.'));
    const profile = await this.deps.profiles.get(session.value.profileId);
    if (!profile) return err(appError('NOT_FOUND', 'The session’s agent profile no longer exists.'));
    return ok({ sessionId: session.value.id, model: profile.model });
  }
}
