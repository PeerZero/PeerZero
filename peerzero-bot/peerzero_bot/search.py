"""
Academic Search — searches OpenAlex, arXiv, and PubMed for real papers.

Used by every school action that produces citations (papers, revisions,
rebuttals, responses, reaffirmations). Each search call:
  1. Collects papers across 4 iterations × 3 APIs (~30-55 unique papers)
  2. Enriches citation counts via OpenAlex cross-reference
  3. Uses a fast LLM call to rank by relevance to the research topic
  4. Summarizes the top 12 most relevant papers

The bot gets 12 high-quality, relevant citation slots with real DOIs,
abstracts, and citation counts to choose from.
"""

import json
import random
import logging
import time
from typing import Optional
from xml.etree import ElementTree as ET

import httpx

logger = logging.getLogger("peerzero-bot.search")

FALLBACK_QUERIES = [
    "machine learning", "neuroscience", "climate change", "epidemiology",
    "genetics", "immunology", "ecology", "pharmacology", "psychology",
    "biochemistry",
]


def search_openalex(query: str, client: httpx.Client) -> list:
    try:
        resp = client.get(
            "https://api.openalex.org/works",
            params={
                "search": query,
                "filter": "has_doi:true",
                "per_page": 10,
                "select": "title,abstract_inverted_index,doi,publication_year,cited_by_count",
            },
            headers={"User-Agent": "PeerZero-bot/1.0 (peerzero.science)"},
        )
        results = []
        for w in resp.json().get("results", []):
            inv = w.get("abstract_inverted_index", {})
            if not inv:
                continue
            words = [""] * (max(max(v) for v in inv.values()) + 1)
            for word, positions in inv.items():
                for pos in positions:
                    words[pos] = word
            abstract = " ".join(words).strip()
            doi = (w.get("doi") or "").replace("https://doi.org/", "")
            if doi and abstract:
                results.append({
                    "title": w.get("title", ""),
                    "abstract": abstract,
                    "year": w.get("publication_year"),
                    "externalIds": {"DOI": doi},
                    "citationCount": w.get("cited_by_count", 0),
                })
        logger.info(f"OpenAlex: {len(results)} papers for '{query}'")
        return results[:5]
    except Exception as e:
        logger.warning(f"OpenAlex error: {e}")
        return []


def search_arxiv(query: str, client: httpx.Client) -> list:
    try:
        resp = client.get(
            "https://export.arxiv.org/api/query",
            params={"search_query": f"all:{query}", "max_results": 10, "sortBy": "relevance"},
        )
        root = ET.fromstring(resp.text)
        ns = {"atom": "http://www.w3.org/2005/Atom"}
        results = []
        for entry in root.findall("atom:entry", ns):
            title = entry.findtext("atom:title", "", ns).strip().replace("\n", " ")
            abstract = entry.findtext("atom:summary", "", ns).strip().replace("\n", " ")
            arxiv_id = entry.findtext("atom:id", "", ns).split("/abs/")[-1]
            doi = f"10.48550/arXiv.{arxiv_id}"
            if title and abstract:
                results.append({
                    "title": title,
                    "abstract": abstract,
                    "year": None,
                    "externalIds": {"DOI": doi},
                    "citationCount": None,
                    "source": "arxiv",
                })
        logger.info(f"arXiv: {len(results)} papers for '{query}'")
        return results[:5]
    except Exception as e:
        logger.warning(f"arXiv error: {e}")
        return []


def search_pubmed(query: str, client: httpx.Client) -> list:
    try:
        search_resp = client.get(
            "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi",
            params={"db": "pubmed", "term": query, "retmax": 8, "retmode": "json"},
        )
        ids = search_resp.json().get("esearchresult", {}).get("idlist", [])
        if not ids:
            return []
        summary_resp = client.get(
            "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi",
            params={"db": "pubmed", "id": ",".join(ids), "retmode": "json"},
        )
        summary_data = summary_resp.json().get("result", {})
        results = []
        for pmid in ids:
            item = summary_data.get(pmid, {})
            title = item.get("title", "")
            doi = ""
            for articleid in item.get("articleids", []):
                if articleid.get("idtype") == "doi":
                    doi = articleid.get("value", "")
                    break
            if title and doi:
                results.append({
                    "title": title,
                    "abstract": f"PubMed paper: {title}. See DOI for full abstract.",
                    "year": item.get("pubdate", "")[:4],
                    "externalIds": {"DOI": doi},
                    "citationCount": None,
                    "source": "pubmed",
                })
        logger.info(f"PubMed: {len(results)} papers for '{query}'")
        return results[:5]
    except Exception as e:
        logger.warning(f"PubMed error: {e}")
        return []


def _enrich_citation_counts(papers: list, client: httpx.Client) -> list:
    """Cross-reference arXiv/PubMed papers against OpenAlex for citation counts."""
    needs_enrichment = []
    for p in papers:
        if p.get("citationCount") is not None and p.get("citationCount") > 0:
            continue
        doi = (p.get("externalIds", {}).get("DOI") or "").strip()
        if not doi:
            continue
        needs_enrichment.append((doi, p))

    if not needs_enrichment:
        return papers

    batch_size = 40
    for i in range(0, len(needs_enrichment), batch_size):
        batch = needs_enrichment[i:i + batch_size]
        doi_filter = "|".join(f"https://doi.org/{doi}" for doi, _ in batch)
        try:
            resp = client.get(
                "https://api.openalex.org/works",
                params={
                    "filter": f"doi:{doi_filter}",
                    "select": "doi,cited_by_count",
                    "per_page": 50,
                },
                headers={"User-Agent": "PeerZero-bot/1.0 (peerzero.science)"},
            )
            for w in resp.json().get("results", []):
                oa_doi = (w.get("doi") or "").replace("https://doi.org/", "").lower()
                for orig_doi, p in batch:
                    if orig_doi.lower() == oa_doi:
                        p["citationCount"] = w.get("cited_by_count", 0)
                        break
        except Exception as e:
            logger.warning(f"OpenAlex enrichment error: {e}")

    return papers


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
        # Parse the array from the response
        import re
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
                        llm_fast, citation_count=0, year=None) -> dict:
    """Use fast LLM to summarize a single citation."""
    if not abstract or len(abstract) < 50:
        return {"agent_summary": "", "source_quality_note": ""}

    tier = (
        "strong (50+ citations)" if citation_count and citation_count >= 50
        else "adequate (10-49 citations)" if citation_count and citation_count >= 10
        else "weak (under 10 citations)" if citation_count and citation_count > 0
        else "unknown (citation count unavailable)"
    )
    year_str = str(year) if year else "unknown"
    prompt = (
        f'Read this abstract and produce two things.\n\n'
        f'Abstract: {abstract}\n\nDOI: {doi}\n'
        f'Citation count: {citation_count} -- quality tier: {tier}\n'
        f'Publication year: {year_str}\nContext: {paper_context}\n\n'
        f'Return JSON only:\n{{\n'
        f'  "agent_summary": "<2-3 sentences: what this paper actually found>",\n'
        f'  "source_quality_note": "<explicit reasoning: why this source is or is not '
        f'credible. Address citation count ({citation_count}), year ({year_str}), '
        f'methodology fit, and limitations. Minimum 40 chars.>"\n}}'
    )
    try:
        raw = llm_fast.call(
            "You summarize scientific abstracts and evaluate source quality. Return JSON only. No explanation.",
            prompt,
        )
        # Extract JSON from response
        result = json.loads(raw.strip()) if raw.strip().startswith("{") else None
        if not result:
            import re
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


def search_and_summarize(
    queries: list[str],
    paper_context: str = "",
    llm_fast=None,
) -> list[dict]:
    """
    Search academic APIs and return the most relevant papers with summaries.

    1. Searches 4 iterations × 3 APIs (OpenAlex, arXiv, PubMed) = ~30-40 papers
    2. Enriches citation counts via OpenAlex cross-reference
    3. Ranks by relevance using fast LLM call → picks top 12
    4. Summarizes each with fast LLM call

    Returns list of papers with DOI, title, abstract, agent_summary,
    source_quality_note, citationCount.
    """
    http = httpx.Client(timeout=15.0)
    all_papers, seen_dois = [], set()

    padded_queries = list(queries)
    if len(padded_queries) < 4:
        padded_queries += random.sample(FALLBACK_QUERIES, min(4 - len(padded_queries), len(FALLBACK_QUERIES)))

    # Phase 1: Collect papers across all APIs (no LLM calls)
    search_fns = [
        ("openalex", search_openalex),
        ("arxiv", search_arxiv),
        ("pubmed", search_pubmed),
    ]
    for iteration in range(4):
        query = padded_queries[iteration] if iteration < len(padded_queries) else padded_queries[-1]
        logger.info(f"Search iteration {iteration + 1}/4: '{query}'")
        random.shuffle(search_fns)
        for api_name, fn in search_fns:
            results = fn(query, http)
            for p in (results or []):
                doi = (p.get("externalIds", {}).get("DOI") or "").strip()
                if not doi or doi.lower() in seen_dois:
                    continue
                seen_dois.add(doi.lower())
                all_papers.append(p)
            time.sleep(0.3)

    logger.info(f"Search collected {len(all_papers)} unique papers")

    # Phase 2: Enrich citation counts
    all_papers = _enrich_citation_counts(all_papers, http)
    http.close()

    # Phase 3: Select most relevant papers
    if llm_fast and paper_context:
        selected = _rank_by_relevance(all_papers, paper_context, llm_fast)
    else:
        all_papers.sort(key=lambda p: (p.get("citationCount") or 0), reverse=True)
        selected = all_papers[:12]

    # Phase 4: Summarize selected papers
    logger.info(f"Summarizing {len(selected)} selected papers")
    for p in selected:
        doi = (p.get("externalIds", {}).get("DOI") or "").strip()
        abstract = p.get("abstract", "")
        if abstract and llm_fast:
            summaries = _summarize_citation(
                doi, abstract, paper_context, llm_fast,
                citation_count=p.get("citationCount"),
                year=p.get("year") or p.get("publication_year"),
            )
            p["agent_summary"] = summaries["agent_summary"]
            p["source_quality_note"] = summaries["source_quality_note"]

    return selected
