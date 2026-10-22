import { VoiceSession, VoiceSessionId } from '@vdoc-server/domain';
import type { Clock } from './ports';
import { nextSessionWake, RETAIN_ENDED_MS, type SessionRecordStorage, type SessionMaintenanceStorage } from './session-record';
import type { VoiceSessionStore } from './voice-session-store';
import type { SessionLifecycle } from './session-lifecycle';
import type { RelaySessionOutbox } from './session-events';

export class ExpireVoiceSession {
  constructor(private readonly store: VoiceSessionStore, private readonly lifecycle: SessionLifecycle, private readonly clock: Clock) {}
  async execute(sessionId: string): Promise<void> {
    const id = VoiceSessionId.parse(sessionId);
    const session = id.ok ? await this.store.findById(id.value) : undefined;
    if (session?.expireIfOverdue(this.clock.now())) {
      const result = await this.lifecycle.persistAndDispatch(session);
      if (!result.ok) throw new Error(result.error.message);
    }
  }
}
/** Runtime-neutral expiration, outbox recovery and retention policy. Call within the command queue. */
export class SessionMaintenance {
  constructor(private readonly repository: SessionRecordStorage & SessionMaintenanceStorage, private readonly expire: ExpireVoiceSession,
    private readonly relay: RelaySessionOutbox, private readonly clock: Clock, private readonly retainMs = RETAIN_ENDED_MS) {}
  async execute(): Promise<void> {
    let failure: unknown;
    try { await this.expireOverdue(); } catch (error) { failure = error; }
    try { await this.relayOutbox(); } catch (error) { failure ??= error; }
    finally { await this.prune(); }
    if (failure) throw failure;
  }
  async expireOverdue(): Promise<void> {
    let failure: unknown;
    for await (const record of this.repository.records()) {
      const session = VoiceSession.restore(record.session);
      if (session.status !== 'ended' && !session.isOpenAt(this.clock.now())) {
        try { await this.expire.execute(session.id); } catch (error) { failure ??= error; }
      }
    }
    if (failure) throw failure;
  }
  async relayOutbox(): Promise<void> {
    let failure: unknown;
    for await (const record of this.repository.records()) if (record.outbox.length) {
      try { const result = await this.relay.execute(record.session.id); if (!result.ok) failure ??= new Error(result.error.message); }
      catch (error) { failure ??= error; }
    }
    if (failure) throw failure;
  }
  async prune(): Promise<void> {
    const now = this.clock.now();
    const stale: string[] = [];
    let next: number | undefined;
    for await (const record of this.repository.records()) {
      if (record.session.status === 'ended' && record.session.endedAt !== null && record.session.endedAt < now - this.retainMs && !record.outbox.length) stale.push(record.session.id);
      else {
        const wake = nextSessionWake(record, now, this.retainMs);
        if (wake !== undefined) next = Math.min(next ?? Infinity, wake);
      }
    }
    try { await this.repository.removeRecords(stale); }
    catch (error) { await this.repository.schedule(Math.min(next ?? Infinity, now + 30_000)); throw error; }
    await this.repository.schedule(next);
  }
}
