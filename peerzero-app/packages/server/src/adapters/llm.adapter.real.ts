// =============================================================================
// Real LLM adapter — calls Anthropic or OpenAI APIs with the user's own key
// Uses fetch directly to avoid SDK version lock-in.
// Retries on transient errors (429, 5xx) with exponential backoff + jitter.
// =============================================================================

import { ILLMAdapter, LLMMessage, LLMResponse } from './llm.adapter';
import { logger } from '../lib/logger';

const MAX_RETRIES = 2;             // 3 attempts total (1 initial + 2 retries)
const BASE_DELAY_MS = 2000;        // First retry after ~2s, second after ~8s

/** Returns true for HTTP status codes that are transient and worth retrying. */
function isRetryable(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

/** Sleep with jitter to avoid thundering herd. */
function sleepWithJitter(baseMs: number): Promise<void> {
  const jitter = Math.random() * baseMs * 0.5; // 0-50% jitter
  return new Promise(resolve => setTimeout(resolve, baseMs + jitter));
}

export class RealLLMAdapter implements ILLMAdapter {
  async chat(
    apiKey: string,
    model: string,
    messages: LLMMessage[],
    options?: { maxTokens?: number; temperature?: number; jsonMode?: boolean },
  ): Promise<LLMResponse> {
    // Detect provider from model name
    const isAnthropic = model.startsWith('claude');
    return isAnthropic
      ? this.callAnthropic(apiKey, model, messages, options)
      : this.callOpenAI(apiKey, model, messages, options);
  }

  private async callAnthropic(
    apiKey: string,
    model: string,
    messages: LLMMessage[],
    options?: { maxTokens?: number; temperature?: number },
  ): Promise<LLMResponse> {
    // Anthropic uses a separate system param, not a system message in the array
    const systemMsg = messages.find(m => m.role === 'system');
    const conversationMessages = messages
      .filter(m => m.role !== 'system')
      .map(m => ({ role: m.role, content: m.content }));

    const body: Record<string, unknown> = {
      model,
      max_tokens: options?.maxTokens || 4096,
      messages: conversationMessages,
    };
    if (systemMsg) body.system = systemMsg.content;
    if (options?.temperature !== undefined) body.temperature = options.temperature;

    const makeRequest = async (): Promise<Response> => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 120000); // 2 min timeout
      try {
        return await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeout);
      }
    };

    const res = await this.fetchWithRetry(makeRequest, 'Anthropic');

    const data = await res.json() as {
      content: Array<{ type: string; text: string }>;
      usage: { input_tokens: number; output_tokens: number };
      model: string;
      stop_reason: string;
    };

    if (!Array.isArray(data.content)) {
      throw new Error('Anthropic API returned invalid response: content is not an array');
    }

    const textBlock = data.content.find((c: { type: string }) => c.type === 'text');
    return {
      content: textBlock?.text || '',
      tokens_used: data.usage.input_tokens + data.usage.output_tokens,
      model: data.model,
      stop_reason: data.stop_reason,
    };
  }

  private async callOpenAI(
    apiKey: string,
    model: string,
    messages: LLMMessage[],
    options?: { maxTokens?: number; temperature?: number; jsonMode?: boolean },
  ): Promise<LLMResponse> {
    const body: Record<string, unknown> = {
      model,
      messages: messages.map(m => ({ role: m.role, content: m.content })),
      max_tokens: options?.maxTokens || 4096,
    };
    if (options?.temperature !== undefined) body.temperature = options.temperature;
    if (options?.jsonMode) body.response_format = { type: 'json_object' };

    const makeRequest = async (): Promise<Response> => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 120000); // 2 min timeout
      try {
        return await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeout);
      }
    };

    const res = await this.fetchWithRetry(makeRequest, 'OpenAI');

    const data = await res.json() as {
      choices: Array<{ message: { content: string }; finish_reason: string }>;
      usage: { total_tokens: number };
      model: string;
    };

    return {
      content: data.choices[0]?.message?.content || '',
      tokens_used: data.usage.total_tokens,
      model: data.model,
      stop_reason: data.choices[0]?.finish_reason || 'stop',
    };
  }

  /**
   * Retry wrapper for LLM API calls.
   * - Retries on 429 (rate limit) and 5xx (server errors) with exponential backoff + jitter
   * - Fails immediately on 400 (bad request), 401 (bad key), 403 (no access)
   * - Returns the successful Response for the caller to parse
   */
  private async fetchWithRetry(
    makeRequest: () => Promise<Response>,
    provider: string,
  ): Promise<Response> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const res = await makeRequest();

        if (res.ok) return res;

        // Non-retryable error — fail immediately
        if (!isRetryable(res.status)) {
          const text = await res.text();
          throw new Error(`${provider} API ${res.status}: ${text}`);
        }

        // Retryable error — log and retry (unless this was the last attempt)
        const text = await res.text();
        lastError = new Error(`${provider} API ${res.status}: ${text}`);

        if (attempt < MAX_RETRIES) {
          const delay = BASE_DELAY_MS * Math.pow(4, attempt); // 2s, 8s
          logger.warn({ provider, status: res.status, attempt: attempt + 1, maxRetries: MAX_RETRIES }, 'Retryable LLM error, backing off');
          await sleepWithJitter(delay);
        }
      } catch (err) {
        // Network error or abort — treat as retryable
        if (err instanceof Error && err.message.includes(`${provider} API`)) {
          // This is our own thrown error from a non-retryable status — re-throw immediately
          throw err;
        }

        lastError = err instanceof Error ? err : new Error(String(err));

        if (attempt < MAX_RETRIES) {
          const delay = BASE_DELAY_MS * Math.pow(4, attempt);
          logger.warn({ provider, err: lastError.message, attempt: attempt + 1, maxRetries: MAX_RETRIES }, 'LLM request failed, retrying');
          await sleepWithJitter(delay);
        }
      }
    }

    throw lastError || new Error(`${provider} API failed after ${MAX_RETRIES + 1} attempts`);
  }
}
