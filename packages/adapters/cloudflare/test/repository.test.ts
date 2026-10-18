import { AgentProfile, DocumentId, InstructionTemplate, PrincipalId, ProfileId, SessionLimits, VoiceSession, VoiceSessionId } from '@vdoc-server/domain';
import { describe, expect, it } from 'vitest';
import { DurableObjectVoiceSessionRepository, type KeyValueStorage, type StorageTransaction, SerialCommandQueue } from '../src';

class MapStorage implements KeyValueStorage {
  map = new Map<string, unknown>();
  alarm: number | null = null;
  failAlarm = false;
  deleteSizes: number[] = [];
  async get<T>(key: string) { return structuredClone(this.map.get(key)) as T | undefined; }
  async put<T>(key: string, value: T) { this.map.set(key, structuredClone(value)); }
  async delete(keys: string[]) {
    if (keys.length > 128) throw new Error('Too many keys');
    this.deleteSizes.push(keys.length);
    return keys.filter((key) => this.map.delete(key)).length;
  }
  async list<T>({ prefix, limit, startAfter }: { prefix: string; limit: number; startAfter?: string }) {
    return new Map([...this.map].sort(([a], [b]) => a.localeCompare(b))
      .filter(([key]) => key.startsWith(prefix) && (startAfter === undefined || key > startAfter))
      .slice(0, limit).map(([k, v]) => [k, structuredClone(v) as T]));
  }
  async getAlarm() { return this.alarm; }
  async setAlarm(time: number) { if (this.failAlarm) throw new Error('Alarm write failed'); this.alarm = time; }
  async deleteAlarm() { this.alarm = null; }
  async transaction<T>(callback: (tx: StorageTransaction) => Promise<T>): Promise<T> {
    const previous = structuredClone(this.map);
    const alarm = this.alarm;
    try { return await callback(this); }
    catch (error) { this.map = previous; this.alarm = alarm; throw error; }
  }
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
    await repo.pruneAndSchedule();
    expect([...storage.map.keys()]).toEqual(['voice-session:vs_new']);
  });
});


describe('Durable Object lifecycle', () => {
  it('restores snapshots after repository reconstruction, including owner and usage', async () => {
    const storage = new MapStorage();
    const value = session('vs_saved', 'doc', 0);
    value.connect(1);
    await new DurableObjectVoiceSessionRepository(storage).save(value);
    const restored = await new DurableObjectVoiceSessionRepository(storage).get(value.id);
    expect(restored?.toSnapshot()).toEqual(value.toSnapshot());
    restored?.end('client', 2);
    expect((await new DurableObjectVoiceSessionRepository(storage).get(value.id))?.status).toBe('active');
  });

  it('atomically stores a snapshot and its wake-up; a failed alarm cannot leave an orphan', async () => {
    const storage = new MapStorage();
    storage.failAlarm = true;
    const repo = new DurableObjectVoiceSessionRepository(storage);
    await expect(repo.save(session('vs_failed', 'doc', 0))).rejects.toThrow('Alarm write failed');
    expect(storage.map.size).toBe(0);
  });

  it('backs up old snapshots with an alarm, without postponing an existing wake-up', async () => {
    const storage = new MapStorage();
    const value = session('vs_old', 'doc', 0);
    await storage.put('voice-session:' + value.id, value.toSnapshot());
    const repo = new DurableObjectVoiceSessionRepository(storage, 1_000, () => 0);
    await repo.ensureAlarm();
    expect(storage.alarm).toBe(value.toSnapshot().connectDeadline + 1);
    storage.alarm = 100;
    await repo.ensureAlarm();
    expect(storage.alarm).toBe(100);
  });

  it('honors grant and active deadlines, renewal, and reschedules an early alarm', async () => {
    const storage = new MapStorage();
    let now = 0;
    const repo = new DurableObjectVoiceSessionRepository(storage, 1_000, () => now);
    const value = session('vs_live', 'doc', now);
    await repo.save(value);
    const originalDeadline = value.toSnapshot().connectDeadline;
    now = originalDeadline;
    expect(await repo.findOverdue()).toEqual([]);
    value.issueGrant(now);
    await repo.save(value);
    now++;
    expect(await repo.findOverdue()).toEqual([]);
    await repo.pruneAndSchedule();
    expect(storage.alarm).toBe(value.toSnapshot().connectDeadline + 1);
    value.connect(now);
    await repo.save(value);
    now += value.limits.maxDurationMs;
    expect(await repo.findOverdue()).toEqual([value.id]);
  });

  it('cleans up more than one page with no new saves, preserving live and recent sessions', async () => {
    const storage = new MapStorage();
    const now = 10_000;
    const repo = new DurableObjectVoiceSessionRepository(storage, 1_000, () => now);
    for (let n = 0; n < 300; n++) {
      const value = session('vs_' + String(n).padStart(3, '0'), 'doc', 0);
      value.end('client', 0);
      await storage.put('voice-session:' + value.id, value.toSnapshot());
    }
    const live = session('vs_live', 'doc', now);
    const recent = session('vs_recent', 'doc', now);
    recent.end('client', now);
    await repo.save(live);
    await repo.save(recent);
    await repo.pruneAndSchedule();
    expect([...storage.map.keys()]).toEqual(['voice-session:vs_live', 'voice-session:vs_recent']);
    expect(storage.deleteSizes).toEqual([128, 128, 44]);
    expect(storage.alarm).toBe(now + 1_001);
  });

  it('deletes the alarm when the last retained session is removed; repeated cleanup is harmless', async () => {
    const storage = new MapStorage();
    let now = 0;
    const repo = new DurableObjectVoiceSessionRepository(storage, 1_000, () => now);
    const value = session('vs_ended', 'doc', 0);
    value.end('client', 0);
    await repo.save(value);
    now = 1_001;
    await repo.pruneAndSchedule();
    await repo.pruneAndSchedule();
    expect(storage.map.size).toBe(0);
    expect(storage.alarm).toBeNull();
  });
});

describe('SerialCommandQueue', () => {
  it('holds subsequent commands across external awaits and recovers after rejection', async () => {
    const queue = new SerialCommandQueue();
    const events: string[] = [];
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const first = queue.run(async () => { events.push('first'); await barrier; throw new Error('failure'); });
    const rejection = expect(first).rejects.toThrow('failure');
    const second = queue.run(async () => { events.push('second'); return 42; });
    await Promise.resolve();
    expect(events).toEqual(['first']);
    release();
    await rejection;
    expect(await second).toBe(42);
    expect(events).toEqual(['first', 'second']);
  });
});
