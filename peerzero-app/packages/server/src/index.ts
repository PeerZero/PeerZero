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
import { errorHandler } from './middleware/error-handler';
import { authLimiter, closeRateLimitRedis } from './middleware/rate-limit';
import { closePool } from './db/client';
import { startWorker, stopWorker } from './jobs/queue';
import { setupWebSocket } from './websocket/activity-stream';

// Routes
import authRoutes from './routes/auth';
import botRoutes from './routes/bots';
import apiKeyRoutes from './routes/api-keys';
import schoolRoutes from './routes/schools';
import paymentRoutes from './routes/payments';
import healthRoutes from './routes/health';

const app = express();

// ── Middleware ──
app.use(helmet());
app.use(cors({
  origin: config.isDev
    ? true
    : ['https://peerzero.science', 'https://www.peerzero.science', 'https://peer-zero.vercel.app'],
  credentials: true,
}));
// Auth routes get IP-based rate limiting (unauthenticated, can't key by user)
// Authenticated routes get per-user Redis-backed limits applied at the route level.

// Raw body for Stripe webhooks (must come before express.json)
app.use('/api/payments/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

// ── Routes ──
app.use('/api/auth', authLimiter, authRoutes);
app.use('/api/bots', botRoutes);
app.use('/api/keys', apiKeyRoutes);
app.use('/api/schools', schoolRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/health', healthRoutes);

// ── Error handler (must be last) ──
app.use(errorHandler);

// ── Start server ──
const server = createServer(app);

// WebSocket for real-time activity
setupWebSocket(server);

// Start BullMQ worker for bot cycles
startWorker();

server.listen(config.port, () => {
  console.log(`[server] PeerZero App Server running on port ${config.port}`);
  console.log(`[server] Environment: ${config.nodeEnv}`);
  console.log(`[server] Real adapters: ${config.useRealAdapters}`);
});

// ── Graceful shutdown ──
async function shutdown() {
  console.log('[server] Shutting down...');
  await stopWorker();
  await closeRateLimitRedis();
  await closePool();
  server.close();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
