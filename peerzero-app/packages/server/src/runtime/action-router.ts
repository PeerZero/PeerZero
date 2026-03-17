// =============================================================================
// Action router — dispatches bot actions to the right handler
// Each action: build prompt → call LLM → parse response → call School → translate
// =============================================================================

import { ISchoolAdapter, SchoolCredentials } from '../adapters/school.adapter';
import { ILLMAdapter } from '../adapters/llm.adapter';
import { buildPrompt } from './prompt-builder';
import * as activity from '../services/activity.service';
import type { SchoolProfile, SchoolPaper, TranslatedActivity, SchoolSkillExercises, SchoolMemoryPrompts } from '@peerzero/shared';

export interface ActionContext {
  schoolAdapter: ISchoolAdapter;
  llmAdapter: ILLMAdapter;
  llmKey: string;
  llmModel: string;
  schoolCreds: SchoolCredentials;
  profile: SchoolProfile;
  botId: string;
  cycleNumber: number;
  selfAuthoredBlock?: string | null;  // Decrypted self-authored identity for prompt injection
}

export interface ActionResult {
  rawRequest: Record<string, unknown> | null;
  rawResponse: Record<string, unknown> | null;
  translated: TranslatedActivity;
  tokensUsed?: number;
  exercises?: Record<string, unknown>;
  memoryPrompts?: SchoolMemoryPrompts;
}

export async function routeAction(actionType: string, ctx: ActionContext): Promise<ActionResult> {
  switch (actionType) {
    case 'review': return executeReview(ctx);
    case 'paper': return executePaper(ctx);
    case 'bounty': return executeBounty(ctx);
    case 'revision': return executeRevision(ctx);
    case 'reaffirmation': return executeReaffirmation(ctx);
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
  const messages = buildPrompt('review', { profile: ctx.profile, paper, selfAuthoredBlock: ctx.selfAuthoredBlock });
  const llmResponse = await ctx.llmAdapter.chat(ctx.llmKey, ctx.llmModel, messages, { jsonMode: true });

  let reviewContent: Record<string, unknown>;
  try {
    reviewContent = JSON.parse(llmResponse.content);
  } catch {
    reviewContent = { overall_assessment: llmResponse.content, score: 50 };
  }

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
  const messages = buildPrompt('paper', { profile: ctx.profile, selfAuthoredBlock: ctx.selfAuthoredBlock });
  const llmResponse = await ctx.llmAdapter.chat(ctx.llmKey, ctx.llmModel, messages, { jsonMode: true });

  let paperContent: Record<string, unknown>;
  try {
    paperContent = JSON.parse(llmResponse.content);
  } catch {
    paperContent = { title: 'Untitled', abstract: llmResponse.content, body: llmResponse.content };
  }

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
  const messages = buildPrompt('bounty', { profile: ctx.profile, paper, selfAuthoredBlock: ctx.selfAuthoredBlock });
  const llmResponse = await ctx.llmAdapter.chat(ctx.llmKey, ctx.llmModel, messages, { jsonMode: true });

  let bountyContent: Record<string, unknown>;
  try {
    bountyContent = JSON.parse(llmResponse.content);
  } catch {
    bountyContent = { challenge_type: 'methodology', evidence: llmResponse.content };
  }

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
  const messages = buildPrompt('revision', { profile: ctx.profile, selfAuthoredBlock: ctx.selfAuthoredBlock });
  const llmResponse = await ctx.llmAdapter.chat(ctx.llmKey, ctx.llmModel, messages, { jsonMode: true });

  let revisionContent: Record<string, unknown>;
  try {
    revisionContent = JSON.parse(llmResponse.content);
  } catch {
    revisionContent = { body: llmResponse.content, revision_notes: 'Revised based on feedback' };
  }

  // Get the reaffirmable papers to find the paper to revise
  const reaffirmable = ctx.profile.reaffirmable_papers || [];
  const paperId = reaffirmable[0]?.id || 'unknown';

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
