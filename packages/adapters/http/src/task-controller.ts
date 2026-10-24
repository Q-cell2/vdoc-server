import type { DelegatedTaskRunner, WorkerToolDefinition, WorkerToolResult } from '@vdoc-server/application';
import { credentialsOf, readJsonObject } from './request';
import { fromAppError, json, problem } from './responses';
import type { Params } from './router';

/** Tool schemas and document reads are far larger than session requests. */
const MAX_TASK_BODY = 1024 * 1024;

/** Worker tasks of the worker-speaker profile: start one from a hand-off, then submit tool results until it is done. */
export class TaskController {
  constructor(private readonly tasks: DelegatedTaskRunner) {}

  start = async (request: Request, params: Params): Promise<Response> => {
    const body = await readJsonObject(request, MAX_TASK_BODY);
    if (!body.ok) return problem(body.status, 'INVALID_INPUT', body.message);
    const { callId, arguments: args, tools } = body.value;
    if (typeof callId !== 'string') return problem(400, 'INVALID_INPUT', '"callId" must be a string.');
    if (!Array.isArray(tools)) return problem(400, 'INVALID_INPUT', '"tools" must be an array.');
    const result = await this.tasks.start({
      credentials: credentialsOf(request), documentId: params.documentId!, sessionId: params.sessionId!,
      callId, arguments: args, tools: tools as WorkerToolDefinition[],
    });
    return result.ok ? json(result.value) : fromAppError(result.error);
  };

  submit = async (request: Request, params: Params): Promise<Response> => {
    const body = await readJsonObject(request, MAX_TASK_BODY);
    if (!body.ok) return problem(body.status, 'INVALID_INPUT', body.message);
    const { results } = body.value;
    const valid = Array.isArray(results) && results.every((result: unknown) => {
      const item = result as Partial<WorkerToolResult> | null;
      return item !== null && typeof item === 'object' && typeof item.callId === 'string' && typeof item.ok === 'boolean';
    });
    if (!valid) return problem(400, 'INVALID_INPUT', '"results" must be an array of { callId, ok, output }.');
    const result = await this.tasks.submit({
      credentials: credentialsOf(request), documentId: params.documentId!, sessionId: params.sessionId!,
      taskId: params.taskId!, results: results as WorkerToolResult[],
    });
    return result.ok ? json(result.value) : fromAppError(result.error);
  };
}
