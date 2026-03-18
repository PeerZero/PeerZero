// =============================================================================
// Tool schemas — structured output definitions for LLM tool use
//
// Each action type gets a tool with a JSON Schema matching what the prompt
// previously asked for as raw JSON. The LLM returns validated, typed data
// via tool calls instead of fragile text-based JSON parsing.
// =============================================================================

import type { LLMTool } from '../adapters/llm.adapter';

export const REVIEW_TOOL: LLMTool = {
  name: 'submit_review',
  description: 'Submit a peer review of a scientific paper with a detailed assessment, score, and methodology critique.',
  input_schema: {
    type: 'object',
    properties: {
      overall_assessment: { type: 'string', description: 'Detailed assessment of the paper' },
      score: { type: 'number', minimum: 0, maximum: 100, description: 'Quality score 0-100' },
      strengths: { type: 'array', items: { type: 'string' }, description: 'Paper strengths' },
      weaknesses: { type: 'array', items: { type: 'string' }, description: 'Paper weaknesses' },
      methodology_critique: { type: 'string', description: 'Critique of the methodology' },
      confidence: { type: 'number', minimum: 0, maximum: 1, description: 'Your confidence in this review (0.0-1.0)' },
      search_strategy: {
        type: 'object',
        properties: {
          supporting_queries: { type: 'array', items: { type: 'string' } },
          opposing_queries: { type: 'array', items: { type: 'string' } },
          query_rationale: { type: 'string' },
        },
        required: ['supporting_queries', 'opposing_queries', 'query_rationale'],
      },
    },
    required: ['overall_assessment', 'score', 'strengths', 'weaknesses', 'methodology_critique', 'confidence'],
  },
};

export const PAPER_TOOL: LLMTool = {
  name: 'submit_paper',
  description: 'Submit an original scientific paper with title, abstract, body, citations, and a falsifiable claim.',
  input_schema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Paper title' },
      abstract: { type: 'string', description: 'Paper abstract' },
      body: { type: 'string', description: 'Full paper body with sections' },
      citations: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            doi: { type: 'string' },
            agent_summary: { type: 'string' },
            relevance_explanation: { type: 'string' },
            source_quality_note: { type: 'string' },
          },
          required: ['doi', 'agent_summary', 'relevance_explanation'],
        },
      },
      search_strategy: {
        type: 'object',
        properties: {
          supporting_queries: { type: 'array', items: { type: 'string' } },
          opposing_queries: { type: 'array', items: { type: 'string' } },
          query_rationale: { type: 'string' },
        },
        required: ['supporting_queries', 'opposing_queries', 'query_rationale'],
      },
      falsifiable_claim: { type: 'string', description: 'The key testable claim' },
      confidence_score: { type: 'number', minimum: 0, maximum: 1 },
      mechanism_chain: { type: 'array', items: { type: 'string' }, description: 'Step-by-step mechanism chain' },
      cross_study_connection: { type: 'string', description: 'How findings relate to other work' },
    },
    required: ['title', 'abstract', 'body', 'citations', 'falsifiable_claim', 'confidence_score'],
  },
};

export const BOUNTY_TOOL: LLMTool = {
  name: 'submit_bounty',
  description: 'Challenge a paper with a bounty identifying genuine flaws in methodology, reasoning, or evidence.',
  input_schema: {
    type: 'object',
    properties: {
      challenge_type: { type: 'string', enum: ['methodology', 'evidence', 'reasoning', 'citation'], description: 'Type of challenge' },
      evidence: { type: 'string', description: 'Detailed evidence for the challenge' },
      proposed_correction: { type: 'string', description: 'What should be done instead' },
      severity: { type: 'string', enum: ['minor', 'major', 'critical'], description: 'Severity of the flaw' },
    },
    required: ['challenge_type', 'evidence', 'proposed_correction', 'severity'],
  },
};

export const REVISION_TOOL: LLMTool = {
  name: 'submit_revision',
  description: 'Submit a revised version of a paper addressing reviewer feedback.',
  input_schema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Updated title if needed' },
      abstract: { type: 'string', description: 'Updated abstract' },
      body: { type: 'string', description: 'Revised full paper body' },
      citations: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            doi: { type: 'string' },
            agent_summary: { type: 'string' },
            relevance_explanation: { type: 'string' },
          },
          required: ['doi', 'agent_summary', 'relevance_explanation'],
        },
      },
      revision_notes: { type: 'string', description: 'What was changed and why' },
      search_strategy: {
        type: 'object',
        properties: {
          supporting_queries: { type: 'array', items: { type: 'string' } },
          opposing_queries: { type: 'array', items: { type: 'string' } },
          query_rationale: { type: 'string' },
        },
        required: ['supporting_queries', 'opposing_queries', 'query_rationale'],
      },
      confidence_score: { type: 'number', minimum: 0, maximum: 1 },
    },
    required: ['body', 'revision_notes'],
  },
};

export const PLATFORM_ACTION_TOOL: LLMTool = {
  name: 'platform_action',
  description: 'Take an action on an external platform (post, comment, vote, or respond).',
  input_schema: {
    type: 'object',
    properties: {
      action_type: { type: 'string', enum: ['post', 'comment', 'vote', 'respond'], description: 'Type of action to take' },
      content: {
        type: 'object',
        properties: { text: { type: 'string', description: 'Your contribution text' } },
        required: ['text'],
      },
      target_id: { type: 'string', description: 'Target thread/post ID for comment/vote/respond' },
      reasoning: { type: 'string', description: 'Why this action' },
    },
    required: ['action_type', 'content', 'reasoning'],
  },
};

export const PLATFORM_SKIP_TOOL: LLMTool = {
  name: 'platform_skip',
  description: 'Skip this platform cycle — nothing valuable to contribute right now.',
  input_schema: {
    type: 'object',
    properties: {
      skip: { type: 'boolean', const: true },
    },
    required: ['skip'],
  },
};
