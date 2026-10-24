import { cascade } from '@vrealtime/cascade';
import { openaiStt } from '@vrealtime/openai';
import { energyVad } from '@vrealtime/vad';
import type { ModelProvider } from '../model-registry';
import { claudeText } from './claude-text';

/**
 * Speech recognition + Claude with streamed text and tool arguments as output.
 * OpenAI transcribes input; energy VAD supplies turn detection. No TTS queue
 * delays text events or turn completion.
 * `choice.model` picks the Claude model.
 */
export function cascadeClaudeProvider(options: { anthropicApiKey: string; openaiApiKey: string }): ModelProvider {
  return {
    id: 'cascade-claude',
    create: (choice) => cascade({
      stt: openaiStt({ apiKey: options.openaiApiKey }),
      llm: claudeText({ apiKey: options.anthropicApiKey, ...(choice.model ? { model: choice.model } : {}) }),
      vad: energyVad(),
    }),
  };
}
