import type { Result } from '@vdoc-server/domain';
import type { AppError } from './errors';
import type { CallerCredentials } from './ports';
import type { AuthorizeDelegatedTaskInput } from './use-cases/authorize-delegated-task';

/** A client tool the worker may call, as the client declares it (JSON Schema parameters). */
export interface WorkerToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: unknown;
}

export interface WorkerToolCall {
  readonly callId: string;
  readonly name: string;
  readonly arguments: unknown;
}

export interface WorkerToolResult {
  readonly callId: string;
  readonly ok: boolean;
  readonly output: unknown;
}

/** Either the client runs these (already allowed) calls and submits their results, or the task is done. */
export type DelegatedTaskStep =
  | { readonly taskId: string; readonly status: 'calls'; readonly calls: readonly WorkerToolCall[] }
  | { readonly taskId: string; readonly status: 'done'; readonly reply: string };

/**
 * Port: runs worker tasks for the worker-speaker profile. The worker thinks on
 * the server; the document lives in the client, so its tool calls go back to
 * the client one step at a time.
 */
export interface DelegatedTaskRunner {
  start(input: AuthorizeDelegatedTaskInput & { readonly tools: readonly WorkerToolDefinition[] }): Promise<Result<DelegatedTaskStep, AppError>>;
  submit(input: {
    readonly credentials: CallerCredentials; readonly documentId: string; readonly sessionId: string;
    readonly taskId: string; readonly results: readonly WorkerToolResult[];
  }): Promise<Result<DelegatedTaskStep, AppError>>;
}
