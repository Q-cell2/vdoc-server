import type { SessionLimits } from '../voice-session/session-limits';
import type { RiskAssessment } from './risk';
import type { ToolCall } from './tool-call';
import type { ToolDecision } from './tool-decision';

/** Everything a rule may look at. Built by the session aggregate; rules never mutate it. */
export interface ToolReviewContext {
  readonly call: ToolCall;
  readonly assessment: RiskAssessment;
  readonly allowedTools: ReadonlySet<string>;
  readonly limits: SessionLimits;
  /** Calls the same turn made before this one. */
  readonly callsSoFarInTurn: number;
  /** The user was asked about exactly this request in an earlier turn and has given input since. */
  readonly confirmedInEarlierTurn: boolean;
}

/** One link of the chain: decide, or return `undefined` to let the next rule decide. */
export interface ToolRule {
  readonly name: string;
  evaluate(context: ToolReviewContext): ToolDecision | undefined;
}

/** Chain of Responsibility over `ToolRule`s. Calls no rule rejects are allowed. */
export class ToolPolicy {
  constructor(private readonly rules: readonly ToolRule[]) {}

  review(context: ToolReviewContext): ToolDecision {
    for (const rule of this.rules) {
      const decision = rule.evaluate(context);
      if (decision) return decision;
    }
    return { kind: 'allow', risk: context.assessment.risk };
  }

  /** Open/Closed: extend a policy without editing existing rules. */
  with(...rules: readonly ToolRule[]): ToolPolicy {
    return new ToolPolicy([...this.rules, ...rules]);
  }
}
