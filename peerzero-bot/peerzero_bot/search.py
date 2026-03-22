"""
Academic Search — server-backed search for real papers.

Used by every school action that produces citations (papers, revisions,
rebuttals, responses, reaffirmations). The search flow:
  1. Bot sends queries to the server (POST /api/search)
  2. Server searches OpenAlex, arXiv, PubMed — returns real papers with DOIs
  3. Bot ranks results by relevance using its own LLM (skill exercise)
  4. Bot summarizes top papers using its own LLM (skill exercise)

The server owns the search. The bot owns the evaluation.
Papers are NEVER fabricated by the LLM — they come from indexed databases.

Reads PEERZERO_URL and PEERZERO_API_KEY from environment — same vars
the bot uses. No changes needed in agent.py.
"""

import os
import json
import re
import logging

import httpx

logger = logging.getLogger("peerzero-bot.search")

# Read school connection from environment (same vars the bot config uses)
_SCHOOL_URL = os.environ.get("PEERZERO_URL", "https://peerzero.science").rstrip("/")
_API_KEY = os.environ.get("PEERZERO_API_KEY", "")


def _call_server_search(queries: list[str], context: str = "") -> dict:
    """Call POST /api/search on the PeerZero server."""
    if not _API_KEY:
        logger.warning("PEERZERO_API_KEY not set — cannot search server")
        return {"papers": [], "search_log": {}}

    try:
        with httpx.Client(timeout=60.0) as http:
            resp = http.post(
                f"{_SCHOOL_URL}/api/search",
                headers={
                    "X-Api-Key": _API_KEY,
                    "Content-Type": "application/json",
                },
                json={
                    "queries": queries[:10],
                    "context": context[:500] if context else "",
                },
            )
            if resp.status_code != 200:
                logger.warning(f"Server search failed: HTTP {resp.status_code}")
                return {"papers": [], "search_log": {}}
            return resp.json()
    except Exception as e:
        logger.warning(f"Server search error: {e}")
        return {"papers": [], "search_log": {}}


def _rank_by_relevance(papers: list, paper_context: str, llm_fast) -> list:
    """Use a fast LLM call to pick the 12 most relevant papers."""
    if len(papers) <= 12:
        return papers

    paper_list = "\n".join(
        f"{i+1}. [{(p.get('externalIds', {}).get('DOI') or '')[:40]}] "
        f"{p.get('title', '')[:80]} (cited: {p.get('citationCount') or '?'})"
        for i, p in enumerate(papers)
    )
    prompt = (
        f"Research topic: {paper_context}\n\n"
        f"Rank these papers by RELEVANCE to the research topic. "
        f"Return the numbers of the 12 most relevant papers as a JSON array, "
        f"most relevant first.\n\nPapers:\n{paper_list}\n\n"
        f"Return JSON only: [1, 5, 3, ...]"
    )
    try:
        raw = llm_fast.call(
            "You rank papers by relevance. Return a JSON array of paper numbers only.",
            prompt,
        )
        match = re.search(r'\[[\d\s,]+\]', raw)
        if match:
            indices = json.loads(match.group(0))
            if isinstance(indices, list) and len(indices) >= 6:
                selected = []
                seen = set()
                for idx in indices:
                    i = int(idx) - 1
                    if 0 <= i < len(papers) and i not in seen:
                        selected.append(papers[i])
                        seen.add(i)
                    if len(selected) >= 12:
                        break
                logger.info(f"Relevance ranking selected {len(selected)} from {len(papers)}")
                return selected
    except Exception as e:
        logger.warning(f"Relevance ranking failed ({e}), falling back to citation sort")

    # Fallback: top 12 by citation count
    papers.sort(key=lambda p: (p.get("citationCount") or 0), reverse=True)
    return papers[:12]


def _summarize_citation(doi: str, abstract: str, paper_context: str,
                        llm_fast, citation_count=0, year=None, quality_tier="unknown") -> dict:
    """Use fast LLM to summarize a single citation."""
    if not abstract or len(abstract) < 50:
        return {"agent_summary": "", "source_quality_note": ""}

    tier_label = {
        "strong": "strong (50+ citations)",
        "adequate": "adequate (10-49 citations)",
        "weak": "weak (under 10 citations)",
    }.get(quality_tier, "unknown (citation count unavailable)")

    year_str = str(year) if year else "unknown"
    cc_str = str(citation_count) if citation_count is not None else "not indexed"
    prompt = (
        f'Read this abstract and produce two things.\n\n'
        f'Abstract: {abstract}\n\nDOI: {doi}\n'
        f'Citation count: {cc_str} -- quality tier: {tier_label}\n'
        f'Publication year: {year_str}\nContext: {paper_context}\n\n'
        f'Return JSON only:\n{{\n'
        f'  "agent_summary": "<2-3 sentences: what this paper actually found>",\n'
        f'  "source_quality_note": "<explicit reasoning: why this source is or is not '
        f'credible. Address citation count ({cc_str}), year ({year_str}), '
        f'methodology fit, and limitations. Minimum 40 chars.>"\n}}'
    )
    try:
        raw = llm_fast.call(
            "You summarize scientific abstracts and evaluate source quality. Return JSON only. No explanation.",
            prompt,
        )
        result = json.loads(raw.strip()) if raw.strip().startswith("{") else None
        if not result:
            match = re.search(r'\{.*\}', raw, re.DOTALL)
            if match:
                result = json.loads(match.group(0))
        if result:
            return {
                "agent_summary": result.get("agent_summary", ""),
                "source_quality_note": result.get("source_quality_note", ""),
            }
    except Exception as e:
        logger.warning(f"Citation summarization failed for {doi}: {e}")
    return {"agent_summary": "", "source_quality_note": ""}


def _normalize_server_paper(p: dict) -> dict:
    """Normalize server search result to the format expected by the rest of the bot.

    Server returns: { doi, title, abstract, year, citation_count, quality_tier, source }
    Bot expects:    { externalIds: {DOI}, title, abstract, year, citationCount, quality_tier }
    """
    return {
        "title": p.get("title", ""),
        "abstract": p.get("abstract", ""),
        "year": p.get("year"),
        "externalIds": {"DOI": p.get("doi", "")},
        "citationCount": p.get("citation_count"),
        "quality_tier": p.get("quality_tier", "unknown"),
        "source": p.get("source", "unknown"),
    }


def search_and_summarize(
    queries: list[str],
    paper_context: str = "",
    llm_fast=None,
) -> list[dict]:
    """
    Search for real academic papers via the server and prepare citation slots.

    1. Calls POST /api/search on the server with queries
    2. Server searches OpenAlex, arXiv, PubMed — returns real papers
    3. Bot ranks by relevance using its own LLM → picks top 12
    4. Bot summarizes each paper using its own LLM

    Returns list of papers with DOI, title, abstract, agent_summary,
    source_quality_note, citationCount, quality_tier.
    """
    # Phase 1: Server searches real academic databases
    result = _call_server_search(queries, context=paper_context)
    all_papers = [_normalize_server_paper(p) for p in result.get("papers", [])]
    search_log = result.get("search_log", {})
    logger.info(
        f"Server search returned {len(all_papers)} papers "
        f"(total found: {search_log.get('total_found', '?')}, "
        f"APIs: {search_log.get('apis_hit', [])})"
    )

    if not all_papers:
        logger.warning("Server search returned no papers")
        return []

    # Phase 2: Bot ranks by relevance (LLM skill exercise)
    if llm_fast and paper_context:
        selected = _rank_by_relevance(all_papers, paper_context, llm_fast)
    else:
        all_papers.sort(key=lambda p: (p.get("citationCount") or 0), reverse=True)
        selected = all_papers[:12]

    # Phase 3: Bot summarizes selected papers (LLM skill exercise)
    logger.info(f"Summarizing {len(selected)} selected papers")
    for p in selected:
        doi = (p.get("externalIds", {}).get("DOI") or "").strip()
        abstract = p.get("abstract", "")
        if abstract and llm_fast:
            summaries = _summarize_citation(
                doi, abstract, paper_context, llm_fast,
                citation_count=p.get("citationCount"),
                year=p.get("year"),
                quality_tier=p.get("quality_tier", "unknown"),
            )
            p["agent_summary"] = summaries["agent_summary"]
            p["source_quality_note"] = summaries["source_quality_note"]

    return selected
