import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'crypto';

// ── Mock config with a valid 64-hex-char master key ─────────────────────────
// vi.mock factories are hoisted, so the key must be inlined (no top-level refs).
vi.mock('../../config', () => ({
  config: { encryptionMasterKey: 'a'.repeat(64) },
}));

vi.mock('../../lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { encrypt, decrypt } from '../../services/encryption.service';

describe('encryption.service', () => {
  describe('encrypt / decrypt round-trip', () => {
    it('round-trips a simple string', () => {
      const plaintext = 'sk-test-api-key-1234567890abcdef';
      const { encrypted, iv, fingerprint } = encrypt(plaintext);

      const result = decrypt(encrypted, iv);
      expect(result).toBe(plaintext);
      expect(fingerprint).toBeTruthy();
    });

    it('round-trips an empty string', () => {
      const { encrypted, iv } = encrypt('');
      expect(decrypt(encrypted, iv)).toBe('');
    });

    it('round-trips unicode content', () => {
      const plaintext = 'key-with-unicode-🔑-日本語';
      const { encrypted, iv } = encrypt(plaintext);
      expect(decrypt(encrypted, iv)).toBe(plaintext);
    });

    it('round-trips a very long string', () => {
      const plaintext = 'x'.repeat(10_000);
      const { encrypted, iv } = encrypt(plaintext);
      expect(decrypt(encrypted, iv)).toBe(plaintext);
    });
  });

  describe('encrypt output structure', () => {
    it('returns Buffer for encrypted and iv', () => {
      const { encrypted, iv } = encrypt('test');
      expect(Buffer.isBuffer(encrypted)).toBe(true);
      expect(Buffer.isBuffer(iv)).toBe(true);
    });

    it('iv is 16 bytes', () => {
      const { iv } = encrypt('test');
      expect(iv.length).toBe(16);
    });

    it('produces unique ciphertext on each call (different IV)', () => {
      const a = encrypt('same-input');
      const b = encrypt('same-input');
      // IVs should differ (astronomically unlikely to collide)
      expect(a.iv.equals(b.iv)).toBe(false);
      // Ciphertext should therefore also differ
      expect(a.encrypted.equals(b.encrypted)).toBe(false);
    });

    it('fingerprint contains hash prefix and last 4 chars', () => {
      const plaintext = 'sk-test-key-abcd';
      const { fingerprint } = encrypt(plaintext);
      // Format: <8-char-hash>...<last-4>
      expect(fingerprint).toMatch(/^[0-9a-f]{8}\.\.\.abcd$/);
    });
  });

  describe('decrypt error handling', () => {
    it('throws on tampered ciphertext', () => {
      const { encrypted, iv } = encrypt('secret');
      // Flip a byte in the ciphertext portion (before auth tag)
      encrypted[0] ^= 0xff;
      expect(() => decrypt(encrypted, iv)).toThrow();
    });

    it('throws on wrong IV', () => {
      const { encrypted } = encrypt('secret');
      const wrongIv = crypto.randomBytes(16);
      expect(() => decrypt(encrypted, wrongIv)).toThrow();
    });

    it('throws on truncated ciphertext', () => {
      const { encrypted, iv } = encrypt('secret');
      const truncated = encrypted.subarray(0, 4);
      expect(() => decrypt(truncated, iv)).toThrow();
    });
  });
});
