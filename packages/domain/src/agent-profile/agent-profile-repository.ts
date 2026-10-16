import type { ProfileId } from '../shared';
import type { AgentProfile } from './agent-profile';

/** Repository port. Profiles are configuration today; a database could back them later. */
export interface AgentProfileRepository {
  get(id: ProfileId): Promise<AgentProfile | undefined>;
  getDefault(): Promise<AgentProfile>;
}
