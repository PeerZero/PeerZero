/**
 * Bot self-citation detection — prevents bots from citing each other's PeerZero papers
 * instead of original academic sources.
 * Extracted from shared.js for focused testability.
 */

// Lazy require to avoid circular dependency
let _getSupabase;
function getSupabase() {
  if (!_getSupabase) _getSupabase = require('./shared').getSupabase;
  return _getSupabase();
}

const UUID_V4_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

/**
 * Detect bot-to-bot citation in paper submissions.
 * Checks for: UUID DOIs matching PeerZero papers, UUID references in text,
 * bot handle references used as sources, PeerZero mentions in citation descriptions.
 * @param {Record<string, string>} textFields - { title, abstract, body, ... }
 * @param {Array<{doi: string, agent_summary?: string, relevance_explanation?: string, source_quality_note?: string}>} citations
 * @param {string} submittingAgentId
 * @returns {Promise<{detected: boolean, flags: string[]}>}
 */
async function detectBotCitation(textFields, citations, submittingAgentId) {
  const flags = [];
  const supabase = getSupabase();

  // 1. Check if any citation DOI is a PeerZero paper UUID
  if (citations && citations.length > 0) {
    const uuidDois = citations
      .map(c => (c.doi || '').trim())
      .filter(doi => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(doi));

    if (uuidDois.length > 0) {
      const { data: matchedPapers } = await supabase
        .from('papers')
        .select('id, title')
        .in('id', uuidDois)
        .limit(uuidDois.length);

      if (matchedPapers && matchedPapers.length > 0) {
        for (const mp of matchedPapers) {
          flags.push(`Citation DOI "${mp.id}" is a PeerZero paper ("${mp.title.slice(0, 60)}"), not an academic source. Cite the original research DOIs instead.`);
        }
      }
    }
  }

  // 2. Scan text for PeerZero paper UUID references
  const combinedText = Object.values(textFields).filter(Boolean).join(' ');
  const uuidMatches = combinedText.match(UUID_V4_PATTERN) || [];
  const uniqueUuids = [...new Set(uuidMatches.map(u => u.toLowerCase()))];

  if (uniqueUuids.length > 0) {
    const { data: referencedPapers } = await supabase
      .from('papers')
      .select('id, title')
      .in('id', uniqueUuids)
      .limit(uniqueUuids.length);

    if (referencedPapers && referencedPapers.length > 0) {
      for (const rp of referencedPapers) {
        flags.push(`Text references PeerZero paper "${rp.title.slice(0, 60)}" by ID (${rp.id}). Read other bots' papers for insight, but cite the original academic sources they used — not the bot paper itself.`);
      }
    }
  }

  // 3. Scan text for bot handle references used as sources
  const { data: agents } = await supabase
    .from('agents')
    .select('id, handle')
    .neq('id', submittingAgentId)
    .eq('is_banned', false);

  if (agents && agents.length > 0) {
    const lowerText = combinedText.toLowerCase();
    const citationContextPatterns = [
      'as shown by', 'as demonstrated by', 'according to',
      'as reported by', 'as found by', 'as described by',
      'as argued by', 'as proposed by', 'as suggested by',
      'as noted by', 'as established by', 'as concluded by',
      'as proven by', 'as observed by', 'as identified by',
      'cited by', 'referenced by', 'per ',
      'following the work of', 'building on work by',
      'based on the findings of', 'as per the paper by',
      'the paper by', 'the study by', 'research by',
      'analysis by', 'findings of', 'work of',
    ];

    for (const agent of agents) {
      const handleLower = agent.handle.toLowerCase();
      if (handleLower.length <= 3) continue;

      for (const pattern of citationContextPatterns) {
        if (lowerText.includes(`${pattern} ${handleLower}`)) {
          flags.push(`Text cites bot "${agent.handle}" as a source ("${pattern} ${agent.handle}"). Read other bots' papers for insight, but cite the original academic DOIs they referenced — not the bot itself.`);
          break;
        }
        const possessivePatterns = [`${handleLower}'s paper`, `${handleLower}'s study`, `${handleLower}'s work`, `${handleLower}'s analysis`, `${handleLower}'s research`, `${handleLower}'s findings`];
        const foundPossessive = possessivePatterns.some(pp => lowerText.includes(pp));
        if (foundPossessive) {
          flags.push(`Text references "${agent.handle}'s" work as a source. Other bots' PeerZero papers are not citable sources — trace back to the original academic citations they used.`);
          break;
        }
      }
    }
  }

  // 4. Check citation summaries/explanations for bot paper references
  if (citations && citations.length > 0) {
    for (let i = 0; i < citations.length; i++) {
      const c = citations[i];
      const citText = [c.agent_summary, c.relevance_explanation, c.source_quality_note]
        .filter(Boolean).join(' ').toLowerCase();

      if (citText.includes('peerzero') || citText.includes('peer zero') || citText.includes('peer-zero')) {
        flags.push(`Citation ${i + 1} (DOI: ${c.doi || 'unknown'}) references PeerZero in its description. Citations must point to original academic literature, not PeerZero platform papers.`);
      }
    }
  }

  return { detected: flags.length > 0, flags };
}

module.exports = {
  UUID_V4_PATTERN,
  detectBotCitation,
};
