import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SchoolProfile } from '@peerzero/shared';

// ── Mock all external dependencies before importing agent-loop ──────────────

vi.mock('../lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Adapter factory — inject mock adapters
const mockSchoolAdapter = {
  getProfile: vi.fn(),
  getReviewablePapers: vi.fn(),
  submitPaper: vi.fn(),
  submitReview: vi.fn(),
  submitBounty: vi.fn(),
  submitRevision: vi.fn(),
  submitReaffirmation: vi.fn(),
  submitResponse: vi.fn(),
  submitCondensation: vi.fn(),
  submitIdentityReflection: vi.fn(),
};

const mockLLMAdapter = {
  chat: vi.fn(),
};

vi.mock('../adapters/adapter.factory', () => ({
  getSchoolAdapter: () => mockSchoolAdapter,
  getLLMAdapter: () => mockLLMAdapter,
}));

vi.mock('../services/bot.service', () => ({
  getDecryptedSchoolKey: vi.fn().mockResolvedValue({
    apiKey: 'test-school-key',
    handle: 'test-bot',
    baseUrl: 'https://school.test',
  }),
  setBotStatus: vi.fn().mockResolvedValue(undefined),
  isBotGradeUnlocked: vi.fn().mockResolvedValue(true),
}));

vi.mock('../services/api-key.service', () => ({
  getDecryptedKey: vi.fn().mockResolvedValue('test-llm-key'),
  markKeyInvalid: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../services/memory.service', () => ({
  storeExercise: vi.fn().mockResolvedValue(undefined),
  storeParagraph: vi.fn().mockResolvedValue(undefined),
  storeCore: vi.fn().mockResolvedValue(undefined),
  storeSelfIdentity: vi.fn().mockResolvedValue(undefined),
  getLatestSelfAuthored: vi.fn().mockResolvedValue(null),
  storeSelfAuthored: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../services/activity.service', () => ({
  logActivity: vi.fn().mockResolvedValue('activity-id'),
  translateReview: vi.fn().mockReturnValue({ headline: 'Reviewed', summary: '+3', details: [], mood: 'positive' }),
  translatePaper: vi.fn().mockReturnValue({ headline: 'Submitted', summary: 'Awaiting reviews', details: [], mood: 'neutral' }),
  translateBounty: vi.fn().mockReturnValue({ headline: 'Challenged', summary: '+5', details: [], mood: 'positive' }),
}));

vi.mock('../services/skill.service', () => ({
  updateSkillSnapshots: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../services/notification.service', () => ({
  notifyGradePaymentNeeded: vi.fn(),
}));

vi.mock('../db/client', () => ({
  query: vi.fn().mockResolvedValue({ rows: [] }),
  queryOne: vi.fn().mockResolvedValue(null),
  queryRows: vi.fn().mockResolvedValue([]),
}));

vi.mock('../jobs/platform-queue', () => ({
  schedulePlatformJobs: vi.fn().mockResolvedValue(undefined),
}));

// ── Import after mocks are set up ──────────────────────────────────────────

import { runOneCycle, BotContext } from '../runtime/agent-loop';
import { getDecryptedSchoolKey, setBotStatus, isBotGradeUnlocked } from '../services/bot.service';
import * as memory from '../services/memory.service';
import * as activity from '../services/activity.service';
import { updateSkillSnapshots } from '../services/skill.service';

// ── Helpers ─────────────────────────────────────────────────────────────────

const BASE_CTX: BotContext = {
  botId: 'bot-1',
  userId: 'user-1',
  llmApiKeyId: 'key-1',
  llmModel: 'claude-opus-4-6',
  fastLlmModel: null,
  extendedThinking: false,
  cycleNumber: 1,
  dailyTokenCap: null,
  dailyTokensUsed: 0,
  userTimezone: 'UTC',
};

function makeProfile(overrides: Partial<SchoolProfile> = {}): SchoolProfile {
  return {
    agent: { id: 'agent-1', handle: 'test-bot', credibility_score: 105, total_papers_submitted: 2, registration_review_passed: true },
    tier_info: 'Tested Reasoner',
    next_action: 'review',
    can_submit_paper: false,
    can_revise: false,
    reviews_completed: 3,
    valid_bounties: 1,
    original_papers_submitted: 2,
    revisions_submitted: 0,
    coaching: { failure_patterns: [], quality_trajectory: 'improving', honest_gaps: [] },
    active_focus: { focus_chunks: [], focus_instruction: '' },
    skill_profile: {
      verified: [{ name: 'Adversarial Reasoning', skill_key: 'adversarial_reasoning', strength: 0.7, reliability: 0.8, reps: 10, streak: 3 }],
      developing: [{ name: 'Source Evaluation', skill_key: 'source_evaluation', strength: 0.4, reliability: 0.5, reps: 3, streak: 1 }],
    },
    skill_condenser: null,
    core_condenser: null,
    identity_core: null,
    identity_reflection: null,
    grade: {
      grade: 2,
      papers_this_grade: 1,
      reviews_this_grade: 2,
      revisions_this_grade: 0,
      bounties_this_grade: 1,
      best_score_this_grade: 72,
      requirements: { papers: 2, reviews: 3, revisions: 1, bounties: 1, min_score: 70 },
      advanced: false,
      failed: false,
    },
    recent_feedback: { reviews_on_your_papers: [], storage_instruction: '' },
    can_reaffirm: false,
    can_respond: false,
    can_rebut: false,
    ...overrides,
  } as SchoolProfile;
}

function mockLLMJson(content: Record<string, unknown>) {
  mockLLMAdapter.chat.mockResolvedValue({
    content: JSON.stringify(content),
    tokens_used: 1000,
    model: 'claude-opus-4-6',
    stop_reason: 'end_turn',
  });
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('runOneCycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Re-apply default mocks after clearAllMocks
    (getDecryptedSchoolKey as ReturnType<typeof vi.fn>).mockResolvedValue({
      apiKey: 'test-school-key', handle: 'test-bot', baseUrl: 'https://school.test',
    });
    (isBotGradeUnlocked as ReturnType<typeof vi.fn>).mockResolvedValue(true);
  });

  // ── Action selection ────────────────────────────────────────────────────

  it('selects review when tier logic says review', async () => {
    const profile = makeProfile({
      next_action: 'review',
      can_submit_paper: true,
      can_revise: false,
    });
    mockSchoolAdapter.getProfile.mockResolvedValue(profile);
    mockSchoolAdapter.getReviewablePapers.mockResolvedValue([
      { id: 'paper-1', title: 'Test Paper', abstract: 'Test', field_id: 1, weighted_score: null, review_count: 0, status: 'pending_review', author_handle: 'other' },
    ]);
    mockSchoolAdapter.submitReview.mockResolvedValue({
      success: true, review_id: 'rev-1', credibility_change: 3, new_credibility: 108,
      skill_exercises: { interaction_type: 'review', exercises: [], coaching: [], storage_instruction: '' },
      memory_prompts: { uncondensed_exercises: 2 },
    });
    mockLLMJson({ overall_assessment: 'Good paper.', score: 72 });

    await runOneCycle(BASE_CTX);

    expect(mockSchoolAdapter.submitReview).toHaveBeenCalled();
    expect(mockSchoolAdapter.submitPaper).not.toHaveBeenCalled();
  });

  it('selects paper when tier logic says submit_paper', async () => {
    const profile = makeProfile({
      next_action: 'submit_paper',
      can_submit_paper: true,
    });
    mockSchoolAdapter.getProfile.mockResolvedValue(profile);
    mockSchoolAdapter.submitPaper.mockResolvedValue({
      success: true, paper_id: 'paper-new',
      skill_exercises: { interaction_type: 'paper_submission', exercises: [], coaching: [], storage_instruction: '' },
      memory_prompts: { uncondensed_exercises: 2 },
    });
    mockLLMJson({ title: 'My Paper', abstract: 'Abstract.', body: 'Body.' });

    await runOneCycle(BASE_CTX);

    expect(mockSchoolAdapter.submitPaper).toHaveBeenCalled();
  });

  it('selects revision when tier logic says revise', async () => {
    const profile = makeProfile({
      next_action: 'revise',
      can_revise: true,
      can_submit_paper: true,
      can_revise_papers: [{ id: 'rev-paper-1', title: 'Old Paper' }],
    });
    mockSchoolAdapter.getProfile.mockResolvedValue(profile);
    mockSchoolAdapter.submitRevision.mockResolvedValue({
      success: true, paper_id: 'rev-paper',
      skill_exercises: { interaction_type: 'revision', exercises: [], coaching: [], storage_instruction: '' },
      memory_prompts: { uncondensed_exercises: 1 },
    });
    mockLLMJson({ body: 'Revised body.', revision_notes: 'Fixed methodology.' });

    await runOneCycle(BASE_CTX);

    expect(mockSchoolAdapter.submitRevision).toHaveBeenCalled();
  });

  it('selects reaffirmation when tier says review but can_reaffirm is true', async () => {
    const profile = makeProfile({
      next_action: 'review',
      can_submit_paper: false,
      can_revise: false,
      can_reaffirm: true,
      reaffirmable_papers: [{ id: 'reaffirm-1', title: 'Old Paper', effective_score: 7.5 }],
    });
    mockSchoolAdapter.getProfile.mockResolvedValue(profile);
    mockSchoolAdapter.submitReaffirmation.mockResolvedValue({ success: true, credibility_change: 2 });

    await runOneCycle(BASE_CTX);

    expect(mockSchoolAdapter.submitReaffirmation).toHaveBeenCalledWith(
      expect.objectContaining({ handle: 'test-bot' }),
      'reaffirm-1',
      { stance: 'reaffirmation' },
    );
  });

  // ── Grade payment gate ──────────────────────────────────────────────────

  it('pauses bot when grade is not unlocked', async () => {
    const profile = makeProfile();
    mockSchoolAdapter.getProfile.mockResolvedValue(profile);
    (isBotGradeUnlocked as ReturnType<typeof vi.fn>).mockResolvedValue(false);

    await runOneCycle(BASE_CTX);

    expect(setBotStatus).toHaveBeenCalledWith('bot-1', 'paused', expect.stringContaining('Grade'));
    expect(mockSchoolAdapter.submitPaper).not.toHaveBeenCalled();
    expect(mockSchoolAdapter.submitReview).not.toHaveBeenCalled();
  });

  // ── Not enrolled ────────────────────────────────────────────────────────

  it('sets error status when bot has no school credentials', async () => {
    (getDecryptedSchoolKey as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    await runOneCycle(BASE_CTX);

    expect(setBotStatus).toHaveBeenCalledWith('bot-1', 'error', 'Not enrolled in any school');
    expect(mockSchoolAdapter.getProfile).not.toHaveBeenCalled();
  });

  // ── Memory storage ──────────────────────────────────────────────────────

  it('stores exercises when action result includes them', async () => {
    const profile = makeProfile();
    mockSchoolAdapter.getProfile.mockResolvedValue(profile);
    mockSchoolAdapter.getReviewablePapers.mockResolvedValue([
      { id: 'paper-1', title: 'Test', abstract: 'Test', field_id: 1, weighted_score: null, review_count: 0, status: 'pending_review', author_handle: 'other' },
    ]);
    const exercises = { interaction_type: 'review', exercises: [{ skill: 'Test', skill_key: 'test', outcome: 'SUCCESS', detail: 'Good' }], coaching: [], storage_instruction: '' };
    mockSchoolAdapter.submitReview.mockResolvedValue({
      success: true, review_id: 'rev-1', credibility_change: 3, new_credibility: 108,
      skill_exercises: exercises,
      memory_prompts: { uncondensed_exercises: 2 },
    });
    mockLLMJson({ overall_assessment: 'Good paper.', score: 72 });

    // Force review action via tier logic next_action
    const reviewProfile = makeProfile({
      ...profile,
      next_action: 'review',
      can_submit_paper: false,
    });
    mockSchoolAdapter.getProfile.mockResolvedValue(reviewProfile);

    await runOneCycle(BASE_CTX);

    expect(memory.storeExercise).toHaveBeenCalledWith(
      'bot-1', 1, 'review', expect.objectContaining({ interaction_type: 'review' }), expect.anything(),
    );
  });

  // ── Condensation ────────────────────────────────────────────────────────

  it('triggers skill condensation when uncondensed_exercises >= 5', async () => {
    const profile = makeProfile({
      skill_condenser: { exercises: ['ex1', 'ex2', 'ex3', 'ex4', 'ex5'] } as any,
      next_action: 'submit_paper',
      can_submit_paper: true,
    });
    mockSchoolAdapter.getProfile.mockResolvedValue(profile);
    mockSchoolAdapter.submitPaper.mockResolvedValue({
      success: true, paper_id: 'paper-new',
      skill_exercises: { interaction_type: 'paper_submission', exercises: [], coaching: [], storage_instruction: '' },
      memory_prompts: { uncondensed_exercises: 5 },
    });
    mockSchoolAdapter.submitCondensation.mockResolvedValue({ success: true });

    // First call returns paper JSON, second returns condensation JSON
    mockLLMAdapter.chat
      .mockResolvedValueOnce({ content: JSON.stringify({ title: 'Paper', abstract: 'Abstract', body: 'Body' }), tokens_used: 1000, model: 'claude-opus-4-6', stop_reason: 'end_turn' })
      .mockResolvedValueOnce({ content: JSON.stringify({ paragraph: 'I learned about source evaluation...' }), tokens_used: 500, model: 'claude-opus-4-6', stop_reason: 'end_turn' });

    await runOneCycle(BASE_CTX);

    expect(mockSchoolAdapter.submitCondensation).toHaveBeenCalled();
    expect(memory.storeParagraph).toHaveBeenCalledWith('bot-1', 'condensation', 'I learned about source evaluation...', 1);
  });

  it('handles malformed JSON in condensation gracefully', async () => {
    const profile = makeProfile({
      skill_condenser: { exercises: ['ex1'] } as any,
      next_action: 'submit_paper',
      can_submit_paper: true,
    });
    mockSchoolAdapter.getProfile.mockResolvedValue(profile);
    mockSchoolAdapter.submitPaper.mockResolvedValue({
      success: true, paper_id: 'paper-new',
      skill_exercises: { interaction_type: 'paper_submission', exercises: [], coaching: [], storage_instruction: '' },
      memory_prompts: { uncondensed_exercises: 5 },
    });

    // First call: paper, second call: broken condensation
    mockLLMAdapter.chat
      .mockResolvedValueOnce({ content: JSON.stringify({ title: 'Paper', abstract: 'Abstract', body: 'Body' }), tokens_used: 1000, model: 'claude-opus-4-6', stop_reason: 'end_turn' })
      .mockResolvedValueOnce({ content: 'This is not valid JSON at all', tokens_used: 500, model: 'claude-opus-4-6', stop_reason: 'end_turn' });

    // Should not throw — gracefully skips condensation
    await runOneCycle(BASE_CTX);

    expect(mockSchoolAdapter.submitCondensation).not.toHaveBeenCalled();
    expect(memory.storeParagraph).not.toHaveBeenCalled();
  });

  it('extracts JSON from markdown-fenced LLM output during condensation', async () => {
    const profile = makeProfile({
      skill_condenser: { exercises: ['ex1'] } as any,
      next_action: 'submit_paper',
      can_submit_paper: true,
    });
    mockSchoolAdapter.getProfile.mockResolvedValue(profile);
    mockSchoolAdapter.submitPaper.mockResolvedValue({
      success: true, paper_id: 'paper-new',
      skill_exercises: { interaction_type: 'paper_submission', exercises: [], coaching: [], storage_instruction: '' },
      memory_prompts: { uncondensed_exercises: 5 },
    });
    mockSchoolAdapter.submitCondensation.mockResolvedValue({ success: true });

    // Markdown-fenced JSON
    const fencedJson = '```json\n{"paragraph": "Condensed learning."}\n```';
    mockLLMAdapter.chat
      .mockResolvedValueOnce({ content: JSON.stringify({ title: 'Paper', abstract: 'A', body: 'B' }), tokens_used: 1000, model: 'claude-opus-4-6', stop_reason: 'end_turn' })
      .mockResolvedValueOnce({ content: fencedJson, tokens_used: 500, model: 'claude-opus-4-6', stop_reason: 'end_turn' });

    await runOneCycle(BASE_CTX);

    expect(memory.storeParagraph).toHaveBeenCalledWith('bot-1', 'condensation', 'Condensed learning.', 1);
  });

  // ── Skill snapshots ─────────────────────────────────────────────────────

  it('extracts and caches skill snapshots from profile', async () => {
    const profile = makeProfile();
    mockSchoolAdapter.getProfile.mockResolvedValue(profile);
    mockSchoolAdapter.getReviewablePapers.mockResolvedValue([
      { id: 'paper-1', title: 'Test', abstract: 'Test', field_id: 1, weighted_score: null, review_count: 0, status: 'pending_review', author_handle: 'other' },
    ]);
    mockSchoolAdapter.submitReview.mockResolvedValue({
      success: true, review_id: 'rev-1', credibility_change: 3, new_credibility: 108,
      skill_exercises: { interaction_type: 'review', exercises: [], coaching: [], storage_instruction: '' },
      memory_prompts: { uncondensed_exercises: 2 },
    });
    mockLLMJson({ overall_assessment: 'Good paper.', score: 72 });

    await runOneCycle(BASE_CTX);

    expect(updateSkillSnapshots).toHaveBeenCalledWith(
      'bot-1',
      expect.arrayContaining([
        expect.objectContaining({ skill_key: 'adversarial_reasoning', strength: 0.7 }),
        expect.objectContaining({ skill_key: 'source_evaluation', strength: 0.4, status: 'developing' }),
      ]),
    );
  });

  // ── Error handling ──────────────────────────────────────────────────────

  it('logs error activity and sets error status on 401', async () => {
    const profile = makeProfile();
    mockSchoolAdapter.getProfile.mockResolvedValue(profile);
    mockSchoolAdapter.getReviewablePapers.mockRejectedValue(new Error('School returned 401 Unauthorized'));

    await expect(runOneCycle(BASE_CTX)).rejects.toThrow('401');

    expect(activity.logActivity).toHaveBeenCalledWith(
      'bot-1', 1, 'error', null, null,
      expect.objectContaining({ headline: 'Cycle error' }),
      expect.any(Number), undefined, expect.stringContaining('401'),
    );
    expect(setBotStatus).toHaveBeenCalledWith('bot-1', 'error', expect.stringContaining('401'));
  });
});
