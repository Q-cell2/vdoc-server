import type { EndReason, Usage, VoiceSession, VoiceSessionStatus } from '@vdoc-server/domain';

/** Read model returned to clients; never exposes internal confirmation state. */
export interface VoiceSessionView {
  readonly sessionId: string;
  readonly documentId: string;
  readonly profileId: string;
  readonly status: VoiceSessionStatus;
  readonly endReason: EndReason | null;
  readonly usage: Pick<Usage, 'turns' | 'toolCalls'>;
}

export interface GrantView {
  readonly token: string;
  readonly expiresAt: number;
}

export function toView(session: VoiceSession, now: number): VoiceSessionView {
  return {
    sessionId: session.id, documentId: session.documentId, profileId: session.profileId,
    status: session.status !== 'ended' && !session.isOpenAt(now) ? 'ended' : session.status,
    endReason: session.endReasonAt(now), usage: { turns: session.usage.turns, toolCalls: session.usage.toolCalls },
  };
}
