import type { WebSocketLike } from '@vrealtime/server';

/** An `error` frame the realtime server sent to a client. */
export interface ProtocolError {
  readonly code: string;
  readonly message: string;
  readonly recoverable: boolean;
}

/**
 * Decorator: reports every `error` frame vRealTime sends on `socket`, so the
 * failures a client sees (MALFORMED audio, START_FAILED, UNAUTHORIZED…) reach
 * the server log too; vRealTime has no hook for them. Frames are sent unchanged.
 * Binary frames (audio) are never read, and text frames are parsed only when
 * they can be an error.
 */
export function observeErrors(socket: WebSocketLike, report: (error: ProtocolError) => void): WebSocketLike {
  return {
    send(data) {
      socket.send(data);
      if (typeof data !== 'string' || !data.includes('"error"')) return;
      const error = errorFrame(data);
      if (error) report(error);
    },
    close: (code, reason) => socket.close(code, reason),
    get bufferedAmount() { return socket.bufferedAmount ?? 0; },
    addEventListener: (type, listener) => socket.addEventListener?.(type, listener),
  };
}

function errorFrame(text: string): ProtocolError | undefined {
  let frame: unknown;
  try {
    frame = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof frame !== 'object' || frame === null) return undefined;
  const { type, code, message, recoverable } = frame as Record<string, unknown>;
  if (type !== 'error' || typeof code !== 'string') return undefined;
  return { code, message: typeof message === 'string' ? message : '', recoverable: recoverable === true };
}
