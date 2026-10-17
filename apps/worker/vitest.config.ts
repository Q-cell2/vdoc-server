import { defineConfig } from 'vitest/config';

// Separate from the root suite: starts workerd, so it is slower and runs in its own CI job.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20000,
    hookTimeout: 90000,
  },
});
