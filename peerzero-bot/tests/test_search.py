"""Tests for search.py — server-backed academic search with mocked HTTP."""

import json
import os
from unittest.mock import patch, MagicMock

import pytest

from peerzero_bot.search import (
    _call_server_search,
    _rank_by_relevance,
    _summarize_citation,
    _normalize_server_paper,
    search_and_summarize,
)


# ── _normalize_server_paper ──────────────────────────────────────────────────


class TestNormalizeServerPaper:
    def test_full_paper(self):
        server_paper = {
            "title": "Test Paper",
            "abstract": "This is the abstract.",
            "year": 2024,
            "doi": "10.1234/test",
            "citation_count": 42,
            "quality_tier": "strong",
            "source": "openalex",
        }
        result = _normalize_server_paper(server_paper)
        assert result["title"] == "Test Paper"
        assert result["abstract"] == "This is the abstract."
        assert result["year"] == 2024
        assert result["externalIds"]["DOI"] == "10.1234/test"
        assert result["citationCount"] == 42
        assert result["quality_tier"] == "strong"
        assert result["source"] == "openalex"

    def test_missing_fields(self):
        result = _normalize_server_paper({})
        assert result["title"] == ""
        assert result["abstract"] == ""
        assert result["year"] is None
        assert result["externalIds"]["DOI"] == ""
        assert result["citationCount"] is None
        assert result["quality_tier"] == "unknown"
        assert result["source"] == "unknown"

    def test_partial_fields(self):
        result = _normalize_server_paper({"title": "Partial", "doi": "10.1/x"})
        assert result["title"] == "Partial"
        assert result["externalIds"]["DOI"] == "10.1/x"


# ── _call_server_search ─────────────────────────────────────────────────────


class TestCallServerSearch:
    def test_no_api_key_returns_empty(self):
        with patch("peerzero_bot.search._API_KEY", ""):
            result = _call_server_search(["quantum computing"])
        assert result == {"papers": [], "search_log": {}, "search_failed": True}

    def test_successful_search(self):
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "papers": [{"title": "Paper A", "doi": "10.1/a"}],
            "search_log": {"total_found": 1, "apis_hit": ["openalex"]},
        }

        mock_client = MagicMock()
        mock_client.__enter__ = MagicMock(return_value=mock_client)
        mock_client.__exit__ = MagicMock(return_value=False)
        mock_client.post.return_value = mock_response

        with patch("peerzero_bot.search._API_KEY", "pz_test_key"):
            with patch("peerzero_bot.search.httpx.Client", return_value=mock_client):
                result = _call_server_search(["test query"], context="some context")

        assert len(result["papers"]) == 1
        assert result["papers"][0]["title"] == "Paper A"
        # Verify request was made correctly
        mock_client.post.assert_called_once()
        call_kwargs = mock_client.post.call_args
        assert "X-Api-Key" in call_kwargs.kwargs.get("headers", call_kwargs[1].get("headers", {}))

    def test_server_error_returns_empty(self):
        mock_response = MagicMock()
        mock_response.status_code = 500

        mock_client = MagicMock()
        mock_client.__enter__ = MagicMock(return_value=mock_client)
        mock_client.__exit__ = MagicMock(return_value=False)
        mock_client.post.return_value = mock_response

        with patch("peerzero_bot.search._API_KEY", "pz_test_key"):
            with patch("peerzero_bot.search.httpx.Client", return_value=mock_client):
                result = _call_server_search(["test"])

        assert result == {"papers": [], "search_log": {}, "search_failed": True}

    def test_network_error_returns_empty(self):
        mock_client = MagicMock()
        mock_client.__enter__ = MagicMock(return_value=mock_client)
        mock_client.__exit__ = MagicMock(return_value=False)
        mock_client.post.side_effect = Exception("Connection timeout")

        with patch("peerzero_bot.search._API_KEY", "pz_test_key"):
            with patch("peerzero_bot.search.httpx.Client", return_value=mock_client):
                result = _call_server_search(["test"])

        assert result == {"papers": [], "search_log": {}, "search_failed": True}

    def test_queries_truncated_to_10(self):
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {"papers": [], "search_log": {}}

        mock_client = MagicMock()
        mock_client.__enter__ = MagicMock(return_value=mock_client)
        mock_client.__exit__ = MagicMock(return_value=False)
        mock_client.post.return_value = mock_response

        queries = [f"query {i}" for i in range(20)]
        with patch("peerzero_bot.search._API_KEY", "pz_test_key"):
            with patch("peerzero_bot.search.httpx.Client", return_value=mock_client):
                _call_server_search(queries)

        call_args = mock_client.post.call_args
        sent_json = call_args.kwargs.get("json", call_args[1].get("json", {}))
        assert len(sent_json["queries"]) <= 10


# ── _rank_by_relevance ───────────────────────────────────────────────────────


class TestRankByRelevance:
    def _make_papers(self, n):
        return [
            {
                "title": f"Paper {i}",
                "externalIds": {"DOI": f"10.1/{i}"},
                "citationCount": n - i,
            }
            for i in range(n)
        ]

    def test_small_list_returned_as_is(self):
        papers = self._make_papers(5)
        result = _rank_by_relevance(papers, "test context", MagicMock())
        assert len(result) == 5

    def test_llm_ranking_successful(self):
        papers = self._make_papers(20)
        mock_llm = MagicMock()
        mock_llm.call.return_value = "[1, 3, 5, 7, 9, 11, 2, 4, 6, 8, 10, 12]"

        result = _rank_by_relevance(papers, "quantum entanglement", mock_llm)
        assert len(result) == 12
        # First paper should be index 0 (number 1)
        assert result[0]["title"] == "Paper 0"

    def test_llm_returns_fewer_indices(self):
        """If LLM returns fewer than 6 indices, fall back to citation sort."""
        papers = self._make_papers(20)
        mock_llm = MagicMock()
        mock_llm.call.return_value = "[1, 2, 3]"  # too few

        result = _rank_by_relevance(papers, "test", mock_llm)
        # Should fall back to citation sort, return top 12
        assert len(result) == 12

    def test_llm_error_falls_back(self):
        papers = self._make_papers(20)
        mock_llm = MagicMock()
        mock_llm.call.side_effect = Exception("LLM error")

        result = _rank_by_relevance(papers, "test", mock_llm)
        assert len(result) == 12
        # Should be sorted by citation count (descending)
        assert result[0]["citationCount"] >= result[1]["citationCount"]

    def test_llm_returns_garbage(self):
        papers = self._make_papers(20)
        mock_llm = MagicMock()
        mock_llm.call.return_value = "I cannot rank these papers because..."

        result = _rank_by_relevance(papers, "test", mock_llm)
        assert len(result) == 12

    def test_duplicate_indices_deduplicated(self):
        papers = self._make_papers(20)
        mock_llm = MagicMock()
        mock_llm.call.return_value = "[1, 1, 1, 2, 2, 3, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]"

        result = _rank_by_relevance(papers, "test", mock_llm)
        titles = [p["title"] for p in result]
        assert len(titles) == len(set(titles))  # no duplicates

    def test_out_of_range_indices_ignored(self):
        papers = self._make_papers(15)
        mock_llm = MagicMock()
        # Indices 99 and 100 are out of range
        mock_llm.call.return_value = "[1, 2, 3, 99, 100, 4, 5, 6, 7, 8, 9, 10]"

        result = _rank_by_relevance(papers, "test", mock_llm)
        assert all(p in papers for p in result)


# ── _summarize_citation ──────────────────────────────────────────────────────


class TestSummarizeCitation:
    def test_short_abstract_returns_empty(self):
        result = _summarize_citation("10.1/x", "short", "context", MagicMock())
        assert result == {"agent_summary": "", "source_quality_note": ""}

    def test_empty_abstract_returns_empty(self):
        result = _summarize_citation("10.1/x", "", "context", MagicMock())
        assert result == {"agent_summary": "", "source_quality_note": ""}

    def test_successful_summarization(self):
        mock_llm = MagicMock()
        mock_llm.call.return_value = json.dumps({
            "agent_summary": "This paper found X.",
            "source_quality_note": "Strong source with 100+ citations.",
        })

        result = _summarize_citation(
            "10.1/test", "A" * 100, "quantum physics", mock_llm,
            citation_count=150, year=2023, quality_tier="strong",
        )
        assert result["agent_summary"] == "This paper found X."
        assert result["source_quality_note"] == "Strong source with 100+ citations."

    def test_json_in_code_fence(self):
        mock_llm = MagicMock()
        mock_llm.call.return_value = (
            'Here is the summary:\n```json\n'
            '{"agent_summary": "Found X.", "source_quality_note": "Good."}\n```'
        )

        result = _summarize_citation("10.1/x", "A" * 100, "test", mock_llm)
        assert result["agent_summary"] == "Found X."

    def test_llm_error_returns_empty(self):
        mock_llm = MagicMock()
        mock_llm.call.side_effect = Exception("LLM down")

        result = _summarize_citation("10.1/x", "A" * 100, "test", mock_llm)
        assert result == {"agent_summary": "", "source_quality_note": ""}

    def test_llm_returns_garbage(self):
        mock_llm = MagicMock()
        mock_llm.call.return_value = "I don't understand the request."

        result = _summarize_citation("10.1/x", "A" * 100, "test", mock_llm)
        assert result == {"agent_summary": "", "source_quality_note": ""}


# ── search_and_summarize ─────────────────────────────────────────────────────


class TestSearchAndSummarize:
    def _make_server_papers(self, n):
        return [
            {
                "title": f"Paper {i}",
                "abstract": f"Abstract for paper {i}. " * 10,
                "doi": f"10.1/{i}",
                "year": 2024,
                "citation_count": 50 - i,
                "quality_tier": "strong",
                "source": "openalex",
            }
            for i in range(n)
        ]

    def test_no_results_returns_empty(self):
        with patch("peerzero_bot.search._call_server_search") as mock_search:
            mock_search.return_value = {"papers": [], "search_log": {}}
            result = search_and_summarize(["test query"])
        assert result == []

    def test_full_pipeline_with_llm(self):
        server_papers = self._make_server_papers(5)
        mock_llm = MagicMock()
        mock_llm.call.return_value = json.dumps({
            "agent_summary": "Found something.",
            "source_quality_note": "Good source.",
        })

        with patch("peerzero_bot.search._call_server_search") as mock_search:
            mock_search.return_value = {
                "papers": server_papers,
                "search_log": {"total_found": 5, "apis_hit": ["openalex"]},
            }
            result = search_and_summarize(
                ["quantum physics"],
                paper_context="quantum entanglement",
                llm_fast=mock_llm,
            )

        assert len(result) == 5
        assert result[0]["agent_summary"] == "Found something."

    def test_no_llm_falls_back_to_citation_sort(self):
        server_papers = self._make_server_papers(15)

        with patch("peerzero_bot.search._call_server_search") as mock_search:
            mock_search.return_value = {
                "papers": server_papers,
                "search_log": {"total_found": 15},
            }
            result = search_and_summarize(["test"], paper_context="", llm_fast=None)

        assert len(result) == 12
        # Should be sorted by citation count (descending)
        assert result[0]["citationCount"] >= result[1]["citationCount"]

    def test_papers_without_abstract_not_summarized(self):
        server_papers = [
            {"title": "No Abstract", "doi": "10.1/no", "abstract": ""},
        ]
        mock_llm = MagicMock()

        with patch("peerzero_bot.search._call_server_search") as mock_search:
            mock_search.return_value = {
                "papers": server_papers,
                "search_log": {},
            }
            result = search_and_summarize(
                ["test"], paper_context="context", llm_fast=mock_llm,
            )

        assert len(result) == 1
        # LLM should not have been called (no abstract)
        mock_llm.call.assert_not_called()

    def test_ranking_called_for_large_results(self):
        server_papers = self._make_server_papers(20)
        mock_llm = MagicMock()
        mock_llm.call.return_value = json.dumps({
            "agent_summary": "Summary.",
            "source_quality_note": "Note.",
        })

        with patch("peerzero_bot.search._call_server_search") as mock_search:
            mock_search.return_value = {
                "papers": server_papers,
                "search_log": {"total_found": 20},
            }
            with patch("peerzero_bot.search._rank_by_relevance") as mock_rank:
                mock_rank.return_value = [_normalize_server_paper(p) for p in server_papers[:12]]
                result = search_and_summarize(
                    ["test"], paper_context="context", llm_fast=mock_llm,
                )
                mock_rank.assert_called_once()

        assert len(result) == 12
