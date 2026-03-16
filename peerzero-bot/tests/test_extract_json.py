"""Tests for extract_json — the LLM response parser."""

import pytest
from peerzero_bot.adapters.school import extract_json


class TestExtractJson:
    """Tests for the extract_json function."""

    def test_pure_json(self):
        result = extract_json('{"score": 7, "notes": "good"}')
        assert result == {"score": 7, "notes": "good"}

    def test_json_with_whitespace(self):
        result = extract_json('  \n  {"score": 7}  \n  ')
        assert result == {"score": 7}

    def test_code_fence(self):
        text = 'Here is my review:\n```json\n{"score": 8}\n```'
        result = extract_json(text)
        assert result == {"score": 8}

    def test_code_fence_no_language(self):
        text = 'Here:\n```\n{"score": 8}\n```'
        result = extract_json(text)
        assert result == {"score": 8}

    def test_embedded_json(self):
        text = 'I think the score should be {"score": 6, "reason": "weak"} based on the evidence.'
        result = extract_json(text)
        assert result == {"score": 6, "reason": "weak"}

    def test_nested_json(self):
        text = '{"outer": {"inner": "value"}, "list": [1, 2, 3]}'
        result = extract_json(text)
        assert result == {"outer": {"inner": "value"}, "list": [1, 2, 3]}

    def test_trailing_comma_cleanup(self):
        text = '{"score": 7, "notes": "ok",}'
        result = extract_json(text)
        assert result is not None
        assert result["score"] == 7

    def test_returns_none_for_empty(self):
        assert extract_json("") is None
        assert extract_json(None) is None

    def test_returns_none_for_no_json(self):
        assert extract_json("This is just plain text with no JSON.") is None

    def test_returns_none_for_array(self):
        """extract_json should only return dicts, not arrays."""
        result = extract_json('[1, 2, 3]')
        assert result is None

    def test_json_with_escaped_quotes(self):
        text = '{"note": "He said \\"hello\\"", "score": 5}'
        result = extract_json(text)
        assert result is not None
        assert result["score"] == 5

    def test_json_after_preamble(self):
        text = """Based on my analysis of the paper, here is my review:

{"score": 7, "methodology_notes": "Sound design", "overall_assessment": "Good paper"}

I hope this review is helpful."""
        result = extract_json(text)
        assert result is not None
        assert result["score"] == 7
        assert "methodology_notes" in result
