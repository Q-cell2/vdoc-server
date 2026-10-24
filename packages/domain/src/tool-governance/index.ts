export { fingerprint, type ToolCall } from './tool-call';
export { RiskAssessor, VDOC_RISK_TABLE, maxRisk, type OperationRiskTable, type RiskAssessment, type RiskLevel } from './risk';
export type { ToolDecision, ToolDenialCode } from './tool-decision';
export { ToolPolicy, type ToolReviewContext, type ToolRule } from './tool-policy';
export { KnownToolRule } from './rules/known-tool';
export { ToolCallBudgetRule } from './rules/tool-call-budget';
export { HighRiskConfirmationRule, HIGH_RISK_CONFIRMATION_MESSAGE } from './rules/high-risk-confirmation';

import { ToolPolicy } from './tool-policy';
import { KnownToolRule } from './rules/known-tool';
import { ToolCallBudgetRule } from './rules/tool-call-budget';
import { HighRiskConfirmationRule } from './rules/high-risk-confirmation';

/** The default chain: unknown tools first, then runaway loops, then destructive edits. */
export const defaultToolPolicy = (): ToolPolicy => new ToolPolicy([new KnownToolRule(), new ToolCallBudgetRule(), new HighRiskConfirmationRule()]);
