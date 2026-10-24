import { boson, type BosonOptions } from '@vrealtime/boson';
import type { ModelProvider } from '../model-registry';

/** Boson Higgs Realtime. On Cloudflare Workers pass `socket: fetchSocket()` (headers need a fetch upgrade). */
export function bosonProvider(options: { apiKey: string; url?: string; socket?: BosonOptions['socket'] }): ModelProvider {
  return {
    id: 'boson',
    create: (choice) => boson({
      apiKey: options.apiKey,
      ...(choice.model ? { model: choice.model } : {}),
      ...(options.url ? { url: options.url } : {}),
      ...(options.socket ? { socket: options.socket } : {}),
    }),
  };
}
