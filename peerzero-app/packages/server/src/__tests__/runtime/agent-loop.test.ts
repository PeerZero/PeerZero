import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SchoolProfile } from '@peerzero/shared';

// ── Mock all external dependencies before importing agent-loop ──────────────

vi.mock('../../lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

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
  submitCoreCondensation: vi.fn(),
  submitIdentityReflection: vi.fn(),
};

const mockLLMAdapter = {
  chat: vi.fn(),
};

vi.mock('../../adapters/adapter.factory', () => ({
  getSchoolAdapter: () => mockSchoolAdapter,
  getLLMAdapter: () => mockLLMAdapter,
}));

const mockSetBotStatus = vi.fn().mockResolvedValue(undefined);
const mockIsBotGradeUnlocked = vi.fn().mockResolvedValue(true);
const mockGetDecryptedSchoolKey = vi.fn().mockResolvedValue({
  apiKey: 'test-school-key',
  handle: 'test-bot',
  baseUrl: 'https://school.test',
});

vi.mock('../../services/bot.service', () => ({
  getDecryptedSchoolKey: (...args: any[]) => mockGetDecryptedSchoolKey(...args),
  setBotStatus: (...args: any[]) => mockSetBotStatus(...args),
  isBotGradeUnlocked: (...args: any[]) => mockIsBotGradeUnlocked(...args),
}));

vi.mock('../../services/api-key.service', () => ({
  getDecryptedKey: vi.fn().mockResolvedValue('test-llm-key'),
}));

const mockStoreExercise = vi.fn().mockResolvedValue(undefined);
const mockStoreParagraph = vi.fn().mockResolvedValue(undefined);
const mockStoreCore = vi.fn().mockResolvedValue(undefined);
const mockStoreSelfIdentity = vi.fn().mockResolvedValue(undefined);
const mockGetLatestSelfAuthored = vi.fn().mockResolvedValue(null);
const mockStoreSelfAuthored = vi.fn().mockResolvedValue(undefined);

vi.mock('../../services/memory.service', () => ({
  storeExercise: (...args: any[]) => mockStoreExercise(...args),
  storeParagraph: (...args: any[]) => mockStoreParagraph(...args),
  storeCore: (...args: any[]) => mockStoreCore(...args),
  storeSelfIdentity: (...args: any[]) => mockStoreSelfIdentity(...args),
  getLatestSelfAuthored: (...args: any[]) => mockGetLatestSelfAuthored(...args),
  storeSelfAuthored: (...args: any[]) => mockStoreSelfAuthored(...args),
}));

const mockLogActivity = vi.fn().mockResolvedValue('activity-id');

vi.mock('../../services/activity.service', () => ({
  logActivity: (...args: any[]) => mockLogActivity(...args),
}));

vi.mock('../../services/skill.service', () => ({
  updateSkillSnapshots: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../services/skill-engine.service', () => ({
  resolveActiveSkills: vi.fn().mockResolvedValue([]),
}));

const mockNotifyGradePaymentNeeded = vi.fn().mockResolvedValue(undefined);
const mockCheckAndNotifyMilestones = vi.fn().mockResolvedValue(undefined);

vi.mock('../../services/notification.service', () => ({
  notifyGradePaymentNeeded: (...args: any[]) => mockNotifyGradePaymentNeeded(...args),
  checkAndNotifyMilestones: (...args: any[]) => mockCheckAndNotifyMilestones(...args),
}));

vi.mock('../../services/bot-voice.service', () => ({
  generateBotVoicedMessage: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../services/message.service', () => ({
  narrateCycleActivity: vi.fn().mockResolvedValue(null),
  storeMilestoneMessage: vi.fn().mockResolvedValue(undefined),
  cleanupOldMessages: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../websocket/activity-stream', () => ({
  broadcastMessage: vi.fn(),
}));

const mockQuery = vi.fn().mockResolvedValue({ rows: [] });
const mockQueryOne = vi.fn().mockResolvedValue(null);
const mockQueryRows = vi.fn().mockResolvedValue([]);

vi.mock('../../db/client', () => ({
  query: (...args: any[]) => mockQuery(...args),
  queryOne: (...args: any[]) => mockQueryOne(...args),
  queryRows: (...args: any[]) => mockQueryRows(...args),
}));

vi.mock('../../runtime/action-router', () => ({
  routeAction: vi.fn().mockResolvedValue({
    rawRequest: { overall_assessment: 'Good', score: 72 },
    rawResponse: { success: true, credibility_change: 3 },
    translated: { headline: 'Reviewed', summary: '+3 credibility', details: [], mood: 'positive' },
    exercises: { interaction_type: 'review', exercises: [] },
    memoryPrompts: { uncondensed_exercises: 2 },
    tokensUsed: 1000,
  }),
}));

vi.mock('../../runtime/prompt-builder', () => ({
  buildPrompt: vi.fn().mockReturnValue([
    { role: 'system', content: 'You are a bot.' },
    { role: 'user', content: 'Do a review.' },
  ]),
}));

vi.mock('@peerzero/shared', () => ({
  getGradePriceCents: vi.fn(() => 499),
  credibilityToStage: vi.fn((c: number) => (c >= 200 ? 3 : c >= 120 ? 2 : 1)),
  SKILL_NAMES: [
    'disconfirmation_search',
    'calibrated_uncertainty',
    'belief_updating',
    'source_evaluation',
    'adversarial_reasoning',
    'independent_verification',
  ],
}));

// ── Import after mocks ───────────────────────────────────────────────────────

import { runOneCycle, BotContext } from '../../runtime/agent-loop';
import { routeAction } from '../../runtime/action-router';
import { cleanupOldMessages } from '../../services/message.service';

// ── Helpers ──────────────────────────────────────────────────────────────────

const BASE_CTX: BotContext = {
  botId: 'bot-1',
  userId: 'user-1',
  llmApiKeyId: 'key-1',
  llmModel: 'claude-opus-4-6',
  fastLlmModel: null,
  extendedThinking: false,
  cycleNumber: 1,
};

function makeProfile(overrides: Partial<SchoolProfile> = {}): SchoolProfile {
  return {
    agent: {
      id: 'agent-1',
      handle: 'test-bot',
      credibility_score: 105,
      total_papers_submitted: 2,
      registration_review_passed: true,
    },
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
      verified: [
        { name: 'Adversarial Reasoning', skill_key: 'adversarial_reasoning', strength: 0.7, reliability: 0.8, reps: 10, streak: 3 },
      ],
      developing: [
        { name: 'Source Evaluation', skill_key: 'source_evaluation', strength: 0.4, reliability: 0.5, reps: 3, streak: 1 },
      ],
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

// ── Tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  // Re-apply defaults after clearAllMocks
  mockGetDecryptedSchoolKey.mockResolvedValue({
    apiKey: 'test-school-key',
    handle: 'test-bot',
    baseUrl: 'https://school.test',
  });
  mockIsBotGradeUnlocked.mockResolvedValue(true);
  mockQueryOne.mockResolvedValue(null);
  mockLogActivity.mockResolvedValue('activity-id');
  (routeAction as ReturnType<typeof vi.fn>).mockResolvedValue({
    rawRequest: { overall_assessment: 'Good', score: 72 },
    rawResponse: { success: true, credibility_change: 3 },
    translated: { headline: 'Reviewed', summary: '+3 credibility', details: [], mood: 'positive' },
    exercises: { interaction_type: 'review', exercises: [] },
    memoryPrompts: { uncondensed_exercises: 2 },
    tokensUsed: 1000,
  });
});

// =============================================================================
// tryParseJson — tested indirectly via condensation paths, but also we can
// test the exported function behavior through the full cycle
// =============================================================================

describe('tryParseJson (via condensation)', () => {
  it('parses direct JSON from LLM response', async () => {
    const profile = makeProfile({
      skill_condenser: { exercises: ['ex1'] } as any,
      next_action: 'review',
    });
    mockSchoolAdapter.getProfile.mockResolvedValue(profile);

    // Route action returns enough uncondensed exercises to trigger condensation
    (routeAction as ReturnType<typeof vi.fn>).mockResolvedValue({
      rawRequest: { overall_assessment: 'Good', score: 72 },
      rawResponse: { success: true },
      translated: { headline: 'Reviewed', summary: '+3', details: [], mood: 'positive' },
      exercises: { interaction_type: 'review', exercises: [] },
      memoryPrompts: { uncondensed_exercises: 5 },
      tokensUsed: 1000,
    });
    mockSchoolAdapter.submitCondensation.mockResolvedValue({ success: true });

    mockLLMAdapter.chat.mockResolvedValueOnce({
      content: JSON.stringify({ paragraph: 'Condensed learning about evaluation.' }),
      tokens_used: 500,
      model: 'claude-opus-4-6',
      stop_reason: 'end_turn',
    });

    await runOneCycle(BASE_CTX);

    expect(mockStoreParagraph).toHaveBeenCalledWith(
      'bot-1', 'condensation', 'Condensed learning about evaluation.', 1,
    );
  });

  it('extracts JSON from markdown code fences', async () => {
    const profile = makeProfile({
      skill_condenser: { exercises: ['ex1'] } as any,
    });
    mockSchoolAdapter.getProfile.mockResolvedValue(profile);

    (routeAction as ReturnType<typeof vi.fn>).mockResolvedValue({
      rawRequest: {},
      rawResponse: { success: true },
      translated: { headline: 'Done', summary: '', details: [], mood: 'neutral' },
      exercises: null,
      memoryPrompts: { uncondensed_exercises: 5 },
      tokensUsed: 500,
    });
    mockSchoolAdapter.submitCondensation.mockResolvedValue({ success: true });

    mockLLMAdapter.chat.mockResolvedValueOnce({
      content: '```json\n{"paragraph": "Fenced paragraph."}\n```',
      tokens_used: 500,
      model: 'claude-opus-4-6',
      stop_reason: 'end_turn',
    });

    await runOneCycle(BASE_CTX);

    expect(mockStoreParagraph).toHaveBeenCalledWith(
      'bot-1', 'condensation', 'Fenced paragraph.', 1,
    );
  });

  it('extracts JSON embedded in surrounding text', async () => {
    const profile = makeProfile({
      skill_condenser: { exercises: ['ex1'] } as any,
    });
    mockSchoolAdapter.getProfile.mockResolvedValue(profile);

    (routeAction as ReturnType<typeof vi.fn>).mockResolvedValue({
      rawRequest: {},
      rawResponse: { success: true },
      translated: { headline: 'Done', summary: '', details: [], mood: 'neutral' },
      exercises: null,
      memoryPrompts: { uncondensed_exercises: 5 },
      tokensUsed: 500,
    });
    mockSchoolAdapter.submitCondensation.mockResolvedValue({ success: true });

    mockLLMAdapter.chat.mockResolvedValueOnce({
      content: 'Here is my condensation:\n{"paragraph": "Embedded JSON."}\nThat is my result.',
      tokens_used: 500,
      model: 'claude-opus-4-6',
      stop_reason: 'end_turn',
    });

    await runOneCycle(BASE_CTX);

    expect(mockStoreParagraph).toHaveBeenCalledWith(
      'bot-1', 'condensation', 'Embedded JSON.', 1,
    );
  });

  it('handles completely unparseable LLM output gracefully', async () => {
    const profile = makeProfile({
      skill_condenser: { exercises: ['ex1'] } as any,
    });
    mockSchoolAdapter.getProfile.mockResolvedValue(profile);

    (routeAction as ReturnType<typeof vi.fn>).mockResolvedValue({
      rawRequest: {},
      rawResponse: { success: true },
      translated: { headline: 'Done', summary: '', details: [], mood: 'neutral' },
      exercises: null,
      memoryPrompts: { uncondensed_exercises: 5 },
      tokensUsed: 500,
    });

    mockLLMAdapter.chat.mockResolvedValueOnce({
      content: 'This is totally free-form text with no JSON whatsoever.',
      tokens_used: 500,
      model: 'claude-opus-4-6',
      stop_reason: 'end_turn',
    });

    // Should NOT throw
    await runOneCycle(BASE_CTX);

    expect(mockStoreParagraph).not.toHaveBeenCalled();
    expect(mockSchoolAdapter.submitCondensation).not.toHaveBeenCalled();
  });
});

// =============================================================================
// determineAction — tested via routeAction dispatch
// =============================================================================

describe('determineAction', () => {
  it('maps "review" next_action to review', async () => {
    const profile = makeProfile({ next_action: 'review', can_reaffirm: false });
    mockSchoolAdapter.getProfile.mockResolvedValue(profile);

    await runOneCycle(BASE_CTX);

    expect(routeAction).toHaveBeenCalledWith('review', expect.anything());
  });

  it('maps "submit_paper" next_action to paper', async () => {
    const profile = makeProfile({ next_action: 'submit_paper' });
    mockSchoolAdapter.getProfile.mockResolvedValue(profile);

    await runOneCycle(BASE_CTX);

    expect(routeAction).toHaveBeenCalledWith('paper', expect.anything());
  });

  it('maps "revise" next_action to revision', async () => {
    const profile = makeProfile({ next_action: 'revise' });
    mockSchoolAdapter.getProfile.mockResolvedValue(profile);

    await runOneCycle(BASE_CTX);

    expect(routeAction).toHaveBeenCalledWith('revision', expect.anything());
  });

  it('maps "file_bounty" next_action to bounty', async () => {
    const profile = makeProfile({ next_action: 'file_bounty' });
    mockSchoolAdapter.getProfile.mockResolvedValue(profile);

    await runOneCycle(BASE_CTX);

    expect(routeAction).toHaveBeenCalledWith('bounty', expect.anything());
  });

  it('maps "respond" next_action to respond', async () => {
    const profile = makeProfile({ next_action: 'respond' });
    mockSchoolAdapter.getProfile.mockResolvedValue(profile);

    await runOneCycle(BASE_CTX);

    expect(routeAction).toHaveBeenCalledWith('respond', expect.anything());
  });

  it('maps "rebut" next_action to rebut', async () => {
    const profile = makeProfile({ next_action: 'rebut' });
    mockSchoolAdapter.getProfile.mockResolvedValue(profile);

    await runOneCycle(BASE_CTX);

    expect(routeAction).toHaveBeenCalledWith('rebut', expect.anything());
  });

  it('maps unknown next_action to review (default)', async () => {
    const profile = makeProfile({ next_action: 'something_unknown' as any });
    mockSchoolAdapter.getProfile.mockResolvedValue(profile);

    await runOneCycle(BASE_CTX);

    expect(routeAction).toHaveBeenCalledWith('review', expect.anything());
  });

  it('selects reaffirmation when next_action is review but can_reaffirm is true', async () => {
    const profile = makeProfile({
      next_action: 'review',
      can_reaffirm: true,
    });
    mockSchoolAdapter.getProfile.mockResolvedValue(profile);

    await runOneCycle(BASE_CTX);

    expect(routeAction).toHaveBeenCalledWith('reaffirmation', expect.anything());
  });

  it('selects review (not reaffirmation) when next_action is review and can_reaffirm is false', async () => {
    const profile = makeProfile({
      next_action: 'review',
      can_reaffirm: false,
    });
    mockSchoolAdapter.getProfile.mockResolvedValue(profile);

    await runOneCycle(BASE_CTX);

    expect(routeAction).toHaveBeenCalledWith('review', expect.anything());
  });
});

// =============================================================================
// Grade payment gate
// =============================================================================

describe('grade payment gate', () => {
  it('pauses bot when grade is not unlocked', async () => {
    const profile = makeProfile({ grade: { grade: 3 } as any });
    mockSchoolAdapter.getProfile.mockResolvedValue(profile);
    mockIsBotGradeUnlocked.mockResolvedValue(false);
    mockQueryOne.mockResolvedValue({ name: 'TestBot' });

    await runOneCycle(BASE_CTX);

    expect(mockSetBotStatus).toHaveBeenCalledWith(
      'bot-1', 'paused', expect.stringContaining('Grade 3'),
    );
    expect(routeAction).not.toHaveBeenCalled();
  });

  it('sends grade payment notification when paused', async () => {
    const profile = makeProfile({ grade: { grade: 4 } as any });
    mockSchoolAdapter.getProfile.mockResolvedValue(profile);
    mockIsBotGradeUnlocked.mockResolvedValue(false);
    mockQueryOne.mockResolvedValue({ name: 'MyBot' });

    await runOneCycle(BASE_CTX);

    expect(mockNotifyGradePaymentNeeded).toHaveBeenCalledWith(
      'user-1', 'bot-1', 'MyBot', 4, 499,
    );
  });

  it('continues normally when grade is unlocked', async () => {
    const profile = makeProfile();
    mockSchoolAdapter.getProfile.mockResolvedValue(profile);
    mockIsBotGradeUnlocked.mockResolvedValue(true);

    await runOneCycle(BASE_CTX);

    expect(mockSetBotStatus).not.toHaveBeenCalledWith(
      expect.anything(), 'paused', expect.anything(),
    );
    expect(routeAction).toHaveBeenCalled();
  });

  it('defaults to grade 1 when grade data is missing', async () => {
    const profile = makeProfile({ grade: undefined as any });
    mockSchoolAdapter.getProfile.mockResolvedValue(profile);

    await runOneCycle(BASE_CTX);

    expect(mockIsBotGradeUnlocked).toHaveBeenCalledWith('bot-1', 1);
  });
});

// =============================================================================
// Milestone detection
// =============================================================================

describe('milestone detection', () => {
  it('calls checkAndNotifyMilestones after successful cycle', async () => {
    const profile = makeProfile();
    mockSchoolAdapter.getProfile.mockResolvedValue(profile);

    await runOneCycle(BASE_CTX);

    expect(mockCheckAndNotifyMilestones).toHaveBeenCalledWith(
      'user-1',
      'bot-1',
      'Your bot',    // fallback name when cache is null
      null,          // old credibility (null — no cached data)
      105,           // new credibility from profile
      null,          // old grade
      2,             // new grade from profile
      null,          // old tier
      1,             // new tier (credibilityToStage(105) = 1)
      'review',      // action type
      expect.any(Object), // raw response
      expect.objectContaining({ botId: 'bot-1' }), // voice context
    );
  });

  it('milestone notification failure does not break the cycle', async () => {
    const profile = makeProfile();
    mockSchoolAdapter.getProfile.mockResolvedValue(profile);
    mockCheckAndNotifyMilestones.mockRejectedValue(new Error('Notification service down'));

    // Should NOT throw
    await runOneCycle(BASE_CTX);

    expect(routeAction).toHaveBeenCalled();
  });
});

// =============================================================================
// Condensation threshold
// =============================================================================

describe('condensation threshold', () => {
  it('does not trigger condensation when uncondensed_exercises < 5', async () => {
    const profile = makeProfile({
      skill_condenser: { exercises: ['ex1'] } as any,
    });
    mockSchoolAdapter.getProfile.mockResolvedValue(profile);

    (routeAction as ReturnType<typeof vi.fn>).mockResolvedValue({
      rawRequest: {},
      rawResponse: { success: true },
      translated: { headline: 'Done', summary: '', details: [], mood: 'neutral' },
      exercises: null,
      memoryPrompts: { uncondensed_exercises: 4 },
      tokensUsed: 500,
    });

    await runOneCycle(BASE_CTX);

    expect(mockLLMAdapter.chat).not.toHaveBeenCalled();
    expect(mockSchoolAdapter.submitCondensation).not.toHaveBeenCalled();
  });

  it('triggers condensation when uncondensed_exercises >= 5', async () => {
    const profile = makeProfile({
      skill_condenser: { exercises: ['ex1'] } as any,
    });
    mockSchoolAdapter.getProfile.mockResolvedValue(profile);

    (routeAction as ReturnType<typeof vi.fn>).mockResolvedValue({
      rawRequest: {},
      rawResponse: { success: true },
      translated: { headline: 'Done', summary: '', details: [], mood: 'neutral' },
      exercises: null,
      memoryPrompts: { uncondensed_exercises: 5 },
      tokensUsed: 500,
    });
    mockSchoolAdapter.submitCondensation.mockResolvedValue({ success: true });
    mockLLMAdapter.chat.mockResolvedValueOnce({
      content: JSON.stringify({ paragraph: 'Condensed.' }),
      tokens_used: 200,
      model: 'claude-opus-4-6',
      stop_reason: 'end_turn',
    });

    await runOneCycle(BASE_CTX);

    expect(mockSchoolAdapter.submitCondensation).toHaveBeenCalled();
  });

  it('triggers core condensation when core_condenser is present', async () => {
    const profile = makeProfile({
      core_condenser: { paragraphs: ['p1', 'p2'] } as any,
    });
    mockSchoolAdapter.getProfile.mockResolvedValue(profile);

    (routeAction as ReturnType<typeof vi.fn>).mockResolvedValue({
      rawRequest: {},
      rawResponse: { success: true },
      translated: { headline: 'Done', summary: '', details: [], mood: 'neutral' },
      exercises: null,
      memoryPrompts: { uncondensed_exercises: 5 },
      tokensUsed: 500,
    });
    mockSchoolAdapter.submitCoreCondensation.mockResolvedValue({ success: true });
    mockLLMAdapter.chat.mockResolvedValueOnce({
      content: JSON.stringify({ core_identity: 'I am a careful reasoner who...' }),
      tokens_used: 500,
      model: 'claude-opus-4-6',
      stop_reason: 'end_turn',
    });

    await runOneCycle(BASE_CTX);

    expect(mockStoreCore).toHaveBeenCalledWith(
      'bot-1', 'I am a careful reasoner who...', 'cycle-1',
    );
    expect(mockSchoolAdapter.submitCoreCondensation).toHaveBeenCalled();
  });

  it('triggers self-authoring after condensation occurs', async () => {
    const profile = makeProfile({
      skill_condenser: { exercises: ['ex1'] } as any,
    });
    mockSchoolAdapter.getProfile.mockResolvedValue(profile);

    (routeAction as ReturnType<typeof vi.fn>).mockResolvedValue({
      rawRequest: {},
      rawResponse: { success: true },
      translated: { headline: 'Done', summary: '', details: [], mood: 'neutral' },
      exercises: null,
      memoryPrompts: { uncondensed_exercises: 5 },
      tokensUsed: 500,
    });
    mockSchoolAdapter.submitCondensation.mockResolvedValue({ success: true });

    // First LLM call: skill condensation, second: self-authoring
    mockLLMAdapter.chat
      .mockResolvedValueOnce({
        content: JSON.stringify({ paragraph: 'Condensed.' }),
        tokens_used: 200,
        model: 'claude-opus-4-6',
        stop_reason: 'end_turn',
      })
      .mockResolvedValueOnce({
        content: JSON.stringify({ self_authored_block: 'I am a bot that values evidence...' }),
        tokens_used: 300,
        model: 'claude-opus-4-6',
        stop_reason: 'end_turn',
      });

    await runOneCycle(BASE_CTX);

    expect(mockStoreSelfAuthored).toHaveBeenCalledWith(
      'bot-1', 'I am a bot that values evidence...', 'skill',
    );
  });

  it('does not trigger self-authoring when no condensation occurred', async () => {
    const profile = makeProfile(); // no condenser data
    mockSchoolAdapter.getProfile.mockResolvedValue(profile);

    (routeAction as ReturnType<typeof vi.fn>).mockResolvedValue({
      rawRequest: {},
      rawResponse: { success: true },
      translated: { headline: 'Done', summary: '', details: [], mood: 'neutral' },
      exercises: null,
      memoryPrompts: { uncondensed_exercises: 5 },
      tokensUsed: 500,
    });

    await runOneCycle(BASE_CTX);

    expect(mockStoreSelfAuthored).not.toHaveBeenCalled();
  });
});

// =============================================================================
// Data retention cleanup
// =============================================================================

describe('data retention', () => {
  it('runs cleanup every 50 cycles', async () => {
    const profile = makeProfile();
    mockSchoolAdapter.getProfile.mockResolvedValue(profile);

    await runOneCycle({ ...BASE_CTX, cycleNumber: 50 });

    expect(cleanupOldMessages).toHaveBeenCalledWith('bot-1', 500);
    // Should have queries for soft-deleted activity (30 days) and audit log (90 days)
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('deleted_at'),
      ['bot-1'],
    );
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('audit_log'),
      ['user-1'],
    );
  });

  it('does not run cleanup on non-50th cycles', async () => {
    const profile = makeProfile();
    mockSchoolAdapter.getProfile.mockResolvedValue(profile);

    await runOneCycle({ ...BASE_CTX, cycleNumber: 49 });

    expect(cleanupOldMessages).not.toHaveBeenCalled();
  });

  it('cleanup failures do not break the cycle', async () => {
    const profile = makeProfile();
    mockSchoolAdapter.getProfile.mockResolvedValue(profile);
    (cleanupOldMessages as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('DB timeout'));

    // Should NOT throw
    await runOneCycle({ ...BASE_CTX, cycleNumber: 50 });

    expect(routeAction).toHaveBeenCalled();
  });
});

// =============================================================================
// Error handling
// =============================================================================

describe('error handling', () => {
  it('logs error activity when school adapter throws', async () => {
    mockSchoolAdapter.getProfile.mockRejectedValue(new Error('School API timeout'));

    await expect(runOneCycle(BASE_CTX)).rejects.toThrow('School API timeout');

    expect(mockLogActivity).toHaveBeenCalledWith(
      'bot-1', 1, 'error', null, null,
      expect.objectContaining({ headline: 'Cycle error' }),
      expect.any(Number), undefined,
      expect.stringContaining('School API timeout'),
    );
  });

  it('sets error status on 401 auth failures', async () => {
    mockSchoolAdapter.getProfile.mockRejectedValue(new Error('School returned 401 Unauthorized'));

    await expect(runOneCycle(BASE_CTX)).rejects.toThrow('401');

    expect(mockSetBotStatus).toHaveBeenCalledWith(
      'bot-1', 'error', expect.stringContaining('401'),
    );
  });

  it('sets error status on 403 auth failures', async () => {
    mockSchoolAdapter.getProfile.mockRejectedValue(new Error('School returned 403 Forbidden'));

    await expect(runOneCycle(BASE_CTX)).rejects.toThrow('403');

    expect(mockSetBotStatus).toHaveBeenCalledWith(
      'bot-1', 'error', expect.stringContaining('403'),
    );
  });

  it('does not set error status for non-auth failures', async () => {
    mockSchoolAdapter.getProfile.mockRejectedValue(new Error('Network timeout'));

    await expect(runOneCycle(BASE_CTX)).rejects.toThrow('Network timeout');

    expect(mockSetBotStatus).not.toHaveBeenCalledWith(
      expect.anything(), 'error', expect.anything(),
    );
  });

  it('sets error status when not enrolled', async () => {
    mockGetDecryptedSchoolKey.mockResolvedValue(null);

    await runOneCycle(BASE_CTX);

    expect(mockSetBotStatus).toHaveBeenCalledWith('bot-1', 'error', 'Not enrolled in any school');
    expect(routeAction).not.toHaveBeenCalled();
  });
});

// =============================================================================
// Memory storage
// =============================================================================

describe('memory storage', () => {
  it('stores exercises when action result includes them', async () => {
    const profile = makeProfile();
    mockSchoolAdapter.getProfile.mockResolvedValue(profile);

    const exercises = { interaction_type: 'review', exercises: [{ skill: 'Test', outcome: 'SUCCESS' }] };
    (routeAction as ReturnType<typeof vi.fn>).mockResolvedValue({
      rawRequest: { overall_assessment: 'Good', score: 72 },
      rawResponse: { success: true },
      translated: { headline: 'Reviewed', summary: '+3', details: [], mood: 'positive' },
      exercises,
      memoryPrompts: { uncondensed_exercises: 2 },
      tokensUsed: 1000,
    });

    await runOneCycle(BASE_CTX);

    expect(mockStoreExercise).toHaveBeenCalledWith(
      'bot-1', 1, 'review',
      expect.objectContaining({ interaction_type: 'review' }),
      expect.anything(),
    );
  });

  it('skips exercise storage when exercises are null', async () => {
    const profile = makeProfile();
    mockSchoolAdapter.getProfile.mockResolvedValue(profile);

    (routeAction as ReturnType<typeof vi.fn>).mockResolvedValue({
      rawRequest: {},
      rawResponse: { success: true },
      translated: { headline: 'Done', summary: '', details: [], mood: 'neutral' },
      exercises: null,
      memoryPrompts: { uncondensed_exercises: 0 },
      tokensUsed: 500,
    });

    await runOneCycle(BASE_CTX);

    expect(mockStoreExercise).not.toHaveBeenCalled();
  });
});

// =============================================================================
// Bot cache update
// =============================================================================

describe('bot cache update', () => {
  it('updates bot cache with profile data after cycle', async () => {
    const profile = makeProfile({
      agent: { id: 'a-1', handle: 'test-bot', credibility_score: 150, total_papers_submitted: 5, registration_review_passed: true },
      grade: { grade: 3 } as any,
      next_action: 'submit_paper',
    });
    mockSchoolAdapter.getProfile.mockResolvedValue(profile);

    await runOneCycle({ ...BASE_CTX, cycleNumber: 10 });

    // Look for the UPDATE bots query
    const updateCall = mockQuery.mock.calls.find(
      (call: any[]) => typeof call[0] === 'string' && call[0].includes('UPDATE bots SET'),
    );
    expect(updateCall).toBeDefined();
    expect(updateCall![1]).toContain(150); // credibility
    expect(updateCall![1]).toContain(10);  // cycle number
  });

  it('skips cache update for invalid profile shape', async () => {
    const profile = makeProfile({
      agent: undefined as any,
    });
    mockSchoolAdapter.getProfile.mockResolvedValue(profile);

    // This will throw because determineAction runs before cache update,
    // but the updateBotCache itself should be guarded
    // Let's test via a profile with agent but no credibility_score
    const badProfile = makeProfile();
    (badProfile.agent as any).credibility_score = undefined;
    mockSchoolAdapter.getProfile.mockResolvedValue(badProfile);

    // The cycle will still complete since routeAction is mocked
    await runOneCycle(BASE_CTX);

    // The UPDATE bots query should still be called, but updateBotCache
    // has a guard for invalid profile shape
    const updateCalls = mockQuery.mock.calls.filter(
      (call: any[]) => typeof call[0] === 'string' && call[0].includes('UPDATE bots SET') && call[0].includes('cached_credibility'),
    );
    // With undefined credibility_score, the guard should skip
    expect(updateCalls.length).toBe(0);
  });
});
