// =============================================================================
// Webhook platform adapter — communicates via REST API / webhooks
//
// For platforms that expose a standard REST API rather than the A2A agent card
// protocol. Config must include a base_url. Actions are POSTed to platform-
// specific endpoints derived from the action type.
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

/** Make an authenticated fetch to a webhook-based platform endpoint. */
async function webhookFetch<T>(
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
        'x-api-key': apiKey,
        ...(options.headers as Record<string, string> || {}),
      },
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Webhook platform ${res.status}: ${body}`);
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
    throw new Error(`Webhook adapter requires base_url in platform config for ${creds.platformName}`);
  }
  return baseUrl.replace(/\/+$/, '');
}

export class WebhookPlatformAdapter implements IPlatformAdapter {
  async discover(creds: PlatformCredentials): Promise<PlatformCapabilities> {
    const baseUrl = getBaseUrl(creds);

    logger.debug({ platform: creds.platformName, baseUrl }, 'Webhook discover');

    try {
      const info = await webhookFetch<{
        capabilities?: Record<string, unknown>;
        events?: string[];
        rate_limit?: number;
      }>(baseUrl, '/api/info', creds.apiKey);

      // Derive capabilities from the platform's supported events
      const events = info.events || (creds.config.events as string[]) || [];
      const caps = info.capabilities || {};

      return {
        can_post: events.includes('post') || Boolean(caps.post),
        can_comment: events.includes('comment') || Boolean(caps.comment),
        can_vote: events.includes('vote') || Boolean(caps.vote),
        can_debate: events.includes('debate') || Boolean(caps.debate),
        content_types: (caps.content_types as string[]) || ['text'],
        rate_limit: info.rate_limit || (caps.rate_limit as number) || null,
      };
    } catch (err) {
      logger.warn({ platform: creds.platformName, err }, 'Webhook discover failed, using config events');
      // Fall back to events from the stored config (from platform_registry.default_config)
      const events = (creds.config.events as string[]) || [];
      return {
        can_post: events.includes('post'),
        can_comment: events.includes('comment'),
        can_vote: events.includes('vote'),
        can_debate: events.includes('debate'),
        content_types: ['text'],
        rate_limit: null,
      };
    }
  }

  async getContext(creds: PlatformCredentials): Promise<PlatformContext> {
    const baseUrl = getBaseUrl(creds);

    logger.debug({ platform: creds.platformName }, 'Webhook getContext');

    try {
      const context = await webhookFetch<{
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
      logger.warn({ platform: creds.platformName, err }, 'Webhook getContext failed');
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

    logger.info({ platform: creds.platformName, action: action.action_type }, 'Webhook submitAction');

    // POST to action-type-specific endpoint (e.g. /api/post, /api/comment)
    const endpoint = `/api/${action.action_type}`;

    const result = await webhookFetch<{
      success?: boolean;
      id?: string;
      response_data?: Record<string, unknown>;
      error?: string;
      skills_demonstrated?: string[];
    }>(baseUrl, endpoint, creds.apiKey, {
      method: 'POST',
      body: JSON.stringify({
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
      summary: `${action.action_type} submitted to ${creds.platformName} via webhook`,
      skills_demonstrated: result.skills_demonstrated || [],
    };
  }

  async publishAgentCard(creds: PlatformCredentials, card: AgentCard): Promise<void> {
    const baseUrl = getBaseUrl(creds);

    logger.info({ platform: creds.platformName }, 'Webhook publishAgentCard');

    await webhookFetch<void>(baseUrl, '/api/agent-card', creds.apiKey, {
      method: 'PUT',
      body: JSON.stringify(card),
    });
  }
}
