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

// Mock db/client so isEmailSuppressed doesn't hit a real database
vi.mock('../../db/client', () => ({
  query: vi.fn().mockResolvedValue({ rows: [] }),
  queryOne: vi.fn().mockResolvedValue(null),
  queryRows: vi.fn().mockResolvedValue([]),
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

    mockSend.mockRejectedValue(new Error('API rate limit'));

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

