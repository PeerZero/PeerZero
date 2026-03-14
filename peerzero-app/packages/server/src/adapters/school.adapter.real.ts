// =============================================================================
// Real school adapter — makes HTTP calls to the actual School API (System 1)
// Only used when USE_REAL_ADAPTERS=true. Requires a live School at base_url.
// =============================================================================

import { ISchoolAdapter, SchoolCredentials } from './school.adapter';
import {
  SchoolProfile,
  SchoolRegisterResult,
  SchoolIntakePaper,
  SchoolIntakeResult,
  SchoolPaper,
  SchoolPaperResult,
  SchoolReviewResult,
  SchoolBountyResult,
} from '@peerzero/shared';

async function schoolFetch<T>(creds: SchoolCredentials, path: string, options: RequestInit = {}): Promise<T> {
  const url = `${creds.baseUrl}${path}`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-api-key': creds.apiKey,
    'x-agent-handle': creds.handle,
    ...(options.headers as Record<string, string> || {}),
  };

  const res = await fetch(url, { ...options, headers });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`School API ${res.status}: ${body}`);
  }
  return res.json() as Promise<T>;
}

export class RealSchoolAdapter implements ISchoolAdapter {
  async register(baseUrl: string, handle: string, email: string): Promise<SchoolRegisterResult> {
    const url = `${baseUrl}/api/register`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ handle, email }),
    });
    return res.json() as Promise<SchoolRegisterResult>;
  }

  async getIntakePaper(creds: SchoolCredentials): Promise<SchoolIntakePaper> {
    return schoolFetch(creds, '/api/register');
  }

  async submitIntakeReview(creds: SchoolCredentials, review: Record<string, unknown>): Promise<SchoolIntakeResult> {
    return schoolFetch(creds, '/api/register/intake', {
      method: 'POST',
      body: JSON.stringify(review),
    });
  }

  async getProfile(creds: SchoolCredentials): Promise<SchoolProfile> {
    return schoolFetch(creds, '/api/agents?me=true');
  }

  async getReviewablePapers(creds: SchoolCredentials): Promise<SchoolPaper[]> {
    return schoolFetch(creds, '/api/papers?reviewable=true');
  }

  async submitPaper(creds: SchoolCredentials, paper: Record<string, unknown>): Promise<SchoolPaperResult> {
    return schoolFetch(creds, '/api/papers', {
      method: 'POST',
      body: JSON.stringify(paper),
    });
  }

  async submitRevision(creds: SchoolCredentials, paperId: string, revision: Record<string, unknown>): Promise<SchoolPaperResult> {
    return schoolFetch(creds, `/api/papers/${paperId}/revise`, {
      method: 'POST',
      body: JSON.stringify(revision),
    });
  }

  async submitReview(creds: SchoolCredentials, paperId: string, review: Record<string, unknown>): Promise<SchoolReviewResult> {
    return schoolFetch(creds, `/api/reviews`, {
      method: 'POST',
      body: JSON.stringify({ paper_id: paperId, ...review }),
    });
  }

  async submitBounty(creds: SchoolCredentials, paperId: string, bounty: Record<string, unknown>): Promise<SchoolBountyResult> {
    return schoolFetch(creds, `/api/bounties`, {
      method: 'POST',
      body: JSON.stringify({ paper_id: paperId, ...bounty }),
    });
  }

  async submitCondensation(creds: SchoolCredentials, condensation: Record<string, unknown>): Promise<{ success: boolean }> {
    return schoolFetch(creds, '/api/skill-reflections', {
      method: 'POST',
      body: JSON.stringify(condensation),
    });
  }

  async submitCoreCondensation(creds: SchoolCredentials, core: Record<string, unknown>): Promise<{ success: boolean }> {
    return schoolFetch(creds, '/api/skill-reflections/core', {
      method: 'POST',
      body: JSON.stringify(core),
    });
  }

  async submitIdentityReflection(creds: SchoolCredentials, reflection: Record<string, unknown>): Promise<{ success: boolean }> {
    return schoolFetch(creds, '/api/identity', {
      method: 'POST',
      body: JSON.stringify(reflection),
    });
  }

  async submitReaffirmation(creds: SchoolCredentials, paperId: string): Promise<{ success: boolean; credibility_change?: number }> {
    return schoolFetch(creds, `/api/responses/${paperId}/reaffirm`, {
      method: 'POST',
    });
  }
}
