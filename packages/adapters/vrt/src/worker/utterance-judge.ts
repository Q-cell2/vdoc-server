import type { AssistantMessage, Context } from '@earendil-works/pi-ai';
import { createModels } from '@earendil-works/pi-ai/models';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';

/** What words spoken during a running task mean for that task. */
export type UtteranceIntent =
  /** Repeats, confirms, or adds or corrects details: the task takes the words in. */
  | 'continue'
  /** Stop or cancel with no new task. */
  | 'stop'
  /** Redo, restart or reset the task, or a different new task: the old task stops and the words become the new one. */
  | 'replace';

export interface UtteranceJudge {
  judge(task: string, utterance: string, signal: AbortSignal): Promise<UtteranceIntent>;
}

const STOP_WORDS = /^(停|停止|停下|停一下|停下来|别做了|不要了|不用了|取消|算了|stop|stop it|cancel|never ?mind)$/i;
/** Filler and acknowledgements: never a new task, so they cannot replace one. */
const FILLER_WORDS = /^(嗯+|啊+|哦+|呃+|好|好的|好吧|对|对的|是的|行|可以|继续|快点|嗯嗯|ok|okay|yes|yeah|uh|um|hmm|go on|continue)$/i;

/** Unambiguous one-phrase stops and filler skip the model call so they act at once. */
export function quickIntent(utterance: string): UtteranceIntent | undefined {
  const words = utterance.replace(/[\s,.!?;:，。！？；：、…]+/g, ' ').trim();
  return STOP_WORDS.test(words) ? 'stop' : FILLER_WORDS.test(words) ? 'continue' : undefined;
}

const SYSTEM = `You classify what a user said to a voice document assistant while it was still working on a task.
Reply with exactly one word:
continue - the words only make sense as part of the current task: they repeat or confirm it, or add or correct a detail of it (for example "make it shorter", "the second section, not the first"), or they are noise or filler.
stop - they want the assistant to stop or cancel and give no new task.
replace - anything else: a different request, a redo or restart, or words that stand on their own as a new instruction.
If unsure, answer replace: users expect the assistant to act on what they said last.`;

export interface UtteranceJudgeOptions {
  apiKey: string;
  /** A fast model: this runs while the user waits. */
  model?: string;
  timeoutMs?: number;
  /** Provider call injection for deterministic tests. */
  completeFn?: (context: Context, signal: AbortSignal) => Promise<AssistantMessage>;
}

/** Any failure or unclear answer is `replace`: users expect their latest words to be acted on, not folded into an older task. */
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
        return answer.startsWith('stop') ? 'stop' : answer.startsWith('continue') ? 'continue' : 'replace';
      } catch {
        return 'replace';
      }
    },
  };
}
