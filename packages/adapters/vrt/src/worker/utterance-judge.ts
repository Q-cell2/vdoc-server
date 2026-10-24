import type { AssistantMessage, Context } from '@earendil-works/pi-ai';
import { createModels } from '@earendil-works/pi-ai/models';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';

/** What words spoken during a running task mean for that task. */
export type UtteranceIntent =
  /** Repeats, confirms or adds details: the task keeps running and receives the words. */
  | 'continue'
  /** Stop or cancel with no new task. */
  | 'stop'
  /** Redo, restart or reset the task, or a different new task: the old task stops and the words become the new one. */
  | 'replace';

export interface UtteranceJudge {
  judge(task: string, utterance: string, signal: AbortSignal): Promise<UtteranceIntent>;
}

const STOP_WORDS = /^(停|停止|停下|停一下|停下来|别做了|不要了|不用了|取消|算了|stop|stop it|cancel|never ?mind)$/i;

/** Unambiguous one-phrase stops skip the model call so they act at once. */
export function quickIntent(utterance: string): UtteranceIntent | undefined {
  return STOP_WORDS.test(utterance.replace(/[\s,.!?;:，。！？；：、…]+/g, ' ').trim()) ? 'stop' : undefined;
}

const SYSTEM = `You classify what a user said to a voice document assistant while it was still working on a task.
Reply with exactly one word:
continue - they repeat, confirm or rephrase the current task, add or correct details of it, think aloud, or it is noise or filler.
stop - they want the assistant to stop or cancel and give no new task.
replace - they want to redo, restart or reset the task, or they ask for a different new task.`;

export interface UtteranceJudgeOptions {
  apiKey: string;
  /** A fast model: this runs while the user waits. */
  model?: string;
  timeoutMs?: number;
  /** Provider call injection for deterministic tests. */
  completeFn?: (context: Context, signal: AbortSignal) => Promise<AssistantMessage>;
}

/** Any failure or unclear answer is `continue`: the safe choice never discards a running task. */
export function createUtteranceJudge(options: UtteranceJudgeOptions): UtteranceJudge {
  const models = createModels();
  models.setProvider(anthropicProvider());
  const modelId = options.model ?? 'claude-haiku-5-5';
  const model = models.getModel('anthropic', modelId);
  if (!model) throw new Error(`Unknown utterance judge model: ${modelId}`);
  const complete = options.completeFn ?? ((context: Context, signal: AbortSignal) => models.completeSimple(model, context, { apiKey: options.apiKey, maxTokens: 8, signal }));
  return {
    async judge(task, utterance, signal) {
      const quick = quickIntent(utterance);
      if (quick) return quick;
      try {
        const message = await complete({
          systemPrompt: SYSTEM,
          messages: [{ role: 'user', content: [{ type: 'text', text: JSON.stringify({ currentTask: task.slice(0, 2000), newWords: utterance.slice(0, 2000) }) }], timestamp: Date.now() }],
        }, AbortSignal.any([signal, AbortSignal.timeout(options.timeoutMs ?? 4000)]));
        const answer = message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('').trim().toLowerCase();
        return answer.startsWith('stop') ? 'stop' : answer.startsWith('replace') ? 'replace' : 'continue';
      } catch {
        return 'continue';
      }
    },
  };
}
