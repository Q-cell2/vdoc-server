import type { DomainEvent, EndReason, Principal, SessionGrant, VoiceSessionId } from '@vdoc-server/domain';

/** Time source; injected so use cases are deterministic under test. */
export interface Clock {
  now(): number;
}

export interface IdGenerator {
  /** A new unique id, e.g. `vs_…` for a voice session. */
  next(prefix: string): string;
}

/** Turns a grant into a tamper-proof token and back. Returns `undefined` for any bad token. */
export interface GrantSigner {
  sign(grant: SessionGrant): Promise<string>;
  verify(token: string): Promise<SessionGrant | undefined>;
}

/** What the caller presented, as the edge received it. */
export interface CallerCredentials {
  readonly bearer: string | undefined;
  readonly trustedUserId?: string;
  readonly requestId?: string;
}

/** Verifies the service credential before accepting its trusted user assertion. */
export interface CallerAuthenticator {
  authenticate(credentials: CallerCredentials): Promise<Principal | undefined>;
}

/** Observer sink for domain events (audit trail, metrics). */
export interface EventPublisher {
  publish(events: readonly DomainEvent[]): Promise<void>;
}

/** Closes the realtime connections of a session that the domain has ended. */
export interface RealtimeConnections {
  close(sessionId: VoiceSessionId, reason: EndReason): Promise<void>;
}
