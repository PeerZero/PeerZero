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
import { config } from './config';
import { logger } from './lib/logger';
import { errorHandler } from './middleware/error-handler';
import { authLimiter, closeRateLimitRedis } from './middleware/rate-limit';
import { closePool } from './db/client';
import { startWorker, stopWorker } from './jobs/queue';
import { startPlatformWorker, stopPlatformWorker } from './jobs/platform-queue';
import { setupWebSocket } from './websocket/activity-stream';

// Routes
import authRoutes from './routes/auth';
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

const app = express();

// ── Middleware ──
app.use(helmet());
app.use(cors({
  origin: config.isDev
    ? true // Allow any origin in dev (mobile devices use the machine's LAN IP, not localhost)
    : config.corsOrigins.split(',').map(s => s.trim()).filter(Boolean),
  credentials: true,
}));
// Auth routes get IP-based rate limiting (unauthenticated, can't key by user)
// Authenticated routes get per-user Redis-backed limits applied at the route level.

// Raw body for Stripe webhooks (must come before express.json)
app.use('/api/payments/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

// ── Routes ──
app.use('/api/auth', authLimiter, authRoutes);
app.use('/api/bots/external-activity', externalActivityRoutes);  // Phone-home from self-hosted bots (token auth, not JWT) — MUST be before /api/bots
app.use('/api/bots/public', publicBotRoutes);                   // Public bot profiles (no auth) — MUST be before /api/bots
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

server.listen(config.port, '0.0.0.0', () => {
  logger.info({ port: config.port, env: config.nodeEnv, realAdapters: config.useRealAdapters }, 'PeerZero App Server started');
});

// ── Graceful shutdown ──
async function shutdown() {
  logger.info('Shutting down...');
  await stopWorker();
  await stopPlatformWorker();
  await closeRateLimitRedis();
  await closePhoneHomeRedis();
  await closePool();
  server.close();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
