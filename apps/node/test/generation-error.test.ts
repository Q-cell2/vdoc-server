import { expect, it } from 'vitest';
import { generationError } from '../src/playground/generation-error';

it('preserves the specific cause when runtime emits a generic failed terminator afterward', () => {
  const specific = generationError('', 'ACTOR_DELEGATION_FAILED: no tool was executed');
  expect(generationError(specific, 'Generation stopped: failed')).toBe(specific);
  const afterWrite = generationError('', 'WORKER_FAILED_AFTER_WRITE: document already changed');
  expect(generationError(afterWrite, 'Generation stopped: failed')).toBe(afterWrite);
});
it('explains an otherwise generic failure and lets a new specific cause replace it', () => {
  const generic = generationError('', 'Generation stopped: failed');
  expect(generic).toContain('GENERATION_FAILED');
  expect(generationError(generic, 'Authentication failed')).toBe('错误：Authentication failed');
});
