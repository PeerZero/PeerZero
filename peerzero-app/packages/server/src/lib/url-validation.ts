// =============================================================================
// URL validation — prevents SSRF by rejecting private/internal addresses
// =============================================================================

/**
 * Validate that a URL is safe for server-side requests (anti-SSRF).
 * Rejects private IPs, loopback, link-local, and non-HTTPS schemes.
 * Throws an Error if the URL is unsafe.
 */
export function validateExternalUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Invalid URL format');
  }

  // Only allow HTTPS in production
  if (parsed.protocol !== 'https:') {
    throw new Error(`URL scheme must be https, got ${parsed.protocol.replace(':', '')}`);
  }

  const hostname = parsed.hostname.toLowerCase();

  // Block localhost variants
  if (hostname === 'localhost' || hostname === 'localhost.') {
    throw new Error('URLs targeting localhost are not allowed');
  }

  // Block IPv6 loopback
  // Hostnames in URL objects are wrapped in brackets for IPv6, e.g. [::1]
  if (hostname === '[::1]' || hostname === '::1') {
    throw new Error('URLs targeting loopback addresses are not allowed');
  }

  // Check for IP addresses (IPv4)
  const ipv4Match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const octets = ipv4Match.slice(1).map(Number);

    // 127.0.0.0/8 — loopback
    if (octets[0] === 127) {
      throw new Error('URLs targeting loopback addresses (127.x.x.x) are not allowed');
    }
    // 10.0.0.0/8 — private
    if (octets[0] === 10) {
      throw new Error('URLs targeting private addresses (10.x.x.x) are not allowed');
    }
    // 172.16.0.0/12 — private
    if (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) {
      throw new Error('URLs targeting private addresses (172.16-31.x.x) are not allowed');
    }
    // 192.168.0.0/16 — private
    if (octets[0] === 192 && octets[1] === 168) {
      throw new Error('URLs targeting private addresses (192.168.x.x) are not allowed');
    }
    // 169.254.0.0/16 — link-local (AWS metadata, etc.)
    if (octets[0] === 169 && octets[1] === 254) {
      throw new Error('URLs targeting link-local addresses (169.254.x.x) are not allowed');
    }
    // 0.0.0.0
    if (octets.every(o => o === 0)) {
      throw new Error('URLs targeting 0.0.0.0 are not allowed');
    }
  }

  // Block IPv6 private/internal ranges (common bracket-wrapped forms)
  // Strip brackets for IPv6 check
  const bareHost = hostname.replace(/^\[/, '').replace(/\]$/, '');
  if (bareHost.startsWith('fc') || bareHost.startsWith('fd') ||  // Unique local
      bareHost.startsWith('fe80') ||                              // Link-local
      bareHost === '::' || bareHost === '::1') {
    throw new Error('URLs targeting private/internal IPv6 addresses are not allowed');
  }
}
