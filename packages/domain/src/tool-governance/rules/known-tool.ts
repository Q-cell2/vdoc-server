import type { ToolReviewContext, ToolRule } from '../tool-policy';
import type { ToolDecision } from '../tool-decision';

/** Only tools the agent profile lists may run. */
export class KnownToolRule implements ToolRule {
  readonly name = 'known-tool';

  evaluate({ call, allowedTools, assessment }: ToolReviewContext): ToolDecision | undefined {
    if (allowedTools.has(call.name)) return undefined;
    return { kind: 'deny', risk: assessment.risk, code: 'UNKNOWN_TOOL', message: `The tool "${call.name}" is not available in this session.` };
  }
}
