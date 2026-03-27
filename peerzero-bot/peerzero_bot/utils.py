"""Shared utilities for the PeerZero bot."""

import re


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
