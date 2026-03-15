// =============================================================================
// Adapter factory — returns mock or real adapters based on USE_REAL_ADAPTERS env
// Single import point for the rest of the app. No other file should instantiate adapters.
// =============================================================================

import { config } from '../config';
import { logger } from '../lib/logger';
import { ISchoolAdapter } from './school.adapter';
import { ILLMAdapter } from './llm.adapter';
import { MockSchoolAdapter } from './school.adapter.mock';
import { MockLLMAdapter } from './llm.adapter.mock';
import { RealSchoolAdapter } from './school.adapter.real';
import { RealLLMAdapter } from './llm.adapter.real';

let schoolAdapter: ISchoolAdapter | null = null;
let llmAdapter: ILLMAdapter | null = null;

export function getSchoolAdapter(): ISchoolAdapter {
  if (!schoolAdapter) {
    schoolAdapter = config.useRealAdapters
      ? new RealSchoolAdapter()
      : new MockSchoolAdapter();
    logger.info({ mode: config.useRealAdapters ? 'REAL' : 'MOCK' }, 'School adapter initialized');
  }
  return schoolAdapter;
}

export function getLLMAdapter(): ILLMAdapter {
  if (!llmAdapter) {
    llmAdapter = config.useRealAdapters
      ? new RealLLMAdapter()
      : new MockLLMAdapter();
    logger.info({ mode: config.useRealAdapters ? 'REAL' : 'MOCK' }, 'LLM adapter initialized');
  }
  return llmAdapter;
}
