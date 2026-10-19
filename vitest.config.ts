import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/test/**/*.test.ts', 'apps/**/test/**/*.test.ts'],
    exclude: [...configDefaults.exclude, 'apps/worker/test/workerd.test.ts'],
    environment: 'node',
    testTimeout: 15000,
  },
});
