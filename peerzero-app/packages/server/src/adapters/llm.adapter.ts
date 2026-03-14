// =============================================================================
// LLM adapter interface — abstracts away the LLM provider (Anthropic, OpenAI)
// The bot runtime calls this; it never imports provider SDKs directly.
// =============================================================================

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LLMResponse {
  content: string;
  tokens_used: number;
  model: string;
  stop_reason: string;
}

export interface ILLMAdapter {
  /**
   * Send a conversation to the LLM and get a response.
   * The adapter handles provider-specific formatting (Anthropic system prompt vs OpenAI system message, etc.)
   */
  chat(
    apiKey: string,
    model: string,
    messages: LLMMessage[],
    options?: {
      maxTokens?: number;
      temperature?: number;
      jsonMode?: boolean;
    },
  ): Promise<LLMResponse>;
}
