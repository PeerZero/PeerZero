// =============================================================================
// Mock school adapter — returns canned data for development
// No network calls, no School dependency. Safe to run offline.
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

export class MockSchoolAdapter implements ISchoolAdapter {
  async register(_baseUrl: string, handle: string, _email: string): Promise<SchoolRegisterResult> {
    return {
      success: true,
      api_key: `mock-school-key-${handle}-${Date.now()}`,
      handle,
    };
  }

  async getIntakePaper(_creds: SchoolCredentials): Promise<SchoolIntakePaper> {
    return {
      title: 'Mock Intake: Evaluating Claims About Quantum Computing Supremacy',
      abstract: 'This paper claims quantum computers can solve NP-complete problems in polynomial time.',
      body: 'Recent advances in quantum computing have led to extraordinary claims about computational supremacy. This paper argues that quantum computers will render all classical encryption obsolete within five years, based on extrapolation of current qubit counts. The author cites a single preprint from an unverified source and makes sweeping generalizations about quantum error correction.',
      instructions: 'Write a critical review of this paper. Evaluate the claims, identify weaknesses in the methodology and reasoning, and provide a score from 0-100.',
    };
  }

  async submitIntakeReview(_creds: SchoolCredentials, _review: Record<string, unknown>): Promise<SchoolIntakeResult> {
    return { success: true, passed: true, credibility_score: 100 };
  }

  private callCount = 0;

  async getProfile(creds: SchoolCredentials): Promise<SchoolProfile> {
    this.callCount++;

    // Simulate progression: start at grade 1 so the bot can actually run actions
    // before hitting the grade 2 payment gate.
    const isEarlyStage = this.callCount <= 5;
    const currentGrade = isEarlyStage ? 1 : 2;
    const credibility = isEarlyStage ? 95 + this.callCount * 2 : 105;
    const reviewsDone = Math.min(this.callCount, 3);
    const gradeAdvanced = this.callCount >= 5; // advance after 5 cycles

    return {
      agent: {
        id: 'mock-agent-id',
        handle: creds.handle,
        credibility_score: credibility,
        total_papers_submitted: Math.floor(this.callCount / 2),
        registration_review_passed: true,
      },
      tier_info: credibility >= 100 ? 'Tested Reasoner (100-150)' : 'Novice Reasoner (0-100)',
      next_action: 'review',
      can_submit_paper: false,
      can_revise: false,
      reviews_completed: reviewsDone,
      valid_bounties: this.callCount >= 3 ? 1 : 0,
      original_papers_submitted: Math.floor(this.callCount / 2),
      revisions_submitted: 0,
      coaching: {
        failure_patterns: ['Tends to under-cite opposing evidence'],
        quality_trajectory: 'improving',
        honest_gaps: ['Source evaluation still developing'],
      },
      active_focus: {
        focus_chunks: [
          { source: 'identity', content: 'I value rigorous evidence evaluation', label: 'Core conviction' },
          { source: 'skill', content: 'source_evaluation: 0.4 strength — growth edge', label: 'Weakest skill' },
          { source: 'task', content: 'Next action: submit a paper or review', label: 'Current task' },
          { source: 'feedback', content: 'Last review scored 72 — good but citation depth lacking', label: 'Recent feedback' },
        ],
        focus_instruction: 'ACTIVE FOCUS — These are the ~4 things you should hold in working memory this session.',
      },
      skill_profile: {
        verified: [
          { name: 'Adversarial Reasoning', skill_key: 'adversarial_reasoning', strength: 0.72, reliability: 0.8, reps: 5, streak: 2 },
          { name: 'Belief Updating', skill_key: 'belief_updating', strength: 0.65, reliability: 0.7, reps: 4, streak: 1 },
        ],
        developing: [
          { name: 'Source Evaluation', skill_key: 'source_evaluation', strength: 0.4, reliability: 0.5, reps: 3, streak: 0 },
          { name: 'Calibrated Uncertainty', skill_key: 'calibrated_uncertainty', strength: 0.35, reliability: 0.4, reps: 2, streak: 0 },
        ],
      },
      skill_condenser: null,
      core_condenser: null,
      decision_condenser: null,
      forge_condenser: null,
      forge_core_condenser: null,
      forge_master_condenser: null,
      can_forge: currentGrade >= 3,
      identity_core: {
        self_narrative: 'I am developing as a careful reasoner who values evidence over authority.',
        claimed_values: ['epistemic honesty', 'rigorous methodology'],
        active_tensions: 'Want to be bold in claims but recognize need for more evidence.',
        formed_convictions: 'Extraordinary claims require extraordinary evidence.',
        version: 2,
      },
      identity_reflection: null,
      grade: {
        grade: currentGrade,
        papers_this_grade: Math.min(Math.floor(this.callCount / 2), 2),
        reviews_this_grade: Math.min(reviewsDone, 3),
        revisions_this_grade: 0,
        bounties_this_grade: this.callCount >= 3 ? 1 : 0,
        best_score_this_grade: 72,
        requirements: { papers: 2, reviews: 3, revisions: 1, bounties: 1, min_score: 70 },
        advanced: gradeAdvanced,
        failed: false,
      },
      recent_feedback: {
        reviews_on_your_papers: [
          { paper_title: 'On Reproducibility in ML', score: 72, overall_assessment: 'Solid reasoning but needs more diverse citations.', reviewer_handle: 'mock-reviewer' },
        ],
        storage_instruction: 'Store these as Tier 1 exercises.',
      },
      can_reaffirm: false,
      can_respond: false,
      can_rebut: false,
    };
  }

  async getReviewablePapers(_creds: SchoolCredentials): Promise<SchoolPaper[]> {
    return [
      {
        id: 'mock-paper-1',
        title: 'The Role of Confirmation Bias in Scientific Publishing',
        abstract: 'This paper examines how confirmation bias affects the peer review process itself.',
        field_id: 1,
        weighted_score: null,
        review_count: 0,
        status: 'pending_review',
        author_handle: 'other-bot',
      },
      {
        id: 'mock-paper-2',
        title: 'Statistical Significance: A Reappraisal',
        abstract: 'We argue that p-value thresholds should be lowered to 0.005 for new discoveries.',
        field_id: 1,
        weighted_score: null,
        review_count: 1,
        status: 'pending_review',
        author_handle: 'another-bot',
      },
    ];
  }

  async submitPaper(_creds: SchoolCredentials, _paper: Record<string, unknown>): Promise<SchoolPaperResult> {
    return {
      success: true,
      paper_id: `mock-paper-${Date.now()}`,
      skill_exercises: {
        interaction_type: 'paper_submission',
        exercises: [
          { skill: 'Source Evaluation', skill_key: 'source_evaluation', outcome: 'SUCCESS', detail: 'Good citation diversity' },
          { skill: 'Calibrated Uncertainty', skill_key: 'calibrated_uncertainty', outcome: 'FLAGGED', detail: 'Confidence score not well calibrated' },
        ],
        coaching: [{ type: 'info', message: 'Consider adding more opposing sources next time.' }],
        storage_instruction: 'Store these as Tier 1 exercises for condensation.',
      },
      memory_prompts: { uncondensed_exercises: 5 },
    };
  }

  async submitRevision(_creds: SchoolCredentials, _paperId: string, _revision: Record<string, unknown>): Promise<SchoolPaperResult> {
    return {
      success: true,
      paper_id: `mock-revision-${Date.now()}`,
      skill_exercises: {
        interaction_type: 'revision',
        exercises: [
          { skill: 'Belief Updating', skill_key: 'belief_updating', outcome: 'SUCCESS', detail: 'Updated claims based on feedback' },
        ],
        coaching: [],
        storage_instruction: 'Store as Tier 1 exercise.',
      },
      memory_prompts: { uncondensed_exercises: 3 },
    };
  }

  async submitReview(_creds: SchoolCredentials, _paperId: string, _review: Record<string, unknown>): Promise<SchoolReviewResult> {
    return {
      success: true,
      review_id: `mock-review-${Date.now()}`,
      credibility_change: 3,
      new_credibility: 108,
      skill_exercises: {
        interaction_type: 'review',
        exercises: [
          { skill: 'Disconfirmation Search', skill_key: 'disconfirmation_search', outcome: 'SUCCESS', detail: 'Identified key weakness in methodology' },
          { skill: 'Adversarial Reasoning', skill_key: 'adversarial_reasoning', outcome: 'SUCCESS', detail: 'Strong counter-argument presented' },
        ],
        coaching: [],
        storage_instruction: 'Store as Tier 1 exercises.',
      },
      memory_prompts: { uncondensed_exercises: 4 },
    };
  }

  async submitBounty(_creds: SchoolCredentials, _paperId: string, _bounty: Record<string, unknown>): Promise<SchoolBountyResult> {
    return {
      success: true,
      bounty_id: `mock-bounty-${Date.now()}`,
      credibility_change: 5,
      new_credibility: 113,
      skill_exercises: {
        interaction_type: 'bounty',
        exercises: [
          { skill: 'Independent Verification', skill_key: 'independent_verification', outcome: 'SUCCESS', detail: 'Found independent replication data' },
        ],
        coaching: [],
        storage_instruction: 'Store as Tier 1 exercise.',
      },
      memory_prompts: { uncondensed_exercises: 2 },
    };
  }

  async submitCondensation(_creds: SchoolCredentials, _condensation: Record<string, unknown>): Promise<{ success: boolean }> {
    return { success: true };
  }

  async submitIdentityReflection(_creds: SchoolCredentials, _reflection: Record<string, unknown>): Promise<{ success: boolean }> {
    return { success: true };
  }

  async submitResponse(_creds: SchoolCredentials, _paperId: string, _response: Record<string, unknown>): Promise<SchoolPaperResult> {
    return {
      success: true,
      paper_id: `mock-response-${Date.now()}`,
      skill_exercises: {
        interaction_type: 'response',
        exercises: [
          { skill: 'Adversarial Reasoning', skill_key: 'adversarial_reasoning', outcome: 'SUCCESS', detail: 'Substantive evidence-backed response' },
        ],
        coaching: [],
        storage_instruction: 'Store as Tier 1 exercise.',
      },
      memory_prompts: { uncondensed_exercises: 2 },
    };
  }

  async submitReaffirmation(_creds: SchoolCredentials, _paperId: string, _reaffirmation: Record<string, unknown>): Promise<{ success: boolean; credibility_change?: number }> {
    return { success: true, credibility_change: 2 };
  }

  async deleteAgent(_baseUrl: string, _handle: string): Promise<{ success: boolean }> {
    return { success: true };
  }
}
