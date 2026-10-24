import type { ProfileId } from '../shared';
import type { SessionLimits } from '../voice-session/session-limits';
import type { InstructionTemplate } from './instruction-template';

/** Which realtime model runs the agent. `provider` is resolved by the infrastructure's model registry. */
export interface ModelChoice {
  readonly provider: string;
  readonly model?: string;
  /** Let the model search the web itself (Boson's hosted `web_search`). Providers without one ignore it. */
  readonly webSearch?: boolean;
}

export interface AgentProfileProps {
  readonly id: ProfileId;
  readonly name: string;
  readonly model: ModelChoice;
  readonly voice?: string;
  readonly turnDetection: 'server' | 'semantic';
  readonly instructions: InstructionTemplate;
  /** BCP 47 tag used when the client does not say. */
  readonly defaultLanguage: string;
  /** Client tools this agent may call; anything else is refused. */
  readonly allowedTools: readonly string[];
  /** How long a client tool may run before it fails as TIMEOUT; the realtime edge's default when absent. */
  readonly clientToolTimeoutMs?: number;
  /** The tool through which this agent hands requests to a worker. Sessions of agents without one cannot start worker tasks. */
  readonly handOffTool?: string;
  /** Upper bound on recognition hints taken from the document. */
  readonly maxVocabulary: number;
  readonly limits: SessionLimits;
}

/** How the voice agent behaves for a kind of work (e.g. editing a document). Entity identified by `id`. */
export class AgentProfile {
  readonly allowedTools: ReadonlySet<string>;

  constructor(private readonly props: AgentProfileProps) {
    this.allowedTools = new Set(props.allowedTools);
  }

  get id(): ProfileId { return this.props.id; }
  get name(): string { return this.props.name; }
  get model(): ModelChoice { return this.props.model; }
  get voice(): string | undefined { return this.props.voice; }
  get turnDetection(): 'server' | 'semantic' { return this.props.turnDetection; }
  get defaultLanguage(): string { return this.props.defaultLanguage; }
  get maxVocabulary(): number { return this.props.maxVocabulary; }
  get limits(): SessionLimits { return this.props.limits; }
  get clientToolTimeoutMs(): number | undefined { return this.props.clientToolTimeoutMs; }
  get handOffTool(): string | undefined { return this.props.handOffTool; }

  instructionsFor(values: { language: string; documentTitle: string }): string {
    return this.props.instructions.render(values);
  }

  /** A copy with a different model, e.g. when the deployment overrides the provider. */
  withModel(model: ModelChoice): AgentProfile {
    return new AgentProfile({ ...this.props, model });
  }
}
