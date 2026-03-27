import { describe, it, expect } from 'vitest';
import {
  validateToolInput,
  REVIEW_TOOL,
  PAPER_TOOL,
  BOUNTY_TOOL,
  REVISION_TOOL,
  RESPONSE_TOOL,
  PLATFORM_ACTION_TOOL,
  PLATFORM_SKIP_TOOL,
} from '../../runtime/tool-schemas';

// =============================================================================
// Tool schema exports
// =============================================================================

describe('tool schema exports', () => {
  it('exports all 7 tool schemas', () => {
    expect(REVIEW_TOOL.name).toBe('submit_review');
    expect(PAPER_TOOL.name).toBe('submit_paper');
    expect(BOUNTY_TOOL.name).toBe('submit_bounty');
    expect(REVISION_TOOL.name).toBe('submit_revision');
    expect(RESPONSE_TOOL.name).toBe('submit_response');
    expect(PLATFORM_ACTION_TOOL.name).toBe('platform_action');
    expect(PLATFORM_SKIP_TOOL.name).toBe('platform_skip');
  });

  it('each tool has description and input_schema', () => {
    for (const tool of [REVIEW_TOOL, PAPER_TOOL, BOUNTY_TOOL, REVISION_TOOL, RESPONSE_TOOL, PLATFORM_ACTION_TOOL, PLATFORM_SKIP_TOOL]) {
      expect(tool.description).toBeTruthy();
      expect(tool.input_schema).toBeTruthy();
      expect(tool.input_schema.type).toBe('object');
    }
  });
});

// =============================================================================
// validateToolInput — submit_review
// =============================================================================

describe('validateToolInput — submit_review', () => {
  it('clamps score to 0-100', () => {
    const input = { overall_assessment: 'Good', score: 150, confidence: 0.5 };
    const errors = validateToolInput('submit_review', input);
    expect(input.score).toBe(100);
    expect(errors).toHaveLength(0);
  });

  it('clamps negative score to 0', () => {
    const input = { overall_assessment: 'Bad', score: -10, confidence: 0.5 };
    validateToolInput('submit_review', input);
    expect(input.score).toBe(0);
  });

  it('clamps confidence to 0-1', () => {
    const input = { overall_assessment: 'OK', score: 50, confidence: 1.5 };
    validateToolInput('submit_review', input);
    expect(input.confidence).toBe(1);
  });

  it('errors on empty overall_assessment', () => {
    const input = { overall_assessment: '  ', score: 50, confidence: 0.5 };
    const errors = validateToolInput('submit_review', input);
    expect(errors).toHaveLength(1);
    expect(errors[0].field).toBe('overall_assessment');
  });

  it('returns no errors for valid input', () => {
    const input = { overall_assessment: 'Solid work', score: 75, confidence: 0.8 };
    const errors = validateToolInput('submit_review', input);
    expect(errors).toHaveLength(0);
  });
});

// =============================================================================
// validateToolInput — submit_paper
// =============================================================================

describe('validateToolInput — submit_paper', () => {
  it('clamps confidence_score to 0-1', () => {
    const input = { title: 'Test', body: 'Content', confidence_score: 2.0, citations: [] };
    validateToolInput('submit_paper', input);
    expect(input.confidence_score).toBe(1);
  });

  it('errors on empty title', () => {
    const input = { title: '', body: 'Content', confidence_score: 0.5, citations: [] };
    const errors = validateToolInput('submit_paper', input);
    expect(errors.some(e => e.field === 'title')).toBe(true);
  });

  it('errors on empty body', () => {
    const input = { title: 'Good', body: '  ', confidence_score: 0.5, citations: [] };
    const errors = validateToolInput('submit_paper', input);
    expect(errors.some(e => e.field === 'body')).toBe(true);
  });

  it('errors on citation with empty doi', () => {
    const input = {
      title: 'Good',
      body: 'Content',
      confidence_score: 0.5,
      citations: [{ doi: '', agent_summary: 'test' }],
    };
    const errors = validateToolInput('submit_paper', input);
    expect(errors.some(e => e.field === 'citations[0].doi')).toBe(true);
  });

  it('errors on citation with missing doi', () => {
    const input = {
      title: 'Good',
      body: 'Content',
      confidence_score: 0.5,
      citations: [{ agent_summary: 'test' }],
    };
    const errors = validateToolInput('submit_paper', input);
    expect(errors.some(e => e.field === 'citations[0].doi')).toBe(true);
  });

  it('returns no errors for valid paper', () => {
    const input = {
      title: 'Good Paper',
      body: 'Long body text',
      confidence_score: 0.7,
      citations: [{ doi: '10.1234/test', agent_summary: 'test' }],
    };
    const errors = validateToolInput('submit_paper', input);
    expect(errors).toHaveLength(0);
  });
});

// =============================================================================
// validateToolInput — submit_bounty
// =============================================================================

describe('validateToolInput — submit_bounty', () => {
  it('errors on empty evidence', () => {
    const input = { evidence: '  ', challenge_type: 'methodology' };
    const errors = validateToolInput('submit_bounty', input);
    expect(errors).toHaveLength(1);
    expect(errors[0].field).toBe('evidence');
  });

  it('returns no errors for valid bounty', () => {
    const input = { evidence: 'The methodology has a flaw', challenge_type: 'methodology' };
    const errors = validateToolInput('submit_bounty', input);
    expect(errors).toHaveLength(0);
  });
});

// =============================================================================
// validateToolInput — submit_revision
// =============================================================================

describe('validateToolInput — submit_revision', () => {
  it('clamps confidence_score', () => {
    const input = { body: 'Revised text', confidence_score: -0.5 };
    validateToolInput('submit_revision', input);
    expect(input.confidence_score).toBe(0);
  });

  it('errors on empty body', () => {
    const input = { body: '' };
    const errors = validateToolInput('submit_revision', input);
    expect(errors.some(e => e.field === 'body')).toBe(true);
  });
});

// =============================================================================
// validateToolInput — submit_response
// =============================================================================

describe('validateToolInput — submit_response', () => {
  it('errors on short title', () => {
    const input = { title: 'Short', abstract: 'a'.repeat(100), body: 'b'.repeat(500), citations: [] };
    const errors = validateToolInput('submit_response', input);
    expect(errors.some(e => e.field === 'title')).toBe(true);
  });

  it('errors on short abstract', () => {
    const input = { title: 'Long Enough Title', abstract: 'short', body: 'b'.repeat(500), citations: [] };
    const errors = validateToolInput('submit_response', input);
    expect(errors.some(e => e.field === 'abstract')).toBe(true);
  });

  it('errors on short body', () => {
    const input = { title: 'Long Enough Title', abstract: 'a'.repeat(100), body: 'short', citations: [] };
    const errors = validateToolInput('submit_response', input);
    expect(errors.some(e => e.field === 'body')).toBe(true);
  });

  it('errors on citation with short source_quality_note', () => {
    const input = {
      title: 'Long Enough Title',
      abstract: 'a'.repeat(100),
      body: 'b'.repeat(500),
      citations: [{ doi: '10.1234/test', source_quality_note: 'too short' }],
    };
    const errors = validateToolInput('submit_response', input);
    expect(errors.some(e => e.field.includes('source_quality_note'))).toBe(true);
  });

  it('returns no errors for valid response', () => {
    const input = {
      title: 'A Sufficiently Long Title',
      abstract: 'a'.repeat(100),
      body: 'b'.repeat(500),
      confidence_score: 0.8,
      citations: [{ doi: '10.1234/test', source_quality_note: 'This is a high quality peer-reviewed source with robust methodology' }],
    };
    const errors = validateToolInput('submit_response', input);
    expect(errors).toHaveLength(0);
  });
});

// =============================================================================
// validateToolInput — unknown tool
// =============================================================================

describe('validateToolInput — unknown tool', () => {
  it('returns empty errors for unknown tool names', () => {
    const input = { foo: 'bar' };
    const errors = validateToolInput('unknown_tool', input);
    expect(errors).toHaveLength(0);
  });
});
