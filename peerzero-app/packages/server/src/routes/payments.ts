// =============================================================================
// Payment routes — products, checkout, Stripe webhook
// =============================================================================

import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import * as paymentService from '../services/payment.service';

const router = Router();

// Public: list products
router.get('/products', async (_req: Request, res: Response) => {
  const products = await paymentService.getProducts();
  res.json(products);
});

// Authenticated: create checkout session
router.post('/checkout', requireAuth, async (req: Request, res: Response) => {
  const { product_id, metadata } = req.body;
  if (!product_id) {
    res.status(400).json({ error: 'product_id required' });
    return;
  }
  const result = await paymentService.createCheckout(req.user!.userId, product_id, metadata);
  res.json(result);
});

// Authenticated: create grade advancement checkout for a bot
router.post('/grade-checkout', requireAuth, async (req: Request, res: Response) => {
  const { bot_id } = req.body;
  if (!bot_id) {
    res.status(400).json({ error: 'bot_id required' });
    return;
  }
  const result = await paymentService.createGradeCheckout(req.user!.userId, bot_id);
  res.json(result);
});

// Authenticated: get grade unlock status for a bot
router.get('/grade-status/:botId', requireAuth, async (req: Request, res: Response) => {
  const grades = await paymentService.getUnlockedGrades(req.params.botId);
  const highest = grades.length > 0 ? Math.max(...grades) : 0;
  res.json({ unlocked_grades: grades, highest_unlocked: highest });
});

// Authenticated: create bulk grade checkout (multiple grades at once)
router.post('/grade-checkout-bulk', requireAuth, async (req: Request, res: Response) => {
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
router.get('/grade-price-preview/:botId', requireAuth, async (req: Request, res: Response) => {
  const targetParam = req.query.through as string;
  const highestUnlocked = (await paymentService.getUnlockedGrades(req.params.botId)).length > 0
    ? Math.max(...await paymentService.getUnlockedGrades(req.params.botId))
    : 0;
  const target = (targetParam === 'graduation' || targetParam === 'all') ? 12 : parseInt(targetParam, 10) || 12;
  const preview = paymentService.calculateBulkPrice(highestUnlocked, target);
  res.json(preview);
});

// Stripe webhook (raw body required — handled in index.ts)
router.post('/webhook', async (req: Request, res: Response) => {
  const signature = req.headers['stripe-signature'] as string;
  if (!signature) {
    res.status(400).json({ error: 'Missing stripe-signature header' });
    return;
  }

  try {
    const event = paymentService.verifyWebhookSignature(req.body, signature);
    await paymentService.handleStripeWebhook(event);
    res.json({ received: true });
  } catch (err) {
    res.status(400).json({ error: 'Webhook signature verification failed' });
  }
});

export default router;
