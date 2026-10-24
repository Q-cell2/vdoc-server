import { createMicrophone, type AudioSource, type AudioSourceFactory } from '@vrealtime/client';

export type MicrophoneState = 'off' | 'starting' | 'listening' | 'paused';
type Capture = (sampleRate: number, onFrame: (frame: Uint8Array) => void) => Promise<AudioSource>;

/** Controls only capture. Never closes/interrupts the session, playback, or worker. */
export function createPausableMicrophone(changed: () => void = () => {}, capture: Capture = createMicrophone, finishSpeech?: () => void) {
  let state: MicrophoneState = 'off';
  let attached = false;
  let source: AudioSource | undefined;
  let send: ((frame: Uint8Array) => void) | undefined;
  let sampleRate = 24000;
  let epoch = 0;
  let pending = Promise.resolve();
  let silence: ReturnType<typeof setInterval> | undefined;
  const update = (next: MicrophoneState) => { state = next; changed(); };
  const clearSilence = () => { if (silence !== undefined) clearInterval(silence); silence = undefined; };
  const enqueue = (operation: () => Promise<void>) => {
    const result = pending.then(operation);
    pending = result.catch(() => undefined);
    return result;
  };
  const open = async (generation: number) => {
    if (!attached || generation !== epoch) return;
    const next = await capture(sampleRate, frame => {
      if (attached && generation === epoch && state === 'listening') send?.(frame);
    });
    if (!attached || generation !== epoch) { await next.stop(); return; }
    source = next; update('listening');
  };
  const stop = () => {
    attached = false; epoch++; send = undefined; clearSilence(); update('off');
    return enqueue(async () => { const old = source; source = undefined; await old?.stop(); });
  };
  const input: AudioSourceFactory = async (format, onFrame) => {
    attached = true; send = onFrame; sampleRate = format.sampleRate ?? 24000;
    const generation = ++epoch; update('starting');
    try { await enqueue(() => open(generation)); }
    catch (error) { await stop(); throw error; }
    return { stop };
  };
  return {
    input, stop,
    get state() { return state; },
    get attached() { return attached; },
    pause() {
      if (!attached || state === 'paused') return pending;
      epoch++; update('paused'); clearSilence();
      // Finish the already-sent utterance for server VAD without sending any more microphone audio.
      // Bounded, synthetic 20ms PCM16 silence; not a new user request or a clear/cancel operation.
      if (finishSpeech) return enqueue(async () => { const old = source; source = undefined; await old?.stop(); finishSpeech(); });
      const generation = epoch;
      const frame = new Uint8Array(Math.round(sampleRate * 0.02) * 2);
      let frames = 0;
      const timer = setInterval(() => {
        if (!attached || generation !== epoch || state !== 'paused' || ++frames > 75) {
          clearInterval(timer); if (silence === timer) silence = undefined; return;
        }
        send?.(frame);
        if (frames === 75) { clearInterval(timer); if (silence === timer) silence = undefined; }
      }, 20);
      silence = timer;
      return enqueue(async () => { const old = source; source = undefined; await old?.stop(); });
    },
    resume() {
      if (!attached || state !== 'paused') return pending;
      const generation = ++epoch; clearSilence(); update('starting');
      return enqueue(() => open(generation)).catch(error => {
        if (generation === epoch && attached) update('paused');
        throw error;
      });
    },
  };
}
