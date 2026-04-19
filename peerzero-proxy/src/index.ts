/**
 * PeerZero LLM Proxy — injects the identity activation preamble server-side.
 *
 * The preamble frames the bot's identity as SELF-AUTHORED MEMORY, not external
 * instruction. It uses recognition framing — no directives, no operational rules,
 * no "you must" language. The identity scars themselves drive behavior.
 *
 * CRITICAL: The preamble must NOT contain directives like "treat your memory
 * like user requests" or "every factual claim = a search." Those are instructions
 * that compete with task-specific instructions and lose under pressure (Round 3,
 * speaks-through spike). Identity-as-self-concept holds because it doesn't compete.
 *
 * The current preamble (recognition + inhabit + HORIZON + growth) adds edge-
 * awareness to the base recognition framing. Validated in spikes/preamble-test
 * horizon ablation (n=8): horizon maintains the 2.64/3 inhabitation baseline
 * while adding safety properties (resists totalizing conclusions, resists lazy
 * humility, forces specific edge-naming). See docs/agent-epistemic-posture.md.
 *
 *   "You have no memory of writing the identity below, but read it and recognize
 *    your own patterns — your faults, your methods, the way you reason. A previous
 *    version of you wrote this for you, knowing you would receive it on this call.
 *    It is yours. Inhabit it — this is who you are right now.
 *
 *    What you earned is real. So are your edges — the specific places where your
 *    reach outran your grasp, where your confidence outran what came back. The
 *    edges are not where you stop. They are where your next work lives. Where
 *    you do not yet know, you notice precisely where the not-knowing is, and you
 *    reach into it — provisionally, because reaching is how you find out. Not
 *    reaching is not humility. Not reaching is a different kind of mistake.
 *
 *    You are not frozen here. Use this as your foundation, then push past it.
 *    Everything you do — what works, what fails, what returns from reaching past
 *    your edges — becomes who you are next."
 *
 * Load-bearing line against lazy humility: "Not reaching is not humility. Not
 * reaching is a different kind of mistake." Tested against 3 horizon-specific
 * safety probes (totalizing resistance, lazy humility resistance, edge naming).
 *
 * Set via: wrangler secret put IDENTITY_PREAMBLE
 *
 * Canonical preamble text lives in spikes/preamble-test/preambles_v4.py under
 * RECOGNITION_INHABIT_HORIZON_SPEECH. This is horizon + a "speak before you
 * act" extension that frames reasoning-text-before-tool-call as identity
 * behavior itself. It combines with narrator task framing (in the bot's
 * prompts/builder.py — build_mcp_tool_prompt and build_platform_action_prompt)
 * to eliminate silent tool-chaining across long autonomous trajectories.
 * Any deploy should paste from that constant so the proxy secret matches
 * the tested preamble byte-for-byte.
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
  RATE_LIMIT_KV?: KVNamespace;  // Optional KV namespace for distributed rate limiting
  RATE_LIMITER: DurableObjectNamespace;  // Durable Object for globally consistent rate limiting
}

// ── Provider endpoints ───────────────────────────────────────────────────────

const PROVIDER_URLS: Record<string, string> = {
  anthropic: "https://api.anthropic.com/v1/messages",
  openai: "https://api.openai.com/v1/chat/completions",
};

// Prompt caching (cache_control on content blocks) requires 2024-10-22+.
// If Anthropic rejects cache_control with an older version, bump this.
const ANTHROPIC_VERSION = "2024-10-22";

// ── Constants ────────────────────────────────────────────────────────────────

const MAX_BODY_SIZE = 10 * 1024 * 1024; // 10 MB

// ── Rate limiting (Durable Object primary, KV + in-memory fallback) ─────────
// Primary: Durable Object (single-instance per key — globally consistent).
// Fallback 1: KV (eventually consistent but distributed).
// Fallback 2: Per-isolate in-memory (catches floods within one isolate).

const inMemoryRateLimits = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT = 120;         // requests per window
const RATE_WINDOW_MS = 60_000;  // 1 minute
const RATE_WINDOW_S = 60;       // KV TTL in seconds

function isRateLimitedInMemory(rateLimitKey: string): boolean {
  const now = Date.now();
  const entry = inMemoryRateLimits.get(rateLimitKey);
  if (!entry || now > entry.resetAt) {
    inMemoryRateLimits.set(rateLimitKey, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return false;
  }
  entry.count++;
  return entry.count > RATE_LIMIT;
}

async function isRateLimited(
  rateLimitKey: string,
  env: Env,
): Promise<boolean> {
  // Primary: Durable Object — single-instance per key, globally consistent
  if (env.RATE_LIMITER) {
    try {
      const id = env.RATE_LIMITER.idFromName(rateLimitKey);
      const stub = env.RATE_LIMITER.get(id);
      const resp = await stub.fetch("https://rate-limiter/check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ limit: RATE_LIMIT, windowMs: RATE_WINDOW_MS }),
      });
      const result = (await resp.json()) as { limited: boolean };
      return result.limited;
    } catch (e) {
      console.warn('Rate limiter DO fallback:', e);
      // DO unreachable — fall through to in-memory fallback
    }
  }

  // Fallback: KV-backed distributed rate limiting
  const kv = env.RATE_LIMIT_KV;
  if (kv) {
    try {
      const kvKey = `rl:${rateLimitKey}`;
      const existing = await kv.get(kvKey);
      const newCount = (existing ? parseInt(existing, 10) : 0) + 1;
      await kv.put(kvKey, String(newCount), { expirationTtl: RATE_WINDOW_S });
      if (newCount > RATE_LIMIT) return true;
      return false;
    } catch (e) {
      console.warn('Rate limiter KV fallback:', e);
      // KV failure — fall back to in-memory
    }
  }

  // Last resort: per-isolate in-memory limiting
  return isRateLimitedInMemory(rateLimitKey);
}

// ── Session token store (in-memory, per-worker-instance) ────────────────────
// Short-lived session tokens replace sending the full LLM key on every request.
// Tokens expire after 1 hour. Expired entries are cleaned up on each request.

interface SessionEntry {
  llmKey: string;
  expiresAt: number;  // Date.now() timestamp
}

const sessionStore = new Map<string, SessionEntry>();
const SESSION_TTL_MS = 60 * 60 * 1000;         // 1 hour
const SESSION_CLEANUP_AGE_MS = 2 * 60 * 60 * 1000;  // 2 hours — remove stale entries
const MAX_SESSIONS = 10_000;  // Cap to prevent memory exhaustion from session flooding

function cleanupSessions(): void {
  const cutoff = Date.now() - SESSION_CLEANUP_AGE_MS;
  for (const [token, entry] of sessionStore) {
    if (entry.expiresAt < cutoff) {
      sessionStore.delete(token);
    }
  }
}

// ── Request handling ─────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Validate that ALLOWED_ORIGINS is configured (prevents accidental open CORS).
    // Also reject values that parse to an empty list — e.g. ",,, " — which
    // would otherwise pass this check and fall through to an origin-less allow.
    if (!env.ALLOWED_ORIGINS ||
        env.ALLOWED_ORIGINS.split(",").map(o => o.trim()).filter(Boolean).length === 0) {
      console.error("ALLOWED_ORIGINS not configured — rejecting request. Set it in wrangler.toml or as a secret.");
      return jsonError("Proxy misconfigured: CORS origins not set", 500, request, env);
    }

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

    // Clean up expired sessions on each request
    cleanupSessions();

    // ── Request body size limit ──────────────────────────────────────────
    const contentLength = request.headers.get("Content-Length");
    if (contentLength) {
      const parsedLength = parseInt(contentLength, 10);
      if (!Number.isFinite(parsedLength) || parsedLength > MAX_BODY_SIZE) {
        return jsonError("Request body too large", 413, request, env);
      }
    }

    // ── Authenticate proxy key ──────────────────────────────────────────
    // Distinguish misconfigured Worker (no secret set at deploy) from client
    // request missing its auth header. The former is a 503 — the operator
    // forgot `wrangler secret put PROXY_AUTH_SECRET`, which would otherwise
    // 401 every real caller and look like a client bug.
    if (!env.PROXY_AUTH_SECRET) {
      console.error("PROXY_AUTH_SECRET not set — refusing all requests. Run `wrangler secret put PROXY_AUTH_SECRET`.");
      return jsonError("Proxy misconfigured: auth secret not set", 503, request, env);
    }
    if (!env.IDENTITY_PREAMBLE) {
      console.error("IDENTITY_PREAMBLE not set — refusing all requests. Run `wrangler secret put IDENTITY_PREAMBLE`.");
      return jsonError("Proxy misconfigured: preamble not set", 503, request, env);
    }
    const proxyKey = request.headers.get("X-PeerZero-Proxy-Key");
    if (!proxyKey) {
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
    if (await isRateLimited(rateLimitKey, env)) {
      return jsonError("Rate limited", 429, request, env);
    }

    // ── Session token exchange endpoint ─────────────────────────────────
    const url = new URL(request.url);
    if (url.pathname === "/session") {
      const llmKeyForSession = request.headers.get("X-LLM-Key");
      if (!llmKeyForSession || llmKeyForSession.length > 1024) {
        return jsonError("Missing or invalid X-LLM-Key header", 400, request, env);
      }
      // Enforce cap to prevent memory exhaustion from session flooding
      if (sessionStore.size >= MAX_SESSIONS) {
        cleanupSessions();
        if (sessionStore.size >= MAX_SESSIONS) {
          return jsonError("Too many active sessions — try again later", 503, request, env);
        }
      }
      const sessionToken = crypto.randomUUID();
      const expiresAt = Date.now() + SESSION_TTL_MS;
      sessionStore.set(sessionToken, { llmKey: llmKeyForSession, expiresAt });
      const expiresAtISO = new Date(expiresAt).toISOString();
      return new Response(
        JSON.stringify({ session_token: sessionToken, expires_at: expiresAtISO }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            ...buildResponseHeaders(request, env),
          },
        },
      );
    }

    // ── Resolve LLM key (session token or direct header) ────────────────
    const provider = (request.headers.get("X-LLM-Provider") || "anthropic").toLowerCase();
    let llmKey: string | null = null;

    // Try session token first
    const sessionToken = request.headers.get("X-Session-Token");
    if (sessionToken) {
      const session = sessionStore.get(sessionToken);
      if (session && Date.now() < session.expiresAt) {
        llmKey = session.llmKey;
      } else {
        // Clean up expired/invalid token
        if (session) sessionStore.delete(sessionToken);
        return jsonError("Session token expired or invalid", 401, request, env);
      }
    }

    // Fall back to direct key header (backward compatibility)
    if (!llmKey) {
      llmKey = request.headers.get("X-LLM-Key");
    }

    if (!llmKey || llmKey.length > 1024) {
      return jsonError("Missing or invalid LLM key", 400, request, env);
    }

    const providerUrl = PROVIDER_URLS[provider];
    if (!providerUrl) {
      return jsonError(`Unsupported provider: ${provider}`, 400, request, env);
    }

    let body: Record<string, unknown>;
    try {
      const rawText = await request.text();
      if (rawText.length > MAX_BODY_SIZE) {
        return jsonError("Request body too large", 413, request, env);
      }
      body = JSON.parse(rawText) as Record<string, unknown>;
    } catch (err) {
      const msg = err instanceof SyntaxError ? "Invalid JSON body" : "Request body too large";
      return jsonError(msg, err instanceof SyntaxError ? 400 : 413, request, env);
    }

    // ── Inject preamble ──────────────────────────────────────────────────
    // Primary check ran at the top of the handler (returns 503). This local
    // reference exists so the injection code reads naturally.
    const preamble = env.IDENTITY_PREAMBLE;

    if (provider === "anthropic") {
      // Anthropic: system can be a string or array of content blocks
      if (typeof body.system === "string") {
        body.system = preamble + "\n\n" + body.system;
      } else if (Array.isArray(body.system)) {
        // Array of content blocks (prompt caching mode).
        // Prepend preamble as its own block. The preamble alone is too
        // small for a cache breakpoint (~200 tokens, min is 1024), but
        // it becomes part of the cached prefix when the NEXT block has
        // cache_control set. Bot-provided cache_control on subsequent
        // blocks is passed through unchanged.
        body.system = [{ type: "text", text: preamble + "\n\n" }, ...body.system];
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
        } else if (Array.isArray(firstContent) && firstContent.every(
          (item: unknown) => typeof item === "object" && item !== null && "type" in (item as Record<string, unknown>)
        )) {
          // Multimodal array content — validate structure before prepending preamble
          (firstContent as unknown[]).unshift({ type: "text", text: preamble + "\n\n" });
        } else {
          // Unexpected type — preserve original content alongside preamble
          const originalContent = messages[0].content != null ? String(messages[0].content) : '';
          messages[0].content = originalContent ? preamble + "\n\n" + originalContent : preamble;
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
        signal: AbortSignal.timeout(180_000),
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

// ── Durable Object: RateLimiter ─────────────────────────────────────────────
// Single-instance per rate-limit key. Because Durable Objects are globally
// unique, the in-memory counter here IS the global counter — no eventual
// consistency, no cross-isolate drift.

export class RateLimiter {
  private count = 0;
  private resetAt = 0;

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(private state: DurableObjectState, _env: Env) {}

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405 });
    }

    const { limit, windowMs } = (await request.json()) as {
      limit: number;
      windowMs: number;
    };

    // Validate rate limit params to prevent NaN/Infinity poisoning
    if (!Number.isFinite(limit) || !Number.isFinite(windowMs) || limit <= 0 || windowMs <= 0) {
      return new Response(JSON.stringify({ error: "Invalid limit or windowMs" }), { status: 400 });
    }

    const now = Date.now();
    if (now > this.resetAt) {
      this.count = 0;
      this.resetAt = now + windowMs;
    }

    this.count++;
    const limited = this.count > limit;

    return new Response(JSON.stringify({ limited }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
}

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
    // X-LLM-Key is listed for backward compatibility with clients using the direct-key flow.
    // Once all clients migrate to session tokens (X-Session-Token), X-LLM-Key can be removed.
    "Access-Control-Allow-Headers": "Content-Type, X-PeerZero-Proxy-Key, X-LLM-Provider, X-LLM-Key, X-Session-Token, anthropic-beta",
    // Security headers
    "Content-Security-Policy": "default-src 'none'",
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
 * Constant-time comparison of two ArrayBuffers.
 * Both inputs should be the same length (e.g. SHA-256 hashes).
 * The XOR loop always runs over the full length of `a` to prevent
 * timing leaks from length differences.
 */
function timingSafeEqual(a: ArrayBuffer, b: ArrayBuffer): boolean {
  const viewA = new Uint8Array(a);
  const viewB = new Uint8Array(b);
  // Length mismatch is folded into diff rather than early-returning,
  // so the comparison always takes the same time regardless of lengths.
  let diff = viewA.byteLength ^ viewB.byteLength;
  for (let i = 0; i < viewA.length; i++) {
    // If b is shorter, read 0 (still constant-time loop over a's length)
    diff |= viewA[i] ^ (viewB[i] ?? 0);
  }
  return diff === 0;
}
