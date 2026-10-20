import { cascade } from '@vrealtime/cascade';
import { openaiStt, openaiTts } from '@vrealtime/openai';
import { energyVad } from '@vrealtime/vad';
import type { ModelProvider } from '../model-registry';
import { claudeText } from './claude-text';

/**
 * Speech recognition + Claude + speech synthesis as one realtime model, for when
 * editing needs stronger reasoning than a speech-to-speech model. Speech goes
 * through OpenAI's transcription and speech endpoints; the energy VAD gives it
 * turn detection, so clients talk to it exactly as they talk to Boson.
 * `choice.model` picks the Claude model.
 */
export function cascadeClaudeProvider(options: { anthropicApiKey: string; openaiApiKey: string }): ModelProvider {
  return {
    id: 'cascade-claude',
    create: (choice) => cascade({
      stt: openaiStt({ apiKey: options.openaiApiKey }),
      llm: claudeText({ apiKey: options.anthropicApiKey, ...(choice.model ? { model: choice.model } : {}) }),
      tts: openaiTts({ apiKey: options.openaiApiKey }),
      vad: energyVad(),
    }),
  };
}
