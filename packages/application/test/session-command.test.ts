import { describe, expect, it } from 'vitest';
import type { VoiceSession } from '@vdoc-server/domain';
import { appError, type AppError } from '../src/errors';
import type { SessionLifecycle } from '../src/session-lifecycle';
import type { VoiceSessionStore } from '../src/voice-session-store';
import { commitSession, updateSession } from '../src/use-cases/session-command';

const failing = (error: AppError) => ({ persistAndDispatch: async () => ({ ok: false as const, error }) }) as unknown as SessionLifecycle;
const deps = (lifecycle: SessionLifecycle, session?: VoiceSession) => ({
  lifecycle, clock: { now: () => 1 }, store: { findById: async () => session } as unknown as VoiceSessionStore,
});

describe('session commands', () => {
  it('keeps the error code when a commit fails', async () => {
    const failure = commitSession(deps(failing(appError('SESSION_CLOSED', 'closed'))), {} as VoiceSession);
    await expect(failure).rejects.toMatchObject({ name: 'ApplicationFailure', code: 'SESSION_CLOSED', message: 'closed' });
  });
  it('skips a malformed or missing session without committing', async () => {
    let commits = 0;
    const lifecycle = { persistAndDispatch: async () => { commits++; return { ok: true as const, value: undefined }; } } as unknown as SessionLifecycle;
    let changed = false;
    await updateSession(deps(lifecycle), 'not a session id!', () => { changed = true; });
    await updateSession(deps(lifecycle), 'vs_missing', () => { changed = true; });
    expect({ changed, commits }).toEqual({ changed: false, commits: 0 });
  });
});
