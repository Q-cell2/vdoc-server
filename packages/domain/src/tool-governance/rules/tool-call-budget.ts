import type { ToolReviewContext, ToolRule } from '../tool-policy';
import type { ToolDecision } from '../tool-decision';

/** Stops an agent that keeps calling tools without returning to the user. */
export class ToolCallBudgetRule implements ToolRule {
  readonly name = 'tool-call-budget';

  evaluate({ callsSoFarInTurn, limits, assessment }: ToolReviewContext): ToolDecision | undefined {
    if (callsSoFarInTurn < limits.maxToolCallsPerTurn) return undefined;
    return {
      kind: 'deny', risk: assessment.risk, code: 'TOOL_BUDGET_EXCEEDED',
      message: 'Too many tool calls in one turn. Stop, tell the user what was done, and wait for their next instruction.',
    };
  }
}
