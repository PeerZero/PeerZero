// =============================================================================
// Request body validation middleware using Zod
// Usage: router.post('/path', validateBody(MySchema), handler)
// =============================================================================

import { Request, Response, NextFunction } from 'express';
import { ZodSchema } from 'zod';

/**
 * Express middleware that validates req.body against a Zod schema.
 * Returns 400 with structured errors on failure, calls next() on success.
 */
export function validateBody(schema: ZodSchema) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const errors = result.error.issues.map((e) => ({
        field: e.path.join('.'),
        message: e.message,
      }));
      res.status(400).json({ error: 'Validation failed', details: errors });
      return;
    }
    // Replace body with parsed (coerced/stripped) data
    req.body = result.data;
    next();
  };
}
