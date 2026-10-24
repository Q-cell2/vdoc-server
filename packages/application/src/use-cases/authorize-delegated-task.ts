import { err, ok, type AgentProfileRepository, type Result } from '@vdoc-server/domain';
import { appError, fromDomain, type AppError } from '../errors';
import type { CallerAuthenticator, CallerCredentials, Clock } from '../ports';
import type { VoiceSessionStore } from '../voice-session-store';
import { authenticateCaller } from './caller';

export interface AuthorizeDelegatedTaskInput {
  readonly credentials: CallerCredentials;
  readonly documentId: string;
  readonly sessionId: string;
  /** The speaker's hand-off call, exactly as the realtime model made it. */
  readonly callId: string;
  readonly arguments: unknown;
}

export interface DelegatedTask {
  readonly sessionId: string;
  /** The speaker's turn; the worker's tool calls are reviewed under it. */
  readonly turnId: string;
  /** What the user wants, in the speaker's words. */
  readonly request: string;
}

/**
 * Query: may the owner's client run a worker task for this hand-off? Only a
 * hand-off the session allowed starts one, so a worker cannot run outside the
 * session's turns, tool budget or profile.
 */
export class AuthorizeDelegatedTask {
  constructor(private readonly deps: { store: VoiceSessionStore; profiles: AgentProfileRepository; authenticator: CallerAuthenticator; clock: Clock }) {}

  async execute(input: AuthorizeDelegatedTaskInput): Promise<Result<DelegatedTask, AppError>> {
    const principal = await authenticateCaller(this.deps.authenticator, input.credentials);
    if (!principal.ok) return principal;
    const session = await this.deps.store.findOwned(input.documentId, input.sessionId, principal.value);
    if (!session.ok) return session;
    const profile = await this.deps.profiles.get(session.value.profileId);
    if (!profile?.handOffTool) return err(appError('FORBIDDEN', 'This session’s agent does not delegate work.'));
    const request = (input.arguments as { request?: unknown } | null)?.request;
    if (typeof request !== 'string' || request.trim() === '') return err(appError('INVALID_INPUT', 'The hand-off has no request.'));
    const turn = session.value.delegatedTurn(input.callId, { name: profile.handOffTool, arguments: input.arguments }, this.deps.clock.now());
    if (!turn.ok) return err(fromDomain(turn.error));
    return ok({ sessionId: session.value.id, turnId: turn.value, request });
  }
}
