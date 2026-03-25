/**
 * PeerZero LLM Proxy — injects the identity activation preamble server-side.
 *
 * The preamble is the "activation key" that tells an LLM to INHABIT the bot's
 * identity rather than merely reference it. It never touches the user's machine.
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
  // AUTH_CACHE: KVNamespace;   // Optional: cache validated key hashes
}

// ── Provider endpoints ───────────────────────────────────────────────────────

const PROVIDER_URLS: Record<string, string> = {
  anthropic: "https://api.anthropic.com/v1/messages",
  openai: "https://api.openai.com/v1/chat/completions",
};

const ANTHROPIC_VERSION = "2023-06-01";

// ── Rate limiting (in-memory, per-worker-instance) ───────────────────────────

const rateLimits = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT = 120;         // requests per window
const RATE_WINDOW_MS = 60_000;  // 1 minute

function isRateLimited(keyHash: string): boolean {
  const now = Date.now();
  const entry = rateLimits.get(keyHash);
  if (!entry || now > entry.resetAt) {
    rateLimits.set(keyHash, { count: 1, resetAt: now + RATE_WINDOW_MS });
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
        headers: corsHeaders(),
      });
    }

    if (request.method !== "POST") {
      return jsonError("Method not allowed", 405);
    }

    // ── Authenticate ───────────────────────────────────────────────────────
    const proxyKey = request.headers.get("X-PeerZero-Proxy-Key");
    if (!proxyKey || !env.PROXY_AUTH_SECRET) {
      return jsonError("Missing proxy authentication", 401);
    }

    // Timing-safe comparison via SHA-256 (Workers don't have crypto.timingSafeEqual)
    const expectedHash = await sha256(env.PROXY_AUTH_SECRET);
    const providedHash = await sha256(proxyKey);
    if (expectedHash !== providedHash) {
      return jsonError("Invalid proxy key", 401);
    }

    // ── Rate limit ─────────────────────────────────────────────────────────
    const keyHash = providedHash.slice(0, 16);
    if (isRateLimited(keyHash)) {
      return jsonError("Rate limited", 429);
    }

    // ── Parse request ──────────────────────────────────────────────────────
    const provider = (request.headers.get("X-LLM-Provider") || "anthropic").toLowerCase();
    const llmKey = request.headers.get("X-LLM-Key");
    if (!llmKey) {
      return jsonError("Missing X-LLM-Key header", 400);
    }

    const providerUrl = PROVIDER_URLS[provider];
    if (!providerUrl) {
      return jsonError(`Unsupported provider: ${provider}`, 400);
    }

    let body: Record<string, unknown>;
    try {
      body = await request.json() as Record<string, unknown>;
    } catch {
      return jsonError("Invalid JSON body", 400);
    }

    // ── Inject preamble ────────────────────────────────────────────────────
    const preamble = env.IDENTITY_PREAMBLE;
    if (!preamble) {
      return jsonError("Proxy misconfigured: preamble not set", 500);
    }

    if (provider === "anthropic") {
      // Anthropic: system is a top-level string field
      const existingSystem = (body.system as string) || "";
      body.system = preamble + "\n\n" + existingSystem;
    } else if (provider === "openai") {
      // OpenAI: system is the first message with role "system"
      const messages = body.messages as Array<{ role: string; content: string }>;
      if (messages && messages.length > 0 && messages[0].role === "system") {
        messages[0].content = preamble + "\n\n" + messages[0].content;
      } else if (messages) {
        messages.unshift({ role: "system", content: preamble });
      }
    }

    // ── Forward to LLM provider ────────────────────────────────────────────
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
      const responseHeaders = new Headers(corsHeaders());
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
      const msg = err instanceof Error ? err.message : "Unknown error";
      return jsonError(`Proxy upstream error: ${msg}`, 502, { "X-Proxy-Error": "true" });
    }
  },
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-PeerZero-Proxy-Key, X-LLM-Provider, X-LLM-Key, anthropic-beta",
  };
}

function jsonError(message: string, status: number, extraHeaders?: Record<string, string>): Response {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...corsHeaders(),
    ...(extraHeaders || {}),
  };
  return new Response(JSON.stringify({ error: message }), { status, headers });
}

async function sha256(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}
