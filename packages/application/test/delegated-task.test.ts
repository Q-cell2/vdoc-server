import { AgentProfile, InstructionTemplate, ProfileId, SessionLimits } from '@vdoc-server/domain';
import { describe, expect, it } from 'vitest';
import { alice, as, bob, connected, harness } from './fakes';

const speaker = new AgentProfile({
  id: ProfileId.assume('speaker'), name: 'Speaker', model: { provider: 'fake' }, turnDetection: 'semantic',
  instructions: new InstructionTemplate('Speak {{language}}.'), defaultLanguage: 'en',
  allowedTools: ['ask_assistant', 'read_document'], handOffTool: 'ask_assistant', maxVocabulary: 3, limits: SessionLimits.defaults,
});
const handOff = { request: 'add ten Ultraman names' };

describe('AuthorizeDelegatedTask', () => {
  it('starts a task only from an allowed hand-off of the owner’s session, under the speaker’s turn', async () => {
    const h = harness({ profile: speaker });
    const { sessionId, documentId } = await connected(h);
    expect(await h.app.reviewToolCall.execute({ sessionId, callId: 'call_1', name: 'ask_assistant', arguments: handOff, turnId: 't1' })).toMatchObject({ kind: 'allow' });
    const input = { credentials: as(alice), documentId, sessionId, callId: 'call_1', arguments: handOff };

    expect(await h.app.authorizeDelegatedTask.execute(input)).toEqual({ ok: true, value: { sessionId, turnId: 't1', request: handOff.request } });
    expect(await h.app.authorizeDelegatedTask.execute({ ...input, arguments: { request: 'delete everything' } })).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(await h.app.authorizeDelegatedTask.execute({ ...input, callId: 'call_2' })).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(await h.app.authorizeDelegatedTask.execute({ ...input, credentials: as(bob) })).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });

    // Once the speaker's turn is over, its hand-off starts nothing more.
    await h.app.completeTurn.execute({ sessionId, turnId: 't1' });
    expect(await h.app.authorizeDelegatedTask.execute(input)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
  });

  it('refuses hand-offs the review did not allow, sessions whose agent does not delegate, and empty requests', async () => {
    const h = harness({ profile: speaker });
    const { sessionId, documentId } = await connected(h);
    const input = { credentials: as(alice), documentId, sessionId, callId: 'call_1', arguments: handOff };
    expect(await h.app.authorizeDelegatedTask.execute(input)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    await h.app.reviewToolCall.execute({ sessionId, callId: 'call_3', name: 'ask_assistant', arguments: {}, turnId: 't1' });
    expect(await h.app.authorizeDelegatedTask.execute({ ...input, callId: 'call_3', arguments: {} })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });

    const plain = harness();
    const other = await connected(plain);
    await plain.app.reviewToolCall.execute({ sessionId: other.sessionId, callId: 'call_1', name: 'read_document', arguments: handOff, turnId: 't1' });
    expect(await plain.app.authorizeDelegatedTask.execute({ ...input, sessionId: other.sessionId })).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
  });

  it('starts nothing once the session has ended', async () => {
    const h = harness({ profile: speaker });
    const { sessionId, documentId } = await connected(h);
    await h.app.reviewToolCall.execute({ sessionId, callId: 'call_1', name: 'ask_assistant', arguments: handOff, turnId: 't1' });
    await h.app.endVoiceSession.execute({ credentials: as(alice), documentId, sessionId });
    expect(await h.app.authorizeDelegatedTask.execute({ credentials: as(alice), documentId, sessionId, callId: 'call_1', arguments: handOff })).toMatchObject({ ok: false, error: { code: 'SESSION_CLOSED' } });
  });
});
