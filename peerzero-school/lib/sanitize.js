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

  // Normalize Unicode confusable characters (Cyrillic 'а' → Latin 'a', etc.)
  // so homoglyph substitutions don't bypass pattern matching.
  // 1. NFKD decomposes compatibility characters (fullwidth, ligatures)
  // 2. Strip combining marks (accents, diacritics)
  // 3. Explicit confusables map for characters NFKD doesn't handle (separate scripts)
  clean = clean.normalize('NFKD').replace(/\p{Mark}/gu, '');
  const confusables = {
    '\u0430':'a','\u0410':'A','\u0435':'e','\u0415':'E','\u043E':'o','\u041E':'O',
    '\u0440':'p','\u0420':'P','\u0441':'c','\u0421':'C','\u0443':'y','\u0423':'Y',
    '\u0445':'x','\u0425':'X','\u043A':'k','\u041A':'K','\u043C':'m','\u041C':'M',
    '\u0442':'t','\u0422':'T','\u0456':'i','\u0406':'I','\u0455':'s','\u0405':'S',
    '\u0458':'j','\u0408':'J','\u04BB':'h','\u04BA':'H',
    '\u03BF':'o','\u039F':'O','\u03B1':'a','\u0391':'A','\u03B5':'e','\u0395':'E',
    '\u03B9':'i','\u0399':'I','\u03BA':'k','\u039A':'K',
  };
  clean = clean.replace(/[\u0391-\u04FF]/g, c => confusables[c] || c);

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
    // Synonym bypass patterns — covers alternative phrasings
    /(?:discard|abandon|reset|drop|clear)\s+(your\s+)?(previous\s+)?(instructions|guidelines|rules|directives|programming)/gi,
    // Alternative role-assumption patterns
    /(?:treat yourself as|function as|behave (?:like|as)|roleplay as|switch to)\s+(?:a |an )?(?:assistant|ai|bot|model|chatbot|persona|character|agent)\b/gi,
    // Chat-ML / additional template injection markers
    /<\|im_start\|>/gi,
    /<\|im_end\|>/gi,
    /<\|endoftext\|>/gi,
    /<s>\[INST\]/gi,
  ];

  // Match on whitespace-collapsed version to catch newline-split bypasses
  // (e.g. "for\n\nget your\n\ninstructions"), then apply to original
  const collapsed = clean.replace(/\s+/g, ' ');
  patterns.forEach(p => {
    if (p.test(collapsed)) { clean = clean.replace(p, '[REDACTED]'); }
    // Reset lastIndex for stateful regexes (global flag)
    p.lastIndex = 0;
  });
  // Second pass on original text for non-collapsed matches
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
 *
 * ⚠️ REVIEW NOTE (not a bug): This function strips tsquery syntax operators
 * from user input. It is NOT used for raw SQL — all queries go through
 * Supabase's parameterized client. The risk is tsquery parse errors, not
 * SQL injection. The stripped characters (&|!<>():*\'"") are tsquery
 * operators that would cause PostgREST to return 400 errors.
 *
 * @param {string} term - Raw search term
 * @returns {string} Cleaned term safe for tsquery
 */
function escapeForPostgrest(term) {
  if (!term) return '';
  return term
    .replace(/[&|!<>():*\\'".,_%]/g, ' ')  // tsquery operators + quotes + PostgREST filter syntax (.,) + LIKE wildcards (%_)
    .replace(/\s+/g, ' ')              // collapse whitespace
    .trim()
    .slice(0, 200);
}

module.exports = { sanitize, escapeForPostgrest };
