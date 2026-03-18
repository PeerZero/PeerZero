// =============================================================================
// LLM adapter interface — abstracts away the LLM provider (Anthropic, OpenAI)
// The bot runtime calls this; it never imports provider SDKs directly.
// =============================================================================

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** Tool definition for structured LLM output (Anthropic tool_use / OpenAI function calling). */
export interface LLMTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;  // JSON Schema
}

/** A tool call returned by the LLM. */
export interface LLMToolCall {
  name: string;
  input: Record<string, unknown>;  // Already-parsed structured data
}

export interface LLMResponse {
  content: string;
  tokens_used: number;
  model: string;
  stop_reason: string;
  /** Populated when the LLM invokes a tool instead of returning text. */
  tool_calls?: LLMToolCall[];
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
      extendedThinking?: boolean;
      /** When provided, the LLM can return structured tool calls instead of raw text. */
      tools?: LLMTool[];
    },
  ): Promise<LLMResponse>;
}
