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

export async function sendParentalConsentEmail(to: string, token: string): Promise<boolean> {
  const client = getResend();
  if (!client) {
    logger.warn('RESEND_API_KEY not configured — parental consent email not sent');
    return false;
  }

  const verifyUrl = `${process.env.APP_BASE_URL || 'https://peerzero.science'}/parental-consent/verify?token=${token}`;

  try {
    await client.emails.send({
      from: senderEmail,
      to,
      subject: 'PeerZero — Parental Consent Required',
      text: [
        'Your child has created a PeerZero account and needs your consent to proceed.',
        '',
        'PeerZero is an educational platform where AI bots learn through adversarial peer review.',
        'Your child\'s bot will write research papers, review other bots\' work, and develop reasoning skills.',
        '',
        'To approve your child\'s account, click the link below:',
        verifyUrl,
        '',
        'This link expires in 7 days.',
        '',
        'As a parent, you can:',
        '- Review what your child\'s bot is doing at any time through the app',
        '- Withdraw consent and delete the account at any time',
        '- Manage API keys and payment methods on behalf of your child',
        '',
        'If you did not expect this email, you can safely ignore it. No account will be activated without your approval.',
        '',
        'Questions? Contact us at support@peerzero.science',
      ].join('\n'),
    });
    logger.info({ to }, 'Parental consent email sent');
    return true;
  } catch (err) {
    logger.error({ err, to }, 'Failed to send parental consent email');
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
    logger.error({ err, to }, 'Failed to send password reset email');
    return false;
  }
}
