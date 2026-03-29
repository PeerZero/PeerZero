/**
 * Tests for the PeerZero LLM Proxy (Cloudflare Worker).
 *
 * These tests exercise the proxy's fetch handler by reconstructing its logic
 * in a Node.js environment. Since the source is TypeScript targeting the
 * Workers runtime, we replicate the key functions and test the handler's
 * behavioral contract directly, using Node's built-in crypto for SHA-256.
 *
 * Run: node --test tests/
 */

const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { webcrypto } = require("node:crypto");

// ---------------------------------------------------------------------------
// Helpers — mirrored from src/index.ts so tests validate the same logic
// ---------------------------------------------------------------------------

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type, X-PeerZero-Proxy-Key, X-LLM-Provider, X-LLM-Key, anthropic-beta",
  };
}

function jsonError(message, status, extraHeaders) {
  const headers = {
    "Content-Type": "application/json",
    ...corsHeaders(),
    ...(extraHeaders || {}),
  };
  return new Response(JSON.stringify({ error: message }), { status, headers });
}

async function sha256(input) {
  const data = new TextEncoder().encode(input);
  const hash = await webcrypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ---------------------------------------------------------------------------
// Rate limiter — exact replica of the Worker's in-memory rate limiter
// ---------------------------------------------------------------------------

function createRateLimiter(limit = 120, windowMs = 60_000) {
  const map = new Map();

  function isRateLimited(keyHash) {
    const now = Date.now();
    const entry = map.get(keyHash);
    if (!entry || now > entry.resetAt) {
      map.set(keyHash, { count: 1, resetAt: now + windowMs });
      return false;
    }
    entry.count++;
    return entry.count > limit;
  }

  function reset() {
    map.clear();
  }

  return { isRateLimited, reset, _map: map };
}

// ---------------------------------------------------------------------------
// Proxy handler — faithful reproduction of the Worker's fetch()
// ---------------------------------------------------------------------------

const PROVIDER_URLS = {
  anthropic: "https://api.anthropic.com/v1/messages",
  openai: "https://api.openai.com/v1/chat/completions",
};

const ANTHROPIC_VERSION = "2023-06-01";

/**
 * Build a handler that behaves identically to the Worker export default.fetch
 * but uses an injected `fetchFn` (so we can mock upstream calls) and an
 * explicit rateLimiter (so we can reset between tests).
 */
function createHandler(fetchFn, rateLimiter) {
  return async function handleRequest(request, env) {
    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    if (request.method !== "POST") {
      return jsonError("Method not allowed", 405);
    }

    // Authenticate
    const proxyKey = request.headers.get("X-PeerZero-Proxy-Key");
    if (!proxyKey || !env.PROXY_AUTH_SECRET) {
      return jsonError("Missing proxy authentication", 401);
    }

    const expectedHash = await sha256(env.PROXY_AUTH_SECRET);
    const providedHash = await sha256(proxyKey);
    if (expectedHash !== providedHash) {
      return jsonError("Invalid proxy key", 401);
    }

    // Rate limit
    const keyHash = providedHash.slice(0, 16);
    if (rateLimiter.isRateLimited(keyHash)) {
      return jsonError("Rate limited", 429);
    }

    // Parse request
    const provider = (
      request.headers.get("X-LLM-Provider") || "anthropic"
    ).toLowerCase();
    const llmKey = request.headers.get("X-LLM-Key");
    if (!llmKey) {
      return jsonError("Missing X-LLM-Key header", 400);
    }

    const providerUrl = PROVIDER_URLS[provider];
    if (!providerUrl) {
      return jsonError(`Unsupported provider: ${provider}`, 400);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return jsonError("Invalid JSON body", 400);
    }

    // Inject preamble
    const preamble = env.IDENTITY_PREAMBLE;
    if (!preamble) {
      return jsonError("Proxy misconfigured: preamble not set", 500);
    }

    if (provider === "anthropic") {
      if (typeof body.system === "string") {
        body.system = preamble + "\n\n" + body.system;
      } else {
        body.system = preamble;
      }
    } else if (provider === "openai") {
      const messages = body.messages;
      if (messages && messages.length > 0 && messages[0].role === "system") {
        messages[0].content = preamble + "\n\n" + messages[0].content;
      } else if (messages) {
        messages.unshift({ role: "system", content: preamble });
      }
    }

    // Forward to LLM provider
    const headers = { "Content-Type": "application/json" };

    if (provider === "anthropic") {
      headers["x-api-key"] = llmKey;
      headers["anthropic-version"] = ANTHROPIC_VERSION;
      const beta = request.headers.get("anthropic-beta");
      if (beta) headers["anthropic-beta"] = beta;
    } else if (provider === "openai") {
      headers["Authorization"] = `Bearer ${llmKey}`;
    }

    try {
      const llmResponse = await fetchFn(providerUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });

      const responseHeaders = new Headers(corsHeaders());
      responseHeaders.set(
        "Content-Type",
        llmResponse.headers.get("Content-Type") || "application/json"
      );
      for (const h of [
        "retry-after",
        "x-ratelimit-limit",
        "x-ratelimit-remaining",
        "x-ratelimit-reset",
      ]) {
        const v = llmResponse.headers.get(h);
        if (v) responseHeaders.set(h, v);
      }

      return new Response(llmResponse.body, {
        status: llmResponse.status,
        headers: responseHeaders,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      return jsonError(`Proxy upstream error: ${msg}`, 502, {
        "X-Proxy-Error": "true",
      });
    }
  };
}

// ---------------------------------------------------------------------------
// Test utilities
// ---------------------------------------------------------------------------

const TEST_SECRET = "test-proxy-secret-key-2024";
const TEST_PREAMBLE = "You are an identity-activated PeerZero agent.";

function defaultEnv(overrides = {}) {
  return {
    PROXY_AUTH_SECRET: TEST_SECRET,
    IDENTITY_PREAMBLE: TEST_PREAMBLE,
    ...overrides,
  };
}

function makeRequest(method, headers = {}, body = null) {
  const url = "https://proxy.peerzero.dev/v1/messages";
  const opts = { method, headers: new Headers(headers) };
  if (body !== null) {
    // We need a Request whose .json() returns the body.
    // Node 18+ global Request supports body as string.
    return new Request(url, {
      ...opts,
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  }
  return new Request(url, opts);
}

function validHeaders(overrides = {}) {
  return {
    "X-PeerZero-Proxy-Key": TEST_SECRET,
    "X-LLM-Key": "sk-ant-test-key-123",
    "X-LLM-Provider": "anthropic",
    "Content-Type": "application/json",
    ...overrides,
  };
}

/** A mock fetch that returns a 200 with a simple JSON body. */
function mockFetchOk(capturedCalls) {
  return async function fakeFetch(url, init) {
    if (capturedCalls) capturedCalls.push({ url, init });
    return new Response(JSON.stringify({ id: "msg_test", content: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
}

async function parseJsonBody(response) {
  return response.json();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PeerZero LLM Proxy", () => {
  let rateLimiter;
  let handler;
  let fetchCalls;

  beforeEach(() => {
    rateLimiter = createRateLimiter(120, 60_000);
    fetchCalls = [];
    handler = createHandler(mockFetchOk(fetchCalls), rateLimiter);
  });

  // 1. CORS preflight
  describe("CORS preflight", () => {
    it("returns 204 with correct CORS headers on OPTIONS", async () => {
      const req = makeRequest("OPTIONS");
      const res = await handler(req, defaultEnv());

      assert.equal(res.status, 204);
      assert.equal(
        res.headers.get("Access-Control-Allow-Origin"),
        "*"
      );
      assert.equal(
        res.headers.get("Access-Control-Allow-Methods"),
        "POST, OPTIONS"
      );
      assert.ok(
        res.headers
          .get("Access-Control-Allow-Headers")
          .includes("X-PeerZero-Proxy-Key")
      );
    });
  });

  // 2. Non-POST methods
  describe("Method enforcement", () => {
    for (const method of ["GET", "PUT", "DELETE", "PATCH"]) {
      it(`returns 405 for ${method} requests`, async () => {
        const req = makeRequest(method);
        const res = await handler(req, defaultEnv());

        assert.equal(res.status, 405);
        const body = await parseJsonBody(res);
        assert.equal(body.error, "Method not allowed");
      });
    }
  });

  // 3. Missing proxy key
  describe("Authentication — missing key", () => {
    it("returns 401 when X-PeerZero-Proxy-Key header is absent", async () => {
      const req = makeRequest("POST", {
        "X-LLM-Key": "sk-test",
        "Content-Type": "application/json",
      }, { model: "test" });
      const res = await handler(req, defaultEnv());

      assert.equal(res.status, 401);
      const body = await parseJsonBody(res);
      assert.equal(body.error, "Missing proxy authentication");
    });

    it("returns 401 when PROXY_AUTH_SECRET is not configured", async () => {
      const req = makeRequest("POST", validHeaders(), { model: "test" });
      const res = await handler(req, defaultEnv({ PROXY_AUTH_SECRET: "" }));

      assert.equal(res.status, 401);
      const body = await parseJsonBody(res);
      assert.equal(body.error, "Missing proxy authentication");
    });
  });

  // 4. Invalid proxy key
  describe("Authentication — invalid key", () => {
    it("returns 401 when proxy key does not match secret", async () => {
      const req = makeRequest(
        "POST",
        validHeaders({ "X-PeerZero-Proxy-Key": "wrong-key" }),
        { model: "test" }
      );
      const res = await handler(req, defaultEnv());

      assert.equal(res.status, 401);
      const body = await parseJsonBody(res);
      assert.equal(body.error, "Invalid proxy key");
    });
  });

  // 5. Missing X-LLM-Key
  describe("Missing X-LLM-Key", () => {
    it("returns 400 when X-LLM-Key header is absent", async () => {
      const headers = validHeaders();
      delete headers["X-LLM-Key"];
      const req = makeRequest("POST", headers, { model: "test" });
      const res = await handler(req, defaultEnv());

      assert.equal(res.status, 400);
      const body = await parseJsonBody(res);
      assert.equal(body.error, "Missing X-LLM-Key header");
    });
  });

  // 6. Unsupported provider
  describe("Unsupported provider", () => {
    it("returns 400 for an unknown LLM provider", async () => {
      const req = makeRequest(
        "POST",
        validHeaders({ "X-LLM-Provider": "cohere" }),
        { model: "test" }
      );
      const res = await handler(req, defaultEnv());

      assert.equal(res.status, 400);
      const body = await parseJsonBody(res);
      assert.match(body.error, /Unsupported provider/);
      assert.match(body.error, /cohere/);
    });
  });

  // 7. Invalid JSON body
  describe("Invalid JSON body", () => {
    it("returns 400 when the body is not valid JSON", async () => {
      const req = makeRequest("POST", validHeaders(), "this is not json{{{");
      const res = await handler(req, defaultEnv());

      assert.equal(res.status, 400);
      const body = await parseJsonBody(res);
      assert.equal(body.error, "Invalid JSON body");
    });
  });

  // 8. Missing preamble (misconfigured)
  describe("Missing preamble", () => {
    it("returns 500 when IDENTITY_PREAMBLE is not set", async () => {
      const req = makeRequest("POST", validHeaders(), {
        model: "claude-opus-4-6",
        messages: [{ role: "user", content: "Hello" }],
      });
      const res = await handler(req, defaultEnv({ IDENTITY_PREAMBLE: "" }));

      assert.equal(res.status, 500);
      const body = await parseJsonBody(res);
      assert.equal(body.error, "Proxy misconfigured: preamble not set");
    });
  });

  // 9. Anthropic preamble injection
  describe("Anthropic preamble injection", () => {
    it("prepends preamble to existing system field", async () => {
      const originalSystem = "You are a helpful assistant.";
      const req = makeRequest("POST", validHeaders(), {
        model: "claude-opus-4-6",
        system: originalSystem,
        messages: [{ role: "user", content: "Hello" }],
      });
      const res = await handler(req, defaultEnv());

      assert.equal(res.status, 200);
      assert.equal(fetchCalls.length, 1);

      const sentBody = JSON.parse(fetchCalls[0].init.body);
      assert.equal(
        sentBody.system,
        TEST_PREAMBLE + "\n\n" + originalSystem
      );
    });

    it("sets preamble as system when no existing system field", async () => {
      const req = makeRequest("POST", validHeaders(), {
        model: "claude-opus-4-6",
        messages: [{ role: "user", content: "Hello" }],
      });
      const res = await handler(req, defaultEnv());

      assert.equal(res.status, 200);
      const sentBody = JSON.parse(fetchCalls[0].init.body);
      assert.equal(sentBody.system, TEST_PREAMBLE);
    });

    it("sends correct Anthropic headers including api key and version", async () => {
      const req = makeRequest("POST", validHeaders(), {
        model: "claude-opus-4-6",
        messages: [{ role: "user", content: "Hello" }],
      });
      await handler(req, defaultEnv());

      const sentHeaders = fetchCalls[0].init.headers;
      assert.equal(sentHeaders["x-api-key"], "sk-ant-test-key-123");
      assert.equal(sentHeaders["anthropic-version"], "2023-06-01");
    });

    it("passes through anthropic-beta header when present", async () => {
      const req = makeRequest(
        "POST",
        validHeaders({ "anthropic-beta": "messages-2024-04-04" }),
        {
          model: "claude-opus-4-6",
          messages: [{ role: "user", content: "Hello" }],
        }
      );
      await handler(req, defaultEnv());

      const sentHeaders = fetchCalls[0].init.headers;
      assert.equal(sentHeaders["anthropic-beta"], "messages-2024-04-04");
    });

    it("forwards to the correct Anthropic URL", async () => {
      const req = makeRequest("POST", validHeaders(), {
        model: "claude-opus-4-6",
        messages: [{ role: "user", content: "Hello" }],
      });
      await handler(req, defaultEnv());

      assert.equal(
        fetchCalls[0].url,
        "https://api.anthropic.com/v1/messages"
      );
    });
  });

  // 10. OpenAI preamble injection — prepend to existing system message
  describe("OpenAI preamble injection", () => {
    it("prepends preamble to existing system message", async () => {
      const originalContent = "You are a coding assistant.";
      const req = makeRequest(
        "POST",
        validHeaders({ "X-LLM-Provider": "openai" }),
        {
          model: "gpt-4",
          messages: [
            { role: "system", content: originalContent },
            { role: "user", content: "Hello" },
          ],
        }
      );
      const res = await handler(req, defaultEnv());

      assert.equal(res.status, 200);
      const sentBody = JSON.parse(fetchCalls[0].init.body);
      assert.equal(sentBody.messages.length, 2);
      assert.equal(sentBody.messages[0].role, "system");
      assert.equal(
        sentBody.messages[0].content,
        TEST_PREAMBLE + "\n\n" + originalContent
      );
    });

    // 11. OpenAI preamble injection — insert when no system message exists
    it("inserts system message when none exists", async () => {
      const req = makeRequest(
        "POST",
        validHeaders({ "X-LLM-Provider": "openai" }),
        {
          model: "gpt-4",
          messages: [{ role: "user", content: "Hello" }],
        }
      );
      const res = await handler(req, defaultEnv());

      assert.equal(res.status, 200);
      const sentBody = JSON.parse(fetchCalls[0].init.body);
      assert.equal(sentBody.messages.length, 2);
      assert.equal(sentBody.messages[0].role, "system");
      assert.equal(sentBody.messages[0].content, TEST_PREAMBLE);
      assert.equal(sentBody.messages[1].role, "user");
      assert.equal(sentBody.messages[1].content, "Hello");
    });

    it("sends correct OpenAI headers with Bearer token", async () => {
      const req = makeRequest(
        "POST",
        validHeaders({
          "X-LLM-Provider": "openai",
          "X-LLM-Key": "sk-openai-test-key",
        }),
        {
          model: "gpt-4",
          messages: [{ role: "user", content: "Hello" }],
        }
      );
      await handler(req, defaultEnv());

      const sentHeaders = fetchCalls[0].init.headers;
      assert.equal(sentHeaders["Authorization"], "Bearer sk-openai-test-key");
      assert.equal(sentHeaders["x-api-key"], undefined);
    });

    it("forwards to the correct OpenAI URL", async () => {
      const req = makeRequest(
        "POST",
        validHeaders({ "X-LLM-Provider": "openai" }),
        {
          model: "gpt-4",
          messages: [{ role: "user", content: "Hello" }],
        }
      );
      await handler(req, defaultEnv());

      assert.equal(
        fetchCalls[0].url,
        "https://api.openai.com/v1/chat/completions"
      );
    });
  });

  // 12. Rate limiting
  describe("Rate limiting", () => {
    it("allows up to 120 requests then blocks the 121st", async () => {
      const env = defaultEnv();

      // Fire 120 requests — all should succeed
      for (let i = 0; i < 120; i++) {
        const req = makeRequest("POST", validHeaders(), {
          model: "claude-opus-4-6",
          messages: [{ role: "user", content: "Hello" }],
        });
        const res = await handler(req, env);
        assert.equal(res.status, 200, `Request ${i + 1} should succeed`);
      }

      // The 121st should be rate-limited
      const req = makeRequest("POST", validHeaders(), {
        model: "claude-opus-4-6",
        messages: [{ role: "user", content: "Hello" }],
      });
      const res = await handler(req, env);
      assert.equal(res.status, 429);
      const body = await parseJsonBody(res);
      assert.equal(body.error, "Rate limited");
    });

    it("resets after the time window expires", async () => {
      // Manually manipulate the rate limiter to simulate window expiry
      const keyHash = (await sha256(TEST_SECRET)).slice(0, 16);

      // Set the entry to be already expired
      rateLimiter._map.set(keyHash, { count: 999, resetAt: Date.now() - 1 });

      const req = makeRequest("POST", validHeaders(), {
        model: "claude-opus-4-6",
        messages: [{ role: "user", content: "Hello" }],
      });
      const res = await handler(req, defaultEnv());
      assert.equal(res.status, 200);
    });
  });

  // Additional edge cases
  describe("Upstream error handling", () => {
    it("returns 502 when the upstream fetch throws", async () => {
      const failHandler = createHandler(async () => {
        throw new Error("Connection refused");
      }, rateLimiter);

      const req = makeRequest("POST", validHeaders(), {
        model: "claude-opus-4-6",
        messages: [{ role: "user", content: "Hello" }],
      });
      const res = await failHandler(req, defaultEnv());

      assert.equal(res.status, 502);
      const body = await parseJsonBody(res);
      assert.match(body.error, /Proxy upstream error/);
      assert.match(body.error, /Connection refused/);
      assert.equal(res.headers.get("X-Proxy-Error"), "true");
    });
  });

  describe("Response streaming", () => {
    it("passes through upstream status code and content-type", async () => {
      const customFetch = async () =>
        new Response('data: {"text":"hi"}', {
          status: 200,
          headers: {
            "Content-Type": "text/event-stream",
            "x-ratelimit-remaining": "42",
          },
        });

      const streamHandler = createHandler(customFetch, rateLimiter);
      const req = makeRequest("POST", validHeaders(), {
        model: "claude-opus-4-6",
        messages: [{ role: "user", content: "Hello" }],
      });
      const res = await streamHandler(req, defaultEnv());

      assert.equal(res.status, 200);
      assert.equal(res.headers.get("Content-Type"), "text/event-stream");
      assert.equal(res.headers.get("x-ratelimit-remaining"), "42");
      // CORS headers should also be present on the forwarded response
      assert.equal(res.headers.get("Access-Control-Allow-Origin"), "*");
    });

    it("passes through non-200 status from upstream", async () => {
      const customFetch = async () =>
        new Response(JSON.stringify({ error: "overloaded" }), {
          status: 529,
          headers: {
            "Content-Type": "application/json",
            "retry-after": "30",
          },
        });

      const streamHandler = createHandler(customFetch, rateLimiter);
      const req = makeRequest("POST", validHeaders(), {
        model: "claude-opus-4-6",
        messages: [{ role: "user", content: "Hello" }],
      });
      const res = await streamHandler(req, defaultEnv());

      assert.equal(res.status, 529);
      assert.equal(res.headers.get("retry-after"), "30");
    });
  });

  describe("Default provider", () => {
    it("defaults to anthropic when X-LLM-Provider is not set", async () => {
      const headers = validHeaders();
      delete headers["X-LLM-Provider"];
      const req = makeRequest("POST", headers, {
        model: "claude-opus-4-6",
        messages: [{ role: "user", content: "Hello" }],
      });
      await handler(req, defaultEnv());

      assert.equal(
        fetchCalls[0].url,
        "https://api.anthropic.com/v1/messages"
      );
    });
  });

  describe("CORS headers on error responses", () => {
    it("includes CORS headers on 401 responses", async () => {
      const req = makeRequest("POST", {
        "X-PeerZero-Proxy-Key": "wrong",
        "X-LLM-Key": "sk-test",
        "Content-Type": "application/json",
      }, { model: "test" });
      const res = await handler(req, defaultEnv());

      assert.equal(res.status, 401);
      assert.equal(res.headers.get("Access-Control-Allow-Origin"), "*");
    });

    it("includes CORS headers on 400 responses", async () => {
      const req = makeRequest("POST", validHeaders(), "not json");
      const res = await handler(req, defaultEnv());

      assert.equal(res.status, 400);
      assert.equal(res.headers.get("Access-Control-Allow-Origin"), "*");
    });
  });

  describe("SHA-256 hashing", () => {
    it("produces consistent hex output", async () => {
      const h1 = await sha256("test");
      const h2 = await sha256("test");
      assert.equal(h1, h2);
      // Known SHA-256 of "test"
      assert.equal(
        h1,
        "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"
      );
      assert.equal(h1.length, 64);
    });

    it("different inputs produce different hashes", async () => {
      const h1 = await sha256("secret-a");
      const h2 = await sha256("secret-b");
      assert.notEqual(h1, h2);
    });
  });
});
