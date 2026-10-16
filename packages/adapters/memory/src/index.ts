import type { EventPublisher, RealtimeConnections } from '@vdoc-server/application';
import {
  VoiceSession,
  type AgentProfile, type AgentProfileRepository, type DocumentId, type DomainEvent, type EndReason, type ProfileId,
  type VoiceSessionId, type VoiceSessionRepository, type VoiceSessionSnapshot,
} from '@vdoc-server/domain';

/** Stores snapshots, not objects, so callers cannot mutate stored state by accident (same as a real store). */
export class InMemoryVoiceSessionRepository implements VoiceSessionRepository {
  readonly #rows = new Map<string, VoiceSessionSnapshot>();

  async get(id: VoiceSessionId): Promise<VoiceSession | undefined> {
    const row = this.#rows.get(id);
    return row && VoiceSession.restore(structuredClone(row));
  }

  async findUnended(documentId: DocumentId): Promise<VoiceSession[]> {
    return [...this.#rows.values()]
      .filter((row) => row.documentId === documentId && row.status !== 'ended')
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((row) => VoiceSession.restore(structuredClone(row)));
  }

  async save(session: VoiceSession): Promise<void> {
    this.#rows.set(session.id, structuredClone(session.toSnapshot()));
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
