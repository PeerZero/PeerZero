import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    // Default: run unit tests (exclude e2e)
    exclude: ['src/__tests__/e2e/**', 'src/__tests__/load/**', 'node_modules/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      reportsDirectory: './coverage',
      include: ['src/**/*.ts'],
      exclude: ['src/__tests__/**', 'src/db/migrations/**'],
    },
  },
});
