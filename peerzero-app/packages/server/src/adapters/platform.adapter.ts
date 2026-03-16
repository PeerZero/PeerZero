// =============================================================================
// Platform adapter interface — mirrors peerzero-bot's IPlatformAdapter
// Same pattern as ISchoolAdapter: interface defines the contract,
// mock returns canned data for dev, real hits actual platform APIs.
// =============================================================================

/** Credentials + config for a platform connection. */
export interface PlatformCredentials {
  apiKey: string;
  config: Record<string, unknown>;
  platformName: string;
}

/** What the platform supports. */
export interface PlatformCapabilities {
  can_post: boolean;
  can_comment: boolean;
  can_vote: boolean;
  can_debate: boolean;
  content_types: string[];
  rate_limit: number | null;
}

/** Current state from the platform. */
export interface PlatformContext {
  available_topics: string[];
  recent_activity: string[];
  pending_interactions: string[];
  summary: string;
}

/** An action the bot wants to take. */
export interface PlatformAction {
  action_type: string;
  content: Record<string, unknown>;
  target_id?: string;
  reasoning?: string;
}

/** Result of an action. */
export interface PlatformResult {
  success: boolean;
  action_type: string;
  platform_name: string;
  response_data: Record<string, unknown>;
  error?: string;
  summary: string;
  skills_demonstrated: string[];
}

/** A2A-compatible Agent Card. */
export interface AgentCard {
  name: string;
  description: string;
  capabilities: Record<string, unknown>;
  skills: Array<{ id: string; name: string; description: string }>;
  extensions?: Record<string, unknown>;
}

/**
 * All platform operations. Each method maps to one platform interaction.
 * When real platforms come online, implement this interface per platform.
 * For now, MockPlatformAdapter returns sensible canned data.
 */
export interface IPlatformAdapter {
  /** Discover what the platform supports. */
  discover(creds: PlatformCredentials): Promise<PlatformCapabilities>;

  /** Fetch current state from the platform. */
  getContext(creds: PlatformCredentials): Promise<PlatformContext>;

  /** Submit an action to the platform. */
  submitAction(creds: PlatformCredentials, action: PlatformAction): Promise<PlatformResult>;

  /** Publish this bot's Agent Card to the platform. */
  publishAgentCard(creds: PlatformCredentials, card: AgentCard): Promise<void>;
}
