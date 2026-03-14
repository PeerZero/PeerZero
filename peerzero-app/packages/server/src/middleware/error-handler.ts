// =============================================================================
// Global error handler — catches unhandled errors, returns clean JSON
// =============================================================================

import { Request, Response, NextFunction } from 'express';
import { config } from '../config';

export class AppError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export function errorHandler(err: Error, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof AppError) {
    res.status(err.statusCode).json({ error: err.message });
    return;
  }

  // Log unexpected errors in dev, hide details in prod
  console.error('[unhandled]', err);
  res.status(500).json({
    error: config.isDev ? err.message : 'Internal server error',
  });
}
