import { finishWorkerSpeech } from './worker/delegated-model';
import { toSessionConfig } from './session-config';
import type { AgentSessionSettings, AppError } from '@vdoc-server/application';
import type { Result } from '@vdoc-server/domain';
import type { RealtimeSession, SessionConfig } from '@vrealtime/core';

/** Context belongs to the application voice session, including any of its live model connections. */
export class ContextUpdates {
  readonly #models = new Set<RealtimeSession>();
  #pending: { context: unknown } | undefined;
  #running = false;
  #closed = false;

  constructor(
    private readonly configure: (context: unknown) => Promise<Result<AgentSessionSettings, AppError>>,
    private readonly refused: (code: string) => void,
  ) {}

  add(model: RealtimeSession): void { if (!this.#closed) this.#models.add(model); }
  finishSpeech(id: string): boolean {
    if (this.#closed || this.#models.size !== 1) return false;
    return finishWorkerSpeech([...this.#models][0]!, id);
  }
  remove(model: RealtimeSession): void { this.#models.delete(model); }

  /** Retain only the latest pending snapshot while a slow provider finishes its current update. */
  schedule(context: unknown): void {
    if (this.#closed) return;
    this.#pending = { context };
    this.#start();
  }

  close(): void {
    this.#closed = true;
    this.#pending = undefined;
    this.#models.clear();
  }

  #start(): void {
    if (this.#running) return;
    this.#running = true;
    void this.#drain().finally(() => {
      this.#running = false;
      if (this.#pending && !this.#closed) this.#start();
    });
  }

  async #drain(): Promise<void> {
    while (this.#pending && !this.#closed) {
      const { context } = this.#pending;
      this.#pending = undefined;
      try {
        const settings = await this.configure(context);
        if (this.#closed) return;
        if (!settings.ok) { this.refused(settings.error.code); continue; }
        const mapped = toSessionConfig(settings.value);
        const config: Partial<SessionConfig> = { instructions: mapped.instructions!, inputTranscription: mapped.inputTranscription! };
        for (const model of this.#models) {
          if (this.#closed) return;
          if (!model.capabilities.midSessionUpdate.instructions) continue;
          try {
            await model.update(model.capabilities.inputTranscription ? config : { instructions: config.instructions! });
          } catch { this.refused('MODEL_UPDATE_FAILED'); }
        }
      } catch { this.refused('CONTEXT_UPDATE_FAILED'); }
    }
  }
}
