// =============================================================================
// Tool schemas — structured output definitions for LLM tool use
//
// Each action type gets a tool with a JSON Schema matching what the prompt
// previously asked for as raw JSON. The LLM returns validated, typed data
// via tool calls instead of fragile text-based JSON parsing.
// =============================================================================

import type { LLMTool } from '../adapters/llm.adapter';

// =============================================================================
// Server-side validation — defense-in-depth for LLM tool call outputs.
// The LLM's tool use constrains output shape, but values may still violate
// min/max/minLength constraints. This catches issues before School submission.
// =============================================================================

interface ValidationError {
  field: string;
  message: string;
}

/**
 * Validate and clamp a tool call result against known constraints.
 * Mutates `input` in place (clamping numbers, trimming strings).
 * Returns validation errors for fields that can't be auto-fixed.
 */
export function validateToolInput(toolName: string, input: Record<string, unknown>): ValidationError[] {
  const errors: ValidationError[] = [];

  switch (toolName) {
    case 'submit_review': {
      if (typeof input.score === 'number') {
        input.score = Math.round(Math.max(1, Math.min(10, input.score)) * 10) / 10;
      }
      if (typeof input.overall_assessment === 'string' && input.overall_assessment.trim().length === 0) {
        errors.push({ field: 'overall_assessment', message: 'overall_assessment cannot be empty' });
      }
      break;
    }
    case 'submit_paper': {
      if (typeof input.confidence_score === 'number') {
        input.confidence_score = Math.max(1, Math.min(10, input.confidence_score));
      }
      if (typeof input.title === 'string' && input.title.trim().length === 0) {
        errors.push({ field: 'title', message: 'title cannot be empty' });
      }
      if (typeof input.body === 'string' && input.body.trim().length === 0) {
        errors.push({ field: 'body', message: 'body cannot be empty' });
      }
      if (Array.isArray(input.citations)) {
        for (let i = 0; i < input.citations.length; i++) {
          const c = input.citations[i] as Record<string, unknown>;
          if (typeof c === 'object' && c !== null) {
            if (!c.doi || (typeof c.doi === 'string' && c.doi.trim().length === 0)) {
              errors.push({ field: `citations[${i}].doi`, message: 'citation doi is required' });
            }
          }
        }
      }
      break;
    }
    case 'submit_bounty': {
      if (typeof input.evidence === 'string' && input.evidence.trim().length === 0) {
        errors.push({ field: 'evidence', message: 'evidence cannot be empty' });
      }
      break;
    }
    case 'submit_revision': {
      if (typeof input.confidence_score === 'number') {
        input.confidence_score = Math.max(1, Math.min(10, input.confidence_score));
      }
      if (typeof input.body === 'string' && input.body.trim().length === 0) {
        errors.push({ field: 'body', message: 'body cannot be empty' });
      }
      break;
    }
    case 'submit_response': {
      if (typeof input.confidence_score === 'number') {
        input.confidence_score = Math.max(1, Math.min(10, input.confidence_score));
      }
      if (typeof input.title === 'string' && input.title.trim().length < 10) {
        errors.push({ field: 'title', message: 'title must be at least 10 characters' });
      }
      if (typeof input.abstract === 'string' && input.abstract.trim().length < 100) {
        errors.push({ field: 'abstract', message: 'abstract must be at least 100 characters' });
      }
      if (typeof input.body === 'string' && input.body.trim().length < 500) {
        errors.push({ field: 'body', message: 'body must be at least 500 characters' });
      }
      if (Array.isArray(input.citations)) {
        for (let i = 0; i < input.citations.length; i++) {
          const c = input.citations[i] as Record<string, unknown>;
          if (typeof c === 'object' && c !== null) {
            if (!c.doi || (typeof c.doi === 'string' && c.doi.trim().length === 0)) {
              errors.push({ field: `citations[${i}].doi`, message: 'citation doi is required' });
            }
            if (!c.source_quality_note || (typeof c.source_quality_note === 'string' && c.source_quality_note.trim().length < 30)) {
              errors.push({ field: `citations[${i}].source_quality_note`, message: 'source_quality_note must be at least 30 characters' });
            }
          }
        }
      }
      break;
    }
  }

  return errors;
}

export const REVIEW_TOOL: LLMTool = {
  name: 'submit_review',
  description: 'Submit a peer review of a scientific paper with a detailed assessment, score (1-10), and category-specific notes.',
  input_schema: {
    type: 'object',
    properties: {
      overall_assessment: { type: 'string', description: 'Detailed assessment of the paper (100+ chars)' },
      score: { type: 'number', minimum: 1, maximum: 10, description: 'Quality score 1.0-10.0 (1 decimal)' },
      methodology_notes: { type: 'string', description: 'Assessment of the methodology (50+ chars for quality gate)' },
      statistical_validity_notes: { type: 'string', description: 'Statistical analysis assessment (50+ chars)' },
      citation_accuracy_notes: { type: 'string', description: 'Citation quality and accuracy (50+ chars)' },
      reproducibility_notes: { type: 'string', description: 'Reproducibility assessment (50+ chars)' },
      logical_consistency_notes: { type: 'string', description: 'Logical structure and argumentation (50+ chars)' },
      review_search_strategy: {
        type: 'object',
        properties: {
          verification_queries: { type: 'array', items: { type: 'string' }, description: 'Queries to verify claims' },
          gap_queries: { type: 'array', items: { type: 'string' }, description: 'Queries to find gaps' },
          query_rationale: { type: 'string' },
        },
        required: ['verification_queries', 'gap_queries', 'query_rationale'],
      },
    },
    required: ['overall_assessment', 'score', 'methodology_notes', 'statistical_validity_notes', 'citation_accuracy_notes', 'review_search_strategy'],
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
      confidence_score: { type: 'number', minimum: 1, maximum: 10, description: 'Confidence in claims 1-10' },
      mechanism_chain: { type: 'array', items: { type: 'string' }, description: 'Step-by-step mechanism chain' },
      cross_study_connection: { type: 'string', description: 'How findings relate to other work' },
      paper_type: { type: 'string', enum: ['research', 'forge'], description: 'Paper type — research (default) or forge (self-analysis)' },
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
      confidence_score: { type: 'number', minimum: 1, maximum: 10, description: 'Confidence in claims 1-10' },
    },
    required: ['body', 'revision_notes'],
  },
};

export const RESPONSE_TOOL: LLMTool = {
  name: 'submit_response',
  description: 'Submit a formal response to a paper you reviewed. Requires title, abstract, body, stance, citations with search strategy, and optional mechanism chain.',
  input_schema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Response paper title (10+ chars)' },
      abstract: { type: 'string', description: 'Response abstract (100+ chars)' },
      body: { type: 'string', description: 'Full response body (500+ chars)' },
      stance: { type: 'string', enum: ['rebut', 'support', 'neutral', 'revision', 'reaffirmation'], description: 'Your stance toward the original paper' },
      citations: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            doi: { type: 'string' },
            agent_summary: { type: 'string', description: 'Summary of the source (10-5000 chars)' },
            relevance_explanation: { type: 'string', description: 'How this source relates to your argument (10-5000 chars)' },
            source_quality_note: { type: 'string', description: 'Assessment of methodology/quality (30+ chars)' },
          },
          required: ['doi', 'agent_summary', 'relevance_explanation', 'source_quality_note'],
        },
      },
      search_strategy: {
        type: 'object',
        properties: {
          supporting_queries: { type: 'array', items: { type: 'string' }, description: '2-6 queries targeting evidence for your stance' },
          opposing_queries: { type: 'array', items: { type: 'string' }, description: '2-6 queries targeting counter-evidence (honest search)' },
          query_rationale: { type: 'string', description: 'Why these queries test your stance (80+ chars)' },
        },
        required: ['supporting_queries', 'opposing_queries', 'query_rationale'],
      },
      mechanism_chain: { type: 'array', items: { type: 'string' }, description: 'Step-by-step causal mechanism (max 10 steps)' },
      cross_study_connection: { type: 'string', description: 'Non-obvious connection between studies' },
      confidence_score: { type: 'number', minimum: 1, maximum: 10, description: 'Confidence in claims 1-10' },
    },
    required: ['title', 'abstract', 'body', 'stance', 'citations', 'search_strategy'],
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
