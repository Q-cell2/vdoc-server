import type { Application } from '@vdoc-server/application';
import { credentialsOf, readJsonObject } from './request';
import { fromAppError, json, problem } from './responses';
import { realtimePath } from './realtime-route';
import type { Params } from './router';

type SessionUseCases = Pick<Application, 'grantVoiceSession' | 'getVoiceSession' | 'renewSessionGrant' | 'endVoiceSession'>;

/** Translates HTTP into use-case calls and back; holds no business rules. */
export class VoiceSessionController {
  constructor(private readonly app: SessionUseCases) {}

  create = async (request: Request, params: Params): Promise<Response> => {
    const body = await readJsonObject(request);
    if (!body.ok) return problem(body.status, 'INVALID_INPUT', body.message);
    const { profileId } = body.value;
    if (profileId !== undefined && typeof profileId !== 'string') return problem(400, 'INVALID_INPUT', '"profileId" must be a string.');
    const result = await this.app.grantVoiceSession.execute({ credentials: credentialsOf(request), documentId: params.documentId!, profileId });
    if (!result.ok) return fromAppError(result.error);
    const { session, grant } = result.value;
    const location = `/v1/documents/${encodeURIComponent(session.documentId)}/voice-sessions/${encodeURIComponent(session.sessionId)}`;
    return json({ ...session, grant, realtimePath: realtimePath(session.documentId, session.sessionId) }, 201, { location });
  };

  get = async (request: Request, params: Params): Promise<Response> => {
    const result = await this.app.getVoiceSession.execute({ credentials: credentialsOf(request), documentId: params.documentId!, sessionId: params.sessionId! });
    return result.ok ? json(result.value) : fromAppError(result.error);
  };

  renewGrant = async (request: Request, params: Params): Promise<Response> => {
    const result = await this.app.renewSessionGrant.execute({ credentials: credentialsOf(request), documentId: params.documentId!, sessionId: params.sessionId! });
    return result.ok ? json(result.value, 201) : fromAppError(result.error);
  };

  end = async (request: Request, params: Params): Promise<Response> => {
    const result = await this.app.endVoiceSession.execute({ credentials: credentialsOf(request), documentId: params.documentId!, sessionId: params.sessionId! });
    return result.ok ? new Response(null, { status: 204 }) : fromAppError(result.error);
  };
}
