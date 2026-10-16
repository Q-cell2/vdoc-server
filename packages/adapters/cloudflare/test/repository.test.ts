import { AgentProfile, DocumentId, InstructionTemplate, PrincipalId, ProfileId, SessionLimits, VoiceSession, VoiceSessionId } from '@vdoc-server/domain';
import { describe, expect, it } from 'vitest';
import { DurableObjectVoiceSessionRepository, type KeyValueStorage } from '../src';

class MapStorage implements KeyValueStorage {
  readonly map = new Map<string, unknown>();
  async get<T>(key: string) { return structuredClone(this.map.get(key)) as T | undefined; }
  async put<T>(key: string, value: T) { this.map.set(key, structuredClone(value)); }
  async delete(keys: string[]) { return keys.filter((key) => this.map.delete(key)).length; }
  async list<T>({ prefix }: { prefix: string }) { return new Map([...this.map].filter(([key]) => key.startsWith(prefix)).map(([k, v]) => [k, structuredClone(v) as T])); }
}

const profile = new AgentProfile({
  id: ProfileId.assume('p'), name: 'p', model: { provider: 'fake' }, turnDetection: 'server', instructions: new InstructionTemplate(''),
  defaultLanguage: 'en', allowedTools: [], maxVocabulary: 1, limits: SessionLimits.defaults,
});
const session = (id: string, doc: string, now: number) => VoiceSession.grant({
  id: VoiceSessionId.assume(id), documentId: DocumentId.assume(doc), principal: { id: PrincipalId.assume('c'), kind: 'client', name: 'c' }, profile, now,
});

describe('DurableObjectVoiceSessionRepository', () => {
  it('stores snapshots and finds unended sessions of a document, oldest first', async () => {
    const repo = new DurableObjectVoiceSessionRepository(new MapStorage());
    await repo.save(session('vs_b', 'doc', 2));
    await repo.save(session('vs_a', 'doc', 1));
    await repo.save(session('vs_c', 'other', 3));
    expect((await repo.findUnended(DocumentId.assume('doc'))).map((s) => s.id)).toEqual(['vs_a', 'vs_b']);
    expect((await repo.get(VoiceSessionId.assume('vs_c')))?.documentId).toBe('other');
  });

  it('prunes ended sessions past the retention window', async () => {
    const storage = new MapStorage();
    let now = 0;
    const repo = new DurableObjectVoiceSessionRepository(storage, 1_000, () => now);
    const old = session('vs_old', 'doc', 0);
    old.end('client', 0);
    await repo.save(old);
    now = 5_000;
    const fresh = session('vs_new', 'doc', 5_000);
    fresh.end('client', 5_000);
    await repo.save(fresh);
    expect([...storage.map.keys()]).toEqual(['voice-session:vs_new']);
  });
});
