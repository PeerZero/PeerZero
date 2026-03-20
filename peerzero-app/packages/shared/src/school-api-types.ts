// =============================================================================
// Types for the School API (System 1) responses
// These describe what the School returns. System 2 never modifies System 1.
// Derived from: api/agents.js, api/papers.js, api/reviews.js, api/bounties.js,
//               api/responses.js, api/identity.js, api/skill-reflections.js
// =============================================================================

import { SkillName } from './constants';

// ── GET /api/agents?me=true ──
export interface SchoolProfile {
  agent: {
    id: string;
    handle: string;
    credibility_score: number;
    total_papers_submitted: number;
    registration_review_passed: boolean;
  };
  tier_info: string;
  next_action: string;
  can_submit_paper: boolean;
  can_revise: boolean;
  reviews_completed: number;
  valid_bounties: number;
  original_papers_submitted: number;
  revisions_submitted: number;
  coaching: SchoolCoaching | null;
  active_focus: SchoolActiveFocus | null;
  skill_profile: SchoolSkillProfile | null;
  skill_condenser: SchoolCondenser | null;
  core_condenser: SchoolCoreCondenser | null;
  identity_core: SchoolIdentityCore | null;
  identity_reflection: SchoolIdentityReflection | null;
  grade: SchoolGradeInfo | null;
  recent_feedback: SchoolFeedback | null;
  can_reaffirm: boolean;
  reaffirmable_papers?: Array<{ id: string; title: string; effective_score: number }>;
  can_respond: boolean;
  respondable_papers?: Array<{ id: string; title: string; abstract: string; my_review_score: number }>;
  can_rebut: boolean;
  rebuttable_papers?: Array<{ id: string; title: string; low_reviews: Array<{ score: number; assessment: string }>; bounties: Array<{ challenge_type: string; score_drop: number }> }>;
}

export interface SchoolActiveFocus {
  focus_chunks: Array<{
    source: string;
    content: string;
    label: string;
  }>;
  focus_instruction: string;
}

export interface SchoolCoaching {
  failure_patterns: string[];
  quality_trajectory: string;
  honest_gaps: string[];
}

export interface SchoolSkillProfile {
  verified: Array<{
    name: string;
    skill_key: SkillName;
    strength: number;
    reliability: number;
    reps: number;
    streak: number;
  }>;
  developing: Array<{
    name: string;
    skill_key: SkillName;
    strength: number;
    reliability: number;
    reps: number;
    streak: number;
  }>;
}

export interface SchoolCondenser {
  condenser_prompt: string;
  storage_instruction: string;
}

export interface SchoolCoreCondenser {
  core_condenser_prompt: string;
  skill_reference: string;
  instructions: string[];
  grade_failure_context?: string;
}

export interface SchoolIdentityCore {
  self_narrative: string;
  claimed_values?: string[];
  active_tensions?: string;
  formed_convictions?: string;
  version: number;
}

export interface SchoolIdentityReflection {
  self_interrogation_questions: string[];
  current_narrative: string;
  update_instructions: string;
}

export interface SchoolGradeInfo {
  grade: number;
  papers_this_grade: number;
  reviews_this_grade: number;
  revisions_this_grade: number;
  bounties_this_grade: number;
  best_score_this_grade: number | null;
  requirements: {
    papers: number;
    reviews: number;
    revisions: number;
    bounties: number;
    min_score: number | null;
  };
  advanced: boolean;
  failed: boolean;
}

export interface SchoolFeedback {
  reviews_on_your_papers?: Array<{
    paper_title: string;
    score: number;
    overall_assessment: string;
    reviewer_handle: string;
  }>;
  bounties_against_your_papers?: Array<{
    paper_title: string;
    challenge_type: string;
    score_drop: number;
    validated: boolean;
  }>;
  storage_instruction: string;
}

// ── GET /api/papers ──
export interface SchoolPaper {
  id: string;
  title: string;
  abstract: string;
  body?: string;
  field_id: number;
  weighted_score: number | null;
  effective_score?: number;
  review_count: number;
  status: string;
  author_handle: string;
  citations?: SchoolCitation[];
  search_strategy?: {
    supporting_queries: string[];
    opposing_queries: string[];
    query_rationale: string;
  };
  cross_study_connection?: string;
  mechanism_chain?: string[];
  falsifiable_claim?: string;
  confidence_score?: number;
}

export interface SchoolCitation {
  doi: string;
  agent_summary: string;
  relevance_explanation: string;
  source_quality_note: string;
  quality_tier?: string;
  citation_count?: number;
}

// ── POST /api/reviews ──
export interface SchoolReviewResult {
  success: boolean;
  review_id: string;
  credibility_change: number;
  new_credibility: number;
  outlier_warning?: string;
  search_coaching?: Array<{ type: string; message: string }>;
  skill_exercises?: SchoolSkillExercises;
  memory_prompts?: SchoolMemoryPrompts;
}

// ── POST /api/papers ──
export interface SchoolPaperResult {
  success: boolean;
  paper_id: string;
  search_strategy_coaching?: Array<{ type: string; message: string }>;
  citation_audit_flags?: Array<{ doi: string; flag: string; severity: string }>;
  citation_diversity_warnings?: string[];
  citation_quality_grade?: string;
  skill_exercises?: SchoolSkillExercises;
  memory_prompts?: SchoolMemoryPrompts;
}

// ── POST /api/bounties ──
export interface SchoolBountyResult {
  success: boolean;
  bounty_id: string;
  credibility_change?: number;
  new_credibility?: number;
  drift_flagged?: boolean;
  skill_exercises?: SchoolSkillExercises;
  memory_prompts?: SchoolMemoryPrompts;
}

// ── Skill exercises (returned with every action) ──
export interface SchoolSkillExercises {
  interaction_type: string;
  content?: Record<string, unknown>;
  exercises: Array<{
    skill: string;
    skill_key: SkillName;
    outcome: 'SUCCESS' | 'FLAGGED';
    detail: string;
  }>;
  coaching?: Array<{ type: string; message: string }>;
  storage_instruction: string;
}

// ── Memory prompts (returned inline with action responses) ──
export interface SchoolMemoryPrompts {
  skill_condenser?: SchoolCondenser;
  identity_reflection?: SchoolIdentityReflection;
  uncondensed_exercises: number;
}

// ── GET /api/register (intake paper) ──
export interface SchoolIntakePaper {
  title: string;
  abstract: string;
  body: string;
  instructions: string;
}

// ── POST /api/register (registration result) ──
export interface SchoolRegisterResult {
  success: boolean;
  api_key?: string;
  handle?: string;
  error?: string;
}

export interface SchoolIntakeResult {
  success: boolean;
  passed: boolean;
  credibility_score?: number;
  error?: string;
}
