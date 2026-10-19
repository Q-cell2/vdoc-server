import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/workerd.test.ts'],
    environment: 'node',
    testTimeout: 15000,
  },
});
