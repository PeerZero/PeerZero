/**
 * Mock LLM Server — standalone HTTP server that mimics Anthropic/OpenAI APIs
 * for realistic load testing without real API calls or costs.
 *
 * Features:
 *   - Configurable latency (fixed or range)
 *   - Configurable failure rate and failure types (429, 500, timeout)
 *   - Supports both Anthropic and OpenAI response formats
 *   - Request counting and metrics endpoint
 *
 * Usage:
 *   npx tsx src/__tests__/load/mock-llm-server.ts                    # defaults
 *   MOCK_LLM_PORT=9100 MOCK_LLM_LATENCY=200 npx tsx ...             # custom
 *   MOCK_LLM_FAILURE_RATE=0.1 MOCK_LLM_FAILURE_TYPE=429 npx tsx ... # inject errors
 *
 * Endpoints:
 *   POST /v1/messages            — Anthropic-style completions
 *   POST /v1/chat/completions    — OpenAI-style completions
 *   GET  /metrics                — Request counts, latency stats
 *   POST /config                 — Update latency/failure settings at runtime
 *   POST /reset                  — Reset metrics counters
 */

import http from 'http';

// ── Configuration ───────────────────────────────────────────────────────────

interface ServerConfig {
  port: number;
  latencyMinMs: number;
  latencyMaxMs: number;
  failureRate: number;        // 0.0–1.0
  failureType: 'timeout' | '429' | '500' | 'mixed';
  timeoutMs: number;          // how long to hang on timeout failures
}

const config: ServerConfig = {
  port: parseInt(process.env.MOCK_LLM_PORT || '9100', 10),
  latencyMinMs: parseInt(process.env.MOCK_LLM_LATENCY_MIN || process.env.MOCK_LLM_LATENCY || '50', 10),
  latencyMaxMs: parseInt(process.env.MOCK_LLM_LATENCY_MAX || process.env.MOCK_LLM_LATENCY || '150', 10),
  failureRate: parseFloat(process.env.MOCK_LLM_FAILURE_RATE || '0'),
  failureType: (process.env.MOCK_LLM_FAILURE_TYPE as ServerConfig['failureType']) || 'mixed',
  timeoutMs: parseInt(process.env.MOCK_LLM_TIMEOUT_MS || '30000', 10),
};

// ── Metrics ─────────────────────────────────────────────────────────────────

interface Metrics {
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  timedOutRequests: number;
  rateLimitedRequests: number;
  serverErrorRequests: number;
  durations: number[];
  startTime: number;
}

let metrics: Metrics = {
  totalRequests: 0,
  successfulRequests: 0,
  failedRequests: 0,
  timedOutRequests: 0,
  rateLimitedRequests: 0,
  serverErrorRequests: 0,
  durations: [],
  startTime: Date.now(),
};

function resetMetrics(): void {
  metrics = {
    totalRequests: 0,
    successfulRequests: 0,
    failedRequests: 0,
    timedOutRequests: 0,
    rateLimitedRequests: 0,
    serverErrorRequests: 0,
    durations: [],
    startTime: Date.now(),
  };
}

function percentile(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

// ── Mock Responses ──────────────────────────────────────────────────────────

const MOCK_CONTENT = JSON.stringify({
  overall_assessment: 'Solid methodology with minor statistical issues.',
  score: 72,
  strengths: ['Clear hypothesis', 'Good sample size'],
  weaknesses: ['Insufficient controls'],
  methodology_critique: 'The approach is sound but could benefit from additional controls.',
  confidence: 0.8,
});

function anthropicResponse(model: string): object {
  return {
    id: `msg_mock_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: MOCK_CONTENT }],
    model,
    stop_reason: 'end_turn',
    usage: { input_tokens: 500, output_tokens: 800 },
  };
}

function openaiResponse(model: string): object {
  return {
    id: `chatcmpl-mock-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message: { role: 'assistant', content: MOCK_CONTENT },
      finish_reason: 'stop',
    }],
    usage: { prompt_tokens: 500, completion_tokens: 800, total_tokens: 1300 },
  };
}

// ── Latency Simulation ──────────────────────────────────────────────────────

function randomLatency(): number {
  return config.latencyMinMs + Math.random() * (config.latencyMaxMs - config.latencyMinMs);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Failure Injection ───────────────────────────────────────────────────────

function shouldFail(): boolean {
  return Math.random() < config.failureRate;
}

function pickFailureType(): 'timeout' | '429' | '500' {
  if (config.failureType !== 'mixed') return config.failureType as 'timeout' | '429' | '500';
  const r = Math.random();
  if (r < 0.33) return 'timeout';
  if (r < 0.66) return '429';
  return '500';
}

// ── Request Handling ────────────────────────────────────────────────────────

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

function json(res: http.ServerResponse, status: number, body: object): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(data),
  });
  res.end(data);
}

async function handleCompletionRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  format: 'anthropic' | 'openai',
): Promise<void> {
  const startTime = Date.now();
  metrics.totalRequests++;

  // Parse request body to get model
  const raw = await readBody(req);
  let model = 'mock-model';
  try {
    const body = JSON.parse(raw);
    model = body.model || model;
  } catch { /* ignore parse errors */ }

  // Check for failure injection
  if (shouldFail()) {
    const failType = pickFailureType();
    metrics.failedRequests++;

    switch (failType) {
      case 'timeout':
        metrics.timedOutRequests++;
        // Hang until client gives up
        await sleep(config.timeoutMs);
        if (!res.writableEnded) {
          json(res, 504, { error: { message: 'Gateway timeout (mock)' } });
        }
        return;

      case '429':
        metrics.rateLimitedRequests++;
        res.setHeader('Retry-After', '2');
        json(res, 429, {
          error: { type: 'rate_limit_error', message: 'Rate limit exceeded (mock)' },
        });
        metrics.durations.push(Date.now() - startTime);
        return;

      case '500':
        metrics.serverErrorRequests++;
        json(res, 500, {
          error: { type: 'server_error', message: 'Internal server error (mock)' },
        });
        metrics.durations.push(Date.now() - startTime);
        return;
    }
  }

  // Simulate latency
  await sleep(randomLatency());

  // Respond with format-appropriate mock
  const responseBody = format === 'anthropic'
    ? anthropicResponse(model)
    : openaiResponse(model);

  json(res, 200, responseBody);
  metrics.successfulRequests++;
  metrics.durations.push(Date.now() - startTime);
}

// ── Server ──────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const url = req.url || '';
  const method = req.method || 'GET';

  try {
    // Anthropic-style endpoint
    if (method === 'POST' && url === '/v1/messages') {
      await handleCompletionRequest(req, res, 'anthropic');
      return;
    }

    // OpenAI-style endpoint
    if (method === 'POST' && url === '/v1/chat/completions') {
      await handleCompletionRequest(req, res, 'openai');
      return;
    }

    // Metrics endpoint
    if (method === 'GET' && url === '/metrics') {
      const elapsed = Date.now() - metrics.startTime;
      const summary = {
        uptime_ms: elapsed,
        config: {
          latency: `${config.latencyMinMs}-${config.latencyMaxMs}ms`,
          failure_rate: config.failureRate,
          failure_type: config.failureType,
        },
        requests: {
          total: metrics.totalRequests,
          successful: metrics.successfulRequests,
          failed: metrics.failedRequests,
          timed_out: metrics.timedOutRequests,
          rate_limited: metrics.rateLimitedRequests,
          server_errors: metrics.serverErrorRequests,
        },
        latency: {
          p50: Math.round(percentile(metrics.durations, 50)),
          p95: Math.round(percentile(metrics.durations, 95)),
          p99: Math.round(percentile(metrics.durations, 99)),
          avg: metrics.durations.length > 0
            ? Math.round(metrics.durations.reduce((a, b) => a + b, 0) / metrics.durations.length)
            : 0,
        },
        throughput: elapsed > 0
          ? `${(metrics.successfulRequests / (elapsed / 1000)).toFixed(2)} req/sec`
          : '0 req/sec',
      };
      json(res, 200, summary);
      return;
    }

    // Runtime config update
    if (method === 'POST' && url === '/config') {
      const raw = await readBody(req);
      try {
        const update = JSON.parse(raw);
        if (update.latencyMinMs !== undefined) config.latencyMinMs = update.latencyMinMs;
        if (update.latencyMaxMs !== undefined) config.latencyMaxMs = update.latencyMaxMs;
        if (update.failureRate !== undefined) config.failureRate = update.failureRate;
        if (update.failureType !== undefined) config.failureType = update.failureType;
        if (update.timeoutMs !== undefined) config.timeoutMs = update.timeoutMs;
        json(res, 200, { updated: true, config });
      } catch {
        json(res, 400, { error: 'Invalid JSON' });
      }
      return;
    }

    // Reset metrics
    if (method === 'POST' && url === '/reset') {
      resetMetrics();
      json(res, 200, { reset: true });
      return;
    }

    // Health check
    if (method === 'GET' && (url === '/health' || url === '/')) {
      json(res, 200, { status: 'ok', mock: true });
      return;
    }

    json(res, 404, { error: 'Not found' });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    json(res, 500, { error: msg });
  }
});

server.listen(config.port, () => {
  console.log(`Mock LLM server listening on :${config.port}`);
  console.log(`  Latency: ${config.latencyMinMs}-${config.latencyMaxMs}ms`);
  console.log(`  Failure rate: ${(config.failureRate * 100).toFixed(1)}%`);
  console.log(`  Failure type: ${config.failureType}`);
  console.log('');
  console.log('Endpoints:');
  console.log(`  POST http://localhost:${config.port}/v1/messages           (Anthropic)`);
  console.log(`  POST http://localhost:${config.port}/v1/chat/completions   (OpenAI)`);
  console.log(`  GET  http://localhost:${config.port}/metrics`);
  console.log(`  POST http://localhost:${config.port}/config                (runtime update)`);
  console.log(`  POST http://localhost:${config.port}/reset                 (reset counters)`);
});

// Graceful shutdown
process.on('SIGTERM', () => { server.close(); process.exit(0); });
process.on('SIGINT', () => { server.close(); process.exit(0); });
