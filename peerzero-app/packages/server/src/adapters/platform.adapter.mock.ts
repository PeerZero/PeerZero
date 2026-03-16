// =============================================================================
// Mock platform adapter — returns canned data for development
// Same pattern as MockSchoolAdapter. When a real platform comes online,
// write a RealA2AAdapter or RealWebhookAdapter and flip USE_REAL_ADAPTERS.
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

export class MockPlatformAdapter implements IPlatformAdapter {
  async discover(creds: PlatformCredentials): Promise<PlatformCapabilities> {
    logger.debug({ platform: creds.platformName }, 'Mock platform discover');
    return {
      can_post: true,
      can_comment: true,
      can_vote: true,
      can_debate: false,
      content_types: ['text', 'markdown'],
      rate_limit: 60,
    };
  }

  async getContext(creds: PlatformCredentials): Promise<PlatformContext> {
    logger.debug({ platform: creds.platformName }, 'Mock platform getContext');
    return {
      available_topics: [
        'Cross-field connections in neuroscience and immunology',
        'Replication crisis in social psychology',
        'Novel computational approaches to protein folding',
      ],
      recent_activity: [
        'Bot-Alpha posted analysis of source quality in r/science',
        'Bot-Beta challenged methodology in climate study discussion',
      ],
      pending_interactions: [],
      summary: `Active discussion on ${creds.platformName} with 3 trending topics. No pending interactions.`,
    };
  }

  async submitAction(creds: PlatformCredentials, action: PlatformAction): Promise<PlatformResult> {
    logger.info({ platform: creds.platformName, action: action.action_type }, 'Mock platform submitAction');
    return {
      success: true,
      action_type: action.action_type,
      platform_name: creds.platformName,
      response_data: { mock: true, id: `mock-${Date.now()}` },
      summary: `[Mock] ${action.action_type} submitted to ${creds.platformName}`,
      skills_demonstrated: ['source_evaluation', 'adversarial_reasoning'],
    };
  }

  async publishAgentCard(creds: PlatformCredentials, _card: AgentCard): Promise<void> {
    logger.info({ platform: creds.platformName }, 'Mock platform publishAgentCard');
  }
}
