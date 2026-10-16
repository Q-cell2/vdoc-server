import { domainError, err, ok, type DomainError, type Result } from '../shared';
import type { VoiceSession } from './voice-session';

/** What happens when a document already has a live voice session (another tab, another device). */
export type ConcurrencyStrategy = 'supersede' | 'reject';

/** Domain service: decides whether a document may get one more voice session. */
export class DocumentSessionPolicy {
  constructor(private readonly strategy: ConcurrencyStrategy = 'supersede', private readonly maxOpen = 1) {}

  /** Returns the open sessions that must end to admit a new one. */
  admit(open: readonly VoiceSession[]): Result<readonly VoiceSession[], DomainError<'DOCUMENT_BUSY'>> {
    if (open.length < this.maxOpen) return ok([]);
    if (this.strategy === 'reject') return err(domainError('DOCUMENT_BUSY', 'This document already has an active voice session.'));
    return ok(open.slice(0, open.length - this.maxOpen + 1));
  }
}
