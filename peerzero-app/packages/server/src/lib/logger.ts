// =============================================================================
// Structured logger — thin wrapper around pino for consistent JSON logging
// Usage: import { logger } from '../lib/logger';
//        logger.info({ botId }, 'Cycle completed');
// =============================================================================

import pino from 'pino';
import { config } from '../config';

export const logger = pino({
  level: config.isDev ? 'debug' : 'info',
  transport: config.isDev
    ? { target: 'pino-pretty', options: { colorize: true } }
    : undefined,
});
