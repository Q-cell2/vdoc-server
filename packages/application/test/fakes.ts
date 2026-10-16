import {
  AgentProfile, DocumentSessionPolicy, InstructionTemplate, PrincipalId, ProfileId, RiskAssessor, SessionGrant, SessionLimits,
  VoiceSession, defaultToolPolicy,
  type AgentProfileRepository, type DocumentId, type DomainEvent, type EndReason, type Principal, type VoiceSessionId,
  type VoiceSessionRepository, type VoiceSessionSnapshot,
} from '@vdoc-server/domain';
import { createApplication, type CallerAuthenticator, type CallerCredentials, type Clock, type EventPublisher, type GrantSigner, type IdGenerator, type RealtimeConnections } from '../src';

export class FakeClock implements Clock {
  constructor(public time = 1_000) {}
  now(): number { return this.time; }
  advance(ms: number): void { this.time += ms; }
}

class SequentialIds implements IdGenerator {
  #n = 0;
  next(prefix: string): string { return `${prefix}_${++this.#n}`; }
}

/** Reversible stand-in for the HMAC signer; the application must not care how tokens look. */
class FakeSigner implements GrantSigner {
  async sign(grant: SessionGrant): Promise<string> { return `grant:${JSON.stringify(grant.toProps())}`; }
  async verify(token: string): Promise<SessionGrant | undefined> {
    if (!token.startsWith('grant:')) return undefined;
    const restored = SessionGrant.restore(JSON.parse(token.slice(6)) as Record<string, unknown>);
    return restored.ok ? restored.value : undefined;
  }
}

export const alice: Principal = { id: PrincipalId.assume('alice'), kind: 'client', name: 'Alice' };
export const bob: Principal = { id: PrincipalId.assume('bob'), kind: 'client', name: 'Bob' };
export const as = (principal: Principal): CallerCredentials => ({ bearer: `key-${principal.id}` });

class FakeAuthenticator implements CallerAuthenticator {
  async authenticate({ bearer }: CallerCredentials): Promise<Principal | undefined> {
    return [alice, bob].find((principal) => bearer === `key-${principal.id}`);
  }
}

class MapRepository implements VoiceSessionRepository {
  readonly rows = new Map<string, VoiceSessionSnapshot>();
  async get(id: VoiceSessionId): Promise<VoiceSession | undefined> {
    const row = this.rows.get(id);
    return row && VoiceSession.restore(structuredClone(row));
  }
  async findUnended(documentId: DocumentId): Promise<VoiceSession[]> {
    return [...this.rows.values()].filter((r) => r.documentId === documentId && r.status !== 'ended').map((r) => VoiceSession.restore(structuredClone(r)));
  }
  async save(session: VoiceSession): Promise<void> { this.rows.set(session.id, structuredClone(session.toSnapshot())); }
}

class Profiles implements AgentProfileRepository {
  constructor(private readonly profile: AgentProfile) {}
  async get(id: ProfileId): Promise<AgentProfile | undefined> { return id === this.profile.id ? this.profile : undefined; }
  async getDefault(): Promise<AgentProfile> { return this.profile; }
}

export class EventLog implements EventPublisher {
  readonly events: DomainEvent[] = [];
  async publish(events: readonly DomainEvent[]): Promise<void> { this.events.push(...events); }
  types(): string[] { return this.events.map((e) => e.type); }
}

export class Connections implements RealtimeConnections {
  readonly closed: { sessionId: string; reason: EndReason }[] = [];
  async close(sessionId: VoiceSessionId, reason: EndReason): Promise<void> { this.closed.push({ sessionId, reason }); }
}

export function testProfile(limits: Partial<SessionLimits> = {}): AgentProfile {
  return new AgentProfile({
    id: ProfileId.assume('editor'), name: 'Editor', model: { provider: 'fake' }, turnDetection: 'semantic',
    instructions: new InstructionTemplate('Speak {{language}}. Document: "{{documentTitle}}".'), defaultLanguage: 'en',
    allowedTools: ['read_document', 'apply_document_operations'], maxVocabulary: 3, limits: { ...SessionLimits.defaults, ...limits },
  });
}

export function harness(options: { limits?: Partial<SessionLimits>; concurrency?: 'supersede' | 'reject' } = {}) {
  const clock = new FakeClock();
  const repository = new MapRepository();
  const events = new EventLog();
  const connections = new Connections();
  const app = createApplication({
    sessions: repository, profiles: new Profiles(testProfile(options.limits)), authenticator: new FakeAuthenticator(), signer: new FakeSigner(),
    clock, ids: new SequentialIds(), events, connections, admission: new DocumentSessionPolicy(options.concurrency ?? 'supersede'),
    toolPolicy: defaultToolPolicy(), riskAssessor: new RiskAssessor(),
  });
  return { app, clock, repository, events, connections };
}

/** Grants and connects a session for Alice; returns its ids and token. */
export async function connected(h: ReturnType<typeof harness>, documentId = 'doc-1') {
  const granted = await h.app.grantVoiceSession.execute({ credentials: as(alice), documentId });
  if (!granted.ok) throw new Error(granted.error.message);
  const { sessionId } = granted.value.session;
  const identity = await h.app.authorizeRealtimeConnection.execute({ token: granted.value.grant.token, documentId, sessionId });
  if (!identity.ok) throw new Error(identity.error.message);
  return { sessionId, documentId, token: granted.value.grant.token };
}
