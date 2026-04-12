// =============================================================================
// PeerZero App Server — Entry point
// System 2: completely separate from the School (System 1).
// Connects to School only through adapters when USE_REAL_ADAPTERS=true.
// =============================================================================

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
import { startPlatformWorker, stopPlatformWorker } from './jobs/platform-queue';
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
    },
  },
}));
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
    purgeExpiredAuditLogs().catch(() => {});
    setInterval(() => purgeExpiredAuditLogs().catch(() => {}), 24 * 60 * 60 * 1000);

    // Clean up old BullMQ completed/failed jobs on startup and weekly (Audit #3)
    if (config.redisUrl) {
      cleanupOldJobs(30).catch(() => {});
      setInterval(() => cleanupOldJobs(30).catch(() => {}), 7 * 24 * 60 * 60 * 1000);
    }
  })
  .catch((err) => {
    logger.fatal({ err }, 'Failed to run migrations — server not started');
    process.exit(1);
  });

// ── Graceful shutdown ──
async function shutdown() {
  logger.info('Shutting down...');
  await stopWorker();
  await stopPlatformWorker();
  await closeActivityStreamRedis();
  await closeRateLimitRedis();
  await closePhoneHomeRedis();
  await closeAuthRedis();
  await closePool();
  // Wait for in-flight HTTP requests to drain before exiting
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    // Force exit after 10s if connections don't close
    setTimeout(() => { logger.warn('Shutdown timeout — forcing exit'); resolve(); }, 10_000).unref();
  });
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
