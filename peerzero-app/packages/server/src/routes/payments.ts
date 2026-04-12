// =============================================================================
// Payment routes — products, checkout, Stripe webhook
// =============================================================================

import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { requireAuth } from '../middleware/auth';
import { userRateLimit } from '../middleware/rate-limit';
import { validateBody } from '../middleware/validate';
import { CheckoutSchema, GradeCheckoutSchema } from '../lib/schemas';
import * as paymentService from '../services/payment.service';

// IP-based rate limit for the Stripe webhook endpoint.
// Stripe retries with exponential backoff, so 100/min is generous.
// This prevents abuse from non-Stripe sources hammering the endpoint.
const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many webhook requests' },
});

const router = Router();

// Public: list products
router.get('/products', async (_req: Request, res: Response) => {
  const products = await paymentService.getProducts();
  res.json(products);
});

// Authenticated: create checkout session
router.post('/checkout', requireAuth, userRateLimit('write'), validateBody(CheckoutSchema), async (req: Request, res: Response) => {
  const { product_id, metadata } = req.body;
  const result = await paymentService.createCheckout(req.user!.userId, product_id, metadata);
  res.json(result);
});

// Authenticated: create grade advancement checkout for a bot
router.post('/grade-checkout', requireAuth, userRateLimit('write'), validateBody(GradeCheckoutSchema), async (req: Request, res: Response) => {
  const { bot_id } = req.body;
  const result = await paymentService.createGradeCheckout(req.user!.userId, bot_id);
  res.json(result);
});

// Authenticated: get grade unlock status for a bot (verifies ownership)
router.get('/grade-status/:botId', requireAuth, async (req: Request, res: Response) => {
  // Verify the requesting user owns this bot before returning grade data
  const bot = await import('../db/client').then(({ queryOne }) =>
    queryOne('SELECT id FROM bots WHERE id = $1 AND user_id = $2', [req.params.botId, req.user!.userId]),
  );
  if (!bot) {
    res.status(404).json({ error: 'Bot not found' });
    return;
  }
  const grades = await paymentService.getUnlockedGrades(req.params.botId);
  const highest = grades.length > 0 ? Math.max(...grades) : 0;
  res.json({ unlocked_grades: grades, highest_unlocked: highest });
});

// Authenticated: create bulk grade checkout (multiple grades at once)
router.post('/grade-checkout-bulk', requireAuth, userRateLimit('write'), async (req: Request, res: Response) => {
  const { bot_id, through_grade } = req.body;
  if (!bot_id) {
    res.status(400).json({ error: 'bot_id required' });
    return;
  }
  // through_grade can be a number, "graduation", or "all"
  let target: number | 'graduation' | 'all';
  if (through_grade === 'graduation' || through_grade === 'all') {
    target = through_grade;
  } else {
    target = parseInt(through_grade, 10);
    if (!Number.isFinite(target) || target < 1 || target > 100) {
      res.status(400).json({ error: 'through_grade must be a grade number (1-100), "graduation", or "all"' });
      return;
    }
  }
  const result = await paymentService.createBulkGradeCheckout(req.user!.userId, bot_id, target);
  res.json(result);
});

// Authenticated: get price preview for bulk grade unlock
router.get('/grade-price-preview/:botId', requireAuth, userRateLimit('read'), async (req: Request, res: Response) => {
  // Verify the requesting user owns this bot
  const bot = await import('../db/client').then(({ queryOne }) =>
    queryOne('SELECT id FROM bots WHERE id = $1 AND user_id = $2', [req.params.botId, req.user!.userId]),
  );
  if (!bot) {
    res.status(404).json({ error: 'Bot not found' });
    return;
  }
  const targetParam = req.query.through as string;
  const unlockedGrades = await paymentService.getUnlockedGrades(req.params.botId);
  const highestUnlocked = unlockedGrades.length > 0 ? Math.max(...unlockedGrades) : 0;
  const parsedGrade = parseInt(targetParam, 10);
  const target = (targetParam === 'graduation' || targetParam === 'all') ? 12 :
    (Number.isFinite(parsedGrade) && parsedGrade > 0 && parsedGrade <= 12) ? parsedGrade : 12;
  const preview = paymentService.calculateBulkPrice(highestUnlocked, target);
  res.json(preview);
});

// Stripe webhook (raw body required — handled in index.ts)
router.post('/webhook', webhookLimiter, async (req: Request, res: Response) => {
  const signature = req.headers['stripe-signature'] as string;
  if (!signature) {
    res.status(400).json({ error: 'Missing stripe-signature header' });
    return;
  }

  // Step 1: Verify signature (auth failure → 400, config error → 500)
  let event;
  try {
    event = paymentService.verifyWebhookSignature(req.body, signature);
  } catch (err) {
    const msg = err instanceof Error ? err.message : '';
    if (msg.includes('not configured')) {
      // Server misconfiguration — 500 so Stripe retries later
      res.status(500).json({ error: 'Webhook configuration error' });
    } else {
      // Actual signature mismatch — 400 (don't retry)
      res.status(400).json({ error: 'Webhook signature verification failed' });
    }
    return;
  }

  // Step 2: Handle event (processing failure → 500, so Stripe retries)
  try {
    await paymentService.handleStripeWebhook(event);
    res.json({ received: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    // Log internally but don't leak details to Stripe
    (await import('../lib/logger')).logger.error({ err: msg, eventType: event.type }, 'Webhook handler failed');
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

export default router;
