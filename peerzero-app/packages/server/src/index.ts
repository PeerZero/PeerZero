// =============================================================================
// PeerZero App Server — Entry point
// System 2: completely separate from the School (System 1).
// Connects to School only through adapters when USE_REAL_ADAPTERS=true.
// =============================================================================

// Sentry must be initialized before other imports for proper instrumentation
import * as Sentry from '@sentry/node';
if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || 'development',
    // Capture 10% of transactions for performance monitoring in production
    tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1.0,
    // Don't send PII (user IPs, cookies)
    sendDefaultPii: false,
  });
}

import 'express-async-errors';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { createServer } from 'http';
import { config, validateStartupConfig } from './config';
import { logger } from './lib/logger';
import { errorHandler } from './middleware/error-handler';
import { requestIdMiddleware } from './middleware/request-id';
import { authLimiter, closeRateLimitRedis } from './middleware/rate-limit';
import { closePool } from './db/client';
import { runMigrations } from './db/auto-migrate';
import { startWorker, stopWorker, recoverRunningBots, cleanupOldJobs } from './jobs/queue';
import { startPlatformWorker, stopPlatformWorker, cleanupOldPlatformJobs } from './jobs/platform-queue';
import { setupWebSocket, closeActivityStreamRedis } from './websocket/activity-stream';
import { purgeExpiredAuditLogs } from './services/audit.service';

// Routes
import authRoutes from './routes/auth';
import { closeAuthRedis } from './services/auth.service';
import botRoutes from './routes/bots';
import apiKeyRoutes from './routes/api-keys';
import schoolRoutes from './routes/schools';
import paymentRoutes from './routes/payments';
import healthRoutes from './routes/health';
import notificationRoutes from './routes/notifications';
import externalActivityRoutes, { closePhoneHomeRedis } from './routes/external-activity';
import widgetRoutes from './routes/widgets';
import platformRoutes from './routes/platforms';
import skillRoutes from './routes/skills';
import publicBotRoutes from './routes/bots-public';
import taskRoutes from './routes/tasks';

let auditPurgeInterval: NodeJS.Timeout;
let jobCleanupInterval: NodeJS.Timeout;

const app = express();

// Trust the first proxy (load balancer / reverse proxy) for accurate client IPs
// in X-Forwarded-For. This ensures req.ip and rate limiting use the real client
// IP, not the proxy's IP. Adjust the number if behind multiple proxy layers.
app.set('trust proxy', 1);

// ── Middleware ──
app.use(requestIdMiddleware);

// CSRF note: This is an API-only server (no HTML forms). CSRF is mitigated by
// requiring Authorization headers (Bearer tokens) on all authenticated endpoints.
// Browsers do not attach Authorization headers automatically from cross-origin
// form submissions, so CSRF attacks cannot forge authenticated requests.
app.use(helmet({
  hsts: {
    maxAge: 31536000,        // 1 year in seconds
    includeSubDomains: true,
    preload: true,
  },
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'none'"],
      scriptSrc: ["'none'"],
      styleSrc: ["'none'"],
      imgSrc: ["'none'"],
      connectSrc: ["'self'"],
      frameSrc: ["'none'"],
      objectSrc: ["'none'"],
      baseUri: ["'none'"],
      formAction: ["'none'"],
      // CSP violation reporting — configure via CSP_REPORT_URI env var
      // (e.g., Sentry CSP endpoint or dedicated report collector)
      ...(process.env.CSP_REPORT_URI ? { reportUri: process.env.CSP_REPORT_URI } : {}),
    },
  },
}));
// Reporting-Endpoints header for CSP report-to (modern browsers)
if (process.env.CSP_REPORT_URI) {
  app.use((_req, res, next) => {
    res.setHeader('Reporting-Endpoints', `csp-endpoint="${process.env.CSP_REPORT_URI}"`);
    next();
  });
}
app.use(cors({
  origin: config.isDev
    ? [/^https?:\/\/localhost(:\d+)?$/, /^https?:\/\/127\.0\.0\.1(:\d+)?$/]
    : config.corsOrigins.split(',').map(s => s.trim()).filter(Boolean),
  credentials: true,
}));
// Auth routes get IP-based rate limiting (unauthenticated, can't key by user)
// Authenticated routes get per-user Redis-backed limits applied at the route level.

// Raw body for Stripe webhooks (must come before express.json)
app.use('/api/payments/webhook', express.raw({ type: 'application/json', limit: '5mb' }));
// Resend webhook needs parsed JSON body
app.use(express.json({ limit: '5mb' }));

// ── Routes ──
app.use('/api/auth', authLimiter, authRoutes);
app.use('/api/bots/external-activity', externalActivityRoutes);  // Phone-home from self-hosted bots (token auth, not JWT) — MUST be before /api/bots
app.use('/api/bots/public', publicBotRoutes);                   // Public bot profiles (no auth) — MUST be before /api/bots
app.use('/api/bots', taskRoutes);                                // Task coordination (incoming + management) — MUST be before botRoutes
app.use('/api/bots', botRoutes);
app.use('/api/keys', apiKeyRoutes);
app.use('/api/schools', schoolRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/widgets', widgetRoutes);
app.use('/api/platforms', platformRoutes);
app.use('/api/skills', skillRoutes);
app.use('/health', healthRoutes);

// ── Resend email webhook (bounce/complaint handling) ──
app.post('/api/webhooks/resend', async (req, res) => {
  try {
    const { handleResendWebhook } = await import('./services/email.service');
    await handleResendWebhook(req.body);
    res.json({ received: true });
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : err }, 'Resend webhook handler failed');
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

// ── Well-known files for Universal Links (iOS) and App Links (Android) ──
app.get('/.well-known/apple-app-site-association', (_req, res) => {
  res.json({
    applinks: {
      apps: [],
      details: [{
        appID: 'TEAM_ID.com.peerzero.app', // Replace TEAM_ID with Apple Developer Team ID
        paths: ['/bot/*', '/invite/*', '/verify/*'],
      }],
    },
    webcredentials: {
      apps: ['TEAM_ID.com.peerzero.app'],
    },
  });
});

app.get('/.well-known/assetlinks.json', (_req, res) => {
  res.json([{
    relation: ['delegate_permission/common.handle_all_urls'],
    target: {
      namespace: 'android_app',
      package_name: 'com.peerzero.app',
      // Replace with production signing certificate SHA-256 fingerprint
      sha256_cert_fingerprints: ['REPLACE_WITH_PRODUCTION_SHA256_FINGERPRINT'],
    },
  }]);
});

// ── 404 catch-all for unknown routes ──
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// ── Sentry error handler (captures exceptions before the custom error handler) ──
if (process.env.SENTRY_DSN) {
  Sentry.setupExpressErrorHandler(app);
}

// ── Error handler (must be last) ──
app.use(errorHandler);

// ── Start server ──
const server = createServer(app);

// WebSocket for real-time activity
setupWebSocket(server);

// Start BullMQ workers for bot cycles and platform cycles (requires Redis)
if (config.redisUrl) {
  startWorker();
  startPlatformWorker();

  // Validate Redis configuration for BullMQ compatibility
  const IORedis = require('ioredis');
  const checkRedis = new IORedis(config.redisUrl, { maxRetriesPerRequest: null, lazyConnect: true });
  checkRedis.connect().then(() => {
    return checkRedis.config('GET', 'maxmemory-policy');
  }).then((result: string[]) => {
    const policy = result?.[1];
    if (policy && policy !== 'noeviction') {
      logger.error(
        { policy },
        `Redis maxmemory-policy is "${policy}" — BullMQ REQUIRES "noeviction". `
        + 'Jobs can be silently evicted, corrupting queue state. '
        + 'Run: redis-cli CONFIG SET maxmemory-policy noeviction'
      );
    } else if (policy === 'noeviction') {
      logger.info('Redis maxmemory-policy verified: noeviction (correct for BullMQ)');
    }
    // Warn if Redis URL is not using TLS in production
    if (config.nodeEnv === 'production' && !config.redisUrl.startsWith('rediss://')) {
      logger.warn('REDIS_URL is not using TLS (rediss://) in production — data in transit is unencrypted');
    }
    checkRedis.quit().catch(() => {});
  }).catch((err: Error) => {
    logger.warn({ err: err.message }, 'Could not verify Redis maxmemory-policy (CONFIG may be disabled on managed Redis)');
    checkRedis.quit().catch(() => {});
  });
} else {
  logger.warn('REDIS_URL not set — job workers disabled (auth and API still work)');
}

// Run startup validation and migrations, then start listening
const startupWarnings = validateStartupConfig();
for (const w of startupWarnings) {
  logger.warn(`[startup] ${w}`);
}

runMigrations()
  .then(async () => {
    server.listen(config.port, '0.0.0.0', () => {
      logger.info({ port: config.port, env: config.nodeEnv, realAdapters: config.useRealAdapters }, 'PeerZero App Server started');
    });
    // Recover bots that were running before restart (after worker is ready)
    if (config.redisUrl) {
      await recoverRunningBots();
    }

    // Purge expired audit logs on startup and then every 24 hours
    purgeExpiredAuditLogs().catch((err) => { logger.warn({ err }, 'Audit log purge failed on startup'); });
    auditPurgeInterval = setInterval(() => purgeExpiredAuditLogs().catch((err) => { logger.warn({ err }, 'Scheduled audit log purge failed'); }), 24 * 60 * 60 * 1000);

    // Clean up old BullMQ completed/failed jobs on startup and daily
    if (config.redisUrl) {
      cleanupOldJobs(14).catch((err) => { logger.warn({ err }, 'BullMQ job cleanup failed on startup'); });
      cleanupOldPlatformJobs(14).catch((err) => { logger.warn({ err }, 'Platform job cleanup failed on startup'); });
      jobCleanupInterval = setInterval(() => {
        cleanupOldJobs(14).catch((err) => { logger.warn({ err }, 'Scheduled BullMQ job cleanup failed'); });
        cleanupOldPlatformJobs(14).catch((err) => { logger.warn({ err }, 'Scheduled platform job cleanup failed'); });
      }, 24 * 60 * 60 * 1000);
    }
  })
  .catch((err) => {
    logger.fatal({ err }, 'Failed to run migrations — server not started');
    process.exit(1);
  });

// ── Graceful shutdown ──
async function shutdown() {
  logger.info('Shutting down...');
  // Clear periodic intervals first
  clearInterval(auditPurgeInterval);
  clearInterval(jobCleanupInterval);
  // Stop accepting new connections and drain in-flight HTTP requests
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    // Force exit after 10s if connections don't close
    setTimeout(() => { logger.warn('Shutdown timeout — forcing exit'); resolve(); }, 10_000).unref();
  });
  await stopWorker();
  await stopPlatformWorker();
  await closeActivityStreamRedis();
  await closeRateLimitRedis();
  await closePhoneHomeRedis();
  await closeAuthRedis();
  await closePool();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// ── Crash handlers ──
process.on('unhandledRejection', (reason) => {
  logger.fatal({ err: reason }, 'Unhandled promise rejection — shutting down');
  shutdown().finally(() => process.exit(1));
});

process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception — shutting down');
  shutdown().finally(() => process.exit(1));
});
