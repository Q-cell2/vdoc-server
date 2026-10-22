import type { AgentSessionSettings } from '@vdoc-server/application';
import type { SessionConfig } from '@vrealtime/core';

/** Application settings → vRealTime session config. Providers want ISO 639-1 language codes. */
export function toSessionConfig(settings: AgentSessionSettings): Partial<SessionConfig> {
  return {
    instructions: settings.instructions,
    turnDetection: settings.turnDetection,
    ...(settings.voice ? { voice: settings.voice } : {}),
    inputTranscription: { language: settings.language.split('-')[0]!.toLowerCase(), vocabulary: settings.vocabulary },
  };
}
