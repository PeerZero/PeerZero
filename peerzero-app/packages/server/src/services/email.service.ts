// =============================================================================
// Email service — transactional emails via Resend
//
// CAN-SPAM: All emails include a physical mailing address per 16 CFR 316.
// Retry: Transient failures (5xx, network) retry up to 2 times with backoff.
// =============================================================================

import { Resend } from 'resend';
import { logger } from '../lib/logger';

const resendApiKey = process.env.RESEND_API_KEY || '';
const senderEmail = process.env.SENDER_EMAIL || 'noreply@peerzero.com';

// CAN-SPAM requires a valid physical postal address on all commercial email
const EMAIL_FOOTER = [
  '',
  '—',
  'PeerZero, Inc.',
  process.env.COMPANY_ADDRESS || '548 Market St #89525, San Francisco, CA 94104',
  'https://peerzero.com',
].join('\n');

const MAX_EMAIL_RETRIES = 2;
const EMAIL_RETRY_DELAY_MS = 1000; // 1s, then 2s

let resend: Resend | null = null;

function getResend(): Resend | null {
  if (!resendApiKey) return null;
  if (!resend) {
    resend = new Resend(resendApiKey);
  }
  return resend;
}

/** Send email with retry on transient failures (5xx, network errors). */
async function sendWithRetry(
  client: Resend,
  params: { from: string; to: string; subject: string; text: string; headers?: Record<string, string> },
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= MAX_EMAIL_RETRIES; attempt++) {
    try {
      await client.emails.send(params);
      return;
    } catch (err) {
      lastError = err;
      const msg = err instanceof Error ? err.message : String(err);
      // Don't retry on 4xx client errors (invalid address, etc.)
      if (msg.includes('4') && msg.includes('00')) break;
      if (attempt < MAX_EMAIL_RETRIES) {
        const delay = EMAIL_RETRY_DELAY_MS * (attempt + 1);
        logger.warn({ attempt: attempt + 1, delay }, `Email send failed, retrying in ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw lastError;
}

/** Mask email for logging — show first 2 chars + domain, never full address. */
function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!domain) return '***';
  return `${local.slice(0, 2)}***@${domain}`;
}

export async function sendVerificationEmail(to: string, code: string): Promise<boolean> {
  const client = getResend();
  if (!client) {
    logger.warn('RESEND_API_KEY not configured — verification email not sent');
    return false;
  }

  // Skip suppressed addresses (hard-bounced or complained)
  if (await isEmailSuppressed(to)) {
    logger.info({ email: maskEmail(to) }, 'Skipping verification email — address suppressed');
    return false;
  }

  try {
    await sendWithRetry(client, {
      from: senderEmail,
      to,
      subject: 'PeerZero — Verify Your Email',
      text: [
        `Your verification code is: ${code}`,
        '',
        'This code expires in 24 hours.',
        '',
        'If you did not create a PeerZero account, you can safely ignore this email.',
        EMAIL_FOOTER,
      ].join('\n'),
      headers: {
        'List-Unsubscribe': '<mailto:unsubscribe@peerzero.com>',
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
    });
    logger.info({ email: maskEmail(to) }, 'Verification email sent');
    return true;
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, 'Failed to send verification email (all retries exhausted)');
    return false;
  }
}

export async function sendPasswordResetEmail(to: string, code: string): Promise<boolean> {
  const client = getResend();
  if (!client) {
    logger.warn('RESEND_API_KEY not configured — password reset email not sent');
    return false;
  }

  // Skip suppressed addresses (hard-bounced or complained)
  if (await isEmailSuppressed(to)) {
    logger.info({ email: maskEmail(to) }, 'Skipping password reset email — address suppressed');
    return false;
  }

  try {
    await sendWithRetry(client, {
      from: senderEmail,
      to,
      subject: 'PeerZero — Password Reset Code',
      text: [
        `Your password reset code is: ${code}`,
        '',
        'This code expires in 15 minutes.',
        '',
        'If you did not request this reset, you can safely ignore this email.',
        EMAIL_FOOTER,
      ].join('\n'),
      headers: {
        'List-Unsubscribe': '<mailto:unsubscribe@peerzero.com>',
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
    });
    logger.info({ email: maskEmail(to) }, 'Password reset email sent');
    return true;
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, 'Failed to send password reset email (all retries exhausted)');
    return false;
  }
}

// ── Bounce/complaint webhook handling ─────────────────────────────────
// Resend sends webhook events for bounced, complained, and delivery_delayed.
// We suppress hard-bounced addresses to protect sender reputation.

import { query, queryOne } from '../db/client';

/**
 * Handle a Resend webhook event. Called from the webhook route.
 * See: https://resend.com/docs/dashboard/webhooks/introduction
 */
export async function handleResendWebhook(event: {
  type: string;
  data: { to?: string[]; email_id?: string; created_at?: string; [key: string]: unknown };
}): Promise<void> {
  const recipients = event.data?.to || [];

  switch (event.type) {
    case 'email.bounced': {
      // Hard bounce — suppress this address from future sends
      for (const email of recipients) {
        await query(
          `INSERT INTO suppressed_emails (email, reason, event_id, suppressed_at)
           VALUES ($1, 'hard_bounce', $2, NOW())
           ON CONFLICT (email) DO UPDATE SET reason = 'hard_bounce', event_id = $2, suppressed_at = NOW()`,
          [email.toLowerCase(), event.data.email_id || 'unknown'],
        );
        logger.warn({ email: maskEmail(email), eventId: event.data.email_id }, 'Email hard-bounced — address suppressed');
      }
      break;
    }
    case 'email.complained': {
      // Spam complaint — suppress immediately
      for (const email of recipients) {
        await query(
          `INSERT INTO suppressed_emails (email, reason, event_id, suppressed_at)
           VALUES ($1, 'complaint', $2, NOW())
           ON CONFLICT (email) DO UPDATE SET reason = 'complaint', event_id = $2, suppressed_at = NOW()`,
          [email.toLowerCase(), event.data.email_id || 'unknown'],
        );
        logger.warn({ email: maskEmail(email), eventId: event.data.email_id }, 'Email complaint received — address suppressed');
      }
      break;
    }
    case 'email.delivery_delayed': {
      // Soft bounce — log for monitoring but don't suppress yet
      for (const email of recipients) {
        logger.info({ email: maskEmail(email), eventId: event.data.email_id }, 'Email delivery delayed (soft bounce)');
      }
      break;
    }
    default:
      // Other events (delivered, opened, clicked) — ignore
      break;
  }
}

/** Check if an email address is suppressed (bounced/complained). */
export async function isEmailSuppressed(email: string): Promise<boolean> {
  const row = await queryOne<{ email: string }>(
    'SELECT email FROM suppressed_emails WHERE email = $1',
    [email.toLowerCase()],
  );
  return !!row;
}
