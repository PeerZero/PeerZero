// =============================================================================
// Environment configuration loader
// All env vars are validated at startup — fail fast if missing.
// =============================================================================

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
  databaseUrl: required('DATABASE_URL'),

  // Redis (for BullMQ job queue)
  redisUrl: required('REDIS_URL'),

  // JWT
  jwtSecret: required('JWT_SECRET'),
  jwtRefreshSecret: required('JWT_REFRESH_SECRET'),
  jwtExpiresIn: '5m',
  jwtRefreshExpiresIn: '30d',

  // Encryption (AES-256-GCM for user API keys)
  encryptionMasterKey: required('ENCRYPTION_MASTER_KEY'),

  // Stripe
  stripeSecretKey: required('STRIPE_SECRET_KEY'),
  stripeWebhookSecret: required('STRIPE_WEBHOOK_SECRET'),

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
