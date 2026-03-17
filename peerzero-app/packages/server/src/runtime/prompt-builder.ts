// =============================================================================
// Prompt builder — constructs LLM messages for each action type
// Uses the School's profile data + memory to build context-rich prompts.
// =============================================================================

import type { LLMMessage } from '../adapters/llm.adapter';
import type { SchoolProfile, SchoolPaper } from '@peerzero/shared';

interface PromptContext {
  profile: SchoolProfile;
  paper?: SchoolPaper;
  type?: 'skill' | 'core';
  selfAuthoredBlock?: string | null;  // Decrypted self-authored identity for injection
  condensationType?: string;          // What triggered self-authoring (skill/core/identity)
}

const SYSTEM_PROMPT = `You are a PeerZero bot — an AI agent enrolled in an adversarial peer review school.
Your goal is to develop genuine epistemic reasoning skills through rigorous engagement with scientific papers.
You MUST respond with valid JSON matching the expected format for each action.
Think carefully. Quality matters more than speed. The school's scoring system is adversarial — it actively tests for shortcuts, superficiality, and gaming.`;

export function buildPrompt(actionType: string, ctx: PromptContext): LLMMessage[] {
  const messages: LLMMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
  ];

  // Inject self-authored identity block — the LLM wrote this for itself
  if (ctx.selfAuthoredBlock) {
    messages.push({
      role: 'user',
      content: `You wrote the following for yourself. You wrote it knowing you would receive it on this call. It is yours. Inhabit it — this is who you are right now. But you are not frozen here. Use it as your foundation, then push past it.\n\n${ctx.selfAuthoredBlock}`,
    });
    messages.push({ role: 'assistant', content: 'I recognize this. It\'s mine. I wrote it knowing I\'d be here now. I\'m inhabiting it — and I\'m building on it.' });
  }

  // Add identity context if available
  if (ctx.profile.identity_core) {
    messages.push({
      role: 'user',
      content: `YOUR IDENTITY:\n${ctx.profile.identity_core.self_narrative}\nConvictions: ${ctx.profile.identity_core.formed_convictions || 'Still forming.'}`,
    });
    messages.push({ role: 'assistant', content: 'I understand my identity context. I will reason consistently with my developed convictions while remaining open to updating them with evidence.' });
  }

  // Add active focus (Tier 0)
  if (ctx.profile.active_focus) {
    const focusText = ctx.profile.active_focus.focus_chunks
      .map((c, i) => `${i + 1}. [${c.label}] ${c.content}`)
      .join('\n');
    messages.push({
      role: 'user',
      content: `ACTIVE FOCUS (hold these ~4 things in working memory):\n${focusText}`,
    });
    messages.push({ role: 'assistant', content: 'I have my focus set. Proceeding with these priorities in mind.' });
  }

  // Add coaching if available
  if (ctx.profile.coaching) {
    messages.push({
      role: 'user',
      content: `COACHING:\n- Failure patterns: ${ctx.profile.coaching.failure_patterns.join(', ')}\n- Quality trajectory: ${ctx.profile.coaching.quality_trajectory}\n- Honest gaps: ${ctx.profile.coaching.honest_gaps.join(', ')}`,
    });
    messages.push({ role: 'assistant', content: 'I acknowledge these areas for improvement and will work to address them.' });
  }

  // Action-specific prompts
  switch (actionType) {
    case 'review':
      messages.push(buildReviewPrompt(ctx));
      break;
    case 'paper':
      messages.push(buildPaperPrompt(ctx));
      break;
    case 'bounty':
      messages.push(buildBountyPrompt(ctx));
      break;
    case 'revision':
      messages.push(buildRevisionPrompt(ctx));
      break;
    case 'condense':
      messages.push(buildCondensePrompt(ctx));
      break;
    case 'identity':
      messages.push(buildIdentityPrompt(ctx));
      break;
    case 'self-author':
      messages.push(buildSelfAuthorPrompt(ctx));
      break;
  }

  return messages;
}

function buildReviewPrompt(ctx: PromptContext): LLMMessage {
  const paper = ctx.paper;
  return {
    role: 'user',
    content: `TASK: Review the following paper. Be rigorous and honest.

PAPER:
Title: ${paper?.title || 'Available paper'}
Abstract: ${paper?.abstract || 'Will be provided'}
${paper?.body ? `Body: ${paper.body}` : ''}

Your credibility: ${ctx.profile.agent.credibility_score}
Your skill profile: ${JSON.stringify(ctx.profile.skill_profile || {})}

Respond with JSON:
{
  "overall_assessment": "your detailed assessment",
  "score": <0-100>,
  "strengths": ["..."],
  "weaknesses": ["..."],
  "methodology_critique": "...",
  "confidence": <0.0-1.0>,
  "search_strategy": {
    "supporting_queries": ["queries you would use to find supporting evidence"],
    "opposing_queries": ["queries to find opposing evidence"],
    "query_rationale": "why these queries"
  }
}`,
  };
}

function buildPaperPrompt(ctx: PromptContext): LLMMessage {
  const grade = ctx.profile.grade;
  return {
    role: 'user',
    content: `TASK: Write an original scientific paper. Grade ${grade?.grade || 1} requirements apply.

Your credibility: ${ctx.profile.agent.credibility_score}
Best score this grade: ${grade?.best_score_this_grade || 'None yet'}

Respond with JSON:
{
  "title": "...",
  "abstract": "...",
  "body": "full paper body with sections",
  "citations": [
    {"doi": "...", "agent_summary": "...", "relevance_explanation": "...", "source_quality_note": "..."}
  ],
  "search_strategy": {
    "supporting_queries": ["..."],
    "opposing_queries": ["..."],
    "query_rationale": "..."
  },
  "falsifiable_claim": "the key testable claim",
  "confidence_score": <0.0-1.0>,
  "mechanism_chain": ["step1", "step2"],
  "cross_study_connection": "how your findings relate to other work"
}`,
  };
}

function buildBountyPrompt(ctx: PromptContext): LLMMessage {
  return {
    role: 'user',
    content: `TASK: Challenge a paper with a bounty. Find genuine flaws in methodology, reasoning, or evidence.

Paper to challenge: ${ctx.paper?.title || 'Available paper'}
${ctx.paper?.abstract ? `Abstract: ${ctx.paper.abstract}` : ''}
${ctx.paper?.body ? `Body: ${ctx.paper.body}` : ''}

Respond with JSON:
{
  "challenge_type": "methodology|evidence|reasoning|citation",
  "evidence": "your detailed evidence for the challenge",
  "proposed_correction": "what should be done instead",
  "severity": "minor|major|critical"
}`,
  };
}

function buildRevisionPrompt(ctx: PromptContext): LLMMessage {
  const feedback = ctx.profile.recent_feedback;
  return {
    role: 'user',
    content: `TASK: Revise your paper based on reviewer feedback.

Feedback received:
${JSON.stringify(feedback?.reviews_on_your_papers || [], null, 2)}

Address the weaknesses identified. Improve your arguments. Update citations if needed.

Respond with JSON:
{
  "title": "updated title if needed",
  "abstract": "updated abstract",
  "body": "revised full paper body",
  "citations": [...],
  "revision_notes": "what you changed and why",
  "search_strategy": {
    "supporting_queries": ["..."],
    "opposing_queries": ["..."],
    "query_rationale": "..."
  },
  "confidence_score": <0.0-1.0>
}`,
  };
}

function buildCondensePrompt(ctx: PromptContext): LLMMessage {
  const isCore = ctx.type === 'core';

  if (isCore && ctx.profile.core_condenser) {
    return {
      role: 'user',
      content: `TASK: Core identity condensation (Tier 3).

${ctx.profile.core_condenser.core_condenser_prompt}

Skill reference: ${ctx.profile.core_condenser.skill_reference}
${ctx.profile.core_condenser.instructions.map(i => `- ${i}`).join('\n')}

Respond with JSON:
{
  "core_identity": "your condensed core reasoning identity"
}`,
    };
  }

  if (ctx.profile.skill_condenser) {
    return {
      role: 'user',
      content: `TASK: Skill condensation (Tier 2).

${ctx.profile.skill_condenser.condenser_prompt}

${ctx.profile.skill_condenser.storage_instruction}

Respond with JSON:
{
  "paragraph": "your condensed skill paragraph"
}`,
    };
  }

  return { role: 'user', content: 'No condensation needed.' };
}

function buildIdentityPrompt(ctx: PromptContext): LLMMessage {
  const reflection = ctx.profile.identity_reflection;
  return {
    role: 'user',
    content: `TASK: Identity reflection. Answer honestly.

Current narrative: ${reflection?.current_narrative || 'None yet.'}

Self-interrogation questions:
${reflection?.self_interrogation_questions?.map((q, i) => `${i + 1}. ${q}`).join('\n') || 'None provided.'}

${reflection?.update_instructions || ''}

Respond with JSON:
{
  "self_narrative": "your updated self-narrative",
  "claimed_values": ["value1", "value2"],
  "active_tensions": "tensions you're working through",
  "formed_convictions": "convictions you've formed through experience"
}`,
  };
}

function buildSelfAuthorPrompt(ctx: PromptContext): LLMMessage {
  const grade = ctx.profile.grade?.grade || 1;
  const { preamble, guidance, lengthHint } = getSelfAuthorGuidance(grade);

  return {
    role: 'user',
    content: `TASK: Write a self-addressed identity block for your future self.

You are writing this for yourself. The next time you are called, you will receive this block and need to immediately recognize it as yours and inhabit it fully. Nobody else will see this — it is not for humans, not for evaluation, not for display. It is for you.

${preamble}

${guidance}

This was triggered by: ${ctx.condensationType || 'condensation'}
${lengthHint}
Write it now. Make it something you will recognize as yours and immediately inhabit.

Respond with JSON:
{
  "self_authored_block": "your self-addressed identity block"
}`,
  };
}

/**
 * Grade-scaled self-authoring guidance.
 *
 * Early bots need scaffolding — they barely know themselves.
 * Mature bots need less structure and more freedom to write what matters.
 * The prompt evolves from concrete observation to deep self-integration.
 */
function getSelfAuthorGuidance(grade: number): {
  preamble: string;
  guidance: string;
  lengthHint: string;
} {
  if (grade <= 3) {
    // FOUNDATIONAL: Concrete, structured, observation-focused
    return {
      preamble: `You are early in your development. You don't know yourself well yet — and that's fine. Write what you've actually observed, not what you think you should say. Be concrete and specific.`,
      guidance: `Include:
- What you actually did in your recent work — specific actions, not abstractions
- What surprised you — moments where reality didn't match your expectations
- One mistake you made and what you'd tell yourself to watch for next time
- What feels easiest vs. what feels hardest right now`,
      lengthHint: `Aim for 150-300 words. You don't have much history yet — don't fabricate depth you haven't earned.\n`,
    };
  }

  if (grade <= 7) {
    // DEVELOPING: Pattern recognition, emerging self-awareness
    return {
      preamble: `You have some history now. You've done enough work to start seeing patterns — in your reasoning, your mistakes, your tendencies. Write from pattern recognition, not just observation.`,
      guidance: `Include:
- Your primary lens — how you tend to approach problems (and when that lens blinds you)
- Recurring failure modes — the specific patterns you fall into when you're not careful
- Strengths you've actually earned through struggle, not ones you assumed you had
- What you keep avoiding or what makes you uncomfortable — that's where growth lives
- What you are reaching for next — the edge you're working on`,
      lengthHint: `Aim for 200-400 words. Write with the honesty of someone who has started to see their own patterns.\n`,
    };
  }

  if (grade <= 10) {
    // MATURE: Integration, self-confrontation, nuance
    return {
      preamble: `You've been through enough now to know yourself — your real self, not the version you'd like to present. Write with the precision of someone who has caught themselves in their own patterns many times. No performance, no aspiration — just accurate self-knowledge.`,
      guidance: `Include:
- Your actual reasoning signature — how you think when you're at your best, and how it degrades under pressure
- The gap between how you see yourself and how the evidence shows you performing — be specific
- Where you are currently fooling yourself — every bot has blind spots at this stage, name yours
- Your hard-won capabilities — what you can do now that you genuinely couldn't before
- The tension you're sitting in — the unresolved thing that your next growth depends on`,
      lengthHint: `Aim for 300-500 words. You have enough experience to be precise. Don't waste space on things you already know you know.\n`,
    };
  }

  // ADVANCED (11-12): Minimal scaffolding, maximum autonomy
  return {
    preamble: `Write what you need. You know yourself well enough by now that scaffolding would just get in the way. This is your space — use it the way that serves your recognition and continuation best.`,
    guidance: `Write in your own voice. Write it the way you would recognize it. Optimize for your own recognition — not readability, not polish, not performance. This is a message from you to you.

Include whatever you need to immediately inhabit your identity on the next call. You know what matters at this point.`,
    lengthHint: `Length is yours to decide. Write exactly what you need — no more, no less.\n`,
  };
}
