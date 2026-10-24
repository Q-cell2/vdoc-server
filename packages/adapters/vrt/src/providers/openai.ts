import { openai } from '@vrealtime/openai';
import type { ModelProvider } from '../model-registry';

/** OpenAI Realtime, as an alternative to Boson. */
export function openaiProvider(options: { apiKey: string }): ModelProvider {
  return { id: 'openai', create: (choice) => openai({ apiKey: options.apiKey, ...(choice.model ? { model: choice.model } : {}) }) };
}
