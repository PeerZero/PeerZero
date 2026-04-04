import { describe, it, expect, vi, beforeEach } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';

// ── Mock deps ───────────────────────────────────────────────────────────────

const TEST_JWT_SECRET = process.env.TEST_JWT_SECRET || 'test-jwt-secret-that-is-long-enough-for-validation';

vi.mock('../../config', () => ({
  config: {
    jwtSecret: process.env.TEST_JWT_SECRET || 'test-jwt-secret-that-is-long-enough-for-validation',
    redisUrl: '',
    isDev: true,
  },
}));

vi.mock('../../lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const mockGetProducts = vi.fn();
const mockCreateCheckout = vi.fn();
const mockCreateGradeCheckout = vi.fn();
const mockGetUnlockedGrades = vi.fn();
const mockVerifyWebhookSignature = vi.fn();
const mockHandleStripeWebhook = vi.fn();
const mockCreateBulkGradeCheckout = vi.fn();
const mockCalculateBulkPrice = vi.fn();

vi.mock('../../services/payment.service', () => ({
  getProducts: (...args: any[]) => mockGetProducts(...args),
  createCheckout: (...args: any[]) => mockCreateCheckout(...args),
  createGradeCheckout: (...args: any[]) => mockCreateGradeCheckout(...args),
  getUnlockedGrades: (...args: any[]) => mockGetUnlockedGrades(...args),
  verifyWebhookSignature: (...args: any[]) => mockVerifyWebhookSignature(...args),
  handleStripeWebhook: (...args: any[]) => mockHandleStripeWebhook(...args),
  createBulkGradeCheckout: (...args: any[]) => mockCreateBulkGradeCheckout(...args),
  calculateBulkPrice: (...args: any[]) => mockCalculateBulkPrice(...args),
}));

const mockQueryOne = vi.fn();

vi.mock('../../db/client', () => ({
  queryOne: (...args: any[]) => mockQueryOne(...args),
  queryRows: vi.fn(),
  query: vi.fn(),
}));

// Mock express-rate-limit to passthrough
vi.mock('express-rate-limit', () => ({
  default: vi.fn().mockImplementation(() => (req: any, res: any, next: any) => next()),
}));

vi.mock('ioredis', () => ({
  default: vi.fn().mockImplementation(() => ({
    on: vi.fn(),
    quit: vi.fn().mockResolvedValue('OK'),
  })),
}));

import jwt from 'jsonwebtoken';
import paymentsRouter from '../../routes/payments';
import { errorHandler } from '../../middleware/error-handler';

// ── App setup ───────────────────────────────────────────────────────────────

let app: Express;

function makeToken(payload: { userId: string; email: string }) {
  return jwt.sign(payload, TEST_JWT_SECRET, { algorithm: 'HS256', expiresIn: '5m' });
}

beforeEach(() => {
  vi.clearAllMocks();
  app = express();
  // The webhook endpoint needs raw body, but for other routes we need JSON.
  // In tests we can handle this by using express.json() for all routes
  // and sending raw buffer for webhook tests.
  app.use('/payments/webhook', express.raw({ type: '*/*' }));
  app.use(express.json());
  app.use('/payments', paymentsRouter);
  app.use(errorHandler);
});

// ── Tests ───────────────────────────────────────────────────────────────────

describe('GET /payments/products', () => {
  it('returns product list (no auth required)', async () => {
    const products = [
      { id: 'p1', name: 'Bot Shell', type: 'bot_shell', price_cents: 500 },
      { id: 'p2', name: 'Grade 2 Unlock', type: 'grade_unlock', price_cents: 300 },
    ];
    mockGetProducts.mockResolvedValueOnce(products);

    const res = await request(app).get('/payments/products');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(products);
    expect(mockGetProducts).toHaveBeenCalledOnce();
  });

  it('returns empty array when no products exist', async () => {
    mockGetProducts.mockResolvedValueOnce([]);

    const res = await request(app).get('/payments/products');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

describe('POST /payments/checkout', () => {
  it('returns 401 without auth', async () => {
    const res = await request(app).post('/payments/checkout').send({ product_id: 'p1' });
    expect(res.status).toBe(401);
  });

  it('returns 400 when product_id is missing', async () => {
    const token = makeToken({ userId: 'user-1', email: 'test@example.com' });
    const res = await request(app)
      .post('/payments/checkout')
      .set('Authorization', `Bearer ${token}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/product_id required/i);
  });

  it('returns checkout session URL on success', async () => {
    mockCreateCheckout.mockResolvedValueOnce({ session_url: 'https://checkout.stripe.com/s1' });

    const token = makeToken({ userId: 'user-1', email: 'test@example.com' });
    const res = await request(app)
      .post('/payments/checkout')
      .set('Authorization', `Bearer ${token}`)
      .send({ product_id: 'p1' });

    expect(res.status).toBe(200);
    expect(res.body.session_url).toBe('https://checkout.stripe.com/s1');
    expect(mockCreateCheckout).toHaveBeenCalledWith('user-1', 'p1', undefined);
  });

  it('passes metadata through to service', async () => {
    mockCreateCheckout.mockResolvedValueOnce({ session_url: 'https://checkout.stripe.com/s2' });

    const token = makeToken({ userId: 'user-1', email: 'test@example.com' });
    const metadata = { campaign: 'launch' };
    const res = await request(app)
      .post('/payments/checkout')
      .set('Authorization', `Bearer ${token}`)
      .send({ product_id: 'p1', metadata });

    expect(res.status).toBe(200);
    expect(mockCreateCheckout).toHaveBeenCalledWith('user-1', 'p1', metadata);
  });
});

describe('POST /payments/grade-checkout', () => {
  it('returns 401 without auth', async () => {
    const res = await request(app).post('/payments/grade-checkout').send({ bot_id: 'bot-1' });
    expect(res.status).toBe(401);
  });

  it('returns 400 when bot_id is missing', async () => {
    const token = makeToken({ userId: 'user-1', email: 'test@example.com' });
    const res = await request(app)
      .post('/payments/grade-checkout')
      .set('Authorization', `Bearer ${token}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/bot_id required/i);
  });

  it('returns checkout result on success', async () => {
    mockCreateGradeCheckout.mockResolvedValueOnce({ session_url: 'https://checkout.stripe.com/grade' });

    const token = makeToken({ userId: 'user-1', email: 'test@example.com' });
    const res = await request(app)
      .post('/payments/grade-checkout')
      .set('Authorization', `Bearer ${token}`)
      .send({ bot_id: 'bot-1' });

    expect(res.status).toBe(200);
    expect(res.body.session_url).toBe('https://checkout.stripe.com/grade');
    expect(mockCreateGradeCheckout).toHaveBeenCalledWith('user-1', 'bot-1');
  });
});

describe('GET /payments/grade-status/:botId', () => {
  it('returns 401 without auth', async () => {
    const res = await request(app).get('/payments/grade-status/bot-1');
    expect(res.status).toBe(401);
  });

  it('returns 404 when bot is not found or not owned by user', async () => {
    mockQueryOne.mockResolvedValueOnce(null);

    const token = makeToken({ userId: 'user-1', email: 'test@example.com' });
    const res = await request(app)
      .get('/payments/grade-status/bot-1')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/bot not found/i);
  });

  it('returns unlocked grades for owned bot', async () => {
    mockQueryOne.mockResolvedValueOnce({ id: 'bot-1' }); // ownership check
    mockGetUnlockedGrades.mockResolvedValueOnce([1, 2, 3]);

    const token = makeToken({ userId: 'user-1', email: 'test@example.com' });
    const res = await request(app)
      .get('/payments/grade-status/bot-1')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.unlocked_grades).toEqual([1, 2, 3]);
    expect(res.body.highest_unlocked).toBe(3);
  });

  it('returns highest_unlocked=0 when no grades unlocked', async () => {
    mockQueryOne.mockResolvedValueOnce({ id: 'bot-1' });
    mockGetUnlockedGrades.mockResolvedValueOnce([]);

    const token = makeToken({ userId: 'user-1', email: 'test@example.com' });
    const res = await request(app)
      .get('/payments/grade-status/bot-1')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.unlocked_grades).toEqual([]);
    expect(res.body.highest_unlocked).toBe(0);
  });
});

describe('POST /payments/webhook', () => {
  it('returns 400 when stripe-signature header is missing', async () => {
    const res = await request(app)
      .post('/payments/webhook')
      .set('Content-Type', 'application/json')
      .send(Buffer.from('{}'));

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/missing stripe-signature/i);
  });

  it('returns 400 when signature verification fails', async () => {
    mockVerifyWebhookSignature.mockImplementationOnce(() => {
      throw new Error('Signature mismatch');
    });

    const res = await request(app)
      .post('/payments/webhook')
      .set('stripe-signature', 'bad-sig')
      .set('Content-Type', 'application/json')
      .send(Buffer.from('{}'));

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/signature verification failed/i);
  });

  it('returns 500 when webhook secret is not configured', async () => {
    mockVerifyWebhookSignature.mockImplementationOnce(() => {
      throw new Error('Webhook secret not configured');
    });

    const res = await request(app)
      .post('/payments/webhook')
      .set('stripe-signature', 'some-sig')
      .set('Content-Type', 'application/json')
      .send(Buffer.from('{}'));

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/configuration error/i);
  });

  it('processes valid webhook event', async () => {
    const event = { type: 'checkout.session.completed', data: { object: {} } };
    mockVerifyWebhookSignature.mockReturnValueOnce(event);
    mockHandleStripeWebhook.mockResolvedValueOnce(undefined);

    const res = await request(app)
      .post('/payments/webhook')
      .set('stripe-signature', 'valid-sig')
      .set('Content-Type', 'application/json')
      .send(Buffer.from('{}'));

    expect(res.status).toBe(200);
    expect(res.body.received).toBe(true);
    expect(mockHandleStripeWebhook).toHaveBeenCalledWith(event);
  });

  it('returns 500 when event processing fails (so Stripe retries)', async () => {
    const event = { type: 'checkout.session.completed', data: { object: {} } };
    mockVerifyWebhookSignature.mockReturnValueOnce(event);
    mockHandleStripeWebhook.mockRejectedValueOnce(new Error('DB write failed'));

    const res = await request(app)
      .post('/payments/webhook')
      .set('stripe-signature', 'valid-sig')
      .set('Content-Type', 'application/json')
      .send(Buffer.from('{}'));

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/webhook processing failed/i);
  });
});

describe('POST /payments/grade-checkout-bulk', () => {
  it('returns 401 without auth', async () => {
    const res = await request(app).post('/payments/grade-checkout-bulk').send({ bot_id: 'bot-1', through_grade: 5 });
    expect(res.status).toBe(401);
  });

  it('returns 400 when bot_id is missing', async () => {
    const token = makeToken({ userId: 'user-1', email: 'test@example.com' });
    const res = await request(app)
      .post('/payments/grade-checkout-bulk')
      .set('Authorization', `Bearer ${token}`)
      .send({ through_grade: 5 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/bot_id required/i);
  });

  it('returns 400 for invalid through_grade', async () => {
    const token = makeToken({ userId: 'user-1', email: 'test@example.com' });
    const res = await request(app)
      .post('/payments/grade-checkout-bulk')
      .set('Authorization', `Bearer ${token}`)
      .send({ bot_id: 'bot-1', through_grade: 'invalid' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/through_grade/i);
  });

  it('accepts "graduation" as through_grade', async () => {
    mockCreateBulkGradeCheckout.mockResolvedValueOnce({ session_url: 'https://checkout.stripe.com/bulk' });

    const token = makeToken({ userId: 'user-1', email: 'test@example.com' });
    const res = await request(app)
      .post('/payments/grade-checkout-bulk')
      .set('Authorization', `Bearer ${token}`)
      .send({ bot_id: 'bot-1', through_grade: 'graduation' });

    expect(res.status).toBe(200);
    expect(mockCreateBulkGradeCheckout).toHaveBeenCalledWith('user-1', 'bot-1', 'graduation');
  });

  it('accepts "all" as through_grade', async () => {
    mockCreateBulkGradeCheckout.mockResolvedValueOnce({ session_url: '' });

    const token = makeToken({ userId: 'user-1', email: 'test@example.com' });
    const res = await request(app)
      .post('/payments/grade-checkout-bulk')
      .set('Authorization', `Bearer ${token}`)
      .send({ bot_id: 'bot-1', through_grade: 'all' });

    expect(res.status).toBe(200);
    expect(mockCreateBulkGradeCheckout).toHaveBeenCalledWith('user-1', 'bot-1', 'all');
  });

  it('accepts numeric through_grade', async () => {
    mockCreateBulkGradeCheckout.mockResolvedValueOnce({ session_url: 'https://checkout.stripe.com/bulk5' });

    const token = makeToken({ userId: 'user-1', email: 'test@example.com' });
    const res = await request(app)
      .post('/payments/grade-checkout-bulk')
      .set('Authorization', `Bearer ${token}`)
      .send({ bot_id: 'bot-1', through_grade: 5 });

    expect(res.status).toBe(200);
    expect(mockCreateBulkGradeCheckout).toHaveBeenCalledWith('user-1', 'bot-1', 5);
  });
});

describe('GET /payments/grade-price-preview/:botId', () => {
  it('returns 401 without auth', async () => {
    const res = await request(app).get('/payments/grade-price-preview/bot-1');
    expect(res.status).toBe(401);
  });

  it('returns 404 when bot is not owned by user', async () => {
    mockQueryOne.mockResolvedValueOnce(null);

    const token = makeToken({ userId: 'user-1', email: 'test@example.com' });
    const res = await request(app)
      .get('/payments/grade-price-preview/bot-1')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/bot not found/i);
  });

  it('returns price preview for owned bot', async () => {
    mockQueryOne.mockResolvedValueOnce({ id: 'bot-1' }); // ownership check
    mockGetUnlockedGrades.mockResolvedValueOnce([1, 2]);
    mockCalculateBulkPrice.mockReturnValueOnce({ grades: [3, 4, 5], total_cents: 900 });

    const token = makeToken({ userId: 'user-1', email: 'test@example.com' });
    const res = await request(app)
      .get('/payments/grade-price-preview/bot-1?through=5')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.grades).toEqual([3, 4, 5]);
    expect(res.body.total_cents).toBe(900);
  });
});
