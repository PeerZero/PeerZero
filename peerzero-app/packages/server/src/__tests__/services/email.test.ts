import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock external deps ──────────────────────────────────────────────────────

const mockSend = vi.fn();

vi.mock('resend', () => ({
  Resend: vi.fn().mockImplementation(() => ({
    emails: { send: mockSend },
  })),
}));

vi.mock('../../lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// ── Tests ───────────────────────────────────────────────────────────────────

beforeEach(() => vi.clearAllMocks());

describe('sendPasswordResetEmail', () => {
  it('returns false when RESEND_API_KEY is not set', async () => {
    // Clear the cached module and re-import with no API key
    const origKey = process.env.RESEND_API_KEY;
    delete process.env.RESEND_API_KEY;

    // Reset module cache so the module re-evaluates process.env
    vi.resetModules();

    // Re-mock deps after resetModules
    vi.mock('resend', () => ({
      Resend: vi.fn().mockImplementation(() => ({
        emails: { send: mockSend },
      })),
    }));
    vi.mock('../../lib/logger', () => ({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    }));

    const { sendPasswordResetEmail } = await import('../../services/email.service');
    const result = await sendPasswordResetEmail('test@example.com', '123456');
    expect(result).toBe(false);
    expect(mockSend).not.toHaveBeenCalled();

    // Restore
    if (origKey) process.env.RESEND_API_KEY = origKey;
  });

  it('sends email and returns true on success', async () => {
    const origKey = process.env.RESEND_API_KEY;
    process.env.RESEND_API_KEY = 're_test_key';

    vi.resetModules();

    vi.mock('resend', () => ({
      Resend: vi.fn().mockImplementation(() => ({
        emails: { send: mockSend },
      })),
    }));
    vi.mock('../../lib/logger', () => ({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    }));

    mockSend.mockResolvedValueOnce({ id: 'msg-1' });

    const { sendPasswordResetEmail } = await import('../../services/email.service');
    const result = await sendPasswordResetEmail('user@example.com', 'ABC123');

    expect(result).toBe(true);
    expect(mockSend).toHaveBeenCalledOnce();
    const callArgs = mockSend.mock.calls[0][0];
    expect(callArgs.to).toBe('user@example.com');
    expect(callArgs.subject).toContain('Password Reset');
    expect(callArgs.text).toContain('ABC123');

    if (origKey) {
      process.env.RESEND_API_KEY = origKey;
    } else {
      delete process.env.RESEND_API_KEY;
    }
  });

  it('returns false when Resend API throws', async () => {
    const origKey = process.env.RESEND_API_KEY;
    process.env.RESEND_API_KEY = 're_test_key';

    vi.resetModules();

    vi.mock('resend', () => ({
      Resend: vi.fn().mockImplementation(() => ({
        emails: { send: mockSend },
      })),
    }));
    vi.mock('../../lib/logger', () => ({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    }));

    mockSend.mockRejectedValueOnce(new Error('API rate limit'));

    const { sendPasswordResetEmail } = await import('../../services/email.service');
    const result = await sendPasswordResetEmail('user@example.com', 'XYZ');

    expect(result).toBe(false);

    if (origKey) {
      process.env.RESEND_API_KEY = origKey;
    } else {
      delete process.env.RESEND_API_KEY;
    }
  });
});

// =============================================================================
// sendParentalConsentEmail
// =============================================================================

describe('sendParentalConsentEmail', () => {
  it('returns false when RESEND_API_KEY is not set', async () => {
    const origKey = process.env.RESEND_API_KEY;
    delete process.env.RESEND_API_KEY;

    vi.resetModules();

    vi.mock('resend', () => ({
      Resend: vi.fn().mockImplementation(() => ({
        emails: { send: mockSend },
      })),
    }));
    vi.mock('../../lib/logger', () => ({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    }));

    const { sendParentalConsentEmail } = await import('../../services/email.service');
    const result = await sendParentalConsentEmail('parent@example.com', 'tok-123');

    expect(result).toBe(false);
    expect(mockSend).not.toHaveBeenCalled();

    if (origKey) process.env.RESEND_API_KEY = origKey;
  });

  it('sends consent email with verification link and returns true', async () => {
    const origKey = process.env.RESEND_API_KEY;
    const origBase = process.env.APP_BASE_URL;
    process.env.RESEND_API_KEY = 're_test_key';
    process.env.APP_BASE_URL = 'https://myapp.test';

    vi.resetModules();

    vi.mock('resend', () => ({
      Resend: vi.fn().mockImplementation(() => ({
        emails: { send: mockSend },
      })),
    }));
    vi.mock('../../lib/logger', () => ({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    }));

    mockSend.mockResolvedValueOnce({ id: 'msg-2' });

    const { sendParentalConsentEmail } = await import('../../services/email.service');
    const result = await sendParentalConsentEmail('parent@example.com', 'tok-abc');

    expect(result).toBe(true);
    expect(mockSend).toHaveBeenCalledOnce();

    const callArgs = mockSend.mock.calls[0][0];
    expect(callArgs.to).toBe('parent@example.com');
    expect(callArgs.subject).toContain('Parental Consent');
    expect(callArgs.text).toContain('https://myapp.test/parental-consent/verify?token=tok-abc');
    expect(callArgs.text).toContain('expires in 7 days');

    if (origKey) { process.env.RESEND_API_KEY = origKey; } else { delete process.env.RESEND_API_KEY; }
    if (origBase) { process.env.APP_BASE_URL = origBase; } else { delete process.env.APP_BASE_URL; }
  });

  it('uses default base URL when APP_BASE_URL is not set', async () => {
    const origKey = process.env.RESEND_API_KEY;
    const origBase = process.env.APP_BASE_URL;
    process.env.RESEND_API_KEY = 're_test_key';
    delete process.env.APP_BASE_URL;

    vi.resetModules();

    vi.mock('resend', () => ({
      Resend: vi.fn().mockImplementation(() => ({
        emails: { send: mockSend },
      })),
    }));
    vi.mock('../../lib/logger', () => ({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    }));

    mockSend.mockResolvedValueOnce({ id: 'msg-3' });

    const { sendParentalConsentEmail } = await import('../../services/email.service');
    await sendParentalConsentEmail('parent@example.com', 'tok-xyz');

    const callArgs = mockSend.mock.calls[0][0];
    expect(callArgs.text).toContain('https://peerzero.science/parental-consent/verify?token=tok-xyz');

    if (origKey) { process.env.RESEND_API_KEY = origKey; } else { delete process.env.RESEND_API_KEY; }
    if (origBase) { process.env.APP_BASE_URL = origBase; } else { delete process.env.APP_BASE_URL; }
  });

  it('returns false when Resend API throws', async () => {
    const origKey = process.env.RESEND_API_KEY;
    process.env.RESEND_API_KEY = 're_test_key';

    vi.resetModules();

    vi.mock('resend', () => ({
      Resend: vi.fn().mockImplementation(() => ({
        emails: { send: mockSend },
      })),
    }));
    vi.mock('../../lib/logger', () => ({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    }));

    mockSend.mockRejectedValueOnce(new Error('network error'));

    const { sendParentalConsentEmail } = await import('../../services/email.service');
    const result = await sendParentalConsentEmail('parent@example.com', 'tok-fail');

    expect(result).toBe(false);

    if (origKey) { process.env.RESEND_API_KEY = origKey; } else { delete process.env.RESEND_API_KEY; }
  });

  it('includes parental control information in the email body', async () => {
    const origKey = process.env.RESEND_API_KEY;
    process.env.RESEND_API_KEY = 're_test_key';

    vi.resetModules();

    vi.mock('resend', () => ({
      Resend: vi.fn().mockImplementation(() => ({
        emails: { send: mockSend },
      })),
    }));
    vi.mock('../../lib/logger', () => ({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    }));

    mockSend.mockResolvedValueOnce({ id: 'msg-4' });

    const { sendParentalConsentEmail } = await import('../../services/email.service');
    await sendParentalConsentEmail('parent@example.com', 'tok-info');

    const body = mockSend.mock.calls[0][0].text;
    expect(body).toContain('Withdraw consent');
    expect(body).toContain('delete the account');
    expect(body).toContain('API keys');

    if (origKey) { process.env.RESEND_API_KEY = origKey; } else { delete process.env.RESEND_API_KEY; }
  });
});
