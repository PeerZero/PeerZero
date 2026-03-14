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
