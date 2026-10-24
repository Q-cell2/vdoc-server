import { boson, type BosonOptions } from '@vrealtime/boson';
import type { ModelProvider } from '../model-registry';
import { withBosonWebSearch } from './boson-web-search';

/** Boson Higgs Realtime. On Cloudflare Workers pass `socket: fetchSocket()` (headers need a fetch upgrade). */
export function bosonProvider(options: { apiKey: string; url?: string; socket?: BosonOptions['socket'] }): ModelProvider {
  return {
    id: 'boson',
    create: (choice) => {
      const socket = choice.webSearch ? withBosonWebSearch(options.socket) : options.socket;
      return boson({
        apiKey: options.apiKey,
        ...(choice.model ? { model: choice.model } : {}),
        ...(options.url ? { url: options.url } : {}),
        ...(socket ? { socket } : {}),
      });
    },
  };
}
