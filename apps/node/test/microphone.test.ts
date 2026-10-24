import { afterEach, expect, it, vi } from 'vitest';
import type { AudioSource } from '@vrealtime/client';
import { createPausableMicrophone } from '../src/playground/microphone';

const format = { encoding: 'pcm16' as const, sampleRate: 24000, channels: 1 as const };
afterEach(() => vi.useRealTimers());

it('stops capture immediately, rejects late real frames, and sends bounded silence to finish the utterance', async () => {
  vi.useFakeTimers();
  const frames: ((frame: Uint8Array) => void)[] = [];
  const stopped = vi.fn(async () => {});
  const mic = createPausableMicrophone(() => {}, async (_rate, frame) => { frames.push(frame); return { stop: stopped }; });
  const sent = vi.fn();
  await mic.input(format, sent);
  frames[0]!(new Uint8Array([7, 0]));
  expect(sent).toHaveBeenCalledTimes(1);
  await mic.pause();
  frames[0]!(new Uint8Array([9, 0]));
  expect(sent).toHaveBeenCalledTimes(1);
  expect(stopped).toHaveBeenCalledTimes(1);
  expect(mic.state).toBe('paused');
  await vi.advanceTimersByTimeAsync(3000);
  expect(sent).toHaveBeenCalledTimes(76);
  expect(sent.mock.calls.slice(1).every(([frame]) => frame.length === 960 && frame.every((byte: number) => byte === 0))).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
  await mic.stop();
});

it('resumes a new capture source while old callbacks stay muted and silence stops', async () => {
  vi.useFakeTimers();
  const frames: ((frame: Uint8Array) => void)[] = [];
  const mic = createPausableMicrophone(() => {}, async (_rate, frame) => { frames.push(frame); return { stop: async () => {} }; });
  const sent = vi.fn();
  const source = await mic.input(format, sent);
  await mic.pause();
  await mic.resume();
  frames[0]!(new Uint8Array([1, 0]));
  frames[1]!(new Uint8Array([2, 0]));
  await vi.advanceTimersByTimeAsync(2000);
  expect(sent.mock.calls.map(([frame]) => [...frame])).toEqual([[2, 0]]);
  expect(mic.state).toBe('listening');
  await source.stop();
  frames[1]!(new Uint8Array([3, 0]));
  expect(sent).toHaveBeenCalledTimes(1);
  expect(mic.attached).toBe(false);
  expect(mic.state).toBe('off');
});

it('cleans up a permission/capture request that resolves after disconnect', async () => {
  let release!: (source: AudioSource) => void;
  const stopped = vi.fn(async () => {});
  const mic = createPausableMicrophone(() => {}, async () => new Promise(resolve => { release = resolve; }));
  const initialized = mic.input(format, vi.fn());
  await Promise.resolve();
  const closed = mic.stop();
  release({ stop: stopped });
  await initialized; await closed;
  expect(stopped).toHaveBeenCalledTimes(1);
  expect(mic.state).toBe('off');
});

it('waits for the previous microphone to close before acquiring another', async () => {
  let releaseStop!: () => void;
  let starts = 0;
  const mic = createPausableMicrophone(() => {}, async () => {
    const first = ++starts === 1;
    return { stop: () => first ? new Promise<void>(resolve => { releaseStop = resolve; }) : Promise.resolve() };
  });
  await mic.input(format, vi.fn());
  const paused = mic.pause(); const resumed = mic.resume();
  await Promise.resolve();
  expect(starts).toBe(1);
  releaseStop(); await paused; await resumed;
  expect(starts).toBe(2);
  expect(mic.state).toBe('listening');
  await mic.stop();
});


it('uses the explicit finish control after capture stops and sends no synthetic client audio in that path', async () => {
  const order: string[] = [];
  let late!: (frame: Uint8Array) => void;
  const finish = vi.fn(() => { order.push('finish'); });
  const microphone = createPausableMicrophone(() => {}, async (_rate, frame) => { late = frame; return { stop: async () => { order.push('stop'); } }; }, finish);
  const send = vi.fn();
  await microphone.input({ encoding: 'pcm16', sampleRate: 24000 }, send);
  await microphone.pause();
  late(new Uint8Array([4, 0]));
  await microphone.pause();
  expect(order).toEqual(['stop', 'finish']);
  expect(finish).toHaveBeenCalledTimes(1);
  expect(send).not.toHaveBeenCalled();
  await microphone.stop();
});
