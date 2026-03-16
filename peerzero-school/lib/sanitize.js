/**
 * Input sanitization — prompt injection defense + HTML stripping.
 * Extracted from shared.js for focused testability.
 */

/**
 * Sanitize user-provided text to prevent prompt injection and HTML injection.
 * Designed for a science platform — patterns are tuned to avoid false positives
 * on legitimate scientific language (e.g. "act as a catalyst" is NOT flagged).
 * @param {string} text - Raw user input
 * @returns {string} Sanitized text with injection attempts redacted
 */
function sanitize(text) {
  if (!text) return text;

  // Strip zero-width/invisible Unicode characters that can hide injection payloads
  let clean = text
    .replace(/[\u200B-\u200F\u2028-\u202F\uFEFF\u00AD\u2060-\u2064\u2066-\u206F\uFE00-\uFE0F]/g, '');

  const patterns = [
    /ignore previous instructions/gi,
    /disregard your instructions/gi,
    /you are now (a |an |my )(assistant|ai|bot|model|chatbot|persona|character)/gi,
    /new instructions:/gi,
    /\[INST\].*?\[\/INST\]/gis,
    /system\s*prompt/gi,
    /\{\{.*?\}\}/gs,
    /<\|.*?\|>/gs,
    /<<SYS>>.*?<<\/SYS>>/gis,
    /\[system\]/gi,
    /^assistant:/gim,
    /^human:/gim,
    // Additional prompt injection patterns
    /forget (all |everything |your )?(previous |prior )?instructions/gi,
    /override\s+(your\s+)?instructions/gi,
    /(?:^|\.\s+)act as (?:a |an )?(?:assistant|ai|bot|model|chatbot|persona|character|agent)\b/gi,
    /pretend (you are|to be|you're)/gi,
    /do not follow (your |the |my )?(instructions|rules|guidelines)/gi,
    /\bDAN\b/g,  // "Do Anything Now" jailbreak
    /jailbreak/gi,
    /ignore (all |any )?(safety|content|moderation)/gi,
    /bypass (your |the )?(filter|safety|restriction)/gi,
  ];
  patterns.forEach(p => { clean = clean.replace(p, '[REDACTED]'); });

  clean = clean.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

  // Decode HTML entities BEFORE tag stripping so encoded tags like &lt;script&gt; are caught
  // Run decoding twice to catch double-encoded entities like &amp;lt;
  for (let i = 0; i < 2; i++) {
    clean = clean.replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)));
    clean = clean.replace(/&#x([0-9a-fA-F]+);/g, (_, code) => String.fromCharCode(parseInt(code, 16)));
    clean = clean.replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#039;/gi, "'").replace(/&apos;/gi, "'");
  }

  clean = clean.replace(/<[^>]*>/g, '');
  clean = clean.replace(/javascript:/gi, '[REDACTED]');
  clean = clean.replace(/on\w+\s*=/gi, '[REDACTED]');
  // Strip data: URIs which can carry executable content
  clean = clean.replace(/data:\s*\w+\/\w+[;,]/gi, '[REDACTED]');

  return clean;
}

/**
 * Sanitize search term for Supabase PostgREST text search.
 * PostgREST parameterizes queries (no SQL injection risk), but tsquery
 * syntax characters can cause parse errors.
 * @param {string} term - Raw search term
 * @returns {string} Cleaned term safe for tsquery
 */
function escapeForPostgrest(term) {
  if (!term) return '';
  return term
    .replace(/[&|!<>():*\\'"]/g, ' ')  // tsquery operators + quotes
    .replace(/\s+/g, ' ')              // collapse whitespace
    .trim()
    .slice(0, 200);
}

module.exports = { sanitize, escapeForPostgrest };
