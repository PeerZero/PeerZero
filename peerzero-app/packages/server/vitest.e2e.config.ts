import { defineConfig } from 'vitest/config';
import { resolve } from 'path';
import { readFileSync } from 'fs';

// Load .env.test into process.env before any test code runs
const envPath = resolve(__dirname, '.env.test');
const envContent = readFileSync(envPath, 'utf-8');
for (const line of envContent.split('\n')) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) continue;
  const eqIdx = trimmed.indexOf('=');
  if (eqIdx === -1) continue;
  const key = trimmed.slice(0, eqIdx);
  const value = trimmed.slice(eqIdx + 1);
  process.env[key] = value;
}

export default defineConfig({
  test: {
    globals: false,
    include: ['src/__tests__/e2e/**/*.test.ts'],
    testTimeout: 30000,
    hookTimeout: 30000,
    // Run in threads (shares process.env)
    pool: 'threads',
    poolOptions: {
      threads: { singleThread: true },
    },
    // Inject env vars into the test environment
    env: Object.fromEntries(
      envContent.split('\n')
        .map(l => l.trim())
        .filter(l => l && !l.startsWith('#') && l.includes('='))
        .map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)])
    ),
  },
});
