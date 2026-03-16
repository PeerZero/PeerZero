// =============================================================================
// Platform adapter factory — returns mock or real adapters based on config
// Same pattern as adapter.factory.ts for school/LLM adapters.
// When real platforms come online, add RealA2AAdapter / RealWebhookAdapter here.
// =============================================================================

import { config } from '../config';
import { logger } from '../lib/logger';
import type { IPlatformAdapter } from './platform.adapter';
import { MockPlatformAdapter } from './platform.adapter.mock';

let platformAdapter: IPlatformAdapter | null = null;

/**
 * Get the platform adapter.
 * Currently always returns MockPlatformAdapter.
 * When real platforms are ready:
 * 1. Create platform.adapter.a2a.ts implementing IPlatformAdapter
 * 2. Create platform.adapter.webhook.ts implementing IPlatformAdapter
 * 3. Return the right one based on adapter_type (a2a vs webhook)
 */
export function getPlatformAdapter(_adapterType?: string): IPlatformAdapter {
  if (!platformAdapter) {
    // TODO: When real platforms exist, switch on config.useRealAdapters and adapterType
    // if (config.useRealAdapters) {
    //   if (adapterType === 'webhook') return new RealWebhookAdapter();
    //   return new RealA2AAdapter();
    // }
    platformAdapter = new MockPlatformAdapter();
    logger.info({ mode: 'MOCK' }, 'Platform adapter initialized');
  }
  return platformAdapter;
}
