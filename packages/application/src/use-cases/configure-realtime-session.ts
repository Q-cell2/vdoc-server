import { VoiceSessionId, err, ok, type AgentProfileRepository, type ModelChoice, type Result } from '@vdoc-server/domain';
import { parseDocumentContext } from '../context/document-context';
import { appError, type AppError } from '../errors';
import type { VoiceSessionStore } from '../voice-session-store';
import type { Clock } from '../ports';

export interface ConfigureRealtimeSessionInput {
  readonly sessionId: string;
  /** Initial, resumed or updated app context: title, language, vocabulary. Untrusted. */
  readonly context: unknown;
}

/** Everything the realtime runtime needs to start the model session. Transport-neutral. */
export interface AgentSessionSettings {
  readonly model: ModelChoice;
  readonly instructions: string;
  readonly voice: string | undefined;
  readonly turnDetection: 'server' | 'semantic';
  readonly language: string;
  readonly vocabulary: readonly string[];
}

/** Query: per-session agent settings from the profile and the document context. */
export class ConfigureRealtimeSession {
  constructor(private readonly deps: { store: VoiceSessionStore; profiles: AgentProfileRepository; clock: Clock }) {}

  async execute(input: ConfigureRealtimeSessionInput): Promise<Result<AgentSessionSettings, AppError>> {
    const id = VoiceSessionId.parse(input.sessionId);
    const session = id.ok ? await this.deps.store.findById(id.value) : undefined;
    if (!session) return err(appError('NOT_FOUND', 'No such voice session.'));
    if (session.status !== 'active' || !session.isOpenAt(this.deps.clock.now())) {
      return err(appError('SESSION_CLOSED', 'This voice session is not active.'));
    }
    const profile = await this.deps.profiles.get(session.profileId);
    if (!profile) return err(appError('NOT_FOUND', 'The session’s agent profile no longer exists.'));
    const context = parseDocumentContext(input.context, profile);
    if (context.documentId !== undefined && context.documentId !== session.documentId) {
      return err(appError('FORBIDDEN', 'The connection context names a different document.'));
    }
    return ok({
      model: profile.model,
      instructions: profile.instructionsFor({ language: context.language, documentTitle: context.title }),
      voice: profile.voice, turnDetection: profile.turnDetection, language: context.language, vocabulary: context.vocabulary,
    });
  }
}
