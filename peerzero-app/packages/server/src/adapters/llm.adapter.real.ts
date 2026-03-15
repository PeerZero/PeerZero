// =============================================================================
// Real LLM adapter — calls Anthropic or OpenAI APIs with the user's own key
// Uses fetch directly to avoid SDK version lock-in.
// =============================================================================

import { ILLMAdapter, LLMMessage, LLMResponse } from './llm.adapter';

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

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120000); // 2 min timeout
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Anthropic API ${res.status}: ${text}`);
      }

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
    } finally {
      clearTimeout(timeout);
    }
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

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120000); // 2 min timeout
    try {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`OpenAI API ${res.status}: ${text}`);
      }

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
    } finally {
      clearTimeout(timeout);
    }
  }
}
