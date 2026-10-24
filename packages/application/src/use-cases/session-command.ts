import { VoiceSessionId, type VoiceSession } from '@vdoc-server/domain';
import { ApplicationFailure } from '../errors';
import type { Clock } from '../ports';
import type { SessionLifecycle } from '../session-lifecycle';
import type { VoiceSessionStore } from '../voice-session-store';

/**
 * Shared steps of the realtime runtime's callbacks. They have no result channel:
 * a malformed or already-gone session is skipped, and a failed commit throws with its code kept.
 */
export interface SessionCommandDeps { store: VoiceSessionStore; lifecycle: SessionLifecycle; clock: Clock }

export async function loadSession(deps: SessionCommandDeps, sessionId: string): Promise<VoiceSession | undefined> {
  const id = VoiceSessionId.parse(sessionId);
  return id.ok ? deps.store.findById(id.value) : undefined;
}

export async function commitSession(deps: SessionCommandDeps, session: VoiceSession): Promise<void> {
  const committed = await deps.lifecycle.persistAndDispatch(session);
  if (!committed.ok) throw new ApplicationFailure(committed.error.code, committed.error.message);
}

/** Load, apply one domain change, commit. */
export async function updateSession(deps: SessionCommandDeps, sessionId: string, change: (session: VoiceSession, now: number) => void): Promise<void> {
  const session = await loadSession(deps, sessionId);
  if (!session) return;
  change(session, deps.clock.now());
  await commitSession(deps, session);
}
