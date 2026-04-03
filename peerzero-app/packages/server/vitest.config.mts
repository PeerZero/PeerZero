import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    // Default: run unit tests (exclude e2e)
    exclude: ['src/__tests__/e2e/**', 'src/__tests__/load/**', 'node_modules/**'],
  },
});
