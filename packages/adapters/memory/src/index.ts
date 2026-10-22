import { migrateSessionRecord } from '@vdoc-server/application';
import type { EventPublisher, RealtimeConnections, SessionRepository, SessionRecord } from '@vdoc-server/application';
import {
  VoiceSession,
  type AgentProfile, type AgentProfileRepository, type DocumentId, type DomainEvent, type EndReason, type ProfileId,
  type VoiceSessionId,
} from '@vdoc-server/domain';

/** Stores snapshots, not objects, so callers cannot mutate stored state by accident (same as a real store). */
export class InMemoryVoiceSessionRepository implements SessionRepository {
  readonly #rows = new Map<string, SessionRecord>();
  async getRecord(id: string): Promise<SessionRecord | undefined> { return structuredClone(this.#rows.get(id)); }
  async putRecord(record: SessionRecord): Promise<void> { this.#rows.set(record.session.id, structuredClone(record)); }
  async *records(): AsyncGenerator<SessionRecord> { for (const row of this.#rows.values()) yield structuredClone(row); }
  async removeRecords(ids: readonly string[]): Promise<void> { for (const id of ids) this.#rows.delete(id); }
  async schedule(_nextWakeAt: number | undefined): Promise<void> {}
  async get(id: VoiceSessionId): Promise<VoiceSession | undefined> {
    const record = await this.getRecord(id); return record && VoiceSession.restore(record.session);
  }
  async findUnended(documentId: DocumentId): Promise<VoiceSession[]> {
    return [...this.#rows.values()].filter(r => r.session.documentId === documentId && r.session.status !== 'ended')
      .sort((a, b) => a.session.createdAt - b.session.createdAt).map(r => VoiceSession.restore(structuredClone(r.session)));
  }
  async save(session: VoiceSession): Promise<void> {
    const previous = await this.getRecord(session.id);
    await this.putRecord(previous ? { ...previous, session: session.toSnapshot() } : migrateSessionRecord(session.toSnapshot()));
  }
}

/** Profiles from configuration. */
export class InMemoryAgentProfileRepository implements AgentProfileRepository {
  readonly #profiles: ReadonlyMap<string, AgentProfile>;

  constructor(profiles: readonly AgentProfile[], private readonly defaultId: ProfileId) {
    this.#profiles = new Map(profiles.map((profile) => [profile.id, profile]));
    if (!this.#profiles.has(defaultId)) throw new Error(`Default profile "${defaultId}" is not configured.`);
  }

  async get(id: ProfileId): Promise<AgentProfile | undefined> {
    return this.#profiles.get(id);
  }

  async getDefault(): Promise<AgentProfile> {
    return this.#profiles.get(this.defaultId)!;
  }
}

/** Keeps every published event; for tests and local inspection. */
export class RecordingEventPublisher implements EventPublisher {
  readonly events: DomainEvent[] = [];

  async publish(events: readonly DomainEvent[]): Promise<void> {
    this.events.push(...events);
  }

  types(): string[] {
    return this.events.map((event) => event.type);
  }
}

/** Remembers which sessions were asked to close; for tests. */
export class RecordingRealtimeConnections implements RealtimeConnections {
  readonly closed: { sessionId: string; reason: EndReason }[] = [];

  async close(sessionId: VoiceSessionId, reason: EndReason): Promise<void> {
    this.closed.push({ sessionId, reason });
  }
}
