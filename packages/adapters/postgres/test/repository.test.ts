import { PGlite } from '@electric-sql/pglite';
import { AgentProfile, DocumentId, InstructionTemplate, PrincipalId, ProfileId, SessionLimits, VoiceSession, VoiceSessionId } from '@vdoc-server/domain';
import { beforeEach, describe, expect, it } from 'vitest';
import { PostgresVoiceSessionRepository } from '../src';

const profile = new AgentProfile({
  id: ProfileId.assume('p'), name: 'p', model: { provider: 'fake' }, turnDetection: 'server', instructions: new InstructionTemplate(''),
  defaultLanguage: 'en', allowedTools: [], maxVocabulary: 1, limits: SessionLimits.defaults,
});
const session = (id: string, doc: string, now: number) => VoiceSession.grant({
  id: VoiceSessionId.assume(id), documentId: DocumentId.assume(doc), principal: { id: PrincipalId.assume('c'), kind: 'client', name: 'c' }, profile, now,
});

describe('PostgresVoiceSessionRepository', () => {
  let db: PGlite;
  beforeEach(() => { db = new PGlite(); });

  it('stores snapshots and finds unended sessions of a document, oldest first', async () => {
    const repo = new PostgresVoiceSessionRepository(db);
    await repo.migrate();
    await repo.migrate();
    await repo.save(session('vs_b', 'doc', 2));
    await repo.save(session('vs_a', 'doc', 1));
    await repo.save(session('vs_c', 'other', 3));
    expect((await repo.findUnended(DocumentId.assume('doc'))).map((s) => s.id)).toEqual(['vs_a', 'vs_b']);
    const restored = await repo.get(VoiceSessionId.assume('vs_c'));
    expect(restored?.toSnapshot()).toEqual(session('vs_c', 'other', 3).toSnapshot());
    expect(await repo.get(VoiceSessionId.assume('vs_missing'))).toBeUndefined();
  });

  it('updates a saved session in place', async () => {
    const repo = new PostgresVoiceSessionRepository(db, 1_000, () => 2);
    await repo.migrate();
    const s = session('vs_a', 'doc', 1);
    await repo.save(s);
    s.end('client', 2);
    await repo.save(s);
    expect(await repo.findUnended(DocumentId.assume('doc'))).toEqual([]);
    expect((await repo.get(VoiceSessionId.assume('vs_a')))?.status).toBe('ended');
  });

  it('prunes ended sessions past the retention window', async () => {
    let now = 0;
    const repo = new PostgresVoiceSessionRepository(db, 1_000, () => now);
    await repo.migrate();
    const old = session('vs_old', 'doc', 0);
    old.end('client', 0);
    await repo.save(old);
    now = 5_000;
    const fresh = session('vs_new', 'doc', 5_000);
    fresh.end('client', 5_000);
    await repo.save(fresh);
    const { rows } = await db.query<{ id: string }>('SELECT id FROM voice_sessions');
    expect(rows.map((r) => r.id)).toEqual(['vs_new']);
  });
});
