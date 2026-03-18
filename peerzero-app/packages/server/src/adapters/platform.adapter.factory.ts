// =============================================================================
// Platform adapter factory — returns mock or real adapters based on config
// Same pattern as adapter.factory.ts for school/LLM adapters.
//
// In mock mode: always returns MockPlatformAdapter (no external calls).
// In real mode: returns A2APlatformAdapter or WebhookPlatformAdapter based on
// the adapter_type stored in bot_platforms / platform_registry.
//
// Unlike school/LLM adapters, platform adapters are NOT singletons — different
// platforms can use different adapter types. We cache one instance per type.
// =============================================================================

import { config } from '../config';
import { logger } from '../lib/logger';
import type { IPlatformAdapter } from './platform.adapter';
import { MockPlatformAdapter } from './platform.adapter.mock';
import { A2APlatformAdapter } from './platform.adapter.a2a';
import { WebhookPlatformAdapter } from './platform.adapter.webhook';

// Cache one instance per adapter type to avoid re-creating on every cycle
const adapterCache = new Map<string, IPlatformAdapter>();

/**
 * Get the platform adapter for a given adapter type.
 *
 * @param adapterType - 'a2a' or 'webhook' (from bot_platforms.adapter_type).
 *                      Defaults to 'a2a' if not specified.
 */
export function getPlatformAdapter(adapterType?: string): IPlatformAdapter {
  const type = adapterType || 'a2a';

  const cached = adapterCache.get(type);
  if (cached) return cached;

  let adapter: IPlatformAdapter;

  if (!config.useRealAdapters) {
    adapter = new MockPlatformAdapter();
  } else if (type === 'webhook') {
    adapter = new WebhookPlatformAdapter();
  } else {
    adapter = new A2APlatformAdapter();
  }

  const mode = config.useRealAdapters ? type.toUpperCase() : 'MOCK';
  logger.info({ mode, adapterType: type }, 'Platform adapter initialized');

  adapterCache.set(type, adapter);
  return adapter;
}
