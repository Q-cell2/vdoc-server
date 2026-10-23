import type { DomainEvent } from '@vdoc-server/domain';
import { describe, expect, it } from 'vitest';
import { JsonLogger, TurnMetricsPublisher } from '../src';

const event = (type: string, fields: Record<string, unknown> = {}): DomainEvent => ({ type, aggregateId: 'vs_a', occurredAt: 123, ...fields });

describe('structured voice metrics', () => {
  it('correlates turn latency, review decisions and tool outcomes without retaining content', async () => {
    const lines: string[] = [];
    const sink = new TurnMetricsPublisher(new JsonLogger('info', (line) => lines.push(line)));
    await sink.publish([
      event('TurnCompleted', { turnId: 't1', toolCalls: 2 }),
      event('TurnTelemetry', { turnId: 't1', modelToolCalls: 1, timeToFirstAudioMs: 120.5, timeToFirstToolCallMs: 80, interruptLatencyMs: 0, text: 'private document', arguments: { text: 'private document' } }),
      event('ToolCallReviewed', { turnId: 't1', callId: 'c1', tool: 'apply_document_operations', risk: 'high', decision: 'confirm', operations: ['private document'] }),
      event('ToolCallReviewed', { turnId: 't1', callId: 'c2', tool: 'shell', risk: 'high', decision: 'deny', code: 'UNKNOWN_TOOL' }),
      event('ToolCallCompleted', { turnId: 't1', callId: 'c3', tool: 'read_document', ok: false, code: 'TIMEOUT', output: 'private document' }),
    ]);
    const points = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(points).toHaveLength(5);
    expect(points[0]).toMatchObject({ metric: 'turn.completed', toolCalls: 2 });
    expect(points[1]).toMatchObject({ metrics: true, metric: 'turn.telemetry', sessionId: 'vs_a', turnId: 't1', modelToolCalls: 1, timeToFirstAudioMs: 120.5, interruptLatencyMs: 0 });
    expect(points[2]).toMatchObject({ metric: 'tool.reviewed', decision: 'confirm', count: 1 });
    expect(points[3]).toMatchObject({ metric: 'tool.reviewed', decision: 'deny', code: 'UNKNOWN_TOOL' });
    expect(points[4]).toMatchObject({ metric: 'tool.completed', ok: false, code: 'TIMEOUT' });
    expect(lines.join('\n')).not.toMatch(/private document|"(?:arguments|output|operations)":/);
  });

  it('omits unavailable or invalid measurements and ignores unrelated events', async () => {
    const lines: string[] = [];
    const sink = new TurnMetricsPublisher(new JsonLogger('info', (line) => lines.push(line)));
    await sink.publish([
      event('VoiceSessionGranted'),
      event('TurnCompleted', { turnId: 't1', toolCalls: 0, timeToFirstAudioMs: NaN, timeToFirstToolCallMs: Infinity, interruptLatencyMs: -1 }),
      event('TurnCompleted', { turnId: 't2', toolCalls: 0 }),
    ]);
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      const point = JSON.parse(line) as Record<string, unknown>;
      expect(point.toolCalls).toBe(0);
      expect(point).not.toHaveProperty('timeToFirstAudioMs');
      expect(point).not.toHaveProperty('timeToFirstToolCallMs');
      expect(point).not.toHaveProperty('interruptLatencyMs');
    }
  });

  it('retains only boolean interruption flags on turn telemetry', async () => {
    const lines: string[] = [];
    const sink = new TurnMetricsPublisher(new JsonLogger('info', line => lines.push(line)));
    await sink.publish([
      event('TurnTelemetry', { interrupted: true }),
      event('TurnTelemetry', { interrupted: false }),
      event('TurnTelemetry', { interrupted: 'private transcript' }),
      event('TurnCompleted', { interrupted: true }),
    ]);
    const points = lines.map(line => JSON.parse(line) as Record<string, unknown>);
    expect(points[0]).toHaveProperty('interrupted', true);
    expect(points[1]).toHaveProperty('interrupted', false);
    expect(points[2]).not.toHaveProperty('interrupted');
    expect(points[3]).not.toHaveProperty('interrupted');
    expect(lines.join('')).not.toContain('private transcript');
  });
});
