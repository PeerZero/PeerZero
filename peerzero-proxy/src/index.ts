/**
 * PeerZero LLM Proxy — injects the identity activation preamble server-side.
 *
 * The preamble is the "activation key" that tells an LLM to INHABIT the bot's
 * identity rather than merely reference it. It never touches the user's machine.
 *
 * SECURITY NOTE: The preamble MUST be sourced from a Worker secret (env.IDENTITY_PREAMBLE),
 * never from user-supplied input. If the preamble were user-controlled, it would allow
 * arbitrary prompt injection into every LLM call routed through this proxy.
 *
 * Flow:
 *   Bot → POST /v1/messages → Proxy prepends preamble → Anthropic/OpenAI → response → Bot
 *
 * The proxy is stateless, does zero computation beyond string prepend, and
 * streams responses back unchanged.
 */

interface Env {
  IDENTITY_PREAMBLE: string;    // The activation preamble (Worker secret)
  PROXY_AUTH_SECRET: string;    // Shared secret for validating proxy requests
  ALLOWED_ORIGINS?: string;     // Comma-separated list of allowed CORS origins
}

// ── Provider endpoints ───────────────────────────────────────────────────────

const PROVIDER_URLS: Record<string, string> = {
  anthropic: "https://api.anthropic.com/v1/messages",
  openai: "https://api.openai.com/v1/chat/completions",
};

const ANTHROPIC_VERSION = "2023-06-01";

// ── Constants ────────────────────────────────────────────────────────────────

const MAX_BODY_SIZE = 10 * 1024 * 1024; // 10 MB

// ── Rate limiting (in-memory, per-worker-instance) ───────────────────────────

const rateLimits = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT = 120;         // requests per window
const RATE_WINDOW_MS = 60_000;  // 1 minute

function isRateLimited(rateLimitKey: string): boolean {
  const now = Date.now();
  const entry = rateLimits.get(rateLimitKey);
  if (!entry || now > entry.resetAt) {
    rateLimits.set(rateLimitKey, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return false;
  }
  entry.count++;
  return entry.count > RATE_LIMIT;
}

// ── Request handling ─────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: buildResponseHeaders(request, env),
      });
    }

    if (request.method !== "POST") {
      return jsonError("Method not allowed", 405, request, env);
    }

    // ── Request body size limit ──────────────────────────────────────────
    const contentLength = request.headers.get("Content-Length");
    if (contentLength && parseInt(contentLength, 10) > MAX_BODY_SIZE) {
      return jsonError("Request body too large", 413, request, env);
    }

    // ── Authenticate ───────────────────────────────────────────────────────
    const proxyKey = request.headers.get("X-PeerZero-Proxy-Key");
    if (!proxyKey || !env.PROXY_AUTH_SECRET) {
      return jsonError("Missing proxy authentication", 401, request, env);
    }

    // Constant-time comparison via SHA-256 + timingSafeEqual on ArrayBuffers
    const expectedBuf = await sha256Raw(env.PROXY_AUTH_SECRET);
    const providedBuf = await sha256Raw(proxyKey);
    const authValid = timingSafeEqual(expectedBuf, providedBuf);
    if (!authValid) {
      return jsonError("Invalid proxy key", 401, request, env);
    }

    // ── Rate limit (keyed on full hash + client IP) ──────────────────────
    const keyHashHex = bufToHex(providedBuf);
    const clientIp = request.headers.get("CF-Connecting-IP") || "unknown";
    const rateLimitKey = keyHashHex + ":" + clientIp;
    if (isRateLimited(rateLimitKey)) {
      return jsonError("Rate limited", 429, request, env);
    }

    // ── Parse request ──────────────────────────────────────────────────────
    const provider = (request.headers.get("X-LLM-Provider") || "anthropic").toLowerCase();
    const llmKey = request.headers.get("X-LLM-Key");
    if (!llmKey) {
      return jsonError("Missing X-LLM-Key header", 400, request, env);
    }

    const providerUrl = PROVIDER_URLS[provider];
    if (!providerUrl) {
      return jsonError(`Unsupported provider: ${provider}`, 400, request, env);
    }

    let body: Record<string, unknown>;
    try {
      body = await request.json() as Record<string, unknown>;
    } catch {
      return jsonError("Invalid JSON body", 400, request, env);
    }

    // ── Inject preamble ──────────────────────────────────────────────────
    const preamble = env.IDENTITY_PREAMBLE;
    if (!preamble) {
      return jsonError("Proxy misconfigured: preamble not set", 500, request, env);
    }

    if (provider === "anthropic") {
      // Anthropic: system is a top-level string field
      if (typeof body.system === "string") {
        body.system = preamble + "\n\n" + body.system;
      } else {
        body.system = preamble;
      }
    } else if (provider === "openai") {
      // OpenAI: system is the first message with role "system"
      const messages = body.messages as Array<{ role: string; content: unknown }> | undefined;
      if (messages && messages.length > 0 && messages[0].role === "system") {
        const firstContent = messages[0].content;
        if (typeof firstContent === "string") {
          // Simple string content — concatenate
          messages[0].content = preamble + "\n\n" + firstContent;
        } else if (Array.isArray(firstContent)) {
          // Multimodal array content — prepend preamble as a separate text block
          (firstContent as unknown[]).unshift({ type: "text", text: preamble + "\n\n" });
        } else {
          // Unexpected type — replace with preamble only
          messages[0].content = preamble;
        }
      } else if (messages) {
        messages.unshift({ role: "system", content: preamble });
      }
    }

    // ── Forward to LLM provider ──────────────────────────────────────────
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (provider === "anthropic") {
      headers["x-api-key"] = llmKey;
      headers["anthropic-version"] = ANTHROPIC_VERSION;
      // Pass through beta headers if present
      const beta = request.headers.get("anthropic-beta");
      if (beta) headers["anthropic-beta"] = beta;
    } else if (provider === "openai") {
      headers["Authorization"] = `Bearer ${llmKey}`;
    }

    try {
      const llmResponse = await fetch(providerUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });

      // Stream the response back unchanged
      const responseHeaders = new Headers(buildResponseHeaders(request, env));
      responseHeaders.set("Content-Type", llmResponse.headers.get("Content-Type") || "application/json");
      // Pass through rate limit headers from the provider
      for (const h of ["retry-after", "x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-reset"]) {
        const v = llmResponse.headers.get(h);
        if (v) responseHeaders.set(h, v);
      }

      return new Response(llmResponse.body, {
        status: llmResponse.status,
        headers: responseHeaders,
      });
    } catch (err) {
      // Log the full error server-side for debugging but never expose details to the client.
      // This also ensures llmKey (present in closure scope) is never included in the response.
      console.error("Upstream request failed:", err instanceof Error ? err.message : "Unknown error");
      return jsonError("Upstream request failed", 502, request, env);
    }
  },
};

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build standard response headers including CORS (origin-validated) and security headers.
 */
function buildResponseHeaders(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get("Origin") || "";
  const allowedOrigins = env.ALLOWED_ORIGINS
    ? env.ALLOWED_ORIGINS.split(",").map(o => o.trim())
    : [];

  // Only reflect the origin if it's in the allow-list; otherwise omit the header
  // so the browser rejects the response for cross-origin requests.
  const allowOrigin = allowedOrigins.includes(origin) ? origin : "";

  return {
    // CORS headers
    ...(allowOrigin ? { "Access-Control-Allow-Origin": allowOrigin } : {}),
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-PeerZero-Proxy-Key, X-LLM-Provider, X-LLM-Key, anthropic-beta",
    // Security headers
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
  };
}

function jsonError(
  message: string,
  status: number,
  request: Request,
  env: Env,
  extraHeaders?: Record<string, string>,
): Response {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...buildResponseHeaders(request, env),
    ...(extraHeaders || {}),
  };
  return new Response(JSON.stringify({ error: message }), { status, headers });
}

/**
 * SHA-256 hash returning the raw ArrayBuffer (for constant-time comparison).
 */
async function sha256Raw(input: string): Promise<ArrayBuffer> {
  const data = new TextEncoder().encode(input);
  return crypto.subtle.digest("SHA-256", data);
}

/**
 * Convert an ArrayBuffer to a hex string (for use as rate-limit key, etc.).
 */
function bufToHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Constant-time comparison of two ArrayBuffers of equal length.
 * Returns true if and only if every byte matches.
 */
function timingSafeEqual(a: ArrayBuffer, b: ArrayBuffer): boolean {
  if (a.byteLength !== b.byteLength) return false;
  const viewA = new Uint8Array(a);
  const viewB = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < viewA.length; i++) {
    diff |= viewA[i] ^ viewB[i];
  }
  return diff === 0;
}
