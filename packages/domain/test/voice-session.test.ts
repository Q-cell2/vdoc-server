import type { ToolCall, ToolGovernance } from '../src';
import { describe, expect, it } from 'vitest';
import { ToolCallId, TurnId, VoiceSession } from '../src';
import { activeSession, governance, grantedSession, principal } from './fixtures';

describe('VoiceSession lifecycle', () => {
  it('is granted to one principal and records the grant', () => {
    const session = grantedSession();
    expect(session.status).toBe('granted');
    expect(session.isOwnedBy(principal.id)).toBe(true);
    expect(session.pullEvents().map((e) => e.type)).toEqual(['VoiceSessionGranted']);
  });

  it('connects once, then treats further connections as reconnects', () => {
    const session = grantedSession();
    expect(session.connect(2_000)).toEqual({ ok: true, value: { reconnect: false } });
    expect(session.connect(3_000)).toEqual({ ok: true, value: { reconnect: true } });
    expect(session.status).toBe('active');
  });

  it('expires when nobody connects before the grant runs out, and renewing extends it', () => {
    const session = grantedSession(0, { grantTtlMs: 1_000 });
    expect(session.issueGrant(900).ok).toBe(true);
    expect(session.isOpenAt(1_500)).toBe(true);
    expect(session.isOpenAt(2_000)).toBe(false);
    expect(session.connect(2_000)).toMatchObject({ ok: false, error: { code: 'SESSION_CLOSED' } });
    expect(session.expireIfOverdue(2_000)).toBe('expired');
    expect(session.status).toBe('ended');
  });

  it('ends at its maximum duration and its maximum number of turns', () => {
    const timed = activeSession(0, { maxDurationMs: 10_000 });
    expect(timed.expireIfOverdue(9_999)).toBeUndefined();
    expect(timed.expireIfOverdue(10_000)).toBe('limit-duration');

    const counted = activeSession(0, { maxTurns: 2 });
    expect(counted.completeTurn(TurnId.assume('t1'), 1)).toBeUndefined();
    expect(counted.completeTurn(TurnId.assume('t2'), 2)).toBe('limit-turns');
    expect(counted.usage.turns).toBe(2);
  });

  it('never reopens and ends exactly once', () => {
    const session = activeSession();
    expect(session.end('client', 5_000)).toBe(true);
    expect(session.end('client', 6_000)).toBe(false);
    expect(session.issueGrant(5_001).ok).toBe(false);
    expect(session.connect(5_001).ok).toBe(false);
    expect(session.pullEvents().filter((e) => e.type === 'VoiceSessionEnded')).toHaveLength(1);
  });

  it('round-trips through its snapshot', () => {
    const session = activeSession();
    session.completeTurn(TurnId.assume('t1'), 2_000);
    const copy = VoiceSession.restore(JSON.parse(JSON.stringify(session.toSnapshot())));
    expect(copy.toSnapshot()).toEqual(session.toSnapshot());
    expect(copy.pullEvents()).toEqual([]);
  });
  it('persists completion idempotency across restore and bounds unconnected renewal', () => {
    const session = activeSession(0, { maxTurns: 3 });
    session.completeTurn(TurnId.assume('same'), 1);
    session.recordToolResult({ id: ToolCallId.assume('call'), name: 'read_document', turnId: TurnId.assume('same') }, { ok: true }, 2);
    const restored = VoiceSession.restore(structuredClone(session.toSnapshot()));
    restored.completeTurn(TurnId.assume('same'), 3);
    restored.recordToolResult({ id: ToolCallId.assume('call'), name: 'read_document', turnId: TurnId.assume('same') }, { ok: true }, 4);
    expect(restored.usage.turns).toBe(1);
    expect(restored.pullEvents()).toEqual([]);
    const pending = grantedSession(0, { grantTtlMs: 1000, maxDurationMs: 1500 });
    expect(pending.issueGrant(900).ok).toBe(true);
    expect(pending.toSnapshot().connectDeadline).toBe(1500);
    expect(pending.issueGrant(1501).ok).toBe(false);
  });

  it('keeps its snapshot small however many turns and tool calls it records', () => {
    const session = activeSession(0, { maxTurns: 300, maxToolCallsPerTurn: 12, maxDurationMs: 1e12 });
    let now = 1;
    for (let turn = 0; turn < 300; turn++) {
      const turnId = TurnId.assume(`turn-${turn}-${'x'.repeat(32)}`);
      for (let index = 0; index < 12; index++) {
        const call = { id: ToolCallId.assume(`call-${turn}-${index}-${'y'.repeat(32)}`), name: 'read_document', arguments: {}, turnId };
        review(session, call, governance(), now++, turn);
        session.recordToolResult(call, { ok: true }, now++);
      }
      session.completeTurn(turnId, now++);
      session.pullEvents();
    }
    expect(session.status).toBe('ended');
    expect(JSON.stringify(session.toSnapshot()).length).toBeLessThan(32_000);
  });

  it('forgets a finished turn’s tool decisions, yet still counts that turn and its results once', () => {
    const session = activeSession();
    const turnId = TurnId.assume('t1');
    const call = { id: ToolCallId.assume('c1'), name: 'read_document', arguments: {}, turnId };
    review(session, call, governance(), 2, 0);
    session.recordToolResult(call, { ok: true }, 3);
    session.completeTurn(turnId, 4);
    expect(session.toSnapshot().toolDecisions ?? {}).toEqual({});
    session.recordToolResult(call, { ok: true }, 5);
    expect(session.completeTurn(turnId, 6)).toBeUndefined();
    expect(session.usage.turns).toBe(1);
    expect(session.pullEvents().filter((event) => event.type === 'ToolCallCompleted' || event.type === 'TurnCompleted')).toHaveLength(2);
  });

});

function review(session: VoiceSession, call: ToolCall, governance: ToolGovernance, now: number, inputs: number) {
  while (session.userInputs < inputs) session.recordUserInput(now);
  return session.reviewToolCall(call, governance, now);
}
