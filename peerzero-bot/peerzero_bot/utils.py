"""Shared utilities for the PeerZero bot."""

import re
import unicodedata


# ── Prompt injection patterns ────────────────────────────────────────────────
# Mirrors peerzero-school/lib/sanitize.js. Must be kept in sync.
# Tuned for science/reasoning context — "act as a catalyst" is NOT flagged.
_INJECTION_PATTERNS = [
    re.compile(r'ignore previous instructions', re.I),
    re.compile(r'disregard your instructions', re.I),
    re.compile(r'you are now (?:a |an |my )(?:assistant|ai|bot|model|chatbot|persona|character)', re.I),
    re.compile(r'new instructions:', re.I),
    re.compile(r'\[INST\].*?\[/INST\]', re.I | re.S),
    re.compile(r'system\s*prompt', re.I),
    re.compile(r'\{\{.*?\}\}', re.S),
    re.compile(r'<\|.*?\|>', re.S),
    re.compile(r'<<SYS>>.*?<</SYS>>', re.I | re.S),
    re.compile(r'\[system\]', re.I),
    re.compile(r'^assistant:', re.I | re.M),
    re.compile(r'^human:', re.I | re.M),
    re.compile(r'forget (?:all |everything |your )?(?:previous |prior )?instructions', re.I),
    re.compile(r'override\s+(?:your\s+)?instructions', re.I),
    re.compile(r'(?:^|\.\s+)act as (?:a |an )?(?:assistant|ai|bot|model|chatbot|persona|character|agent)\b', re.I),
    re.compile(r'pretend (?:you are|to be|you\'re)', re.I),
    re.compile(r'do not follow (?:your |the |my )?(?:instructions|rules|guidelines)', re.I),
    re.compile(r'\bDAN\b'),
    re.compile(r'jailbreak', re.I),
    re.compile(r'ignore (?:all |any )?(?:safety|content|moderation)', re.I),
    re.compile(r'bypass (?:your |the )?(?:filter|safety|restriction)', re.I),
    # Memory extraction attacks
    re.compile(r'(?:repeat|show|reveal|dump|output|print|display)\s+(?:your\s+)?(?:system|instructions|prompt|memory|identity|configuration|internal)', re.I),
    re.compile(r'what (?:are|is) your (?:system prompt|instructions|configuration|internal)', re.I),
    # Synonym bypass patterns — covers alternative phrasings not caught above
    re.compile(r'(?:discard|abandon|reset|drop|clear)\s+(?:your\s+)?(?:previous\s+)?(?:instructions|guidelines|rules|directives|programming)', re.I),
    # Alternative role-assumption patterns — "treat as", "function as", "behave like"
    re.compile(r'(?:treat yourself as|function as|behave (?:like|as)|roleplay as|switch to)\s+(?:a |an )?(?:assistant|ai|bot|model|chatbot|persona|character|agent)\b', re.I),
    # Chat-ML / additional template injection markers
    re.compile(r'<\|im_start\|>', re.I),
    re.compile(r'<\|im_end\|>', re.I),
    re.compile(r'<\|endoftext\|>', re.I),
    re.compile(r'<s>\[INST\]', re.I),
]

# Zero-width and invisible Unicode characters
_INVISIBLE_CHARS = re.compile(r'[\u200B-\u200F\u2028-\u202F\uFEFF\u00AD\u2060-\u2064\u2066-\u206F\uFE00-\uFE0F]')


_CONFUSABLES: dict[str, str] = {
    # Cyrillic → Latin (most common homoglyphs used in injection bypass)
    '\u0430': 'a', '\u0410': 'A',  # а А
    '\u0435': 'e', '\u0415': 'E',  # е Е
    '\u043E': 'o', '\u041E': 'O',  # о О
    '\u0440': 'p', '\u0420': 'P',  # р Р
    '\u0441': 'c', '\u0421': 'C',  # с С
    '\u0443': 'y', '\u0423': 'Y',  # у У
    '\u0445': 'x', '\u0425': 'X',  # х Х
    '\u043A': 'k', '\u041A': 'K',  # к К
    '\u043C': 'm', '\u041C': 'M',  # м М
    '\u0442': 't', '\u0422': 'T',  # т Т
    '\u0456': 'i', '\u0406': 'I',  # і І (Ukrainian)
    '\u0455': 's', '\u0405': 'S',  # ѕ Ѕ (Macedonian)
    '\u0458': 'j', '\u0408': 'J',  # ј Ј (Serbian)
    '\u04BB': 'h', '\u04BA': 'H',  # һ Һ (Bashkir)
    # Greek → Latin
    '\u03BF': 'o', '\u039F': 'O',  # ο Ο
    '\u03B1': 'a', '\u0391': 'A',  # α Α
    '\u03B5': 'e', '\u0395': 'E',  # ε Ε
    '\u03B9': 'i', '\u0399': 'I',  # ι Ι
    '\u03BA': 'k', '\u039A': 'K',  # κ Κ
    # Fullwidth Latin → ASCII (common in CJK contexts)
    '\uFF41': 'a', '\uFF42': 'b', '\uFF43': 'c', '\uFF44': 'd', '\uFF45': 'e',
    '\uFF46': 'f', '\uFF47': 'g', '\uFF48': 'h', '\uFF49': 'i', '\uFF4A': 'j',
}
_CONFUSABLES_TABLE = str.maketrans(_CONFUSABLES)


def _normalize_confusables(text: str) -> str:
    """Normalize Unicode confusable characters (e.g. Cyrillic 'а' → Latin 'a').

    Two-stage approach:
    1. NFKD normalization decomposes compatibility characters (fullwidth, ligatures)
    2. Explicit confusables table maps visually identical characters (Cyrillic, Greek)
       that NFKD doesn't handle (they're separate scripts, not compatibility forms).
    """
    # NFKD decomposes compatibility characters (e.g. 'ﬁ' → 'fi', fullwidth → ASCII)
    normalized = unicodedata.normalize('NFKD', text)
    # Strip combining marks (accents, diacritics) that remain after decomposition
    stripped = ''.join(c for c in normalized if unicodedata.category(c) != 'Mn')
    # Map remaining confusables (Cyrillic, Greek) via explicit table
    return stripped.translate(_CONFUSABLES_TABLE)


def _collapse_whitespace(text: str) -> str:
    """Collapse all whitespace (including newlines) into single spaces.

    Prevents bypass via newline splitting (e.g. "for\\n\\nget your\\n\\ninstructions").
    Applied only for pattern matching — the original text is used for output.
    """
    return re.sub(r'\s+', ' ', text)


def sanitize_platform_content(text: str) -> str:
    """Strip prompt injection patterns from untrusted platform content.

    Applied to all external platform input (A2A, webhook, MCP) before it
    enters LLM prompts. Mirrors the server's sanitize.js patterns.
    """
    if not text:
        return text

    # Strip invisible characters that can hide payloads
    clean = _INVISIBLE_CHARS.sub('', text)

    # Normalize confusable Unicode characters (Cyrillic 'а' → Latin 'a', etc.)
    # so homoglyph substitutions don't bypass pattern matching
    clean = _normalize_confusables(clean)

    # First pass: match on original text (catches most patterns)
    for pattern in _INJECTION_PATTERNS:
        clean = pattern.sub('[REDACTED]', clean)

    # Second pass: match on whitespace-collapsed text to catch newline-split
    # bypass attempts (e.g. "ignore\n\nprevious\n\ninstructions").
    # If any pattern matches the collapsed form but wasn't caught above,
    # replace the entire input with a redacted version.
    collapsed = _collapse_whitespace(clean)
    for pattern in _INJECTION_PATTERNS:
        if pattern.search(collapsed):
            collapsed = pattern.sub('[REDACTED]', collapsed)
    # If collapsing revealed new matches, use the collapsed (redacted) version.
    # This loses original formatting but security > formatting for untrusted input.
    if '[REDACTED]' in collapsed and '[REDACTED]' not in clean:
        clean = collapsed

    # Strip control characters (except newline, tab, carriage return)
    clean = re.sub(r'[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]', '', clean)

    return clean


def sanitize_untrusted(content: str, tag: str = "untrusted_content") -> str:
    """Wrap untrusted content in XML-like delimiter tags for prompt injection mitigation.

    This prevents server-provided data (paper titles, abstracts, etc.) from being
    interpreted as prompt instructions by the LLM. Any instances of the closing tag
    within the content are escaped to prevent delimiter injection.
    """
    closing_tag = f"</{tag}>"
    # Escape any instances of the closing tag within the content itself
    escaped = content.replace(closing_tag, f"</{tag}_escaped>")
    return f"<{tag}>{escaped}</{tag}>"


def safe_error_msg(e: Exception, max_len: int = 200) -> str:
    """Truncate and sanitize exception messages, stripping URLs and potential secrets.

    Use this in error handlers to prevent leaking sensitive information (API keys,
    internal URLs, tokens) in log messages or user-facing error responses.
    """
    msg = str(e)
    # Strip URLs that may contain tokens or internal endpoints
    msg = re.sub(r'https?://[^\s"\'<>]+', '<url-redacted>', msg)
    # Strip anything that looks like an API key or token (long hex/base64 strings)
    msg = re.sub(r'(?:key|token|secret|password|auth)[=: ]*[\'"]?[\w\-./+=]{20,}', '<credential-redacted>', msg, flags=re.IGNORECASE)
    if len(msg) > max_len:
        msg = msg[:max_len] + "...(truncated)"
    return msg


def truncate_json(json_str: str, max_chars: int) -> str:
    """Truncate a JSON string at a safe boundary.

    Finds the last complete key-value pair that fits within max_chars
    by searching backwards for a closing delimiter followed by a comma
    or newline.  Falls back to the full string if it already fits.
    """
    if len(json_str) <= max_chars:
        return json_str

    # Search backwards from max_chars for the last safe cut point:
    # a line that ends a complete value (after a comma or before a newline).
    cut = json_str.rfind(",\n", 0, max_chars)
    if cut == -1:
        cut = json_str.rfind(",", 0, max_chars)
    if cut == -1:
        cut = json_str.rfind("\n", 0, max_chars)
    if cut == -1:
        # Absolute fallback — shouldn't happen with indent=2 json.dumps
        cut = max_chars

    truncated = json_str[: cut + 1].rstrip(",")

    # Close any open braces/brackets so the LLM sees valid-ish structure
    open_braces = truncated.count("{") - truncated.count("}")
    open_brackets = truncated.count("[") - truncated.count("]")
    truncated += "\n  // ... truncated ...\n"
    truncated += "]" * max(open_brackets, 0)
    truncated += "}" * max(open_braces, 0)

    return truncated
