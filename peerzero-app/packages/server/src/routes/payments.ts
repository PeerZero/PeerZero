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
