"""Shared utilities for the PeerZero bot."""


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
