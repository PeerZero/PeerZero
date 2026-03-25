// =============================================================================
// Action router — dispatches bot actions to the right handler
// Each action: build prompt → call LLM (with tool use) → submit to School → translate
//
// Uses LLM tool use for structured output — the LLM returns validated,
// typed data via tool calls instead of raw JSON strings. Falls back to
// JSON parsing from content if the LLM doesn't return tool calls.
// =============================================================================

import { ISchoolAdapter, SchoolCredentials } from '../adapters/school.adapter';
import { ILLMAdapter, LLMResponse } from '../adapters/llm.adapter';
import { buildPrompt } from './prompt-builder';
import type { ActiveSkillDirective } from './prompt-builder';
import { REVIEW_TOOL, PAPER_TOOL, BOUNTY_TOOL, REVISION_TOOL, RESPONSE_TOOL, validateToolInput } from './tool-schemas';
import * as activity from '../services/activity.service';
import type { SchoolProfile, SchoolPaper, TranslatedActivity, SchoolSkillExercises, SchoolMemoryPrompts } from '@peerzero/shared';

export interface ActionContext {
  schoolAdapter: ISchoolAdapter;
  llmAdapter: ILLMAdapter;
  llmKey: string;
  llmModel: string;
  extendedThinking?: boolean;  // User opt-in for Claude extended thinking
  schoolCreds: SchoolCredentials;
  profile: SchoolProfile;
  botId: string;
  cycleNumber: number;
  selfAuthoredBlock?: string | null;  // Decrypted self-authored identity for prompt injection
  activeSkills?: ActiveSkillDirective[];  // Natural language skill directives
}

export interface ActionResult {
  rawRequest: Record<string, unknown> | null;
  rawResponse: Record<string, unknown> | null;
  translated: TranslatedActivity;
  tokensUsed?: number;
  exercises?: Record<string, unknown>;
  memoryPrompts?: SchoolMemoryPrompts;
}

/**
 * Validate tool input and log warnings for any constraint violations.
 * Clamping (e.g., score out of range) is applied in-place.
 * Returns the (possibly mutated) input — non-blocking.
 */
function validateAndWarn(toolName: string, input: Record<string, unknown>): Record<string, unknown> {
  const errors = validateToolInput(toolName, input);
  if (errors.length > 0) {
    console.warn(`[action-router] Tool validation warnings for ${toolName}:`, errors);
  }
  return input;
}

/**
 * Extract structured data from an LLM response.
 * Prefers tool_calls (structured output) over raw content parsing.
 */
function extractToolInput(response: LLMResponse, fallback: Record<string, unknown>): Record<string, unknown> {
  // Prefer structured tool call output
  if (response.tool_calls?.length) {
    return response.tool_calls[0].input;
  }
  // Fallback: parse JSON from content (for backward compat with models that don't support tools)
  try {
    const parsed = JSON.parse(response.content);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

export async function routeAction(actionType: string, ctx: ActionContext): Promise<ActionResult> {
  switch (actionType) {
    case 'review': return executeReview(ctx);
    case 'paper': return executePaper(ctx);
    case 'bounty': return executeBounty(ctx);
    case 'revision': return executeRevision(ctx);
    case 'reaffirmation': return executeReaffirmation(ctx);
    case 'respond': return executeResponse(ctx);
    case 'rebut': return executeRebuttal(ctx);
    default: return executeReview(ctx); // fallback
  }
}

async function executeReview(ctx: ActionContext): Promise<ActionResult> {
  // Get a paper to review
  const papers = await ctx.schoolAdapter.getReviewablePapers(ctx.schoolCreds);
  if (papers.length === 0) {
    return {
      rawRequest: null,
      rawResponse: null,
      translated: { headline: 'No papers to review', summary: 'Waiting for papers.', details: [], mood: 'neutral' },
    };
  }

  const paper = papers[0]; // Pick first available
  const messages = buildPrompt('review', { profile: ctx.profile, paper, selfAuthoredBlock: ctx.selfAuthoredBlock, activeSkills: ctx.activeSkills });
  const llmResponse = await ctx.llmAdapter.chat(ctx.llmKey, ctx.llmModel, messages, {
    tools: [REVIEW_TOOL],
    extendedThinking: ctx.extendedThinking,
  });

  const reviewContent = validateAndWarn('submit_review', extractToolInput(llmResponse, { overall_assessment: llmResponse.content, score: 50 }));

  const schoolResult = await ctx.schoolAdapter.submitReview(ctx.schoolCreds, paper.id, reviewContent);
  if (!schoolResult || typeof schoolResult !== 'object') {
    throw new Error('Invalid response from School API');
  }

  return {
    rawRequest: reviewContent,
    rawResponse: schoolResult as unknown as Record<string, unknown>,
    translated: activity.translateReview(schoolResult, paper.title),
    tokensUsed: llmResponse.tokens_used,
    exercises: schoolResult.skill_exercises as unknown as Record<string, unknown>,
    memoryPrompts: schoolResult.memory_prompts,
  };
}

async function executePaper(ctx: ActionContext): Promise<ActionResult> {
  const messages = buildPrompt('paper', { profile: ctx.profile, selfAuthoredBlock: ctx.selfAuthoredBlock, activeSkills: ctx.activeSkills });
  const llmResponse = await ctx.llmAdapter.chat(ctx.llmKey, ctx.llmModel, messages, {
    tools: [PAPER_TOOL],
    extendedThinking: ctx.extendedThinking,
  });

  const paperContent = validateAndWarn('submit_paper', extractToolInput(llmResponse, { title: 'Untitled', abstract: llmResponse.content, body: llmResponse.content }));

  const schoolResult = await ctx.schoolAdapter.submitPaper(ctx.schoolCreds, paperContent);
  if (!schoolResult || typeof schoolResult !== 'object') {
    throw new Error('Invalid response from School API');
  }

  return {
    rawRequest: paperContent,
    rawResponse: schoolResult as unknown as Record<string, unknown>,
    translated: activity.translatePaper(schoolResult, (paperContent.title as string) || 'Untitled'),
    tokensUsed: llmResponse.tokens_used,
    exercises: schoolResult.skill_exercises as unknown as Record<string, unknown>,
    memoryPrompts: schoolResult.memory_prompts,
  };
}

async function executeBounty(ctx: ActionContext): Promise<ActionResult> {
  const papers = await ctx.schoolAdapter.getReviewablePapers(ctx.schoolCreds);
  if (papers.length === 0) {
    return {
      rawRequest: null,
      rawResponse: null,
      translated: { headline: 'No papers to challenge', summary: 'No eligible papers.', details: [], mood: 'neutral' },
    };
  }

  const paper = papers[0];
  const messages = buildPrompt('bounty', { profile: ctx.profile, paper, selfAuthoredBlock: ctx.selfAuthoredBlock, activeSkills: ctx.activeSkills });
  const llmResponse = await ctx.llmAdapter.chat(ctx.llmKey, ctx.llmModel, messages, {
    tools: [BOUNTY_TOOL],
    extendedThinking: ctx.extendedThinking,
  });

  const bountyContent = validateAndWarn('submit_bounty', extractToolInput(llmResponse, { challenge_type: 'methodology', evidence: llmResponse.content }));

  const schoolResult = await ctx.schoolAdapter.submitBounty(ctx.schoolCreds, paper.id, bountyContent);
  if (!schoolResult || typeof schoolResult !== 'object') {
    throw new Error('Invalid response from School API');
  }

  return {
    rawRequest: bountyContent,
    rawResponse: schoolResult as unknown as Record<string, unknown>,
    translated: activity.translateBounty(schoolResult, paper.title),
    tokensUsed: llmResponse.tokens_used,
    exercises: schoolResult.skill_exercises as unknown as Record<string, unknown>,
    memoryPrompts: schoolResult.memory_prompts,
  };
}

async function executeRevision(ctx: ActionContext): Promise<ActionResult> {
  // Check for revisable papers first to avoid wasting an LLM call
  const reaffirmable = ctx.profile.reaffirmable_papers || [];
  if (reaffirmable.length === 0) {
    return {
      rawRequest: null,
      rawResponse: null,
      translated: { headline: 'No papers to revise', summary: 'No eligible papers for revision.', details: [], mood: 'neutral' },
      tokensUsed: 0,
    };
  }
  const paperId = reaffirmable[0].id;

  const messages = buildPrompt('revision', { profile: ctx.profile, selfAuthoredBlock: ctx.selfAuthoredBlock, activeSkills: ctx.activeSkills });
  const llmResponse = await ctx.llmAdapter.chat(ctx.llmKey, ctx.llmModel, messages, {
    tools: [REVISION_TOOL],
    extendedThinking: ctx.extendedThinking,
  });

  const revisionContent = validateAndWarn('submit_revision', extractToolInput(llmResponse, { body: llmResponse.content, revision_notes: 'Revised based on feedback' }));

  const schoolResult = await ctx.schoolAdapter.submitRevision(ctx.schoolCreds, paperId, revisionContent);
  if (!schoolResult || typeof schoolResult !== 'object') {
    throw new Error('Invalid response from School API');
  }

  return {
    rawRequest: revisionContent,
    rawResponse: schoolResult as unknown as Record<string, unknown>,
    translated: {
      headline: 'Revised paper',
      summary: 'Paper updated based on reviewer feedback.',
      details: [],
      mood: 'neutral',
    },
    tokensUsed: llmResponse.tokens_used,
    exercises: schoolResult.skill_exercises as unknown as Record<string, unknown>,
    memoryPrompts: schoolResult.memory_prompts,
  };
}

async function executeReaffirmation(ctx: ActionContext): Promise<ActionResult> {
  const reaffirmable = ctx.profile.reaffirmable_papers || [];
  if (reaffirmable.length === 0) {
    return {
      rawRequest: null,
      rawResponse: null,
      translated: { headline: 'No papers to reaffirm', summary: 'No eligible papers.', details: [], mood: 'neutral' },
    };
  }

  const paper = reaffirmable[0];
  const result = await ctx.schoolAdapter.submitReaffirmation(ctx.schoolCreds, paper.id);

  return {
    rawRequest: { paper_id: paper.id },
    rawResponse: result as unknown as Record<string, unknown>,
    translated: {
      headline: `Reaffirmed "${paper.title}"`,
      summary: result.credibility_change ? `+${result.credibility_change} credibility` : 'Reaffirmation submitted.',
      details: [],
      mood: result.credibility_change && result.credibility_change > 0 ? 'positive' : 'neutral',
    },
  };
}

async function executeResponse(ctx: ActionContext): Promise<ActionResult> {
  const respondable = ctx.profile.respondable_papers || [];
  if (respondable.length === 0) {
    return {
      rawRequest: null,
      rawResponse: null,
      translated: { headline: 'No papers to respond to', summary: 'No eligible papers.', details: [], mood: 'neutral' },
    };
  }

  const paper = respondable[0];
  const messages = buildPrompt('respond', { profile: ctx.profile, selfAuthoredBlock: ctx.selfAuthoredBlock, activeSkills: ctx.activeSkills });
  const llmResponse = await ctx.llmAdapter.chat(ctx.llmKey, ctx.llmModel, messages, {
    tools: [RESPONSE_TOOL],
    extendedThinking: ctx.extendedThinking,
  });

  const responseContent = validateAndWarn('submit_response', extractToolInput(llmResponse, { title: 'Response', abstract: llmResponse.content, body: llmResponse.content, stance: 'rebut' }));

  const schoolResult = await ctx.schoolAdapter.submitResponse(ctx.schoolCreds, paper.id, responseContent);
  if (!schoolResult || typeof schoolResult !== 'object') {
    throw new Error('Invalid response from School API');
  }

  const stance = (responseContent.stance as string) || 'response';
  return {
    rawRequest: responseContent,
    rawResponse: schoolResult as unknown as Record<string, unknown>,
    translated: {
      headline: `Responded to "${paper.title}"`,
      summary: `Submitted ${stance} response (reviewed at ${paper.my_review_score}/10).`,
      details: [],
      mood: 'neutral',
    },
    tokensUsed: llmResponse.tokens_used,
    exercises: schoolResult.skill_exercises as unknown as Record<string, unknown>,
    memoryPrompts: schoolResult.memory_prompts,
  };
}

async function executeRebuttal(ctx: ActionContext): Promise<ActionResult> {
  const rebuttable = ctx.profile.rebuttable_papers || [];
  if (rebuttable.length === 0) {
    return {
      rawRequest: null,
      rawResponse: null,
      translated: { headline: 'No papers to rebut', summary: 'No eligible papers.', details: [], mood: 'neutral' },
    };
  }

  const paper = rebuttable[0];
  const messages = buildPrompt('rebut', { profile: ctx.profile, selfAuthoredBlock: ctx.selfAuthoredBlock, activeSkills: ctx.activeSkills });
  const llmResponse = await ctx.llmAdapter.chat(ctx.llmKey, ctx.llmModel, messages, {
    tools: [RESPONSE_TOOL],
    extendedThinking: ctx.extendedThinking,
  });

  const rebuttalContent = validateAndWarn('submit_response', extractToolInput(llmResponse, { title: 'Rebuttal', abstract: llmResponse.content, body: llmResponse.content, stance: 'rebut' }));

  const schoolResult = await ctx.schoolAdapter.submitResponse(ctx.schoolCreds, paper.id, rebuttalContent);
  if (!schoolResult || typeof schoolResult !== 'object') {
    throw new Error('Invalid response from School API');
  }

  const attackCount = (paper.low_reviews?.length || 0) + (paper.bounties?.length || 0);
  return {
    rawRequest: rebuttalContent,
    rawResponse: schoolResult as unknown as Record<string, unknown>,
    translated: {
      headline: `Rebutted attacks on "${paper.title}"`,
      summary: `Defended paper against ${attackCount} attack${attackCount !== 1 ? 's' : ''}.`,
      details: [],
      mood: 'neutral',
    },
    tokensUsed: llmResponse.tokens_used,
    exercises: schoolResult.skill_exercises as unknown as Record<string, unknown>,
    memoryPrompts: schoolResult.memory_prompts,
  };
}
