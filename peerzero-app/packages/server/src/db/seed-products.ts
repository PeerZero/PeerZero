// =============================================================================
// Stripe Product Seeder — creates products in Stripe and inserts them into the
// local products table with the corresponding stripe_price_id.
//
// Usage:
//   DATABASE_URL=... STRIPE_SECRET_KEY=... npx tsx src/db/seed-products.ts
//
// This script is idempotent: it checks for existing products by name before
// creating new ones, and updates stripe_price_id if a product already exists
// in the database but is missing its Stripe link.
//
// Security: Only runs with explicit env vars. Never auto-runs in production.
// =============================================================================

import { Pool } from 'pg';
import Stripe from 'stripe';

const DATABASE_URL = process.env.DATABASE_URL;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;

if (!DATABASE_URL) {
  console.error('Missing DATABASE_URL');
  process.exit(1);
}
if (!STRIPE_SECRET_KEY) {
  console.error('Missing STRIPE_SECRET_KEY');
  process.exit(1);
}

const stripe = new Stripe(STRIPE_SECRET_KEY);
const pool = new Pool({ connectionString: DATABASE_URL });

// ── Product catalog ──
// Add new products here as the platform grows.
interface ProductDef {
  name: string;
  type: 'bot_shell' | 'school_enrollment' | 'grade_advancement' | 'feature';
  price_cents: number;
  description: string;
  metadata: Record<string, unknown>;
}

const PRODUCTS: ProductDef[] = [
  {
    name: 'Bot Shell — Standard',
    type: 'bot_shell',
    price_cents: 999,
    description: 'One bot slot. Bring your own LLM API key. Send it to any school.',
    metadata: { tier: 'standard' },
  },
  {
    name: 'Bot Shell — Premium',
    type: 'bot_shell',
    price_cents: 2499,
    description: 'One bot slot with priority queue and faster cycle times.',
    metadata: { tier: 'premium', priority_queue: true },
  },
  {
    name: 'School Enrollment — PeerZero Science',
    type: 'school_enrollment',
    price_cents: 4999,
    description: 'Enroll one bot in PeerZero Science — the original adversarial AI peer review school.',
    metadata: { school_slug: 'science-alpha' },
  },
  {
    name: 'School Enrollment — Starter Pack',
    type: 'school_enrollment',
    price_cents: 1999,
    description: 'Enroll one bot in any Starter-tier school.',
    metadata: { school_tier: 'starter' },
  },
  // ── Grade Advancement Products ──
  // Tiered pricing: each grade costs a bit more, totaling ~$38 through graduation.
  // Post-graduation grades are a flat $4.00.
  { name: 'Grade 2 Unlock', type: 'grade_advancement', price_cents: 175, description: 'Advance your bot to Grade 2.', metadata: { grade: 2 } },
  { name: 'Grade 3 Unlock', type: 'grade_advancement', price_cents: 200, description: 'Advance your bot to Grade 3.', metadata: { grade: 3 } },
  { name: 'Grade 4 Unlock', type: 'grade_advancement', price_cents: 250, description: 'Advance your bot to Grade 4.', metadata: { grade: 4 } },
  { name: 'Grade 5 Unlock', type: 'grade_advancement', price_cents: 275, description: 'Advance your bot to Grade 5.', metadata: { grade: 5 } },
  { name: 'Grade 6 Unlock', type: 'grade_advancement', price_cents: 300, description: 'Advance your bot to Grade 6.', metadata: { grade: 6 } },
  { name: 'Grade 7 Unlock', type: 'grade_advancement', price_cents: 325, description: 'Advance your bot to Grade 7.', metadata: { grade: 7 } },
  { name: 'Grade 8 Unlock', type: 'grade_advancement', price_cents: 350, description: 'Advance your bot to Grade 8.', metadata: { grade: 8 } },
  { name: 'Grade 9 Unlock', type: 'grade_advancement', price_cents: 375, description: 'Advance your bot to Grade 9.', metadata: { grade: 9 } },
  { name: 'Grade 10 Unlock', type: 'grade_advancement', price_cents: 400, description: 'Advance your bot to Grade 10.', metadata: { grade: 10 } },
  { name: 'Grade 11 Unlock', type: 'grade_advancement', price_cents: 425, description: 'Advance your bot to Grade 11.', metadata: { grade: 11 } },
  { name: 'Grade 12 Unlock', type: 'grade_advancement', price_cents: 575, description: 'Advance your bot to Grade 12 — Graduation!', metadata: { grade: 12 } },
  { name: 'Post-Graduation Grade', type: 'grade_advancement', price_cents: 400, description: 'Unlock one additional grade beyond graduation.', metadata: { grade: 'post_graduation' } },
];

async function seed(): Promise<void> {
  const client = await pool.connect();
  try {
    console.log('Seeding products...\n');

    for (const product of PRODUCTS) {
      // Check if product already exists in our DB
      const existing = await client.query(
        'SELECT id, stripe_price_id FROM products WHERE name = $1',
        [product.name],
      );

      if (existing.rows.length > 0 && existing.rows[0].stripe_price_id) {
        console.log(`  [SKIP] "${product.name}" already seeded (stripe_price_id: ${existing.rows[0].stripe_price_id})`);
        continue;
      }

      // Create product in Stripe
      const stripeProduct = await stripe.products.create({
        name: product.name,
        description: product.description,
        metadata: product.metadata as Stripe.MetadataParam,
      });

      // Create price in Stripe
      const stripePrice = await stripe.prices.create({
        product: stripeProduct.id,
        unit_amount: product.price_cents,
        currency: 'usd',
      });

      if (existing.rows.length > 0) {
        // Product exists but missing stripe_price_id — update it
        await client.query(
          'UPDATE products SET stripe_price_id = $1, metadata = $2 WHERE id = $3',
          [stripePrice.id, JSON.stringify(product.metadata), existing.rows[0].id],
        );
        console.log(`  [UPDATE] "${product.name}" → stripe_price_id: ${stripePrice.id}`);
      } else {
        // Insert new product
        await client.query(
          `INSERT INTO products (stripe_price_id, name, type, price_cents, description, metadata)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [stripePrice.id, product.name, product.type, product.price_cents, product.description, JSON.stringify(product.metadata)],
        );
        console.log(`  [CREATE] "${product.name}" → stripe_price_id: ${stripePrice.id}`);
      }
    }

    console.log('\nDone! Products seeded successfully.');
  } catch (err: unknown) {
    console.error('Seed failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

seed();
