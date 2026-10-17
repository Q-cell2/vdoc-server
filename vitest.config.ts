import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/test/**/*.test.ts', 'apps/**/test/**/*.test.ts'],
    // Needs workerd; runs on its own with `npm run test:workerd` (separate CI job).
    exclude: ['**/node_modules/**', 'apps/worker/**'],
    environment: 'node',
    testTimeout: 15000,
  },
});
