import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock deps ───────────────────────────────────────────────────────────────

let skipPayments = false;

vi.mock('../../config', () => ({
  config: {
    get skipPayments() { return skipPayments; },
    stripeSecretKey: 'sk-test-xxx',
    stripeWebhookSecret: 'whsec-test',
    frontendUrl: 'https://app.test.com',
  },
}));

vi.mock('../../lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const mockQueryOne = vi.fn();
const mockQueryRows = vi.fn();
const mockQuery = vi.fn();

vi.mock('../../db/client', () => ({
  queryOne: (...args: any[]) => mockQueryOne(...args),
  queryRows: (...args: any[]) => mockQueryRows(...args),
  query: (...args: any[]) => mockQuery(...args),
}));

vi.mock('../../services/bot.service', () => ({
  setBotStatus: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../jobs/queue', () => ({
  addBotCycleJob: vi.fn().mockResolvedValue(undefined),
}));

// Mock Stripe constructor and its methods
const mockStripeCheckoutCreate = vi.fn();
const mockStripeCustomerCreate = vi.fn();
const mockStripeWebhookConstruct = vi.fn();
const mockStripeProductCreate = vi.fn();
const mockStripePriceCreate = vi.fn();

vi.mock('stripe', () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      checkout: { sessions: { create: mockStripeCheckoutCreate } },
      customers: { create: mockStripeCustomerCreate },
      webhooks: { constructEvent: mockStripeWebhookConstruct },
      products: { create: mockStripeProductCreate },
      prices: { create: mockStripePriceCreate },
    })),
  };
});

import {
  getProducts,
  createCheckout,
  createGradeCheckout,
  unlockGrade,
  unlockGradeOne,
  getHighestUnlockedGrade,
  getUnlockedGrades,
  calculateBulkPrice,
  handleStripeWebhook,
  createBulkGradeCheckout,
} from '../../services/payment.service';
import { AppError } from '../../middleware/error-handler';

beforeEach(() => {
  vi.clearAllMocks();
  skipPayments = false;
});

describe('payment.service', () => {
  // ── calculateBulkPrice (pure function) ─────────────────────────────────
  describe('calculateBulkPrice', () => {
    it('calculates price for grades 2-5 when highest unlocked is 1', () => {
      const result = calculateBulkPrice(1, 5);
      expect(result.grades).toEqual([2, 3, 4, 5]);
      expect(result.total_cents).toBeGreaterThan(0);
      expect(typeof result.total_cents).toBe('number');
    });

    it('returns empty list when already unlocked through target', () => {
      const result = calculateBulkPrice(5, 5);
      expect(result.grades).toEqual([]);
      expect(result.total_cents).toBe(0);
    });

    it('returns single grade when just one to unlock', () => {
      const result = calculateBulkPrice(4, 5);
      expect(result.grades).toEqual([5]);
      expect(result.total_cents).toBeGreaterThan(0);
    });

    it('returns empty list when target is below highest unlocked', () => {
      const result = calculateBulkPrice(8, 5);
      expect(result.grades).toEqual([]);
      expect(result.total_cents).toBe(0);
    });
  });

  // ── getProducts ────────────────────────────────────────────────────────
  describe('getProducts', () => {
    it('returns active products from DB', async () => {
      const products = [
        { id: 'p1', name: 'Bot Shell', type: 'bot_shell', price_cents: 500, description: 'A bot' },
      ];
      mockQueryRows.mockResolvedValueOnce(products);

      const result = await getProducts();
      expect(result).toEqual(products);
      expect(mockQueryRows).toHaveBeenCalledWith(
        expect.stringContaining('is_active = true'),
      );
    });
  });

  // ── unlockGrade ────────────────────────────────────────────────────────
  describe('unlockGrade', () => {
    it('inserts a grade_unlock row with ON CONFLICT DO NOTHING', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      await unlockGrade('bot-1', 'school-1', 3, 'purchase-1');
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO grade_unlocks'),
        ['bot-1', 'school-1', 3, 'purchase-1'],
      );
    });
  });

  // ── unlockGradeOne ─────────────────────────────────────────────────────
  describe('unlockGradeOne', () => {
    it('inserts grade 1 without a purchase ID', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      await unlockGradeOne('bot-1', 'school-1');
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('grade_unlocks'),
        ['bot-1', 'school-1'],
      );
    });
  });

  // ── getHighestUnlockedGrade ────────────────────────────────────────────
  describe('getHighestUnlockedGrade', () => {
    it('returns the max grade from DB', async () => {
      mockQueryOne.mockResolvedValueOnce({ max_grade: 7 });
      const result = await getHighestUnlockedGrade('bot-1', 'school-1');
      expect(result).toBe(7);
    });

    it('returns 0 when no grades unlocked', async () => {
      mockQueryOne.mockResolvedValueOnce({ max_grade: 0 });
      const result = await getHighestUnlockedGrade('bot-1', 'school-1');
      expect(result).toBe(0);
    });

    it('returns 0 when query returns null', async () => {
      mockQueryOne.mockResolvedValueOnce(null);
      const result = await getHighestUnlockedGrade('bot-1', 'school-1');
      expect(result).toBe(0);
    });
  });

  // ── getUnlockedGrades ──────────────────────────────────────────────────
  describe('getUnlockedGrades', () => {
    it('returns sorted grade list', async () => {
      mockQueryRows.mockResolvedValueOnce([{ grade: 1 }, { grade: 2 }, { grade: 3 }]);
      const result = await getUnlockedGrades('bot-1', 'school-1');
      expect(result).toEqual([1, 2, 3]);
    });

    it('returns empty array when no grades', async () => {
      mockQueryRows.mockResolvedValueOnce([]);
      const result = await getUnlockedGrades('bot-1', 'school-1');
      expect(result).toEqual([]);
    });
  });

  // ── createCheckout ─────────────────────────────────────────────────────
  describe('createCheckout', () => {
    it('throws 404 for unknown product', async () => {
      mockQueryOne.mockResolvedValueOnce(null); // product not found
      await expect(createCheckout('user-1', 'bad-product-id'))
        .rejects.toThrow(/product not found/i);
    });

    it('throws 404 for unknown user', async () => {
      mockQueryOne.mockResolvedValueOnce({ id: 'p1', stripe_price_id: 'price_x', price_cents: 500, name: 'Bot' }); // product
      mockQueryOne.mockResolvedValueOnce(null); // user not found
      await expect(createCheckout('bad-user', 'p1'))
        .rejects.toThrow(/user not found/i);
    });

    it('creates Stripe checkout session and returns URL', async () => {
      // product
      mockQueryOne.mockResolvedValueOnce({ id: 'p1', stripe_price_id: 'price_x', price_cents: 500, name: 'Bot Shell' });
      // user with existing stripe customer
      mockQueryOne.mockResolvedValueOnce({ id: 'user-1', email: 'test@test.com', stripe_customer_id: 'cus_123' });
      // INSERT purchase
      mockQueryOne.mockResolvedValueOnce({ id: 'purchase-1' });
      // Stripe session
      mockStripeCheckoutCreate.mockResolvedValueOnce({ id: 'sess_1', url: 'https://checkout.stripe.com/test' });
      // UPDATE purchase with session ID
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const result = await createCheckout('user-1', 'p1');
      expect(result.session_url).toBe('https://checkout.stripe.com/test');
    });

    it('creates a Stripe customer when user has none', async () => {
      mockQueryOne.mockResolvedValueOnce({ id: 'p1', stripe_price_id: 'price_x', price_cents: 500, name: 'Bot Shell' });
      mockQueryOne.mockResolvedValueOnce({ id: 'user-1', email: 'test@test.com', stripe_customer_id: null });
      // Stripe customer create
      mockStripeCustomerCreate.mockResolvedValueOnce({ id: 'cus_new' });
      // UPDATE user with customer ID (atomic: WHERE stripe_customer_id IS NULL)
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
      // INSERT purchase
      mockQueryOne.mockResolvedValueOnce({ id: 'purchase-1' });
      // Stripe session
      mockStripeCheckoutCreate.mockResolvedValueOnce({ id: 'sess_1', url: 'https://checkout.stripe.com/new' });
      // UPDATE purchase
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const result = await createCheckout('user-1', 'p1');
      expect(mockStripeCustomerCreate).toHaveBeenCalled();
      expect(result.session_url).toBe('https://checkout.stripe.com/new');
    });
  });

  // ── createGradeCheckout ────────────────────────────────────────────────
  describe('createGradeCheckout', () => {
    it('throws 404 for non-existent bot', async () => {
      mockQueryOne.mockResolvedValueOnce(null);
      await expect(createGradeCheckout('user-1', 'bad-bot'))
        .rejects.toThrow(/bot not found/i);
    });

    it('throws 400 for bot not enrolled in school', async () => {
      mockQueryOne.mockResolvedValueOnce({ id: 'bot-1', cached_grade: 3, school_id: null });
      await expect(createGradeCheckout('user-1', 'bot-1'))
        .rejects.toThrow(/enrolled in a school/i);
    });

    it('throws 409 if grade already unlocked', async () => {
      mockQueryOne.mockResolvedValueOnce({ id: 'bot-1', cached_grade: 3, school_id: 'school-1' });
      // Already unlocked check (now includes school_id)
      mockQueryOne.mockResolvedValueOnce({ id: 'unlock-1' });

      await expect(createGradeCheckout('user-1', 'bot-1'))
        .rejects.toThrow(/already unlocked/i);
    });

    it('unlocks grade immediately when skipPayments is true', async () => {
      skipPayments = true;

      mockQueryOne.mockResolvedValueOnce({ id: 'bot-1', cached_grade: 3, school_id: 'school-1' });
      // Not already unlocked
      mockQueryOne.mockResolvedValueOnce(null);
      // unlockGrade INSERT
      mockQuery.mockResolvedValueOnce({ rows: [] });
      // resumeBotAfterGradePayment — SELECT bot
      mockQueryOne.mockResolvedValueOnce(null); // bot not paused, nothing to resume

      const result = await createGradeCheckout('user-1', 'bot-1');
      expect(result.session_url).toBe('');
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO grade_unlocks'),
        ['bot-1', 'school-1', 4, 'skip-payments'],
      );
    });
  });

  // ── createBulkGradeCheckout ────────────────────────────────────────────
  describe('createBulkGradeCheckout', () => {
    it('throws 404 for non-existent bot', async () => {
      mockQueryOne.mockResolvedValueOnce(null);
      await expect(createBulkGradeCheckout('user-1', 'bad-bot', 5))
        .rejects.toThrow(/bot not found/i);
    });

    it('throws 409 when all grades already unlocked', async () => {
      mockQueryOne.mockResolvedValueOnce({ id: 'bot-1', cached_grade: 5, school_id: 'school-1' });
      // getHighestUnlockedGrade
      mockQueryOne.mockResolvedValueOnce({ max_grade: 5 });

      await expect(createBulkGradeCheckout('user-1', 'bot-1', 5))
        .rejects.toThrow(/already unlocked/i);
    });

    it('unlocks all grades immediately when skipPayments is true', async () => {
      skipPayments = true;

      mockQueryOne.mockResolvedValueOnce({ id: 'bot-1', cached_grade: 2, school_id: 'school-1' });
      // getHighestUnlockedGrade
      mockQueryOne.mockResolvedValueOnce({ max_grade: 2 });
      // unlockGrade for grades 3, 4, 5
      mockQuery.mockResolvedValue({ rows: [] });
      // resumeBotAfterGradePayment — bot not paused
      mockQueryOne.mockResolvedValueOnce(null);

      const result = await createBulkGradeCheckout('user-1', 'bot-1', 5);
      expect(result.session_url).toBe('');
      // Should have called INSERT INTO grade_unlocks 3 times (grades 3, 4, 5)
      const gradeInserts = mockQuery.mock.calls.filter(
        (call: any[]) => typeof call[0] === 'string' && call[0].includes('grade_unlocks'),
      );
      expect(gradeInserts.length).toBe(3);
    });
  });

  // ── handleStripeWebhook ────────────────────────────────────────────────
  describe('handleStripeWebhook', () => {
    it('skips checkout.session.completed with no purchase_id', async () => {
      await handleStripeWebhook({
        type: 'checkout.session.completed',
        data: { object: { id: 'sess_1', metadata: {} } },
      } as any);

      // Should not have tried to update purchases
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('skips already-completed purchases (idempotent)', async () => {
      mockQueryOne.mockResolvedValueOnce({ status: 'completed' }); // already processed

      await handleStripeWebhook({
        type: 'checkout.session.completed',
        data: {
          object: {
            id: 'sess_1',
            metadata: { purchase_id: 'p-1', user_id: 'u-1' },
            payment_intent: 'pi_1',
          },
        },
      } as any);

      // Should not have called UPDATE
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('processes checkout.session.completed and grants entitlement', async () => {
      // Check existing status
      mockQueryOne.mockResolvedValueOnce({ status: 'pending' });
      // UPDATE purchase to completed
      mockQuery.mockResolvedValueOnce({ rows: [] });
      // SELECT purchase
      mockQueryOne.mockResolvedValueOnce({ user_id: 'u-1', product_id: 'prod-1' });
      // SELECT product
      mockQueryOne.mockResolvedValueOnce({ type: 'bot_shell', metadata: {} });
      // INSERT entitlement
      mockQuery.mockResolvedValueOnce({ rows: [] });

      await handleStripeWebhook({
        type: 'checkout.session.completed',
        data: {
          object: {
            id: 'sess_1',
            metadata: { purchase_id: 'p-1', user_id: 'u-1', product_id: 'prod-1' },
            payment_intent: 'pi_1',
          },
        },
      } as any);

      // Verify entitlement was inserted
      const entitlementInsert = mockQuery.mock.calls.find(
        (call: any[]) => typeof call[0] === 'string' && call[0].includes('user_entitlements'),
      );
      expect(entitlementInsert).toBeTruthy();
    });

    it('handles charge.refunded by updating status and revoking access', async () => {
      // queryOne: UPDATE purchases ... RETURNING — returns the purchase row
      mockQueryOne.mockResolvedValueOnce({ id: 'purchase-1', user_id: 'user-1', product_id: 'prod-1' });
      // queryRows: SELECT DISTINCT bot_id FROM grade_unlocks — affected bots
      mockQueryRows.mockResolvedValueOnce([{ bot_id: 'bot-1' }]);

      await handleStripeWebhook({
        type: 'charge.refunded',
        data: {
          object: { payment_intent: 'pi_1' },
        },
      } as any);

      // Verify the refund UPDATE was called
      expect(mockQueryOne).toHaveBeenCalledWith(
        expect.stringContaining("status = 'refunded'"),
        ['pi_1'],
      );
      // Verify DELETE calls were made (entitlements + grade_unlocks)
      expect(mockQuery).toHaveBeenCalledTimes(2);
    });

    it('ignores unknown event types', async () => {
      await handleStripeWebhook({
        type: 'some.unknown.event',
        data: { object: {} },
      } as any);

      expect(mockQuery).not.toHaveBeenCalled();
      expect(mockQueryOne).not.toHaveBeenCalled();
    });
  });
});
