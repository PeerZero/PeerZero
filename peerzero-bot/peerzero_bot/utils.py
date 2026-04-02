"""Shared utilities for the PeerZero bot."""

import re


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
]

# Zero-width and invisible Unicode characters
_INVISIBLE_CHARS = re.compile(r'[\u200B-\u200F\u2028-\u202F\uFEFF\u00AD\u2060-\u2064\u2066-\u206F\uFE00-\uFE0F]')


def sanitize_platform_content(text: str) -> str:
    """Strip prompt injection patterns from untrusted platform content.

    Applied to all external platform input (A2A, webhook, MCP) before it
    enters LLM prompts. Mirrors the server's sanitize.js patterns.
    """
    if not text:
        return text

    # Strip invisible characters that can hide payloads
    clean = _INVISIBLE_CHARS.sub('', text)

    # Strip injection patterns
    for pattern in _INJECTION_PATTERNS:
        clean = pattern.sub('[REDACTED]', clean)

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
