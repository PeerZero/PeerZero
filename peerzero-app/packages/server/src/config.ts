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
  // WARNING: JWT_SECRET must never be committed to .env in source control.
  // Use a secrets manager (AWS Secrets Manager, Vault, etc.) in production.
  get jwtSecret() {
    const secret = required('JWT_SECRET');
    if (secret.length < 32) {
      throw new Error('JWT_SECRET must be at least 32 characters for adequate security');
    }
    return secret;
  },
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

/**
 * Validate correlated config constraints that can't be caught by individual
 * env var checks. Call during startup, before server.listen().
 * Returns an array of warning messages (empty = all clear).
 */
export function validateStartupConfig(): string[] {
  const warnings: string[] = [];

  if (config.useRealAdapters && config.defaultSchoolUrl === 'https://peerzero.science') {
    // Not an error — just verify the user intends to hit production School
    // This catches cases where someone enables real adapters but forgot to
    // set a staging URL during development.
    if (config.isDev) {
      warnings.push(
        'USE_REAL_ADAPTERS=true with default School URL (production) in dev mode. '
        + 'Set DEFAULT_SCHOOL_URL to a staging URL if this is unintentional.'
      );
    }
  }

  if (config.skipPayments && config.nodeEnv === 'production') {
    throw new Error(
      'SKIP_PAYMENTS=true is not allowed in production. '
      + 'All grades would be auto-unlocked, bypassing payment enforcement. '
      + 'Remove SKIP_PAYMENTS or set NODE_ENV to something other than production.'
    );
  }

  if (!config.useRealAdapters && config.nodeEnv === 'production') {
    warnings.push(
      'USE_REAL_ADAPTERS=false in production — School API calls are mocked. '
      + 'Bots will not interact with the real School.'
    );
  }

  if (!config.redisUrl && config.nodeEnv === 'production') {
    warnings.push(
      'REDIS_URL not set in production — job workers and rate limiting will be disabled.'
    );
  }

  // Eagerly validate lazy-getter secrets at startup so misconfigured
  // env vars fail fast instead of crashing on first request.
  if (config.nodeEnv === 'production') {
    config.databaseUrl;       // throws if DATABASE_URL missing
    config.jwtSecret;         // throws if JWT_SECRET missing or < 32 chars
    config.jwtRefreshSecret;  // throws if JWT_REFRESH_SECRET missing
    config.encryptionMasterKey; // throws if ENCRYPTION_MASTER_KEY missing
    config.stripeSecretKey;   // throws if STRIPE_SECRET_KEY missing (unless SKIP_PAYMENTS)

    // Guard against Stripe test keys in production
    const stripeKey = config.stripeSecretKey;
    if (stripeKey && stripeKey.startsWith('sk_test_')) {
      throw new Error(
        'STRIPE_SECRET_KEY is a test key (sk_test_*) in production. '
        + 'Use a live key (sk_live_*) or set NODE_ENV to something other than production.'
      );
    }
  }

  return warnings;
}
