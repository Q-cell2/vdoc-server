import type { ModelChoice } from '@vdoc-server/domain';
import type { RealtimeModel } from '@vrealtime/core';

/** Strategy for one provider: turns a profile's `ModelChoice` into a vRealTime model. */
export interface ModelProvider {
  readonly id: string;
  create(choice: ModelChoice): RealtimeModel;
}

/** Registry + factory. Adding a provider is one `register()` call; nothing else changes (Open/Closed). */
export class ModelRegistry {
  readonly #providers = new Map<string, ModelProvider>();

  register(provider: ModelProvider): this {
    if (this.#providers.has(provider.id)) throw new Error(`Model provider "${provider.id}" is already registered.`);
    this.#providers.set(provider.id, provider);
    return this;
  }

  has(id: string): boolean {
    return this.#providers.has(id);
  }

  create(choice: ModelChoice): RealtimeModel {
    const provider = this.#providers.get(choice.provider);
    if (!provider) throw new Error(`No model provider "${choice.provider}" is registered.`);
    return provider.create(choice);
  }
}
