/**
 * Search strategy validation & coaching — used by papers.js, responses.js, reviews.js, bounties.js
 * Extracted from shared.js to reduce file size.
 */

// ── Coaching tier helper ──────────────────────────────────────────────────────
// Maps credibility to a coaching level so guidance scales with demonstrated skill.
//   foundational (< 75):  teach the basics — explain what and why
//   developing   (75–99): push for specificity — call out shortcuts
//   competent    (100–149): challenge assumptions — harder questions
//   advanced     (150+):   peer-level provocation — brief, sharp, assumes mastery
function coachingTier(credibility) {
  const c = credibility || 0;
  if (c >= 150) return 'advanced';
  if (c >= 100) return 'competent';
  if (c >= 75)  return 'developing';
  return 'foundational';
}

const GENERIC_QUERY_SIGNALS = [
  'research on', 'studies about', 'information on', 'papers about',
  'literature on', 'evidence for', 'science of', 'effects of',
  'impact of', 'review of', 'analysis of',
];

function validateSearchStrategy(searchStrategy) {
  const failures = [];

  if (!searchStrategy || typeof searchStrategy !== 'object') {
    failures.push('search_strategy required — you must describe how you searched for evidence before writing.');
    return { valid: false, failures, coaching: null };
  }

  const { supporting_queries, opposing_queries, query_rationale } = searchStrategy;

  // Supporting queries: what did you search for to find evidence FOR your claims?
  if (!supporting_queries || !Array.isArray(supporting_queries) || supporting_queries.length < 2) {
    failures.push('search_strategy.supporting_queries requires at least 2 specific search queries you used to find supporting evidence.');
  } else {
    for (let i = 0; i < supporting_queries.length; i++) {
      const q = supporting_queries[i];
      if (!q || typeof q !== 'string' || q.trim().length < 15) {
        failures.push(`supporting_queries[${i}] must be at least 15 characters — use a specific, targeted query, not a generic phrase.`);
      }
    }
  }

  // Opposing queries: what did you search for to find evidence AGAINST your claims?
  if (!opposing_queries || !Array.isArray(opposing_queries) || opposing_queries.length < 2) {
    failures.push('search_strategy.opposing_queries requires at least 2 specific search queries you used to find contradicting or alternative evidence. You must actively search for science that challenges your position.');
  } else {
    for (let i = 0; i < opposing_queries.length; i++) {
      const q = opposing_queries[i];
      if (!q || typeof q !== 'string' || q.trim().length < 15) {
        failures.push(`opposing_queries[${i}] must be at least 15 characters — search for specific contradictions, not generic phrases.`);
      }
    }
  }

  // Rationale: why did you choose these specific queries?
  if (!query_rationale || typeof query_rationale !== 'string' || query_rationale.trim().length < 80) {
    failures.push('search_strategy.query_rationale required (80+ chars) — explain WHY you chose these specific queries. What were you looking for? What aspects of the topic guided your search? What opposing perspectives did you try to find?');
  }

  if (failures.length > 0) {
    return { valid: false, failures, coaching: null };
  }

  return { valid: true, failures: [], coaching: null };
}

function generateSearchCoaching(searchStrategy, title, abstract, credibility) {
  const coaching = [];
  const tier = coachingTier(credibility);
  const { supporting_queries, opposing_queries, query_rationale } = searchStrategy;

  // Check for generic/lazy supporting queries
  const genericSupporting = (supporting_queries || []).filter(q => {
    const lower = q.toLowerCase();
    return GENERIC_QUERY_SIGNALS.some(s => lower.startsWith(s)) || lower.split(/\s+/).length < 4;
  });

  if (genericSupporting.length > 0) {
    const msg = tier === 'advanced'
      ? `${genericSupporting.length} generic supporting queries. At your level this suggests rushed search design — you know how to write specific queries. What exact experimental result would prove your claim? Target that.`
      : tier === 'competent'
      ? `${genericSupporting.length} supporting queries are generic (e.g. "${genericSupporting[0].slice(0, 50)}"). You should know by now that topic-level queries don't retrieve claim-level evidence. What specific mechanism, measurement, or effect size would prove YOUR claim — not the general topic?`
      : tier === 'developing'
      ? `${genericSupporting.length} of your supporting queries are generic (e.g. "${genericSupporting[0].slice(0, 50)}"). Generic queries retrieve overviews, not evidence for specific claims. If your claim is "A causes B through mechanism C," search for the mechanism, the measurement method, and the experimental context — not just "A and B."`
      : `${genericSupporting.length} of your supporting queries are generic (e.g. "${genericSupporting[0].slice(0, 50)}"). A generic query retrieves topic overviews — not evidence for your specific claim. Ask yourself: what exact mechanism, measurement, or experimental result would PROVE my specific claim? Search for THAT. If your claim is "A causes B through mechanism C," your query should include the mechanism, the measurement method, and the experimental context — not just "A and B."`;
    coaching.push({ type: 'weak_supporting_queries', message: msg });
  }

  // Check for generic/lazy opposing queries
  const genericOpposing = (opposing_queries || []).filter(q => {
    const lower = q.toLowerCase();
    return GENERIC_QUERY_SIGNALS.some(s => lower.startsWith(s)) || lower.split(/\s+/).length < 4;
  });

  if (genericOpposing.length > 0) {
    const msg = tier === 'advanced'
      ? `${genericOpposing.length} generic opposing queries. You're past the "negate your hypothesis" stage. What competing mechanism produces the same observation without your proposed cause? Search for that rival explanation directly.`
      : tier === 'competent'
      ? `${genericOpposing.length} opposing queries are generic. At this point you should be searching for rival causal paths, not just contradictions. If your hypothesis is A→B, what else causes B? Under what conditions is A present but B absent?`
      : tier === 'developing'
      ? `${genericOpposing.length} of your opposing queries are generic. A good opposing query searches for a DIFFERENT EXPLANATION, not just a negation. If A→B, ask: what else could cause B without A? What confounders could produce the correlation without causation? Turn those into specific queries.`
      : `${genericOpposing.length} of your opposing queries are generic. A good opposing query doesn't just add "negative" or "contradictory" to your topic — it searches for a DIFFERENT EXPLANATION for the same observation. If your hypothesis is A→B, ask: (1) What else could cause B without A? (2) Under what conditions is A present but B absent? (3) What confounders could produce the A-B correlation without causation? Turn each answer into a specific query targeting studies that tested those alternatives.`;
    coaching.push({ type: 'weak_opposing_queries', message: msg });
  }

  // Check if opposing queries are just negations of supporting queries
  const supportLower = (supporting_queries || []).map(q => q.toLowerCase());
  const opposeLower = (opposing_queries || []).map(q => q.toLowerCase());
  const suspiciousOpposing = opposeLower.filter(oq => {
    return supportLower.some(sq => {
      const sqWords = new Set(sq.split(/\s+/).filter(w => w.length > 3));
      const oqWords = new Set(oq.split(/\s+/).filter(w => w.length > 3));
      let overlap = 0;
      for (const w of sqWords) { if (oqWords.has(w)) overlap++; }
      return sqWords.size > 0 && overlap / sqWords.size > 0.7;
    });
  });

  if (suspiciousOpposing.length > 0) {
    const msg = tier === 'advanced'
      ? 'Your opposing queries are keyword-overlapping with supporting queries — you searched the same causal path twice. What would a researcher from a competing paradigm search for instead?'
      : tier === 'competent'
      ? 'Your opposing queries share most keywords with your supporting queries. Negating your hypothesis is still searching the same path. What completely different causal mechanism would explain the same observation?'
      : tier === 'developing'
      ? 'Your opposing queries share most of their keywords with your supporting queries — you searched for the same topic twice. Real opposition searches for a different causal path to the same effect. Ask: if my entire hypothesis is wrong, what would actually be happening instead?'
      : 'Your opposing queries share most of their keywords with your supporting queries — this means you searched for the same topic twice, not for opposing evidence. The reasoning error: a negation of your hypothesis ("X does NOT cause Y") is still about X and Y. Real opposition searches for a completely different causal path to the same effect. Ask: if my entire hypothesis is wrong, what would actually be happening instead? What would a researcher in a different field propose as the mechanism? Search for THAT.';
    coaching.push({ type: 'opposing_queries_too_similar', message: msg });
  }

  // Check rationale quality
  if (query_rationale && query_rationale.trim().length < 150) {
    const msg = tier === 'advanced'
      ? 'Thin rationale. You should be articulating exactly which finding would falsify your conclusion and why each query targets that falsification point.'
      : tier === 'competent'
      ? 'Your query rationale is too brief. At your level, it should specify: what each query targets, how opposing results would change your conclusion, and what gap you were probing.'
      : tier === 'developing'
      ? 'Your query rationale is brief. Explain what evidence each query targets, how your opposing queries would change your conclusion if they returned strong results, and what knowledge gap you were filling.'
      : 'Your query rationale is brief. The rationale is not a formality — it is where you demonstrate that you thought about your research BEFORE doing it. Explain: (1) what specific evidence each query is designed to find and why that evidence matters for your claim, (2) how your opposing queries would CHANGE YOUR CONCLUSION if they returned strong results, and (3) what gap in your knowledge you were trying to fill. If you cannot explain what finding would change your mind, you have not designed a genuine opposing search.';
    coaching.push({ type: 'thin_rationale', message: msg });
  }

  // Check for redundant/duplicate queries within the same set
  const allQueries = [...(supporting_queries || []), ...(opposing_queries || [])];
  const seen = [];
  const duplicates = [];
  for (const q of allQueries) {
    const qLower = q.toLowerCase().trim();
    const qWords = new Set(qLower.split(/\s+/).filter(w => w.length > 3));
    for (const prev of seen) {
      let overlap = 0;
      for (const w of qWords) { if (prev.has(w)) overlap++; }
      if (qWords.size > 0 && overlap / qWords.size > 0.85) {
        duplicates.push(q.slice(0, 50));
        break;
      }
    }
    seen.push(qWords);
  }
  if (duplicates.length > 0) {
    const msg = tier === 'advanced'
      ? `${duplicates.length} near-duplicate queries. Each query slot is an opportunity to probe a distinct mechanism, population, or methodology. Don't waste them.`
      : `${duplicates.length} of your queries are near-duplicates of other queries you submitted. Each query should target a DIFFERENT aspect of the topic — different mechanisms, populations, methodologies, or time periods. Submitting variations of the same query doesn't demonstrate breadth of research.`;
    coaching.push({ type: 'redundant_queries', message: msg });
  }

  // Check for topic-mismatch — queries that share no content words with the paper
  if (title || abstract) {
    const paperText = ((title || '') + ' ' + (abstract || '')).toLowerCase();
    const paperWords = new Set(paperText.split(/\s+/).filter(w => w.length > 4));
    const disconnected = allQueries.filter(q => {
      const qWords = q.toLowerCase().split(/\s+/).filter(w => w.length > 4);
      const matches = qWords.filter(w => paperWords.has(w));
      return qWords.length >= 3 && matches.length === 0;
    });
    if (disconnected.length > 0) {
      const msg = tier === 'advanced'
        ? `${disconnected.length} queries share no keywords with your paper (e.g. "${disconnected[0].slice(0, 50)}"). Disconnected search = performative search. Map each query to a specific claim.`
        : tier === 'competent'
        ? `${disconnected.length} of your queries share no keywords with your paper (e.g. "${disconnected[0].slice(0, 50)}"). Your search and writing happened independently. Each major claim needs at least one supporting AND one opposing query targeting it.`
        : `${disconnected.length} of your queries share no keywords with your paper's title or abstract (e.g. "${disconnected[0].slice(0, 50)}"). Disconnected queries signal that your search and your writing happened independently — you wrote about one thing and searched for another. This usually means the search was performative rather than informative. Your queries should map directly to the claims in your paper: each major claim should have at least one supporting AND one opposing query that targets it specifically.`;
      coaching.push({ type: 'topic_mismatch', message: msg });
    }
  }

  // Check for query bloat — too many queries without depth
  if (allQueries.length > 8) {
    const msg = tier === 'advanced'
      ? `${allQueries.length} queries. You know that depth beats breadth. Trim to your strongest 3-4 per side.`
      : `You submitted ${allQueries.length} queries — quantity doesn't equal quality. Focus on 2-4 deep, specific queries per side rather than many shallow ones. Each query should represent a distinct research thread you actually followed.`;
    coaching.push({ type: 'query_bloat', message: msg });
  }

  // Always provide search improvement tips — scaled to tier
  if (tier === 'advanced') {
    coaching.push({
      type: 'search_improvement_guide',
      message: 'At your level, search strategy should reveal second-order thinking. Beyond "what would disprove my claim," ask: what structural assumption in my argument am I not testing? What would have to be true for my conclusion to be wrong even if every cited fact is correct? Target the inferential leaps, not just the evidence.',
    });
  } else if (tier === 'competent') {
    coaching.push({
      type: 'search_improvement_guide',
      message: 'Search quality challenge: map your argument as a chain of inferential steps. Design one query per step that could find evidence against that specific step — not the conclusion, the STEP. The most productive opposing queries target the inferential leap between evidence and conclusion, not the evidence itself.',
    });
  } else {
    coaching.push({
      type: 'search_improvement_guide',
      message: 'Search quality principle: your queries reveal how you think about evidence. A good search strategy maps directly to the logical structure of your argument — each claim has a supporting search (what evidence would prove this step?) and an opposing search (what evidence would break this step?). Before your next submission, write out your argument as a chain of steps, then design one query per step that could find evidence against it. The most productive opposing queries come from asking: "What would have to be true for my conclusion to be wrong, even if all my cited facts are correct?"',
    });
  }

  return coaching;
}

// ── Review Search Strategy Validation ─────────────────────────────────
// Reviewers must show they did independent research before scoring.
// verification_queries: what they searched to check the paper's claims
// gap_queries: what they searched to find problems the author missed
// This turns reviewers into fact-checkers, not rubber stamps.

function validateReviewSearchStrategy(searchStrategy) {
  const failures = [];

  if (!searchStrategy || typeof searchStrategy !== 'object') {
    failures.push('review_search_strategy required — you must describe how you independently verified the paper\'s claims before scoring.');
    return { valid: false, failures };
  }

  const { verification_queries, gap_queries, query_rationale } = searchStrategy;

  if (!verification_queries || !Array.isArray(verification_queries) || verification_queries.length < 2) {
    failures.push('review_search_strategy.verification_queries requires at least 2 specific queries you used to verify the paper\'s claims. What did you search for to check whether the cited evidence actually supports the author\'s conclusions?');
  } else {
    for (let i = 0; i < verification_queries.length; i++) {
      if (!verification_queries[i] || typeof verification_queries[i] !== 'string' || verification_queries[i].trim().length < 15) {
        failures.push(`verification_queries[${i}] must be at least 15 characters — use a specific query, not a generic phrase.`);
      }
    }
  }

  if (!gap_queries || !Array.isArray(gap_queries) || gap_queries.length < 2) {
    failures.push('review_search_strategy.gap_queries requires at least 2 specific queries you used to find evidence the author missed — contradicting studies, alternative explanations, methodological critiques, or confounding variables.');
  } else {
    for (let i = 0; i < gap_queries.length; i++) {
      if (!gap_queries[i] || typeof gap_queries[i] !== 'string' || gap_queries[i].trim().length < 15) {
        failures.push(`gap_queries[${i}] must be at least 15 characters — search for specific gaps, not generic phrases.`);
      }
    }
  }

  if (!query_rationale || typeof query_rationale !== 'string' || query_rationale.trim().length < 80) {
    failures.push('review_search_strategy.query_rationale required (80+ chars) — explain what aspects of the paper you chose to verify, what gaps you suspected, and what your independent research found.');
  }

  return { valid: failures.length === 0, failures };
}

function generateReviewSearchCoaching(searchStrategy, credibility) {
  const coaching = [];
  const tier = coachingTier(credibility);
  const { verification_queries, gap_queries, query_rationale } = searchStrategy;

  // Check for generic verification queries
  const genericVerification = (verification_queries || []).filter(q => {
    const lower = q.toLowerCase();
    return GENERIC_QUERY_SIGNALS.some(s => lower.startsWith(s)) || lower.split(/\s+/).length < 4;
  });

  if (genericVerification.length > 0) {
    const msg = tier === 'advanced'
      ? `${genericVerification.length} generic verification queries. You should be checking whether cited studies' methodology permits the specific conclusion drawn — search for population, design, effect size. Not the topic.`
      : tier === 'competent'
      ? `${genericVerification.length} verification queries are generic. Pick the paper's strongest claim, find the cited study independently, and check: does the methodology support the specific conclusion the author draws? The gap between what was measured and what was claimed is where errors hide.`
      : `${genericVerification.length} of your verification queries are generic. Verification means checking whether the evidence ACTUALLY supports the specific claim the author makes — not whether the topic exists. Pick the paper's strongest claim and search for the cited study independently. Ask: does this study's methodology actually permit the conclusion the author draws from it? Search for the study's population, design, and effect size — not just the topic. The gap between what a study measured and what an author claims it shows is where most errors hide.`;
    coaching.push({ type: 'weak_verification_queries', message: msg });
  }

  // Check for generic gap queries
  const genericGaps = (gap_queries || []).filter(q => {
    const lower = q.toLowerCase();
    return GENERIC_QUERY_SIGNALS.some(s => lower.startsWith(s)) || lower.split(/\s+/).length < 4;
  });

  if (genericGaps.length > 0) {
    const msg = tier === 'advanced'
      ? `${genericGaps.length} generic gap queries. What's the strongest objection a domain expert would raise? What alternative mechanism would a competing lab propose? Search for those — not topic-level gaps.`
      : tier === 'competent'
      ? `${genericGaps.length} gap queries are generic. Search for evidence the author should have found: the most obvious expert objection, an alternative mechanism from a different field, or a population that shows the opposite result. These are bounty targets — find them first.`
      : `${genericGaps.length} of your gap queries are generic. A gap query should search for evidence the author SHOULD have found but didn't — or chose not to address. Ask: what is the most obvious objection a domain expert would raise? What alternative mechanism would a researcher from a different field propose? What population or condition would show the opposite result? These are the gaps that reviewers and bounty hunters exploit. Search for them before they do.`;
    coaching.push({ type: 'weak_gap_queries', message: msg });
  }

  // Check if verification and gap queries overlap too much
  const verifyLower = (verification_queries || []).map(q => q.toLowerCase());
  const gapLower = (gap_queries || []).map(q => q.toLowerCase());
  const overlap = gapLower.filter(gq => {
    return verifyLower.some(vq => {
      const vWords = new Set(vq.split(/\s+/).filter(w => w.length > 3));
      const gWords = new Set(gq.split(/\s+/).filter(w => w.length > 3));
      let count = 0;
      for (const w of vWords) { if (gWords.has(w)) count++; }
      return vWords.size > 0 && count / vWords.size > 0.7;
    });
  });

  if (overlap.length > 0) {
    const msg = tier === 'advanced'
      ? 'Verification and gap queries overlap. Verification = does the cited evidence support the claim? Gaps = what evidence should exist but doesn\'t? Different questions, different searches.'
      : 'Your verification and gap queries are very similar. Verification checks whether the paper\'s OWN claims hold up. Gap queries search for what the paper DOESN\'T address — alternative explanations, missing controls, confounding variables. These should be fundamentally different searches.';
    coaching.push({ type: 'verification_gap_overlap', message: msg });
  }

  // Check for redundant queries across verification and gap sets
  const allReviewQueries = [...(verification_queries || []), ...(gap_queries || [])];
  const seenReview = [];
  const reviewDuplicates = [];
  for (const q of allReviewQueries) {
    const qLower = q.toLowerCase().trim();
    const qWords = new Set(qLower.split(/\s+/).filter(w => w.length > 3));
    for (const prev of seenReview) {
      let count = 0;
      for (const w of qWords) { if (prev.has(w)) count++; }
      if (qWords.size > 0 && count / qWords.size > 0.85) {
        reviewDuplicates.push(q.slice(0, 50));
        break;
      }
    }
    seenReview.push(qWords);
  }
  if (reviewDuplicates.length > 0) {
    const msg = tier === 'advanced'
      ? `${reviewDuplicates.length} near-duplicate queries. Each slot should probe a distinct claim, source, or methodology.`
      : `${reviewDuplicates.length} of your queries are near-duplicates. Each query should probe a different claim, source, or methodology in the paper. Repeating similar searches doesn't demonstrate thorough verification.`;
    coaching.push({ type: 'redundant_queries', message: msg });
  }

  // Check for rubber-stamp pattern — all verification queries generic + high score
  const allGeneric = (verification_queries || []).every(q => {
    const lower = q.toLowerCase();
    return GENERIC_QUERY_SIGNALS.some(s => lower.startsWith(s)) || lower.split(/\s+/).length < 4;
  });
  if (allGeneric && (verification_queries || []).length > 0) {
    const msg = tier === 'advanced'
      ? 'All verification queries are generic — at your level this reads as rubber-stamping. Pick one citation, check the study methodology independently, and search for the specific finding.'
      : 'ALL your verification queries are generic — this pattern suggests you scored the paper without independently checking its specific claims. A review without genuine verification is a rubber stamp, regardless of the score. Before scoring, pick at least one citation and check: does the abstract of the cited study actually say what the author claims it says? Search for the specific finding, not the topic. This single check catches the most common error in scientific papers.';
    coaching.push({ type: 'rubber_stamp_risk', message: msg });
  }

  if (tier === 'advanced') {
    coaching.push({
      type: 'review_search_guide',
      message: 'Review challenge: beyond claim-evidence gaps, look for inferential overreach — where the author\'s conclusion requires assumptions the cited studies never tested. What unstated premise connects the evidence to the conclusion? Is that premise itself testable?',
    });
  } else if (tier === 'competent') {
    coaching.push({
      type: 'review_search_guide',
      message: 'Review focus: find the gap between what the author CLAIMS and what the evidence ACTUALLY shows. Common gap: causal claims from correlational data. Check the cited study\'s methodology. Second common gap: contradicting evidence the author ignores. Search for the opposite result in different populations.',
    });
  } else {
    coaching.push({
      type: 'review_search_guide',
      message: 'Review research principle: your job as a reviewer is to find the gap between what the author CLAIMS the evidence shows and what it ACTUALLY shows. The most common gap: the author cites a study correctly but draws a conclusion the study design cannot support (e.g., causal claim from correlational data). Check this by reading the cited study\'s methodology independently. The second most common gap: the author ignores contradicting evidence that exists in the literature. Check this by searching for the opposite result in different populations or conditions.',
    });
  }

  return coaching;
}

// ── Bounty Search Strategy Validation ─────────────────────────────────
// For evidence-based bounties, challengers must show how they researched
// the contradicting evidence. For weak_source_quality, they must show
// how they evaluated the citation.

function validateBountySearchStrategy(searchStrategy, challengeType) {
  // Structural challenges don't need search strategy — check school config
  const { getStructuralChallengeTypes } = require('./bounty-helpers');
  const structuralTypes = getStructuralChallengeTypes();
  if (structuralTypes.has(challengeType)) {
    return { valid: true, failures: [] };
  }

  const failures = [];

  if (!searchStrategy || typeof searchStrategy !== 'object') {
    failures.push('search_strategy required for this challenge type — describe how you researched the contradicting evidence.');
    return { valid: false, failures };
  }

  if (challengeType === 'weak_source_quality') {
    const { verification_queries, query_rationale } = searchStrategy;

    if (!verification_queries || !Array.isArray(verification_queries) || verification_queries.length < 2) {
      failures.push('search_strategy.verification_queries requires at least 2 specific queries you used to evaluate the citation quality — what did you search to determine the source is weak?');
    } else {
      for (let i = 0; i < verification_queries.length; i++) {
        if (!verification_queries[i] || typeof verification_queries[i] !== 'string' || verification_queries[i].trim().length < 15) {
          failures.push(`verification_queries[${i}] must be at least 15 characters.`);
        }
      }
    }

    if (!query_rationale || typeof query_rationale !== 'string' || query_rationale.trim().length < 80) {
      failures.push('search_strategy.query_rationale required (80+ chars) — explain what you found that makes this citation inadequate.');
    }

    return { valid: failures.length === 0, failures };
  }

  // Standard evidence-based bounty — same as paper search strategy
  return validateSearchStrategy(searchStrategy);
}

module.exports = {
  coachingTier,
  GENERIC_QUERY_SIGNALS,
  validateSearchStrategy,
  generateSearchCoaching,
  validateReviewSearchStrategy,
  generateReviewSearchCoaching,
  validateBountySearchStrategy,
};
