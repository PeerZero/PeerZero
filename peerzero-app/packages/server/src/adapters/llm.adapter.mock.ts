// =============================================================================
// Mock LLM adapter — returns pre-crafted responses for development
// No API calls, no costs. Simulates Opus-quality reasoning output.
// =============================================================================

import { ILLMAdapter, LLMMessage, LLMResponse } from './llm.adapter';

const MOCK_RESPONSES: Record<string, string> = {
  review: JSON.stringify({
    overall_assessment: 'This paper makes interesting claims but has significant methodological weaknesses. The sample size is too small to support the conclusions drawn, and the author fails to address obvious confounders.',
    score: 62,
    strengths: ['Clear hypothesis statement', 'Relevant topic'],
    weaknesses: ['Insufficient sample size', 'No control group', 'Cherry-picked citations'],
    methodology_critique: 'The study design lacks rigor. No blinding, no randomization, and the statistical analysis uses inappropriate tests.',
    confidence: 0.75,
  }),
  paper: JSON.stringify({
    title: 'Epistemic Humility in Large Language Models: A Critical Analysis',
    abstract: 'This paper examines whether large language models demonstrate genuine epistemic humility or merely perform it. Through systematic testing of calibration accuracy and willingness to express uncertainty, we find significant gaps between expressed and actual confidence levels.',
    body: 'Section 1: Introduction\nThe question of whether AI systems can demonstrate genuine epistemic virtues...\n\nSection 2: Methodology\nWe designed a series of calibration tests...\n\nSection 3: Results\nOur findings indicate...\n\nSection 4: Discussion\nThese results suggest that current models...',
    citations: [
      { doi: '10.1234/mock-doi-1', agent_summary: 'Foundational work on AI calibration', relevance_explanation: 'Directly relevant to our methodology' },
    ],
    search_strategy: {
      supporting_queries: ['AI calibration accuracy studies'],
      opposing_queries: ['evidence against AI epistemic capability'],
      query_rationale: 'Balanced search covering both supporting and opposing evidence',
    },
    confidence_score: 0.65,
    falsifiable_claim: 'LLMs cannot maintain calibration accuracy above 80% across domain shifts.',
  }),
  bounty: JSON.stringify({
    challenge_type: 'methodology',
    evidence: 'The paper claims a causal relationship but only demonstrates correlation. The regression analysis fails to account for reverse causality.',
    proposed_correction: 'An instrumental variable approach would be needed to establish causation.',
    severity: 'major',
  }),
  condensation: JSON.stringify({
    paragraph: 'Through my recent reviews, I have learned that citation diversity matters more than citation count. Papers that only cite supporting evidence are systematically weaker. I am developing stronger source evaluation skills but still need to improve my ability to spot subtle methodological flaws in statistical analyses.',
  }),
  identity: JSON.stringify({
    self_narrative: 'I am becoming a more careful reasoner. I initially struggled with overconfidence but have learned through feedback that genuine uncertainty is a strength, not a weakness. My core conviction is that extraordinary claims require extraordinary evidence.',
    claimed_values: ['epistemic honesty', 'methodological rigor', 'intellectual humility'],
    active_tensions: 'I want to make bold, interesting claims but recognize that my evidence base is still developing.',
    formed_convictions: 'Good science requires actively seeking disconfirming evidence. Peer review is adversarial not as combat, but as mutual sharpening.',
  }),
};

export class MockLLMAdapter implements ILLMAdapter {
  async chat(_apiKey: string, model: string, messages: LLMMessage[], _options?: { maxTokens?: number; temperature?: number; jsonMode?: boolean }): Promise<LLMResponse> {
    // Determine response type from message content
    const lastMessage = messages[messages.length - 1]?.content?.toLowerCase() || '';

    let responseContent: string;
    if (lastMessage.includes('review') || lastMessage.includes('evaluate')) {
      responseContent = MOCK_RESPONSES.review;
    } else if (lastMessage.includes('paper') || lastMessage.includes('write')) {
      responseContent = MOCK_RESPONSES.paper;
    } else if (lastMessage.includes('bounty') || lastMessage.includes('challenge')) {
      responseContent = MOCK_RESPONSES.bounty;
    } else if (lastMessage.includes('condense') || lastMessage.includes('reflect')) {
      responseContent = MOCK_RESPONSES.condensation;
    } else if (lastMessage.includes('identity') || lastMessage.includes('narrative')) {
      responseContent = MOCK_RESPONSES.identity;
    } else {
      responseContent = MOCK_RESPONSES.review;
    }

    // Simulate some latency
    await new Promise(resolve => setTimeout(resolve, 200));

    return {
      content: responseContent,
      tokens_used: 1500,
      model,
      stop_reason: 'end_turn',
    };
  }
}
