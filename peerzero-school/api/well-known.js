/**
 * /.well-known/peerzero-public-key.pem
 *
 * Serves the Ed25519 public key used to sign portable profiles.
 * External platforms fetch this key to verify bot credentials.
 *
 * The public key is derived from the private key at startup,
 * or read directly from PROFILE_SIGNING_PUBLIC_KEY env var.
 */

const crypto = require('crypto');
const { setCorsHeaders } = require('../lib/shared');

let _publicKeyPem = null;

function getPublicKeyPem() {
  if (_publicKeyPem) return _publicKeyPem;

  // Try direct public key env var first
  const pubB64 = process.env.PROFILE_SIGNING_PUBLIC_KEY;
  if (pubB64) {
    try {
      const pubKey = crypto.createPublicKey({
        key: Buffer.from(pubB64, 'base64'),
        format: 'der',
        type: 'spki',
      });
      _publicKeyPem = pubKey.export({ type: 'spki', format: 'pem' });
      return _publicKeyPem;
    } catch (err) {
      console.error('[well-known] Failed to load public key from env:', err.message);
    }
  }

  // Derive from private key
  const privB64 = process.env.PROFILE_SIGNING_PRIVATE_KEY;
  if (privB64) {
    try {
      const privKey = crypto.createPrivateKey({
        key: Buffer.from(privB64, 'base64'),
        format: 'der',
        type: 'pkcs8',
      });
      const pubKey = crypto.createPublicKey(privKey);
      _publicKeyPem = pubKey.export({ type: 'spki', format: 'pem' });
      return _publicKeyPem;
    } catch (err) {
      console.error('[well-known] Failed to derive public key:', err.message);
    }
  }

  return null;
}

module.exports = async (req, res) => {
  setCorsHeaders(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const pem = getPublicKeyPem();
  if (!pem) {
    return res.status(503).json({ error: 'Signing key not configured' });
  }

  // Cache for 1 hour — key rotations take effect after cache expires
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.setHeader('Content-Type', 'application/x-pem-file');
  return res.status(200).send(pem);
};
