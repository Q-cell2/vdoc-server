import type { ToolReviewContext, ToolRule } from '../tool-policy';
import type { ToolDecision } from '../tool-decision';

/**
 * Destructive edits need the user's explicit yes: the first request is turned
 * into a question, and the identical request is allowed only in a later turn,
 * after the user has spoken. Language-agnostic; no transcript parsing.
 */
export class HighRiskConfirmationRule implements ToolRule {
  readonly name = 'high-risk-confirmation';

  evaluate({ assessment, confirmedInEarlierTurn }: ToolReviewContext): ToolDecision | undefined {
    if (assessment.risk !== 'high' || confirmedInEarlierTurn) return undefined;
    return {
      kind: 'confirm', risk: 'high',
      message: 'This edit can remove or rewrite a lot of content. Ask the user to confirm in one short sentence. Only if they clearly agree, make exactly the same call again.',
    };
  }
}
