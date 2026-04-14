// =============================================================================
// Payment service — Stripe checkout sessions, webhook handling, entitlements
// Users pay for bot shells and school enrollments. All costs are on the user.
// =============================================================================

import Stripe from 'stripe';
import { config } from '../config';
import { queryOne, queryRows, query } from '../db/client';
import { AppError } from '../middleware/error-handler';
import type { ProductInfo, CheckoutResponse } from '@peerzero/shared';
import { getGradePriceCents, GRADUATION_GRADE, POST_GRADUATION_PRICE_CENTS } from '@peerzero/shared';
import { logger } from '../lib/logger';
import { setBotStatus } from './bot.service';
import { addBotCycleJob } from '../jobs/queue';

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
    // Atomic write: only set if no other concurrent request wrote it first
    const updated = await query('UPDATE users SET stripe_customer_id = $1 WHERE id = $2 AND stripe_customer_id IS NULL', [customerId, userId]);
    if ((updated.rowCount ?? 0) === 0) {
      // Another request won the race — read the existing value
      const existing = await queryOne<{ stripe_customer_id: string }>('SELECT stripe_customer_id FROM users WHERE id = $1', [userId]);
      if (existing?.stripe_customer_id) customerId = existing.stripe_customer_id;
    }
  }

  // Create purchase record
  const purchase = await queryOne<{ id: string }>(
    `INSERT INTO purchases (user_id, product_id, amount_cents, status)
     VALUES ($1, $2, $3, 'pending')
     RETURNING id`,
    [userId, productId, product.price_cents],
  );

  if (!purchase) {
    throw new Error('Failed to create purchase record');
  }

  // Create Stripe checkout session
  const session = await getStripe().checkout.sessions.create({
    customer: customerId,
    mode: 'payment',
    line_items: [{ price: product.stripe_price_id, quantity: 1 }],
    metadata: {
      purchase_id: purchase.id,
      user_id: userId,
      product_id: productId,
      ...metadata,
    },
    success_url: `${config.frontendUrl}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${config.frontendUrl}/payment/cancel`,
  });

  // Store session ID
  await query(
    'UPDATE purchases SET stripe_session_id = $1 WHERE id = $2',
    [session.id, purchase.id],
  );

  return { session_url: session.url! };
}

/** Handle Stripe webhook events. Called from the webhook route. */
export async function handleStripeWebhook(event: Stripe.Event): Promise<void> {
  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object as Stripe.Checkout.Session;
      const purchaseId = session.metadata?.purchase_id;
      if (!purchaseId) {
        logger.warn({ sessionId: session.id, metadata: session.metadata }, 'Stripe webhook missing purchase_id in metadata — skipping');
        break;
      }

      // Atomically mark completed — returns null if already processed (prevents duplicate entitlements)
      const purchase = await queryOne<{ user_id: string; product_id: string }>(
        `UPDATE purchases SET status = 'completed', stripe_payment_id = $1
         WHERE id = $2 AND status != 'completed'
         RETURNING user_id, product_id`,
        [session.payment_intent as string, purchaseId],
      );
      if (!purchase) {
        return; // Already processed or not found, skip
      }

      // purchase is guaranteed unique here — the UPDATE only succeeds once
      const product = await queryOne<{ type: string; metadata: Record<string, unknown> }>(
        'SELECT type, metadata FROM products WHERE id = $1',
        [purchase.product_id],
      );
      if (!product) {
        logger.warn({ purchaseId, productId: purchase.product_id }, 'Stripe webhook: product not found for purchase');
        break;
      }

      await query(
        `INSERT INTO user_entitlements (user_id, entitlement_type, quantity, source_purchase_id, metadata)
         VALUES ($1, $2, 1, $3, $4)
         ON CONFLICT (source_purchase_id, entitlement_type) DO NOTHING`,
        [purchase.user_id, product.type, purchaseId, JSON.stringify(session.metadata || {})],
      );

      // Handle grade advancement fulfillment (single or bulk)
      if (session.metadata?.bot_id) {
        if (session.metadata?.type === 'grade_advancement_bulk' && session.metadata?.grades) {
          // Bulk unlock: batch insert all grades in one query
          const rawGrades = typeof session.metadata.grades === 'string' ? session.metadata.grades : '';
          const gradeNums = rawGrades.split(',').map(Number).filter(n => Number.isFinite(n) && n > 0 && n <= 200).slice(0, 50);
          if (gradeNums.length > 0) {
            const values = gradeNums.map((g, i) => `($1, $${i + 2}, $${gradeNums.length + 2})`).join(', ');
            await query(
              `INSERT INTO grade_unlocks (bot_id, grade, purchase_id) VALUES ${values} ON CONFLICT (bot_id, grade) DO NOTHING`,
              [session.metadata.bot_id, ...gradeNums, purchaseId],
            );
            for (const g of gradeNums) {
              logger.info({ botId: session.metadata.bot_id, grade: g, purchaseId }, 'Grade unlocked');
            }
          }
        } else if (session.metadata?.grade) {
          // Single grade unlock
          const gradeNum = parseInt(session.metadata.grade, 10);
          if (Number.isFinite(gradeNum) && gradeNum > 0 && gradeNum <= 200) {
            await unlockGrade(session.metadata.bot_id, gradeNum, purchaseId);
          }
        }
        // Auto-resume bot if it was paused waiting for grade payment
        try {
          await resumeBotAfterGradePayment(session.metadata.bot_id);
        } catch (resumeErr) {
          logger.error({ botId: session.metadata.bot_id, err: resumeErr instanceof Error ? resumeErr.message : resumeErr }, 'Failed to resume bot after grade payment — grades unlocked but bot may need manual restart');
        }
      }
      break;
    }

    case 'charge.refunded': {
      const charge = event.data.object as Stripe.Charge;
      // Mark purchase as refunded
      const refundedPurchase = await queryOne<{ id: string; user_id: string; product_id: string }>(
        `UPDATE purchases SET status = 'refunded' WHERE stripe_payment_id = $1 AND status = 'completed'
         RETURNING id, user_id, product_id`,
        [charge.payment_intent as string],
      );
      if (refundedPurchase) {
        // Revoke entitlements and grade unlocks granted by this purchase
        await query(
          'DELETE FROM user_entitlements WHERE source_purchase_id = $1',
          [refundedPurchase.id],
        );
        await query(
          'DELETE FROM grade_unlocks WHERE purchase_id = $1',
          [refundedPurchase.id],
        );
        logger.info({ purchaseId: refundedPurchase.id, userId: refundedPurchase.user_id }, 'Refund processed — entitlements and grade unlocks revoked');
      }
      break;
    }

    case 'invoice.finalization_failed': {
      const invoice = event.data.object as Stripe.Invoice;
      logger.error(
        { invoiceId: invoice.id, customerId: invoice.customer, reason: invoice.last_finalization_error?.message },
        'Invoice finalization failed — subscription may be stuck without payment',
      );
      break;
    }
  }
}

/**
 * Create a checkout session for advancing a bot to the next grade.
 * Looks up the appropriate grade product and validates the bot is ready.
 */
export async function createGradeCheckout(
  userId: string,
  botId: string,
): Promise<CheckoutResponse> {
  // Verify bot ownership and get current grade
  const bot = await queryOne<{ id: string; cached_grade: number | null; school_id: string | null }>(
    'SELECT id, cached_grade, school_id FROM bots WHERE id = $1 AND user_id = $2',
    [botId, userId],
  );
  if (!bot) throw new AppError(404, 'Bot not found');
  if (!bot.school_id) throw new AppError(400, 'Bot must be enrolled in a school first');

  const currentGrade = bot.cached_grade || 1;
  const nextGrade = currentGrade + 1;

  // Check if next grade is already unlocked
  const alreadyUnlocked = await queryOne(
    'SELECT id FROM grade_unlocks WHERE bot_id = $1 AND grade = $2',
    [botId, nextGrade],
  );
  if (alreadyUnlocked) throw new AppError(409, `Grade ${nextGrade} is already unlocked for this bot`);

  // Skip payments: unlock grade immediately without Stripe
  if (config.skipPayments) {
    await unlockGrade(botId, nextGrade, 'skip-payments');
    logger.info({ botId, grade: nextGrade }, 'Grade unlocked (payments skipped)');
    try { await resumeBotAfterGradePayment(botId); } catch (err) { logger.error({ botId, err: err instanceof Error ? err.message : err }, 'Failed to resume bot after grade payment (payments skipped)'); }
    return { session_url: '' };
  }

  // Find the appropriate product
  const isPostGrad = nextGrade > GRADUATION_GRADE;
  const product = isPostGrad
    ? await queryOne<{ id: string; stripe_price_id: string; price_cents: number; name: string }>(
        `SELECT id, stripe_price_id, price_cents, name FROM products
         WHERE type = 'grade_advancement' AND metadata->>'grade' = 'post_graduation' AND is_active = true`,
      )
    : await queryOne<{ id: string; stripe_price_id: string; price_cents: number; name: string }>(
        `SELECT id, stripe_price_id, price_cents, name FROM products
         WHERE type = 'grade_advancement' AND (metadata->>'grade')::int = $1 AND is_active = true`,
        [nextGrade],
      );

  if (!product) {
    // Fallback: create a dynamic checkout if no seeded product exists
    const priceCents = getGradePriceCents(nextGrade);
    return createDynamicGradeCheckout(userId, botId, nextGrade, priceCents);
  }

  return createCheckout(userId, product.id, { bot_id: botId, grade: String(nextGrade) });
}

/**
 * Dynamic grade checkout for grades without pre-seeded products (e.g. grade 13+).
 */
async function createDynamicGradeCheckout(
  userId: string,
  botId: string,
  grade: number,
  priceCents: number,
): Promise<CheckoutResponse> {
  const user = await queryOne<{ id: string; email: string; stripe_customer_id: string | null }>(
    'SELECT id, email, stripe_customer_id FROM users WHERE id = $1',
    [userId],
  );
  if (!user) throw new AppError(404, 'User not found');

  let customerId = user.stripe_customer_id;
  if (!customerId) {
    const customer = await getStripe().customers.create({ email: user.email, metadata: { user_id: userId } });
    customerId = customer.id;
    const updated = await query('UPDATE users SET stripe_customer_id = $1 WHERE id = $2 AND stripe_customer_id IS NULL', [customerId, userId]);
    if ((updated.rowCount ?? 0) === 0) {
      const existing = await queryOne<{ stripe_customer_id: string }>('SELECT stripe_customer_id FROM users WHERE id = $1', [userId]);
      if (existing?.stripe_customer_id) customerId = existing.stripe_customer_id;
    }
  }

  // Create a one-off Stripe price for this grade
  const stripeProduct = await getStripe().products.create({
    name: `Grade ${grade} Unlock`,
    description: `Advance your bot to Grade ${grade}.`,
    metadata: { grade: String(grade), type: 'grade_advancement' },
  });

  const stripePrice = await getStripe().prices.create({
    product: stripeProduct.id,
    unit_amount: priceCents,
    currency: 'usd',
  });

  // Create purchase record (no product FK — dynamic grade)
  // ORDER BY id ensures deterministic product selection when multiple grade_advancement products exist
  const purchase = await queryOne<{ id: string }>(
    `INSERT INTO purchases (user_id, product_id, amount_cents, status, metadata)
     VALUES ($1, (SELECT id FROM products WHERE type = 'grade_advancement' ORDER BY id LIMIT 1), $2, 'pending', $3)
     RETURNING id`,
    [userId, priceCents, JSON.stringify({ grade, bot_id: botId, dynamic: true })],
  );

  const session = await getStripe().checkout.sessions.create({
    customer: customerId,
    mode: 'payment',
    line_items: [{ price: stripePrice.id, quantity: 1 }],
    metadata: {
      purchase_id: purchase!.id,
      user_id: userId,
      bot_id: botId,
      grade: String(grade),
      type: 'grade_advancement',
    },
    success_url: `${config.frontendUrl}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${config.frontendUrl}/payment/cancel`,
  });

  await query('UPDATE purchases SET stripe_session_id = $1 WHERE id = $2', [session.id, purchase!.id]);

  return { session_url: session.url! };
}

/**
 * Unlock a grade for a bot after successful payment.
 * Called from the webhook handler.
 */
export async function unlockGrade(botId: string, grade: number, purchaseId: string): Promise<void> {
  await query(
    `INSERT INTO grade_unlocks (bot_id, grade, purchase_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (bot_id, grade) DO NOTHING`,
    [botId, grade, purchaseId],
  );
  logger.info({ botId, grade, purchaseId }, 'Grade unlocked');
}

/**
 * Auto-unlock grade 1 for a bot (called on enrollment — grade 1 is free).
 */
export async function unlockGradeOne(botId: string): Promise<void> {
  await query(
    `INSERT INTO grade_unlocks (bot_id, grade)
     VALUES ($1, 1)
     ON CONFLICT (bot_id, grade) DO NOTHING`,
    [botId],
  );
}

/**
 * Get the highest unlocked grade for a bot.
 */
export async function getHighestUnlockedGrade(botId: string): Promise<number> {
  const result = await queryOne<{ max_grade: number }>(
    'SELECT COALESCE(MAX(grade), 0) as max_grade FROM grade_unlocks WHERE bot_id = $1',
    [botId],
  );
  return result?.max_grade || 0;
}

/**
 * Get all unlocked grades for a bot.
 */
export async function getUnlockedGrades(botId: string): Promise<number[]> {
  const rows = await queryRows<{ grade: number }>(
    'SELECT grade FROM grade_unlocks WHERE bot_id = $1 ORDER BY grade ASC',
    [botId],
  );
  return rows.map(r => r.grade);
}

/**
 * Create a checkout session to unlock multiple grades at once.
 * `throughGrade` = unlock all grades from (highest_unlocked + 1) through this grade.
 * Pass `throughGrade = 'graduation'` to unlock all grades through 12.
 * Pass `throughGrade = 'all'` — same as graduation (post-grad are one-at-a-time).
 */
export async function createBulkGradeCheckout(
  userId: string,
  botId: string,
  throughGrade: number | 'graduation' | 'all',
): Promise<CheckoutResponse> {
  const bot = await queryOne<{ id: string; cached_grade: number | null; school_id: string | null }>(
    'SELECT id, cached_grade, school_id FROM bots WHERE id = $1 AND user_id = $2',
    [botId, userId],
  );
  if (!bot) throw new AppError(404, 'Bot not found');
  if (!bot.school_id) throw new AppError(400, 'Bot must be enrolled in a school first');

  const highestUnlocked = await getHighestUnlockedGrade(botId);
  const targetGrade = (throughGrade === 'graduation' || throughGrade === 'all')
    ? GRADUATION_GRADE
    : throughGrade;

  if (targetGrade <= highestUnlocked) {
    throw new AppError(409, `All grades through ${targetGrade} are already unlocked`);
  }

  // Build line items for each grade to unlock
  const gradesToUnlock: number[] = [];
  for (let g = highestUnlocked + 1; g <= targetGrade; g++) {
    gradesToUnlock.push(g);
  }

  if (gradesToUnlock.length === 0) {
    throw new AppError(409, 'No grades to unlock');
  }

  // Skip payments: unlock all grades immediately without Stripe
  if (config.skipPayments) {
    for (const g of gradesToUnlock) {
      await unlockGrade(botId, g, 'skip-payments');
    }
    logger.info({ botId, grades: gradesToUnlock }, 'Grades unlocked (payments skipped)');
    try { await resumeBotAfterGradePayment(botId); } catch (err) { logger.error({ botId, err: err instanceof Error ? err.message : err }, 'Failed to resume bot after bulk grade payment (payments skipped)'); }
    return { session_url: '' };
  }

  // Calculate total
  let totalCents = 0;
  for (const g of gradesToUnlock) {
    totalCents += getGradePriceCents(g);
  }

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
    const updated = await query('UPDATE users SET stripe_customer_id = $1 WHERE id = $2 AND stripe_customer_id IS NULL', [customerId, userId]);
    if ((updated.rowCount ?? 0) === 0) {
      const existing = await queryOne<{ stripe_customer_id: string }>('SELECT stripe_customer_id FROM users WHERE id = $1', [userId]);
      if (existing?.stripe_customer_id) customerId = existing.stripe_customer_id;
    }
  }

  // Create a single Stripe product for the bundle
  const label = gradesToUnlock.length === 1
    ? `Grade ${gradesToUnlock[0]} Unlock`
    : `Grade ${gradesToUnlock[0]}-${gradesToUnlock[gradesToUnlock.length - 1]} Bundle`;

  const stripeProduct = await getStripe().products.create({
    name: label,
    description: `Unlock grades ${gradesToUnlock.join(', ')} for your bot.`,
    metadata: { type: 'grade_advancement', grades: gradesToUnlock.join(','), bot_id: botId },
  });

  const stripePrice = await getStripe().prices.create({
    product: stripeProduct.id,
    unit_amount: totalCents,
    currency: 'usd',
  });

  // Create purchase record
  // ORDER BY id ensures deterministic product selection when multiple grade_advancement products exist
  const purchase = await queryOne<{ id: string }>(
    `INSERT INTO purchases (user_id, product_id, amount_cents, status, metadata)
     VALUES ($1, (SELECT id FROM products WHERE type = 'grade_advancement' ORDER BY id LIMIT 1), $2, 'pending', $3)
     RETURNING id`,
    [userId, totalCents, JSON.stringify({ grades: gradesToUnlock, bot_id: botId, bulk: true })],
  );

  const session = await getStripe().checkout.sessions.create({
    customer: customerId,
    mode: 'payment',
    line_items: [{ price: stripePrice.id, quantity: 1 }],
    metadata: {
      purchase_id: purchase!.id,
      user_id: userId,
      bot_id: botId,
      grades: gradesToUnlock.join(','),
      type: 'grade_advancement_bulk',
    },
    success_url: `${config.frontendUrl}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${config.frontendUrl}/payment/cancel`,
  });

  await query('UPDATE purchases SET stripe_session_id = $1 WHERE id = $2', [session.id, purchase!.id]);

  return { session_url: session.url! };
}

/**
 * Calculate the total cost to unlock all remaining grades through graduation.
 */
export function calculateBulkPrice(highestUnlocked: number, throughGrade: number): { grades: number[]; total_cents: number } {
  const grades: number[] = [];
  let total = 0;
  for (let g = highestUnlocked + 1; g <= throughGrade; g++) {
    grades.push(g);
    total += getGradePriceCents(g);
  }
  return { grades, total_cents: total };
}

/**
 * Auto-resume a bot that was paused waiting for grade payment.
 * Called from the webhook after grade unlock(s) are processed.
 */
async function resumeBotAfterGradePayment(botId: string): Promise<void> {
  const bot = await queryOne<{
    status: string;
    error_message: string | null;
    cached_grade: number | null;
    user_id: string;
    llm_api_key_id: string | null;
    llm_model: string;
    cycle_delay_seconds: number;
  }>(
    'SELECT status, error_message, cached_grade, user_id, llm_api_key_id, llm_model, cycle_delay_seconds FROM bots WHERE id = $1',
    [botId],
  );

  if (!bot) return;

  // Only resume if the bot was paused specifically for grade payment
  if (bot.status !== 'paused' || !bot.error_message?.includes('requires payment')) return;
  if (!bot.llm_api_key_id) return;

  // Verify the grade is actually unlocked now (check truth, not just string matching)
  const nextGrade = (bot.cached_grade ?? 0) + 1;
  const gradeUnlocked = await queryOne<{ grade: number }>(
    'SELECT grade FROM grade_unlocks WHERE bot_id = $1 AND grade >= $2 LIMIT 1',
    [botId, nextGrade],
  );
  if (!gradeUnlocked) {
    logger.warn({ botId, nextGrade }, 'Bot resume: grade not yet unlocked — skipping resume');
    return;
  }

  // Atomically transition from paused to running — skip if another request already resumed
  const resumed = await query(
    "UPDATE bots SET status = 'running', error_message = NULL, updated_at = NOW() WHERE id = $1 AND status = 'paused' RETURNING id",
    [botId],
  );
  if ((resumed.rowCount ?? 0) === 0) {
    logger.info({ botId }, 'Bot resume skipped — already resumed by another request');
    return;
  }
  await addBotCycleJob(botId, bot.user_id, bot.llm_api_key_id, bot.llm_model, bot.cycle_delay_seconds);
  logger.info({ botId, grade: gradeUnlocked.grade }, 'Bot auto-resumed after grade payment');
}

/** Verify Stripe webhook signature. Throws StripeSignatureError on failure. */
export function verifyWebhookSignature(body: Buffer, signature: string): Stripe.Event {
  if (!config.stripeWebhookSecret) {
    logger.error('STRIPE_WEBHOOK_SECRET is not configured — all webhooks will be rejected');
    throw new Error('Webhook signing secret not configured');
  }
  return getStripe().webhooks.constructEvent(body, signature, config.stripeWebhookSecret);
}
