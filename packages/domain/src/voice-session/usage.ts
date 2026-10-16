import type { TurnId } from '../shared';

/** What a session has consumed so far. Value object; transitions return new values. */
export interface Usage {
  readonly turns: number;
  readonly toolCalls: number;
  readonly currentTurnId: TurnId | null;
  readonly toolCallsInTurn: number;
}

export const Usage = {
  empty: Object.freeze({ turns: 0, toolCalls: 0, currentTurnId: null, toolCallsInTurn: 0 }) as Usage,

  /** Counts a reviewed tool call, starting a fresh per-turn count when the turn changes. */
  withToolCall(usage: Usage, turnId: TurnId): Usage {
    const sameTurn = usage.currentTurnId === turnId;
    return { turns: usage.turns, toolCalls: usage.toolCalls + 1, currentTurnId: turnId, toolCallsInTurn: sameTurn ? usage.toolCallsInTurn + 1 : 1 };
  },

  /** Tool calls the given turn has made so far, before counting the next one. */
  callsSoFar(usage: Usage, turnId: TurnId): number {
    return usage.currentTurnId === turnId ? usage.toolCallsInTurn : 0;
  },

  withCompletedTurn(usage: Usage): Usage {
    return { turns: usage.turns + 1, toolCalls: usage.toolCalls, currentTurnId: null, toolCallsInTurn: 0 };
  },
};
