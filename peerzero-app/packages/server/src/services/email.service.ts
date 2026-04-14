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
  params: { from: string; to: string; subject: string; text: string },
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

export async function sendVerificationEmail(to: string, code: string): Promise<boolean> {
  const client = getResend();
  if (!client) {
    logger.warn('RESEND_API_KEY not configured — verification email not sent');
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
    });
    logger.info({ to }, 'Verification email sent');
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
    });
    logger.info({ to }, 'Password reset email sent');
    return true;
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, 'Failed to send password reset email (all retries exhausted)');
    return false;
  }
}
