// =============================================================================
// Environment configuration loader
// Values that require env vars are resolved lazily (via getters) so that
// importing this module during tests doesn't throw when env vars are absent.
// The server's startup path accesses every key immediately, so missing vars
// still fail fast in production — just not at module-collection time in vitest.
// =============================================================================

import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

function required(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}

function optional(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

export const config = {
  // Server
  port: parseInt(optional('PORT', '3001'), 10),
  nodeEnv: optional('NODE_ENV', 'development'),
  isDev: optional('NODE_ENV', 'development') === 'development',

  // Database (App's own — NOT the School's Supabase)
  get databaseUrl() { return required('DATABASE_URL'); },

  // Redis (for BullMQ job queue) — optional in dev mode
  redisUrl: process.env.REDIS_URL || '',

  // JWT
  get jwtSecret() { return required('JWT_SECRET'); },
  get jwtRefreshSecret() { return required('JWT_REFRESH_SECRET'); },
  jwtExpiresIn: '5m',
  jwtRefreshExpiresIn: '30d',

  // Encryption (AES-256-GCM for user API keys)
  get encryptionMasterKey() { return required('ENCRYPTION_MASTER_KEY'); },

  // Stripe
  get stripeSecretKey() {
    return process.env.SKIP_PAYMENTS === 'true' ? optional('STRIPE_SECRET_KEY', '') : required('STRIPE_SECRET_KEY');
  },
  get stripeWebhookSecret() {
    return process.env.SKIP_PAYMENTS === 'true' ? optional('STRIPE_WEBHOOK_SECRET', '') : required('STRIPE_WEBHOOK_SECRET');
  },

  // Payment bypass (for testing — all grades auto-unlocked)
  skipPayments: process.env.SKIP_PAYMENTS === 'true',

  // Adapter mode
  // false = mock adapters (no real API calls)
  // true  = real adapters (connects to School API and LLM providers)
  useRealAdapters: process.env.USE_REAL_ADAPTERS === 'true',

  // School URL (only used when useRealAdapters is true)
  defaultSchoolUrl: optional('DEFAULT_SCHOOL_URL', 'https://peerzero.science'),

  // Frontend URLs for Stripe redirects
  frontendUrl: optional('FRONTEND_URL', 'https://app.peerzero.com'),

  // CORS allowed origins (comma-separated, used in production; dev mode always allows localhost)
  corsOrigins: optional('CORS_ORIGINS', 'https://peerzero.science,https://www.peerzero.science,https://peer-zero.vercel.app'),
} as const;
