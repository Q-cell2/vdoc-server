import type { RiskLevel } from './risk';

export type ToolDenialCode = 'UNKNOWN_TOOL' | 'TOOL_BUDGET_EXCEEDED' | 'SESSION_CLOSED' | 'CALL_ID_REUSED';

/**
 * The verdict on a tool call. `confirm` means: not now; ask the user, and the
 * same request is allowed if the model repeats it in a later turn.
 */
export type ToolDecision =
  | { readonly kind: 'allow'; readonly risk: RiskLevel }
  | { readonly kind: 'deny'; readonly risk: RiskLevel; readonly code: ToolDenialCode; readonly message: string }
  | { readonly kind: 'confirm'; readonly risk: RiskLevel; readonly message: string };
