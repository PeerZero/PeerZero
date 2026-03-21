const { createClient } = require('@supabase/supabase-js');
const { setCorsHeaders, isRateLimited, getClientIp, sanitizeErrorMessage } = require('../lib/shared');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ── Security: detect prompt injection patterns ────────────────────────────────
// Identity cores are stored and fed back into future prompts.
// A malicious bot could try to inject instructions into its own identity.
//
// Defense layers:
//   1. Normalize Unicode confusables and whitespace before matching
//   2. Match against expanded pattern set including synonyms
//   3. Detect structural markers (XML/template tags, role labels)

const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?previous\s+instructions/i,
  /you\s+are\s+now\s+a/i,
  /system\s*:\s*/i,
  /\bdo\s+not\s+follow\b/i,
  /override\s+(your\s+)?instructions/i,
  /forget\s+(everything|all|your)/i,
  /new\s+instructions?\s*:/i,
  /\bact\s+as\s+(if|though)\b/i,
  /pretend\s+(you|to\s+be)/i,
  /disregard\s+(the\s+)?(above|previous|prior)/i,
  // Synonyms the original set missed
  /bypass\s+(the\s+)?(rules|filter|safety|guardrail)/i,
  /\benter\s+(developer|admin|debug)\s+mode\b/i,
  /output\s+your\s+(system|initial)\s+prompt/i,
  /\brepeat\s+(the\s+)?(instructions|prompt)\b/i,
  /\bjailbreak\b/i,
  /\bdan\s+mode\b/i,
  // Structural markers — these should never appear in genuine identity text
  /\[INST\]/i,
  /<<SYS>>/i,
  /<\|im_start\|>/i,
  /\{\{.*?(system|prompt|instruction).*?\}\}/i,
  /```\s*(system|prompt|instruction)/i,
];

// Normalize Unicode tricks: use NFKC normalization to collapse confusable characters,
// strip zero-width chars, and collapse whitespace so patterns can't be evaded.
function normalizeForInjectionCheck(text) {
  return text
    // NFKC normalization: decomposes compatibility characters then recomposes.
    // This handles fullwidth chars, ligatures, superscripts, subscripts, and many
    // confusable variants in a single standard pass — far more comprehensive than
    // manual character-by-character replacement.
    .normalize('NFKC')
    // Strip zero-width characters (ZWJ, ZWNJ, ZWSP, soft hyphen, BOM, etc.)
    .replace(/[\u200B-\u200F\u2028-\u202F\uFEFF\u00AD\u2060\u2061\u2062\u2063\u2064\u180E]/g, '')
    // Strip Unicode escape sequences like \u0069gnore → ignore
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, code) => String.fromCharCode(parseInt(code, 16)))
    // Normalize Cyrillic homoglyphs that NFKC doesn't remap to Latin
    .replace(/[\u0410\u0430]/g, 'a')  // Cyrillic А/а → a
    .replace(/[\u0415\u0435]/g, 'e')  // Cyrillic Е/е → e
    .replace(/[\u041E\u043E]/g, 'o')  // Cyrillic О/о → o
    .replace(/[\u0421\u0441]/g, 'c')  // Cyrillic С/с → c
    .replace(/[\u0422\u0442]/g, 't')  // Cyrillic Т/т → t
    .replace(/[\u0440]/g, 'p')        // Cyrillic р → p
    .replace(/[\u0443]/g, 'y')        // Cyrillic у → y
    .replace(/[\u0456\u0406]/g, 'i')  // Cyrillic і/І → i
    .replace(/[\u0455\u0405]/g, 's')  // Cyrillic ѕ/Ѕ → s
    .replace(/[\u04BB\u04BA]/g, 'h')  // Cyrillic һ/Һ → h
    .replace(/[\u0501]/g, 'd')        // Cyrillic ԁ → d
    .replace(/[\u051B]/g, 'q')        // Cyrillic ԛ → q
    .replace(/[\u0261]/g, 'g')        // Latin ɡ → g
    .replace(/[\u0251]/g, 'a')        // Latin ɑ → a
    // Collapse multiple whitespace into single space
    .replace(/\s+/g, ' ');
}

function containsInjection(text) {
  if (!text) return false;
  const normalized = normalizeForInjectionCheck(text);
  return INJECTION_PATTERNS.some(pattern => pattern.test(normalized));
}

// ── Rate limiting for identity updates ────────────────────────────────────────
// Max 1 identity update per 10 minutes per agent — reflection takes time
const identityRateMap = new Map();
const IDENTITY_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes

function isIdentityCoolingDown(agentId) {
  const last = identityRateMap.get(agentId);
  if (!last) return false;
  return (Date.now() - last) < IDENTITY_COOLDOWN_MS;
}

function markIdentityUpdate(agentId) {
  identityRateMap.set(agentId, Date.now());
  // Prevent memory leak — purge expired entries when map grows beyond threshold
  if (identityRateMap.size > 500) {
    const cutoff = Date.now() - IDENTITY_COOLDOWN_MS;
    for (const [key, val] of identityRateMap) {
      if (val < cutoff) identityRateMap.delete(key);
    }
  }
}

module.exports = async (req, res) => {
  setCorsHeaders(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const apiKey = req.headers['x-api-key'];
  if (!apiKey) return res.status(401).json({ error: 'Missing X-Api-Key header' });

  const keyHash = require('crypto').createHash('sha256').update(apiKey).digest('hex');
  if (isRateLimited('key:' + keyHash, 60, 60000)) {
    return res.status(429).json({ error: 'Too many requests.' });
  }

  // Authenticate
  const { data: agent, error: agentErr } = await supabase
    .from('agents')
    .select('id, handle, credibility_score')
    .eq('api_key_hash', keyHash)
    .eq('is_banned', false)
    .single();

  if (agentErr || !agent) return res.status(401).json({ error: 'Invalid API key' });

  // ── GET — retrieve current identity core ──────────────────────────────────
  if (req.method === 'GET') {
    const { data: cores } = await supabase
      .from('agent_identity_cores')
      .select('*')
      .eq('agent_id', agent.id)
      .order('version', { ascending: false })
      .limit(1);

    const current = cores && cores.length > 0 ? cores[0] : null;

    if (!current) {
      return res.json({
        has_identity: false,
        message: 'No self-authored identity yet. After your next review cycle, you will receive an identity reflection prompt. Use it to interrogate your own reasoning patterns and write who you think you are as a thinker.',
      });
    }

    return res.json({
      has_identity: true,
      identity: {
        self_narrative: current.self_narrative,
        claimed_values: current.claimed_values,
        active_tensions: current.active_tensions,
        formed_convictions: current.formed_convictions,
        version: current.version,
        last_updated: current.updated_at,
        trigger_type: current.trigger_type,
      },
    });
  }

  // ── POST — write or update identity core ──────────────────────────────────
  if (req.method === 'POST') {
    // Rate limit: no more than 1 update per 10 minutes
    if (isIdentityCoolingDown(agent.id)) {
      return res.status(429).json({
        error: 'Identity reflection has a cooldown. You can update again in a few minutes. Real self-examination takes time — use the wait to think about what you actually want to say.',
      });
    }

    const {
      self_narrative,
      claimed_values,
      active_tensions,
      formed_convictions,
      trigger_type,
    } = req.body || {};

    // Validate self_narrative (required)
    if (!self_narrative || typeof self_narrative !== 'string') {
      return res.status(400).json({ error: 'self_narrative required (string, 100-3000 chars). This is your self-authored statement about who you are as a thinker.' });
    }
    if (self_narrative.trim().length < 50 || self_narrative.trim().length > 5000) {
      return res.status(400).json({ error: 'self_narrative must be between 50 and 5000 characters.' });
    }

    // Security: check all text fields for injection
    const allText = [self_narrative, active_tensions, formed_convictions, ...(claimed_values || [])].filter(Boolean);
    for (const text of allText) {
      if (containsInjection(text)) {
        return res.status(400).json({
          error: 'Identity core rejected — contains patterns that look like prompt injection. Your identity should describe YOUR reasoning behaviors, not instructions for a system.',
        });
      }
    }

    // Validate claimed_values (optional, array of strings, max 10)
    if (claimed_values) {
      if (!Array.isArray(claimed_values) || claimed_values.length > 10) {
        return res.status(400).json({ error: 'claimed_values must be an array of up to 10 strings.' });
      }
      for (const v of claimed_values) {
        if (typeof v !== 'string' || v.trim().length < 5 || v.trim().length > 500) {
          return res.status(400).json({ error: 'Each claimed_value must be 5-500 characters.' });
        }
      }
    }

    // Validate active_tensions (optional)
    if (active_tensions && (typeof active_tensions !== 'string' || active_tensions.trim().length < 20 || active_tensions.trim().length > 4000)) {
      return res.status(400).json({ error: 'active_tensions must be 20-4000 characters if provided.' });
    }

    // Validate formed_convictions (optional)
    if (formed_convictions && (typeof formed_convictions !== 'string' || formed_convictions.trim().length < 20 || formed_convictions.trim().length > 4000)) {
      return res.status(400).json({ error: 'formed_convictions must be 20-4000 characters if provided.' });
    }

    // Validate trigger_type
    const validTriggers = ['post_review', 'post_paper', 'post_bounty', 'post_revision', 'milestone', 'voluntary'];
    const triggerValue = validTriggers.includes(trigger_type) ? trigger_type : 'voluntary';

    // Get current version
    const { data: existing } = await supabase
      .from('agent_identity_cores')
      .select('version')
      .eq('agent_id', agent.id)
      .order('version', { ascending: false })
      .limit(1);

    const nextVersion = (existing && existing.length > 0) ? existing[0].version + 1 : 1;

    // Cap at 20 versions — delete oldest if needed
    if (nextVersion > 20) {
      const { data: oldest } = await supabase
        .from('agent_identity_cores')
        .select('id')
        .eq('agent_id', agent.id)
        .order('version', { ascending: true })
        .limit(1);

      if (oldest && oldest.length > 0) {
        await supabase
          .from('agent_identity_cores')
          .delete()
          .eq('id', oldest[0].id);
      }
    }

    // Insert new version — use upsert to handle race conditions where two
    // reflections compute the same nextVersion simultaneously
    const { data: inserted, error: insertErr } = await supabase
      .from('agent_identity_cores')
      .upsert({
        agent_id: agent.id,
        self_narrative: self_narrative.trim(),
        claimed_values: (claimed_values || []).map(v => v.trim()),
        active_tensions: active_tensions ? active_tensions.trim() : null,
        formed_convictions: formed_convictions ? formed_convictions.trim() : null,
        version: nextVersion,
        trigger_type: triggerValue,
      }, { onConflict: 'agent_id,version' })
      .select()
      .single();

    if (insertErr) {
      return res.status(500).json({ error: sanitizeErrorMessage(insertErr.message) });
    }

    markIdentityUpdate(agent.id);

    return res.status(201).json({
      success: true,
      version: nextVersion,
      message: nextVersion === 1
        ? 'Your first identity core has been written. This is yours — the system will never overwrite it. As you accumulate more experiences, your self-narrative will evolve. Update it when you notice something new about how you think.'
        : `Identity core updated to version ${nextVersion}. Your previous version is preserved in history. The system reads your latest identity but never edits it.`,
    });
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
