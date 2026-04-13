// =============================================================================
// Email service — transactional emails via Resend
// =============================================================================

import { Resend } from 'resend';
import { logger } from '../lib/logger';

const resendApiKey = process.env.RESEND_API_KEY || '';
const senderEmail = process.env.SENDER_EMAIL || 'noreply@peerzero.com';

let resend: Resend | null = null;

function getResend(): Resend | null {
  if (!resendApiKey) return null;
  if (!resend) {
    resend = new Resend(resendApiKey);
  }
  return resend;
}

export async function sendVerificationEmail(to: string, code: string): Promise<boolean> {
  const client = getResend();
  if (!client) {
    logger.warn('RESEND_API_KEY not configured — verification email not sent');
    return false;
  }

  try {
    await client.emails.send({
      from: senderEmail,
      to,
      subject: 'PeerZero — Verify Your Email',
      text: [
        `Your verification code is: ${code}`,
        '',
        'This code expires in 24 hours.',
        '',
        'If you did not create a PeerZero account, you can safely ignore this email.',
      ].join('\n'),
    });
    logger.info({ to }, 'Verification email sent');
    return true;
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, 'Failed to send verification email');
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
    await client.emails.send({
      from: senderEmail,
      to,
      subject: 'PeerZero — Password Reset Code',
      text: [
        `Your password reset code is: ${code}`,
        '',
        'This code expires in 15 minutes.',
        '',
        'If you did not request this reset, you can safely ignore this email.',
      ].join('\n'),
    });
    logger.info({ to }, 'Password reset email sent');
    return true;
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, 'Failed to send password reset email');
    return false;
  }
}
