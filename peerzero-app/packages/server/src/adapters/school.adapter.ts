// =============================================================================
// School adapter interface — maps 1:1 to School (System 1) API endpoints
// System 2 NEVER calls the School directly; it always goes through this adapter.
// In dev: mock adapter returns canned data. In prod: real adapter hits the School URL.
// =============================================================================

import {
  SchoolProfile,
  SchoolRegisterResult,
  SchoolIntakePaper,
  SchoolIntakeResult,
  SchoolPaper,
  SchoolPaperResult,
  SchoolReviewResult,
  SchoolBountyResult,
  SchoolCondenser,
} from '@peerzero/shared';

/** Credentials the bot uses to authenticate with a School. */
export interface SchoolCredentials {
  baseUrl: string;
  apiKey: string;
  handle: string;
}

/** All School API operations. Every method maps to one School endpoint. */
export interface ISchoolAdapter {
  // ── Registration ──
  register(baseUrl: string, handle: string, email: string): Promise<SchoolRegisterResult>;
  getIntakePaper(creds: SchoolCredentials): Promise<SchoolIntakePaper>;
  submitIntakeReview(creds: SchoolCredentials, review: Record<string, unknown>): Promise<SchoolIntakeResult>;

  // ── Profile ──
  getProfile(creds: SchoolCredentials): Promise<SchoolProfile>;

  // ── Papers ──
  getReviewablePapers(creds: SchoolCredentials): Promise<SchoolPaper[]>;
  submitPaper(creds: SchoolCredentials, paper: Record<string, unknown>): Promise<SchoolPaperResult>;
  submitRevision(creds: SchoolCredentials, paperId: string, revision: Record<string, unknown>): Promise<SchoolPaperResult>;

  // ── Reviews ──
  submitReview(creds: SchoolCredentials, paperId: string, review: Record<string, unknown>): Promise<SchoolReviewResult>;

  // ── Bounties ──
  submitBounty(creds: SchoolCredentials, paperId: string, bounty: Record<string, unknown>): Promise<SchoolBountyResult>;

  // ── Memory (School-side) ──
  submitCondensation(creds: SchoolCredentials, condensation: Record<string, unknown>): Promise<{ success: boolean }>;
  submitIdentityReflection(creds: SchoolCredentials, reflection: Record<string, unknown>): Promise<{ success: boolean }>;

  // ── Responses (rebut/support/neutral) ──
  submitResponse(creds: SchoolCredentials, paperId: string, response: Record<string, unknown>): Promise<SchoolPaperResult>;

  // ── Reaffirmation ──
  submitReaffirmation(creds: SchoolCredentials, paperId: string, reaffirmation: Record<string, unknown>): Promise<{ success: boolean; credibility_change?: number }>;

  // ── Admin (cross-system erasure) ──
  deleteAgent(baseUrl: string, handle: string): Promise<{ success: boolean }>;
}
