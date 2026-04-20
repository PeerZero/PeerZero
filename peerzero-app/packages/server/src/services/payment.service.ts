// =============================================================================
// Payment service — Stripe checkout sessions, webhook handling, entitlements
// Users pay for bot shells and school enrollments. All costs are on the user.
// =============================================================================

import Stripe from 'stripe';
import { config } from '../config';
import { queryOne, queryRows, query, withTransaction } from '../db/client';
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
    const customer = await getStripe().customers.create(
      { email: user.email, metadata: { user_id: userId } },
      { idempotencyKey: `customer-${userId}` },
    );
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
  }, {
    // Key on the purchase row id so each checkout attempt is its own Stripe
    // session. The previous key bucketed by minute, which made rapid
    // double-clicks reuse one session whose metadata only pointed at the
    // first purchase row — the second row stayed in 'pending' forever.
    idempotencyKey: `checkout-${purchase.id}`,
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

      // The mark-completed UPDATE and the entitlement/grade-unlock INSERTs must
      // be atomic. If we SIGTERM or OOM-kill between them, a Stripe retry would
      // see status='completed' and exit early — user paid, no entitlement
      // granted. The transaction ensures the UPDATE rolls back on any failure,
      // so the retry finds the purchase still 'pending' and redoes everything.
      await withTransaction(async (tx) => {
        const purchase = await tx.queryOne<{ user_id: string; product_id: string }>(
          `UPDATE purchases SET status = 'completed', stripe_payment_id = $1
           WHERE id = $2 AND status != 'completed'
           RETURNING user_id, product_id`,
          [session.payment_intent as string, purchaseId],
        );
        if (!purchase) {
          return; // Already processed or not found — nothing to roll back.
        }

        const product = await tx.queryOne<{ type: string; metadata: Record<string, unknown> }>(
          'SELECT type, metadata FROM products WHERE id = $1',
          [purchase.product_id],
        );
        if (!product) {
          // Abort the transaction — we don't want to mark the purchase
          // completed without a product to grant the entitlement for.
          // Log before throw so the operator sees the purchase/product ids
          // even when the error surfaces through the tx-rollback path.
          logger.error(
            { purchaseId, productId: purchase.product_id, userId: purchase.user_id },
            'Stripe webhook: product lookup failed during checkout processing — rolling back',
          );
          throw new Error(`Stripe webhook: product ${purchase.product_id} not found for purchase ${purchaseId}`);
        }

        await tx.query(
          `INSERT INTO user_entitlements (user_id, entitlement_type, quantity, source_purchase_id, metadata)
           VALUES ($1, $2, 1, $3, $4)
           ON CONFLICT (source_purchase_id, entitlement_type) DO NOTHING`,
          [purchase.user_id, product.type, purchaseId, JSON.stringify(session.metadata || {})],
        );

        // Handle grade advancement fulfillment (single or bulk)
        if (session.metadata?.bot_id && session.metadata?.school_id) {
          if (session.metadata?.type === 'grade_advancement_bulk' && session.metadata?.grades) {
            // Bulk unlock: batch insert all grades in one query
            const rawGrades = typeof session.metadata.grades === 'string' ? session.metadata.grades : '';
            const gradeNums = rawGrades.split(',').map(Number).filter(n => Number.isFinite(n) && n > 0 && n <= 200).slice(0, 50);
            if (gradeNums.length > 0) {
              const values = gradeNums.map((g, i) => `($1, $2, $${i + 3}, $${gradeNums.length + 3})`).join(', ');
              await tx.query(
                `INSERT INTO grade_unlocks (bot_id, school_id, grade, purchase_id) VALUES ${values} ON CONFLICT (bot_id, school_id, grade) DO NOTHING`,
                [session.metadata.bot_id, session.metadata.school_id, ...gradeNums, purchaseId],
              );
              for (const g of gradeNums) {
                logger.info({ botId: session.metadata.bot_id, schoolId: session.metadata.school_id, grade: g, purchaseId }, 'Grade unlocked');
              }
            }
          } else if (session.metadata?.grade) {
            // Single grade unlock — inline the insert so it participates in the tx.
            const gradeNum = parseInt(session.metadata.grade, 10);
            if (Number.isFinite(gradeNum) && gradeNum > 0 && gradeNum <= 200) {
              await tx.query(
                `INSERT INTO grade_unlocks (bot_id, school_id, grade, purchase_id)
                 VALUES ($1, $2, $3, $4) ON CONFLICT (bot_id, school_id, grade) DO NOTHING`,
                [session.metadata.bot_id, session.metadata.school_id, gradeNum, purchaseId],
              );
              logger.info({ botId: session.metadata.bot_id, schoolId: session.metadata.school_id, grade: gradeNum, purchaseId }, 'Grade unlocked');
            }
          }
        }
      });

      // Auto-resume bot if it was paused waiting for grade payment. This runs
      // AFTER the transaction commits — a failure here must not roll back the
      // entitlement that has already been granted, just log so an operator
      // can unstick the bot manually.
      if (session.metadata?.bot_id && session.metadata?.school_id) {
        try {
          await resumeBotAfterGradePayment(session.metadata.bot_id, session.metadata.school_id);
        } catch (resumeErr) {
          logger.error({ botId: session.metadata.bot_id, err: resumeErr instanceof Error ? resumeErr.message : resumeErr }, 'Failed to resume bot after grade payment — grades unlocked but bot may need manual restart');
        }
      }
      break;
    }

    case 'charge.refunded': {
      const charge = event.data.object as Stripe.Charge;

      // Mirrors the checkout.session.completed tx above: the UPDATE that
      // marks the purchase refunded and the two DELETEs that revoke the
      // entitlement + grade unlocks must be atomic. If the process dies
      // between them, a Stripe retry would see status='refunded' and skip
      // the handler entirely — leaving a refunded user with live grade
      // access and a live entitlement row.
      const affectedBots = await withTransaction(async (tx) => {
        const refundedPurchase = await tx.queryOne<{ id: string; user_id: string; product_id: string }>(
          `UPDATE purchases SET status = 'refunded' WHERE stripe_payment_id = $1 AND status = 'completed'
           RETURNING id, user_id, product_id`,
          [charge.payment_intent as string],
        );
        if (!refundedPurchase) return [] as { bot_id: string }[];

        await tx.query(
          'DELETE FROM user_entitlements WHERE source_purchase_id = $1',
          [refundedPurchase.id],
        );
        const bots = await tx.queryRows<{ bot_id: string }>(
          'SELECT DISTINCT bot_id FROM grade_unlocks WHERE purchase_id = $1',
          [refundedPurchase.id],
        );
        await tx.query(
          'DELETE FROM grade_unlocks WHERE purchase_id = $1',
          [refundedPurchase.id],
        );
        logger.info({ purchaseId: refundedPurchase.id, userId: refundedPurchase.user_id }, 'Refund processed — entitlements and grade unlocks revoked');
        return bots;
      });

      // Pause any affected bots AFTER the revocation commits — a failure
      // here must not roll back the revocation itself (which has already
      // committed), just log so an operator can manually pause the bot.
      for (const { bot_id } of affectedBots) {
        try {
          await setBotStatus(bot_id, 'paused', 'Paused: grade access revoked due to refund');
          logger.info({ botId: bot_id }, 'Bot paused after refund — grade unlocks revoked');
        } catch (pauseErr) {
          logger.error({ botId: bot_id, err: pauseErr instanceof Error ? pauseErr.message : pauseErr }, 'Failed to pause bot after refund');
        }
      }
      break;
    }

    case 'invoice.finalization_failed': {
      const invoice = event.data.object as Stripe.Invoice;
      const customerId = typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id;
      const reason = invoice.last_finalization_error?.message || 'unknown';
      logger.error(
        { invoiceId: invoice.id, customerId, reason },
        'Invoice finalization failed — subscription may be stuck without payment',
      );
      // Log to audit trail for operator visibility
      if (customerId) {
        const user = await queryOne<{ id: string }>('SELECT id FROM users WHERE stripe_customer_id = $1', [customerId]);
        if (user) {
          await query(
            `INSERT INTO audit_log (user_id, action, entity_type, entity_id, metadata) VALUES ($1, 'invoice.finalization_failed', 'payment', uuid_generate_v4(), $2)`,
            [user.id, JSON.stringify({ invoiceId: invoice.id, customerId, reason })],
          );
        }
      }
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
  const schoolId = bot.school_id!;

  // Check if next grade is already unlocked
  const alreadyUnlocked = await queryOne(
    'SELECT id FROM grade_unlocks WHERE bot_id = $1 AND school_id = $2 AND grade = $3',
    [botId, schoolId, nextGrade],
  );
  if (alreadyUnlocked) throw new AppError(409, `Grade ${nextGrade} is already unlocked for this bot`);

  // Skip payments: unlock grade immediately without Stripe
  if (config.skipPayments) {
    await unlockGrade(botId, schoolId, nextGrade, 'skip-payments');
    logger.info({ botId, schoolId, grade: nextGrade }, 'Grade unlocked (payments skipped)');
    try { await resumeBotAfterGradePayment(botId, schoolId); } catch (err) { logger.error({ botId, err: err instanceof Error ? err.message : err }, 'Failed to resume bot after grade payment (payments skipped)'); }
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
    return createDynamicGradeCheckout(userId, botId, schoolId, nextGrade, priceCents);
  }

  return createCheckout(userId, product.id, { bot_id: botId, school_id: schoolId, grade: String(nextGrade) });
}

/**
 * Dynamic grade checkout for grades without pre-seeded products (e.g. grade 13+).
 */
async function createDynamicGradeCheckout(
  userId: string,
  botId: string,
  schoolId: string,
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
    const customer = await getStripe().customers.create(
      { email: user.email, metadata: { user_id: userId } },
      { idempotencyKey: `customer-${userId}` },
    );
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
  }, {
    idempotencyKey: `product-grade-${grade}`,
  });

  const stripePrice = await getStripe().prices.create({
    product: stripeProduct.id,
    unit_amount: priceCents,
    currency: 'usd',
  }, {
    idempotencyKey: `price-grade-${grade}-${priceCents}`,
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
      school_id: schoolId,
      grade: String(grade),
      type: 'grade_advancement',
    },
    success_url: `${config.frontendUrl}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${config.frontendUrl}/payment/cancel`,
  }, {
    idempotencyKey: `checkout-${purchase!.id}`,
  });

  await query('UPDATE purchases SET stripe_session_id = $1 WHERE id = $2', [session.id, purchase!.id]);

  return { session_url: session.url! };
}

/**
 * Unlock a grade for a bot after successful payment.
 * Called from the webhook handler.
 */
export async function unlockGrade(botId: string, schoolId: string, grade: number, purchaseId: string): Promise<void> {
  await query(
    `INSERT INTO grade_unlocks (bot_id, school_id, grade, purchase_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (bot_id, school_id, grade) DO NOTHING`,
    [botId, schoolId, grade, purchaseId],
  );
  // Clear any grace-period tracking for this bot/grade. Payment resolved
  // the block; the next cycle should proceed without grace-period state
  // lingering in the bots table.
  await query(
    `UPDATE bots
        SET grade_grace_until = NULL,
            grade_grace_locked_grade = NULL,
            updated_at = NOW()
      WHERE id = $1
        AND grade_grace_locked_grade = $2`,
    [botId, grade],
  );
  logger.info({ botId, schoolId, grade, purchaseId }, 'Grade unlocked');
}

/**
 * Auto-unlock grade 1 for a bot (called on enrollment — grade 1 is free).
 */
export async function unlockGradeOne(botId: string, schoolId: string): Promise<void> {
  await query(
    `INSERT INTO grade_unlocks (bot_id, school_id, grade)
     VALUES ($1, $2, 1)
     ON CONFLICT (bot_id, school_id, grade) DO NOTHING`,
    [botId, schoolId],
  );
}

/**
 * Get the highest unlocked grade for a bot.
 */
export async function getHighestUnlockedGrade(botId: string, schoolId: string): Promise<number> {
  const result = await queryOne<{ max_grade: number }>(
    'SELECT COALESCE(MAX(grade), 0) as max_grade FROM grade_unlocks WHERE bot_id = $1 AND school_id = $2',
    [botId, schoolId],
  );
  return result?.max_grade || 0;
}

/**
 * Get all unlocked grades for a bot.
 */
export async function getUnlockedGrades(botId: string, schoolId: string): Promise<number[]> {
  const rows = await queryRows<{ grade: number }>(
    'SELECT grade FROM grade_unlocks WHERE bot_id = $1 AND school_id = $2 ORDER BY grade ASC',
    [botId, schoolId],
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

  const schoolId = bot.school_id!;
  const highestUnlocked = await getHighestUnlockedGrade(botId, schoolId);
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
      await unlockGrade(botId, schoolId, g, 'skip-payments');
    }
    logger.info({ botId, schoolId, grades: gradesToUnlock }, 'Grades unlocked (payments skipped)');
    try { await resumeBotAfterGradePayment(botId, schoolId); } catch (err) { logger.error({ botId, err: err instanceof Error ? err.message : err }, 'Failed to resume bot after bulk grade payment (payments skipped)'); }
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
    const customer = await getStripe().customers.create(
      { email: user.email, metadata: { user_id: userId } },
      { idempotencyKey: `customer-${userId}` },
    );
    customerId = customer.id;
    const updated = await query('UPDATE users SET stripe_customer_id = $1 WHERE id = $2 AND stripe_customer_id IS NULL', [customerId, userId]);
    if ((updated.rowCount ?? 0) === 0) {
      const existing = await queryOne<{ stripe_customer_id: string }>('SELECT stripe_customer_id FROM users WHERE id = $1', [userId]);
      if (existing?.stripe_customer_id) customerId = existing.stripe_customer_id;
    }
  }

  // Create a single Stripe product for the bundle
  const gradesKey = gradesToUnlock.join('-');
  const label = gradesToUnlock.length === 1
    ? `Grade ${gradesToUnlock[0]} Unlock`
    : `Grade ${gradesToUnlock[0]}-${gradesToUnlock[gradesToUnlock.length - 1]} Bundle`;

  const stripeProduct = await getStripe().products.create({
    name: label,
    description: `Unlock grades ${gradesToUnlock.join(', ')} for your bot.`,
    metadata: { type: 'grade_advancement', grades: gradesToUnlock.join(','), bot_id: botId },
  }, {
    idempotencyKey: `product-bulk-${gradesKey}`,
  });

  const stripePrice = await getStripe().prices.create({
    product: stripeProduct.id,
    unit_amount: totalCents,
    currency: 'usd',
  }, {
    idempotencyKey: `price-bulk-${gradesKey}-${totalCents}`,
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
      school_id: schoolId,
      grades: gradesToUnlock.join(','),
      type: 'grade_advancement_bulk',
    },
    success_url: `${config.frontendUrl}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${config.frontendUrl}/payment/cancel`,
  }, {
    idempotencyKey: `checkout-bulk-${purchase!.id}`,
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
async function resumeBotAfterGradePayment(botId: string, schoolId: string): Promise<void> {
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
    'SELECT grade FROM grade_unlocks WHERE bot_id = $1 AND school_id = $2 AND grade >= $3 LIMIT 1',
    [botId, schoolId, nextGrade],
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

/**
 * Create a Stripe billing portal session so the user can manage payment methods,
 * view invoices, and request refunds.
 */
export async function createBillingPortalSession(userId: string): Promise<{ url: string }> {
  const user = await queryOne<{ stripe_customer_id: string | null }>(
    'SELECT stripe_customer_id FROM users WHERE id = $1',
    [userId],
  );
  if (!user) throw new AppError(404, 'User not found');
  if (!user.stripe_customer_id) throw new AppError(400, 'No billing account found — make a purchase first');

  const session = await getStripe().billingPortal.sessions.create({
    customer: user.stripe_customer_id,
    return_url: `${config.frontendUrl}/settings/billing`,
  });

  return { url: session.url };
}

/** Verify Stripe webhook signature. Throws StripeSignatureError on failure. */
export function verifyWebhookSignature(body: Buffer, signature: string): Stripe.Event {
  if (!config.stripeWebhookSecret) {
    logger.error('STRIPE_WEBHOOK_SECRET is not configured — all webhooks will be rejected');
    throw new Error('Webhook signing secret not configured');
  }
  return getStripe().webhooks.constructEvent(body, signature, config.stripeWebhookSecret);
}
