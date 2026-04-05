import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock deps ───────────────────────────────────────────────────────────────

vi.mock('../../lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../services/activity.service', () => ({
  translateReview: vi.fn((_result: any, title: string) => ({
    headline: `Reviewed "${title}"`,
    summary: 'Review submitted.',
    details: [],
    mood: 'neutral' as const,
  })),
  translatePaper: vi.fn((_result: any, title: string) => ({
    headline: `Wrote "${title}"`,
    summary: 'Paper submitted.',
    details: [],
    mood: 'positive' as const,
  })),
  translateBounty: vi.fn((_result: any, title: string) => ({
    headline: `Challenged "${title}"`,
    summary: 'Bounty submitted.',
    details: [],
    mood: 'neutral' as const,
  })),
}));

// Mock tool-schemas — validateToolInput returns no errors and does not mutate
vi.mock('../../runtime/tool-schemas', () => ({
  REVIEW_TOOL: { name: 'submit_review', description: 'Submit review', input_schema: { type: 'object' } },
  PAPER_TOOL: { name: 'submit_paper', description: 'Submit paper', input_schema: { type: 'object' } },
  BOUNTY_TOOL: { name: 'submit_bounty', description: 'Submit bounty', input_schema: { type: 'object' } },
  REVISION_TOOL: { name: 'submit_revision', description: 'Submit revision', input_schema: { type: 'object' } },
  RESPONSE_TOOL: { name: 'submit_response', description: 'Submit response', input_schema: { type: 'object' } },
  validateToolInput: vi.fn(() => []),
}));

// Mock prompt-builder
vi.mock('../../runtime/prompt-builder', () => ({
  buildPrompt: vi.fn(() => [{ role: 'system', content: 'test' }, { role: 'user', content: 'do task' }]),
}));

import { routeAction, type ActionContext } from '../../runtime/action-router';

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeMockSchoolAdapter(overrides?: Record<string, any>) {
  return {
    getReviewablePapers: vi.fn().mockResolvedValue([
      { id: 'paper-1', title: 'Test Paper', abstract: 'Abstract text', body: 'Body text' },
    ]),
    submitReview: vi.fn().mockResolvedValue({ success: true, skill_exercises: { test: 1 }, memory_prompts: null }),
    submitPaper: vi.fn().mockResolvedValue({ success: true, skill_exercises: null }),
    submitBounty: vi.fn().mockResolvedValue({ success: true, skill_exercises: null }),
    submitRevision: vi.fn().mockResolvedValue({ success: true, skill_exercises: null }),
    submitReaffirmation: vi.fn().mockResolvedValue({ success: true, credibility_change: 5 }),
    submitResponse: vi.fn().mockResolvedValue({ success: true, skill_exercises: null }),
    ...overrides,
  };
}

function makeMockLLMAdapter() {
  return {
    chat: vi.fn().mockResolvedValue({
      content: '{}',
      tokens_used: 100,
      model: 'claude-opus-4-6',
      stop_reason: 'end_turn',
      tool_calls: [{ name: 'submit_review', input: { overall_assessment: 'Good work', score: 75 } }],
    }),
  };
}

function makeContext(overrides?: Partial<ActionContext>): ActionContext {
  return {
    schoolAdapter: makeMockSchoolAdapter() as any,
    llmAdapter: makeMockLLMAdapter() as any,
    llmKey: 'test-key',
    llmModel: 'claude-opus-4-6',
    schoolCreds: { baseUrl: 'http://school', apiKey: 'key', handle: 'bot-1' },
    profile: {
      agent: { id: 'a1', handle: 'bot-1', credibility_score: 50, total_papers_submitted: 3, registration_review_passed: true },
      tier_info: 'Tier 1',
      next_action: 'review',
      can_submit_paper: true,
      can_revise: false,
      reviews_completed: 5,
      valid_bounties: 2,
      original_papers_submitted: 3,
      revisions_submitted: 1,
      coaching: null,
      active_focus: null,
      skill_profile: null,
      skill_condenser: null,
      core_condenser: null,
      forge_condenser: null,
      forge_core_condenser: null,
      forge_master_condenser: null,
      can_forge: false,
      identity_core: null,
      identity_reflection: null,
      grade: { grade: 2, best_score_this_grade: 65 } as any,
      recent_feedback: null,
      can_reaffirm: false,
      can_respond: false,
      can_rebut: false,
    },
    botId: 'bot-1',
    cycleNumber: 10,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// =============================================================================
// routeAction — dispatch
// =============================================================================

describe('routeAction', () => {
  it('routes "review" to executeReview', async () => {
    const ctx = makeContext();
    const result = await routeAction('review', ctx);

    expect(ctx.schoolAdapter.getReviewablePapers).toHaveBeenCalled();
    expect(ctx.schoolAdapter.submitReview).toHaveBeenCalled();
    expect(result.translated.headline).toContain('Reviewed');
  });

  it('routes "paper" to executePaper', async () => {
    const ctx = makeContext();
    (ctx.llmAdapter.chat as any).mockResolvedValueOnce({
      content: '{}',
      tokens_used: 200,
      model: 'claude-opus-4-6',
      stop_reason: 'end_turn',
      tool_calls: [{ name: 'submit_paper', input: { title: 'My Paper', body: 'Content' } }],
    });

    const result = await routeAction('paper', ctx);

    expect(ctx.schoolAdapter.submitPaper).toHaveBeenCalled();
    expect(result.translated.headline).toContain('Wrote');
  });

  it('routes "bounty" to executeBounty', async () => {
    const ctx = makeContext();
    const result = await routeAction('bounty', ctx);

    expect(ctx.schoolAdapter.getReviewablePapers).toHaveBeenCalled();
    expect(ctx.schoolAdapter.submitBounty).toHaveBeenCalled();
    expect(result.translated.headline).toContain('Challenged');
  });

  it('routes unknown actions to review as fallback', async () => {
    const ctx = makeContext();
    const result = await routeAction('unknown_action', ctx);

    expect(ctx.schoolAdapter.getReviewablePapers).toHaveBeenCalled();
    expect(ctx.schoolAdapter.submitReview).toHaveBeenCalled();
  });

  it('routes "reaffirmation" and returns early when no papers', async () => {
    const ctx = makeContext();
    ctx.profile.reaffirmable_papers = [];

    const result = await routeAction('reaffirmation', ctx);

    expect(result.translated.headline).toContain('No papers to reaffirm');
    expect(result.rawRequest).toBeNull();
  });

  it('routes "reaffirmation" and submits when papers exist', async () => {
    const ctx = makeContext();
    ctx.profile.reaffirmable_papers = [{ id: 'p1', title: 'Paper 1', effective_score: 70 }];

    const result = await routeAction('reaffirmation', ctx);

    expect(ctx.schoolAdapter.submitReaffirmation).toHaveBeenCalledWith(ctx.schoolCreds, 'p1');
    expect(result.translated.headline).toContain('Reaffirmed');
    expect(result.translated.summary).toContain('+5 credibility');
  });

  it('routes "respond" and returns early when no respondable papers', async () => {
    const ctx = makeContext();
    ctx.profile.respondable_papers = [];

    const result = await routeAction('respond', ctx);

    expect(result.translated.headline).toContain('No papers to respond');
    expect(result.rawRequest).toBeNull();
  });

  it('routes "respond" and submits when papers exist', async () => {
    const ctx = makeContext();
    ctx.profile.respondable_papers = [{ id: 'p1', title: 'Bad Paper', abstract: 'Abs', my_review_score: 3 }];
    (ctx.llmAdapter.chat as any).mockResolvedValueOnce({
      content: '{}',
      tokens_used: 300,
      model: 'claude-opus-4-6',
      stop_reason: 'end_turn',
      tool_calls: [{ name: 'submit_response', input: { title: 'Response', abstract: 'Abs', body: 'Body', stance: 'rebut' } }],
    });

    const result = await routeAction('respond', ctx);

    expect(ctx.schoolAdapter.submitResponse).toHaveBeenCalledWith(ctx.schoolCreds, 'p1', expect.any(Object));
    expect(result.translated.headline).toContain('Responded');
  });

  it('routes "rebut" and returns early when no rebuttable papers', async () => {
    const ctx = makeContext();
    ctx.profile.rebuttable_papers = [];

    const result = await routeAction('rebut', ctx);

    expect(result.translated.headline).toContain('No papers to rebut');
  });

  it('routes "rebut" and includes attack count in summary', async () => {
    const ctx = makeContext();
    ctx.profile.rebuttable_papers = [{
      id: 'p1',
      title: 'My Paper',
      low_reviews: [{ score: 3, assessment: 'Bad' }],
      bounties: [{ challenge_type: 'methodology', score_drop: 10 }],
    }];
    (ctx.llmAdapter.chat as any).mockResolvedValueOnce({
      content: '{}',
      tokens_used: 300,
      model: 'claude-opus-4-6',
      stop_reason: 'end_turn',
      tool_calls: [{ name: 'submit_response', input: { title: 'Rebuttal', abstract: 'Abs', body: 'Body', stance: 'rebut' } }],
    });

    const result = await routeAction('rebut', ctx);

    expect(result.translated.summary).toContain('2 attacks');
  });

  it('routes "revision" and returns early when no reaffirmable papers', async () => {
    const ctx = makeContext();
    ctx.profile.reaffirmable_papers = [];

    const result = await routeAction('revision', ctx);

    expect(result.translated.headline).toContain('No papers to revise');
    expect(result.tokensUsed).toBe(0);
  });

  it('routes "revision" and submits when papers exist', async () => {
    const ctx = makeContext();
    ctx.profile.reaffirmable_papers = [{ id: 'p1', title: 'Paper', effective_score: 50 }];

    const result = await routeAction('revision', ctx);

    expect(ctx.schoolAdapter.submitRevision).toHaveBeenCalledWith(ctx.schoolCreds, 'p1', expect.any(Object));
    expect(result.translated.headline).toBe('Revised paper');
  });
});

// =============================================================================
// Review — no papers available
// =============================================================================

describe('executeReview — empty paper list', () => {
  it('returns neutral waiting message when no papers', async () => {
    const adapter = makeMockSchoolAdapter({ getReviewablePapers: vi.fn().mockResolvedValue([]) });
    const ctx = makeContext({ schoolAdapter: adapter as any });

    const result = await routeAction('review', ctx);

    expect(result.translated.headline).toBe('No papers to review');
    expect(result.rawRequest).toBeNull();
    expect(result.rawResponse).toBeNull();
  });
});

// =============================================================================
// Bounty — no papers available
// =============================================================================

describe('executeBounty — empty paper list', () => {
  it('returns neutral message when no papers to challenge', async () => {
    const adapter = makeMockSchoolAdapter({ getReviewablePapers: vi.fn().mockResolvedValue([]) });
    const ctx = makeContext({ schoolAdapter: adapter as any });

    const result = await routeAction('bounty', ctx);

    expect(result.translated.headline).toBe('No papers to challenge');
  });
});

// =============================================================================
// Tool call extraction fallback
// =============================================================================

describe('tool call extraction fallback', () => {
  it('falls back to JSON parsing from content when no tool_calls', async () => {
    const ctx = makeContext();
    (ctx.llmAdapter.chat as any).mockResolvedValueOnce({
      content: '{"overall_assessment": "Parsed from content", "score": 60}',
      tokens_used: 50,
      model: 'claude-opus-4-6',
      stop_reason: 'end_turn',
      // No tool_calls
    });

    const result = await routeAction('review', ctx);

    expect(ctx.schoolAdapter.submitReview).toHaveBeenCalledWith(
      ctx.schoolCreds,
      'paper-1',
      expect.objectContaining({ overall_assessment: 'Parsed from content', score: 60 }),
    );
  });

  it('uses fallback defaults when content is not valid JSON and no tool_calls', async () => {
    const ctx = makeContext();
    (ctx.llmAdapter.chat as any).mockResolvedValueOnce({
      content: 'This is just text, not JSON',
      tokens_used: 50,
      model: 'claude-opus-4-6',
      stop_reason: 'end_turn',
    });

    const result = await routeAction('review', ctx);

    // Should fall back to { overall_assessment: content, score: 50 }
    expect(ctx.schoolAdapter.submitReview).toHaveBeenCalledWith(
      ctx.schoolCreds,
      'paper-1',
      expect.objectContaining({ overall_assessment: 'This is just text, not JSON', score: 50 }),
    );
  });
});

// =============================================================================
// exercises and memoryPrompts extraction
// =============================================================================

describe('exercises and memoryPrompts', () => {
  it('extracts skill_exercises from school response', async () => {
    const ctx = makeContext();

    const result = await routeAction('review', ctx);

    expect(result.exercises).toEqual({ test: 1 });
  });

  it('extracts memory_prompts from school response', async () => {
    const adapter = makeMockSchoolAdapter({
      submitReview: vi.fn().mockResolvedValue({
        success: true,
        skill_exercises: null,
        memory_prompts: { desk_prompt: 'Focus on methodology' },
      }),
    });
    const ctx = makeContext({ schoolAdapter: adapter as any });

    const result = await routeAction('review', ctx);

    expect(result.memoryPrompts).toEqual({ desk_prompt: 'Focus on methodology' });
  });

  it('returns undefined exercises when skill_exercises is null', async () => {
    const adapter = makeMockSchoolAdapter({
      submitReview: vi.fn().mockResolvedValue({ success: true, skill_exercises: null }),
    });
    const ctx = makeContext({ schoolAdapter: adapter as any });

    const result = await routeAction('review', ctx);

    expect(result.exercises).toBeUndefined();
  });
});
