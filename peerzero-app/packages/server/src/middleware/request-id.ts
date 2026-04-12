// =============================================================================
// Request ID middleware — attaches a unique ID to every request for tracing.
// The ID is returned in the X-Request-Id response header and available as
// req.requestId for use in log messages and error responses.
// =============================================================================

import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';

declare global {
  namespace Express {
    interface Request {
      requestId: string;
    }
  }
}

export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Accept client-provided request ID (e.g., from bot or mobile app) or generate one.
  // Validate format: must be 8-64 alphanumeric/hyphen characters to prevent header injection.
  const clientId = req.headers['x-request-id'];
  const isValid = typeof clientId === 'string' && /^[a-zA-Z0-9-]{8,64}$/.test(clientId);
  const id = isValid ? clientId : crypto.randomUUID();

  req.requestId = id;
  res.setHeader('X-Request-Id', id);
  next();
}
