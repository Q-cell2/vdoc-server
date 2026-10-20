import { describe, expect, it } from 'vitest';
import { RiskAssessor, VoiceSession, fingerprint } from '../src';
import { activeSession, call, governance, ops } from './fixtures';

describe('RiskAssessor', () => {
  const assessor = new RiskAssessor();

  it('rates batches by their riskiest operation and summarises them without content', () => {
    expect(assessor.assess(call('apply_document_operations', ops('text.style', 'text.insert')))).toEqual({ risk: 'low', operations: ['text.style', 'text.insert'] });
    expect(assessor.assess(call('apply_document_operations', ops('text.style', 'text.delete'))).risk).toBe('medium');
    expect(assessor.assess(call('apply_document_operations', ops('table.edit:deleteTable'))).risk).toBe('high');
    expect(assessor.assess(call('apply_document_operations', ops('table.edit:rowAfter'))).risk).toBe('low');
    expect(assessor.assess(call('apply_document_operations', ops('text.findReplace'))).risk).toBe('high');
  });

  it('treats unrated operations as high, unknown tools as medium, and very large batches as high', () => {
    expect(assessor.assess(call('apply_document_operations', ops('something.new'))).risk).toBe('high');
    expect(assessor.assess(call('apply_document_operations', { operations: [{ action: 'deleteTable' }] })).risk).toBe('high');
    expect(assessor.assess(call('apply_document_operations', ops('block.insert'))).risk).toBe('low');
    expect(assessor.assess(call('mystery', {})).risk).toBe('medium');
    expect(assessor.assess(call('apply_document_operations', ops(...Array(25).fill('text.style')))).risk).toBe('high');
  });
});

describe('fingerprint', () => {
  it('ignores top-level ids, version preconditions and key order', () => {
    const a = { id: 'x', expectedRevision: 3, target: { kind: 'block', id: 'b1' }, operations: [{ type: 'text.delete' }] };
    const b = { operations: [{ type: 'text.delete' }], target: { id: 'b1', kind: 'block' }, expectedRevision: 9, id: 'y' };
    expect(fingerprint({ name: 'apply_document_operations', arguments: a })).toBe(fingerprint({ name: 'apply_document_operations', arguments: b }));
    expect(fingerprint({ name: 'apply_document_operations', arguments: { ...a, operations: [{ type: 'text.insert' }] } })).not.toBe(fingerprint({ name: 'apply_document_operations', arguments: a }));
  });

  it('keeps nested ids, which name what an edit targets', () => {
    const remove = (id: string) => ({ name: 'apply_document_operations', arguments: { expectedRevision: 1, target: { kind: 'block', id: 'b0' }, operations: [{ type: 'block.delete', id }] } });
    expect(fingerprint(remove('b1'))).not.toBe(fingerprint(remove('b2')));
    const targeted = (id: string) => ({ name: 'apply_document_operations', arguments: { target: { kind: 'block', id }, operations: [{ type: 'text.delete' }] } });
    expect(fingerprint(targeted('b1'))).not.toBe(fingerprint(targeted('b2')));
  });
});

describe('VoiceSession.reviewToolCall', () => {
  it('allows ordinary edits and counts them per turn', () => {
    const session = activeSession();
    expect(session.reviewToolCall(call('apply_document_operations', ops('text.style')), governance(), 2_000, 0)).toEqual({ kind: 'allow', risk: 'low' });
    expect(session.usage).toMatchObject({ toolCalls: 1, toolCallsInTurn: 1 });
    const [event] = session.pullEvents();
    expect(event).toMatchObject({ type: 'ToolCallReviewed', decision: 'allow', operations: ['text.style'] });
  });

  it('refuses tools the profile does not list', () => {
    const decision = activeSession().reviewToolCall(call('delete_everything', {}), governance(), 2_000, 0);
    expect(decision).toMatchObject({ kind: 'deny', code: 'UNKNOWN_TOOL' });
  });

  it('stops a turn that keeps calling tools', () => {
    const session = activeSession(0, { maxToolCallsPerTurn: 2 });
    const read = () => session.reviewToolCall(call('read_document', {}, 't1'), governance(), 1, 0);
    expect(read().kind).toBe('allow');
    expect(read().kind).toBe('allow');
    expect(read()).toMatchObject({ kind: 'deny', code: 'TOOL_BUDGET_EXCEEDED' });
    expect(session.reviewToolCall(call('read_document', {}, 't2'), governance(), 2, 0).kind).toBe('allow');
  });

  it('asks before a destructive edit and allows the same request only in a later turn', () => {
    const session = activeSession();
    const destructive = (turn: string, revision: number) => call('apply_document_operations', { expectedRevision: revision, ...ops('table.edit:deleteTable') }, turn);
    expect(session.reviewToolCall(destructive('t1', 4), governance(), 1, 1)).toMatchObject({ kind: 'confirm', risk: 'high' });
    expect(session.reviewToolCall(destructive('t1', 4), governance(), 2, 1).kind).toBe('confirm');
    expect(session.reviewToolCall(destructive('t2', 5), governance(), 3, 2)).toEqual({ kind: 'allow', risk: 'high' });
    expect(session.reviewToolCall(destructive('t3', 6), governance(), 4, 3).kind).toBe('confirm');
  });

  it('does not let a confirmation for one block authorize deleting another', () => {
    const session = activeSession();
    const remove = (id: string, turn: string) => call('apply_document_operations', { expectedSessionId: 'ed1', expectedBlocks: [{ id, version: 1 }], target: { kind: 'block', id }, operations: [{ type: 'block.delete', id }] }, turn);
    expect(session.reviewToolCall(remove('b1', 't1'), governance(), 1, 1).kind).toBe('confirm');
    expect(session.reviewToolCall(remove('b2', 't2'), governance(), 2, 2).kind).toBe('confirm');
    expect(session.reviewToolCall(remove('b1', 't3'), governance(), 3, 3)).toEqual({ kind: 'allow', risk: 'high' });
  });

  it('consumes a confirmation only after the user has given input since it was asked', () => {
    const session = activeSession();
    const destructive = (turn: string) => call('apply_document_operations', ops('block.delete'), turn);
    expect(session.reviewToolCall(destructive('t1'), governance(), 1, 1).kind).toBe('confirm');
    // A turn the model opened by itself (late tool result, unprompted response): no new input.
    expect(session.reviewToolCall(destructive('t2'), governance(), 2, 1).kind).toBe('confirm');
    expect(session.reviewToolCall(destructive('t3'), governance(), 3, 2)).toEqual({ kind: 'allow', risk: 'high' });
  });

  it('asks again for confirmations stored before user input was tracked', () => {
    const asked = activeSession();
    const destructive = (turn: string) => call('apply_document_operations', ops('block.delete'), turn);
    expect(asked.reviewToolCall(destructive('t1'), governance(), 1, 1).kind).toBe('confirm');
    const snapshot = structuredClone(asked.toSnapshot());
    const legacy = VoiceSession.restore({ ...snapshot, pendingConfirmations: snapshot.pendingConfirmations.map(({ fingerprint, turnId }) => ({ fingerprint, turnId })) });
    expect(legacy.reviewToolCall(destructive('t2'), governance(), 2, 5).kind).toBe('confirm');
    expect(legacy.reviewToolCall(destructive('t3'), governance(), 3, 6)).toEqual({ kind: 'allow', risk: 'high' });
  });

  it('denies every call once the session is closed', () => {
    const session = activeSession();
    session.end('client', 2);
    expect(session.reviewToolCall(call('read_document', {}), governance(), 3, 0)).toMatchObject({ kind: 'deny', code: 'SESSION_CLOSED' });
    expect(activeSession(0, { maxDurationMs: 10 }).reviewToolCall(call('read_document', {}), governance(), 10, 0)).toMatchObject({ kind: 'deny', code: 'SESSION_CLOSED' });
  });
  it('persists review idempotency but never reuses an allow for a different request or a closed session', () => {
    const session = activeSession();
    const request = call('read_document', {});
    expect(session.reviewToolCall(request, governance(), 2000, 0).kind).toBe('allow');
    const restored = VoiceSession.restore(structuredClone(session.toSnapshot()));
    expect(restored.reviewToolCall(request, governance(), 2001, 0).kind).toBe('allow');
    expect(restored.usage.toolCalls).toBe(1);
    expect(restored.pullEvents()).toEqual([]);
    expect(restored.reviewToolCall({ ...request, name: 'apply_document_operations', arguments: ops('text.delete') }, governance(), 2002, 0)).toMatchObject({ kind: 'deny', code: 'CALL_ID_REUSED' });
    restored.end('client', 2003);
    expect(restored.reviewToolCall(request, governance(), 2004, 0)).toMatchObject({ kind: 'deny', code: 'SESSION_CLOSED' });
  });

});
