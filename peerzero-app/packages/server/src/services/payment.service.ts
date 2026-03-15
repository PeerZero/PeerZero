// =============================================================================
// Payment service — Stripe checkout sessions, webhook handling, entitlements
// Users pay for bot shells and school enrollments. All costs are on the user.
// =============================================================================

import Stripe from 'stripe';
import { config } from '../config';
import { queryOne, queryRows, query } from '../db/client';
import { AppError } from '../middleware/error-handler';
import type { ProductInfo, CheckoutResponse } from '@peerzero/shared';

let stripe: Stripe | null = null;

function getStripe(): Stripe {
  if (!stripe) {
    stripe = new Stripe(config.stripeSecretKey);
  }
  return stripe;
}

export async function getProducts(): Promise<ProductInfo[]> {
  return queryRows<ProductInfo>(
    'SELECT id, name, type, price_cents, description FROM products WHERE is_active = true ORDER BY price_cents ASC',
  );
}

export async function createCheckout(
  userId: string,
  productId: string,
  metadata?: Record<string, string>,
): Promise<CheckoutResponse> {
  const product = await queryOne<{ id: string; stripe_price_id: string; price_cents: number; name: string }>(
    'SELECT id, stripe_price_id, price_cents, name FROM products WHERE id = $1 AND is_active = true',
    [productId],
  );
  if (!product) throw new AppError(404, 'Product not found');

  // Get or create Stripe customer
  const user = await queryOne<{ id: string; email: string; stripe_customer_id: string | null }>(
    'SELECT id, email, stripe_customer_id FROM users WHERE id = $1',
    [userId],
  );
  if (!user) throw new AppError(404, 'User not found');

  let customerId = user.stripe_customer_id;
  if (!customerId) {
    const customer = await getStripe().customers.create({ email: user.email, metadata: { user_id: userId } });
    customerId = customer.id;
    await query('UPDATE users SET stripe_customer_id = $1 WHERE id = $2', [customerId, userId]);
  }

  // Create purchase record
  const purchase = await queryOne<{ id: string }>(
    `INSERT INTO purchases (user_id, product_id, amount_cents, status)
     VALUES ($1, $2, $3, 'pending')
     RETURNING id`,
    [userId, productId, product.price_cents],
  );

  // Create Stripe checkout session
  const session = await getStripe().checkout.sessions.create({
    customer: customerId,
    mode: 'payment',
    line_items: [{ price: product.stripe_price_id, quantity: 1 }],
    metadata: {
      purchase_id: purchase!.id,
      user_id: userId,
      product_id: productId,
      ...metadata,
    },
    success_url: `${config.isDev ? 'http://localhost:3001' : 'https://app.peerzero.com'}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${config.isDev ? 'http://localhost:3001' : 'https://app.peerzero.com'}/payment/cancel`,
  });

  // Store session ID
  await query(
    'UPDATE purchases SET stripe_session_id = $1 WHERE id = $2',
    [session.id, purchase!.id],
  );

  return { session_url: session.url! };
}

/** Handle Stripe webhook events. Called from the webhook route. */
export async function handleStripeWebhook(event: Stripe.Event): Promise<void> {
  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object as Stripe.Checkout.Session;
      const purchaseId = session.metadata?.purchase_id;
      if (!purchaseId) break;

      // Check if already processed
      const existing = await queryOne<{ status: string }>('SELECT status FROM purchases WHERE id = $1', [purchaseId]);
      if (existing?.status === 'completed') {
        return; // Already processed, skip
      }

      // Mark purchase as completed
      await query(
        `UPDATE purchases SET status = 'completed', stripe_payment_id = $1 WHERE id = $2`,
        [session.payment_intent as string, purchaseId],
      );

      // Grant entitlement
      const purchase = await queryOne<{ user_id: string; product_id: string }>(
        'SELECT user_id, product_id FROM purchases WHERE id = $1',
        [purchaseId],
      );
      if (!purchase) break;

      const product = await queryOne<{ type: string; metadata: Record<string, unknown> }>(
        'SELECT type, metadata FROM products WHERE id = $1',
        [purchase.product_id],
      );
      if (!product) break;

      await query(
        `INSERT INTO user_entitlements (user_id, entitlement_type, quantity, source_purchase_id, metadata)
         VALUES ($1, $2, 1, $3, $4)`,
        [purchase.user_id, product.type, purchaseId, JSON.stringify(session.metadata || {})],
      );
      break;
    }

    case 'charge.refunded': {
      const charge = event.data.object as Stripe.Charge;
      await query(
        `UPDATE purchases SET status = 'refunded' WHERE stripe_payment_id = $1`,
        [charge.payment_intent as string],
      );
      break;
    }
  }
}

/** Verify Stripe webhook signature. */
export function verifyWebhookSignature(body: Buffer, signature: string): Stripe.Event {
  return getStripe().webhooks.constructEvent(body, signature, config.stripeWebhookSecret);
}
