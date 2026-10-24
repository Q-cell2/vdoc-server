import type { DocumentId, VoiceSessionId } from '../shared';
import type { VoiceSession } from './voice-session';

/** Repository port for the `VoiceSession` aggregate. */
export interface VoiceSessionRepository {
  get(id: VoiceSessionId): Promise<VoiceSession | undefined>;
  /** Sessions of a document that have not ended (they may still be past a deadline). */
  findUnended(documentId: DocumentId): Promise<VoiceSession[]>;
  save(session: VoiceSession): Promise<void>;
}
