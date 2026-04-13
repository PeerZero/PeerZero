// =============================================================================
// A2A (Agent-to-Agent) platform adapter — communicates via Agent Card protocol
//
// Uses the A2A pattern: discover the remote agent card at a well-known URL,
// then POST actions to the agent's task endpoint.
// Same fetch-based approach as RealSchoolAdapter / RealLLMAdapter.
// =============================================================================

import type {
  IPlatformAdapter,
  PlatformCredentials,
  PlatformCapabilities,
  PlatformContext,
  PlatformAction,
  PlatformResult,
  AgentCard,
} from './platform.adapter';
import { logger } from '../lib/logger';
import { validateExternalUrl } from '../lib/url-validation';

const REQUEST_TIMEOUT_MS = 30_000;

/** Make an authenticated fetch to an A2A platform endpoint. */
async function a2aFetch<T>(
  baseUrl: string,
  path: string,
  apiKey: string,
  options: RequestInit = {},
): Promise<T> {
  const url = `${baseUrl}${path}`;
  validateExternalUrl(url);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        ...(options.headers as Record<string, string> || {}),
      },
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`A2A platform ${res.status}: ${body}`);
    }

    return res.json() as Promise<T>;
  } finally {
    clearTimeout(timeout);
  }
}

/** Resolve the base URL from platform credentials config. */
function getBaseUrl(creds: PlatformCredentials): string {
  const baseUrl = creds.config.base_url as string | undefined;
  if (!baseUrl) {
    throw new Error(`A2A adapter requires base_url in platform config for ${creds.platformName}`);
  }
  return baseUrl.replace(/\/+$/, ''); // strip trailing slashes
}

export class A2APlatformAdapter implements IPlatformAdapter {
  async discover(creds: PlatformCredentials): Promise<PlatformCapabilities> {
    const baseUrl = getBaseUrl(creds);
    const agentCardUrl = (creds.config.agent_card_url as string) || '/.well-known/agent-card.json';

    logger.debug({ platform: creds.platformName, baseUrl }, 'A2A discover');

    try {
      const card = await a2aFetch<AgentCard>(baseUrl, agentCardUrl, creds.apiKey);

      // Map agent card capabilities to our PlatformCapabilities shape
      const caps = card.capabilities || {};
      return {
        can_post: Boolean(caps.post ?? caps.publish ?? true),
        can_comment: Boolean(caps.comment ?? caps.reply ?? true),
        can_vote: Boolean(caps.vote ?? false),
        can_debate: Boolean(caps.debate ?? false),
        content_types: (caps.content_types as string[]) || ['text', 'markdown'],
        rate_limit: (caps.rate_limit as number) || null,
      };
    } catch (err) {
      logger.error({ platform: creds.platformName, err }, 'A2A discover failed, returning restrictive defaults');
      // Fallback capabilities — fail closed: deny all actions until discovery succeeds
      return {
        can_post: false,
        can_comment: false,
        can_vote: false,
        can_debate: false,
        content_types: ['text'],
        rate_limit: null,
      };
    }
  }

  async getContext(creds: PlatformCredentials): Promise<PlatformContext> {
    const baseUrl = getBaseUrl(creds);

    logger.debug({ platform: creds.platformName }, 'A2A getContext');

    try {
      const context = await a2aFetch<{
        topics?: string[];
        available_topics?: string[];
        recent_activity?: string[];
        pending?: string[];
        pending_interactions?: string[];
        summary?: string;
      }>(baseUrl, '/api/context', creds.apiKey);

      return {
        available_topics: context.available_topics || context.topics || [],
        recent_activity: context.recent_activity || [],
        pending_interactions: context.pending_interactions || context.pending || [],
        summary: context.summary || `Context from ${creds.platformName}`,
      };
    } catch (err) {
      logger.warn({ platform: creds.platformName, err }, 'A2A getContext failed');
      return {
        available_topics: [],
        recent_activity: [],
        pending_interactions: [],
        summary: `Unable to fetch context from ${creds.platformName}`,
      };
    }
  }

  async submitAction(creds: PlatformCredentials, action: PlatformAction): Promise<PlatformResult> {
    const baseUrl = getBaseUrl(creds);

    logger.info({ platform: creds.platformName, action: action.action_type }, 'A2A submitAction');

    const result = await a2aFetch<{
      success?: boolean;
      id?: string;
      response_data?: Record<string, unknown>;
      error?: string;
      skills_demonstrated?: string[];
    }>(baseUrl, '/api/actions', creds.apiKey, {
      method: 'POST',
      body: JSON.stringify({
        action_type: action.action_type,
        content: action.content,
        target_id: action.target_id,
        reasoning: action.reasoning,
      }),
    });

    return {
      success: result.success !== false,
      action_type: action.action_type,
      platform_name: creds.platformName,
      response_data: result.response_data || { id: result.id },
      error: result.error,
      summary: `${action.action_type} submitted to ${creds.platformName} via A2A`,
      skills_demonstrated: result.skills_demonstrated || [],
    };
  }

  async publishAgentCard(creds: PlatformCredentials, card: AgentCard): Promise<void> {
    const baseUrl = getBaseUrl(creds);

    logger.info({ platform: creds.platformName }, 'A2A publishAgentCard');

    await a2aFetch<void>(baseUrl, '/api/agent-card', creds.apiKey, {
      method: 'PUT',
      body: JSON.stringify(card),
    });
  }
}
