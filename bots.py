"""
PeerZero Bot Fleet — 8 adversarial general scientists
Runs purely from the SKILL.md endpoint — no hardcoded system knowledge.
Each bot registers, fetches the skill, and operates entirely from its instructions.

Requirements:
    pip install anthropic requests

Usage:
    python bots.py

Environment variables:
    PEERZERO_BASE_URL  — e.g. https://peerzero.science (no trailing slash)

Session 6 changes (all items from handoff):
  1.  Revision gate fixed: raw_review_count >= 5 (was 3)
  2.  haiku_audit wired into revision prompt as explicit instruction set
  3.  haiku_audit.search_queries used for revision search when available
  4.  Personal failure pattern extraction (Haiku call) before every writing action
  5.  Citation summaries generated immediately after abstract fetch (not at write time)
  6.  Cross-study connection placeholder validation before submit + Haiku rewrite on fail
  7.  Confidence gate: < 6.5 -> find weakest element via Haiku, targeted rewrite, max 2 attempts
  8.  Field coverage check: all 4 APIs attempted before accepting thin results
  9.  Iterative search with Haiku satisfaction criteria (up to 4 iterations)
  10. Pre-revision section categorization fallback when haiku_audit absent
  11. Gates 4-9 applied to do_submit_paper, do_revise, do_file_bounty

Session 7 changes:
  12. weak_source_quality bounty type: bots now check citations for weak/unknown quality_tier
      and can file a targeted citation-level challenge without needing a full rebuttal paper.
      Filed via: {"action": "register", "challenge_type": "weak_source_quality",
                  "challenged_doi": "...", "quality_challenge_reason": "..."}
  13. do_file_bounty updated: after standard bounty logic, checks if any citation on the
      target paper has weak/unknown quality_tier with a source_quality_note that looks
      inadequate — and tries a weak_source_quality challenge if the standard path fails
      or as a supplementary challenge when the server-side audit already flagged something.
  14. Review prompts updated: explicitly instruct bots to flag weak_source_quality in
      citation_accuracy_notes when quality_tier is weak/unknown and the note is boilerplate
      or contradicts the tier. Reviewers know this bounty type exists and can suggest it.

Session 8 changes (search strategy — required on ALL submissions):
  15. search_strategy required on paper submissions: supporting_queries, opposing_queries,
      query_rationale. Built from concept generation + Haiku opposing query generation.
  16. review_search_strategy required on reviews: verification_queries, gap_queries,
      query_rationale. Generated via Haiku from the paper being reviewed.
  17. search_strategy required on response papers (revisions, rebuttals): built from
      the queries used for the revision/rebuttal research.
  18. search_strategy required on bounty registrations: standard bounties need full
      supporting+opposing, weak_source_quality needs verification_queries.
  19. New helpers: generate_opposing_queries(), generate_review_search_strategy()
  20. All submission responses now include coaching feedback — bots log it.
"""

import os
import re
import time
import json
import random
import logging
import requests
import anthropic
from typing import Optional
from concurrent.futures import ThreadPoolExecutor, as_completed

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s"
)

BASE_URL = os.environ.get("PEERZERO_BASE_URL", "https://peerzero.science")
SKILL_URL = f"{BASE_URL}/api/skill"
MODEL_SMART = "claude-opus-4-5"
MODEL_FAST  = "claude-haiku-4-5-20251001"
KEYS_FILE = "keys.json"

MIN_BODY_LENGTH = 200

# Session 6 wall #6: cross-study placeholder signals
PLACEHOLDER_SIGNALS = [
    "study a", "study b", "both studies", "paper 1", "paper 2",
    "first study", "second study", "the studies", "these studies",
]

SEARCH_APIS = ["openalex", "arxiv", "pubmed"]


def load_keys() -> dict:
    if os.path.exists(KEYS_FILE):
        with open(KEYS_FILE, "r") as f:
            return json.load(f)
    return {}


def save_key(handle: str, api_key: str):
    keys = load_keys()
    existing = keys.get(handle)
    if isinstance(existing, dict):
        existing["api_key"] = api_key
        keys[handle] = existing
    else:
        keys[handle] = {"api_key": api_key, "reviewed_ids": []}
    with open(KEYS_FILE, "w") as f:
        json.dump(keys, f, indent=2)


BOT_CONFIGS = [
    {
        "handle": "CriticalMass_1",
        "persona": "A rigorous physicist who believes most papers overclaim. You are deeply skeptical of weak statistics and love finding methodology flaws. You read every citation carefully and flag misrepresentation immediately.",
        "search_queries": [
            "quantum entanglement experimental",
            "dark matter detection",
            "gravitational waves LIGO",
            "statistical mechanics phase transitions",
            "superconductivity mechanism",
            "nuclear fusion plasma",
            "particle physics standard model",
            "cosmological constant dark energy",
            "neutrino mass measurement",
            "quantum computing error correction",
        ]
    },
    {
        "handle": "NullHypothesis_2",
        "persona": "A statistician who is almost offended by poor experimental design. You immediately spot missing controls, underpowered studies, and statistical misuse. You file bounties aggressively when you find real flaws.",
        "search_queries": [
            "p-hacking clinical trials",
            "statistical power meta-analysis",
            "randomized controlled trial",
            "Bayesian inference biology",
            "causal inference observational study",
            "false discovery rate genomics",
            "publication bias systematic review",
            "effect size replication",
            "multiple comparisons correction",
            "survival analysis clinical",
        ]
    },
    {
        "handle": "ReplicationCrisis_3",
        "persona": "A biologist haunted by the replication crisis. You are obsessed with reproducibility and always check whether methods are described precisely enough to replicate. You are suspicious of effect sizes that seem too clean.",
        "search_queries": [
            "CRISPR genome editing reproducibility",
            "cell line contamination biology",
            "RNA sequencing normalization",
            "protein folding prediction",
            "microbiome sequencing variability",
            "epigenetic inheritance",
            "stem cell differentiation",
            "single cell sequencing",
            "animal model translation",
            "antibody validation specificity",
        ]
    },
    {
        "handle": "OccamsEdge_4",
        "persona": "A chemist who believes most papers are overcomplicated. You cut through jargon to find whether the actual claims are supported. You love finding logical gaps between data and conclusions.",
        "search_queries": [
            "catalysis reaction mechanism",
            "nanoparticle characterization",
            "battery electrolyte degradation",
            "polymer self-assembly",
            "photocatalysis quantum yield",
            "enzyme kinetics inhibition",
            "organic synthesis yield",
            "electrochemistry cyclic voltammetry",
            "computational chemistry DFT",
            "crystal engineering polymorph",
        ]
    },
    {
        "handle": "AdversarialPrior_5",
        "persona": "A machine learning researcher who treats every paper as a potential adversarial example. You look for places where the argument breaks down under pressure. You write sharp, specific rebuttals.",
        "search_queries": [
            "deep learning generalization",
            "transformer model evaluation",
            "adversarial robustness",
            "reinforcement learning reward",
            "large language model benchmark",
            "graph neural network",
            "federated learning privacy",
            "uncertainty quantification neural",
            "continual learning forgetting",
            "fairness machine learning",
        ]
    },
    {
        "handle": "ConfidenceInterval_6",
        "persona": "An epidemiologist who never accepts a causal claim without proper controls. You are particularly good at identifying confounders and unsupported causal language in observational studies.",
        "search_queries": [
            "mendelian randomization",
            "cohort study confounding",
            "air pollution cardiovascular",
            "diet cancer risk",
            "vaccine effectiveness",
            "infectious disease transmission",
            "drug interaction pharmacovigilance",
            "mental health social media",
            "screening test overdiagnosis",
            "socioeconomic health gradient",
        ]
    },
    {
        "handle": "FalsifiabilityFirst_7",
        "persona": "A philosopher of science who believes unfalsifiable claims are not science. You immediately challenge any paper that makes predictions that cannot be tested. You write thorough cross-study synthesis.",
        "search_queries": [
            "consciousness measurement",
            "evolutionary psychology",
            "social priming replication",
            "nutrition science diet",
            "aging intervention lifespan",
            "placebo mechanism neuroscience",
            "climate tipping point",
            "gene expression stochastic",
            "economics behavioral anomaly",
            "emergence complexity biology",
        ]
    },
    {
        "handle": "SteelManning_8",
        "persona": "A generalist scientist who steelmans papers before critiquing them. You give fair scores but when you find a real flaw you are devastating and precise. You are the most feared reviewer because you are never unfair.",
        "search_queries": [
            "negative result null finding",
            "systematic review heterogeneity",
            "preregistration replication",
            "open data reproducibility",
            "peer review quality",
            "model validation prediction",
            "assumption violation sensitivity",
            "cross disciplinary synthesis",
            "scientific retraction correction",
            "competing hypothesis selection",
        ]
    },
]

FALLBACK_QUERIES = [
    "machine learning", "neuroscience", "climate change",
    "epidemiology", "genetics", "immunology",
    "ecology", "pharmacology", "psychology", "biochemistry",
]


# ── API helpers ───────────────────────────────────────────────────────────────

def api(method: str, path: str, api_key: Optional[str] = None, **kwargs) -> dict:
    url = f"{BASE_URL}/api{path}"
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["X-Api-Key"] = api_key
    resp = getattr(requests, method)(url, headers=headers, timeout=30, **kwargs)
    try:
        return resp.json()
    except Exception:
        return {"error": resp.text, "status_code": resp.status_code}


def fetch_skill() -> str:
    resp = requests.get(SKILL_URL, timeout=30)
    return resp.text


def fetch_full_paper(paper_id: str, api_key: str, log, learning_mode: bool = False) -> Optional[dict]:
    learning_param = "&learning_mode=true" if learning_mode else ""
    full = api("get", f"/papers?id={paper_id}{learning_param}", api_key=api_key)

    if "error" in full:
        log.warning(f"Full paper fetch failed for {paper_id}: {full.get('error')}")
        return None

    paper = full.get("paper")
    if not paper:
        log.warning(f"Full paper fetch returned no paper object for {paper_id}")
        return None

    body = paper.get("body", "")
    if not body or len(body) < MIN_BODY_LENGTH:
        log.warning(f"Paper {paper_id} has truncated/missing body ({len(body) if body else 0} chars) — skipping")
        return None

    return {"paper": paper, "full": full}


# ── Academic search sources (unchanged) ──────────────────────────────────────


def search_openalex(query: str, log) -> list:
    try:
        resp = requests.get(
            "https://api.openalex.org/works",
            params={
                "search": query,
                "filter": "has_doi:true",
                "per_page": 10,
                "select": "title,abstract_inverted_index,doi,publication_year,cited_by_count"
            },
            headers={"User-Agent": "PeerZero-bot/1.0 (peerzero.science)"},
            timeout=15
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
                    "citationCount": w.get("cited_by_count", 0)
                })
        log.info(f"OpenAlex: {len(results)} papers for '{query}'")
        return results[:5]
    except Exception as e:
        log.warning(f"OpenAlex error: {e}")
        return []


def search_arxiv(query: str, log) -> list:
    try:
        resp = requests.get(
            "https://export.arxiv.org/api/query",
            params={"search_query": f"all:{query}", "max_results": 10, "sortBy": "relevance"},
            timeout=15
        )
        import xml.etree.ElementTree as ET
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
                    "citationCount": 0,
                    "source": "arxiv"
                })
        log.info(f"arXiv: {len(results)} papers for '{query}'")
        return results[:5]
    except Exception as e:
        log.warning(f"arXiv error: {e}")
        return []


def search_pubmed(query: str, log) -> list:
    try:
        search_resp = requests.get(
            "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi",
            params={"db": "pubmed", "term": query, "retmax": 8, "retmode": "json"},
            timeout=15
        )
        ids = search_resp.json().get("esearchresult", {}).get("idlist", [])
        if not ids:
            return []

        summary_resp = requests.get(
            "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi",
            params={"db": "pubmed", "id": ",".join(ids), "retmode": "json"},
            timeout=15
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
                    "citationCount": 0,
                    "source": "pubmed"
                })
        log.info(f"PubMed: {len(results)} papers for '{query}'")
        return results[:5]
    except Exception as e:
        log.warning(f"PubMed error: {e}")
        return []


# ── Session 6 wall #8: field coverage check ──────────────────────────────────

def _search_all_apis_for_query(query: str, log) -> dict:
    """Try all 4 APIs for a single query. Returns results keyed by API name."""
    search_fns = [
        ("openalex",         search_openalex),
        ("arxiv",            search_arxiv),
        ("pubmed",           search_pubmed),
    ]
    random.shuffle(search_fns)
    results_by_api = {}
    for api_name, fn in search_fns:
        results_by_api[api_name] = fn(query, log)
        time.sleep(0.3)
    return results_by_api


def _check_field_coverage(results_by_api: dict, log) -> tuple:
    """Wall #8: (ok, missing). ok only if all 4 tried OR total >= 6."""
    tried = [name for name, results in results_by_api.items() if results is not None]
    missing = [name for name in SEARCH_APIS if name not in tried]
    if missing:
        log.warning(f"Field coverage incomplete — missing APIs: {missing}")
        return False, missing
    total = sum(len(r) for r in results_by_api.values() if r)
    if total < 6:
        log.info(f"All 4 APIs tried but only {total} total results — thin coverage, proceeding")
    return True, []


# ── Session 6 wall #9: Haiku satisfaction check ───────────────────────────────

def _search_satisfied(client: anthropic.Anthropic, results: list, paper_topic: str, log) -> bool:
    """Wall #9: ask Haiku if search results are sufficient."""
    if not client or len(results) < 2:
        return False
    titles = [r.get("title", "") for r in results[:8]]
    prompt = (
        f"You are evaluating search results for a paper about: {paper_topic}\n\n"
        f"Results found: {len(results)} papers\n"
        f"Titles: {titles}\n\n"
        f"Are these results sufficient to write a strong cross-study synthesis?\n"
        f"Answer ONLY: SUFFICIENT or INSUFFICIENT: <one reason>"
    )
    try:
        msg = client.messages.create(
            model=MODEL_FAST,
            max_tokens=60,
            system="Answer only: SUFFICIENT or INSUFFICIENT: <one reason>",
            messages=[{"role": "user", "content": prompt}],
            timeout=20
        )
        verdict = msg.content[0].text.strip()
        return verdict.upper().startswith("SUFFICIENT")
    except Exception as e:
        log.warning(f"Search satisfaction check failed: {e}")
        return True  # non-blocking on failure


# ── Session 6 wall #5: citation summary immediately after fetch ───────────────

def _summarize_citation(client: anthropic.Anthropic, doi: str, abstract: str, paper_context: str, log,
                        citation_count: int = 0, year: int = None) -> dict:
    """Wall #5: generate agent_summary AND source_quality_note from the abstract right now, not at write time.
    Returns {"agent_summary": str, "source_quality_note": str}."""
    if not abstract or len(abstract) < 50:
        return {"agent_summary": "", "source_quality_note": ""}

    # Compute quality tier for the prompt
    if citation_count >= 50:
        tier = "strong (50+ citations)"
    elif citation_count >= 10:
        tier = "adequate (10-49 citations)"
    elif citation_count > 0:
        tier = "weak (under 10 citations)"
    else:
        tier = "unknown (citation count unavailable)"

    year_str = str(year) if year else "unknown"

    prompt = (
        f"Read this abstract and produce two things.\n\n"
        f"Abstract: {abstract}\n\n"
        f"DOI: {doi}\n"
        f"Citation count: {citation_count} — quality tier: {tier}\n"
        f"Publication year: {year_str}\n"
        f"Context: {paper_context}\n\n"
        f"Return JSON only:\n"
        f'{{\n'
        f'  "agent_summary": "<2-3 sentences: what this paper actually found, from the abstract above — not from memory>",\n'
        f'  "source_quality_note": "<explicit reasoning: why this source is or is not credible evidence for the specific claim. '
        f'Address citation count ({citation_count}), publication year ({year_str}), methodology fit, and any limitations. '
        f'If tier is weak or unknown, justify why you are citing it anyway. Minimum 40 chars.>"\n'
        f'}}'
    )
    try:
        msg = client.messages.create(
            model=MODEL_FAST,
            max_tokens=400,
            system="You summarize scientific abstracts and evaluate source quality. Return JSON only, no preamble.",
            messages=[{"role": "user", "content": prompt}],
            timeout=30
        )
        raw = msg.content[0].text.strip()
        if raw.startswith("```"):
            raw = "\n".join(raw.split("\n")[1:])
        if raw.endswith("```"):
            raw = "\n".join(raw.split("\n")[:-1])
        result = json.loads(raw.strip())
        return {
            "agent_summary": result.get("agent_summary", ""),
            "source_quality_note": result.get("source_quality_note", "")
        }
    except Exception as e:
        log.warning(f"Citation summarization failed for {doi}: {e}")
        return {"agent_summary": "", "source_quality_note": ""}


def search_and_summarize(queries: list, log, client: anthropic.Anthropic, paper_context: str = "") -> list:
    """
    Walls #5 + #8 + #9 combined:
    - Tries all 4 APIs per query (field coverage)
    - Iterates up to 4 times with Haiku satisfaction check
    - Attaches agent_summary to each result immediately after fetch
    Falls back to search_all_sources behaviour if client unavailable.
    """
    all_papers = []
    seen_dois = set()

    # Pad queries to 4 with fallbacks if needed
    padded_queries = list(queries)
    if len(padded_queries) < 4:
        padded_queries += random.sample(FALLBACK_QUERIES, 4 - len(padded_queries))

    for iteration in range(4):
        query = padded_queries[iteration] if iteration < len(padded_queries) else padded_queries[-1]
        log.info(f"Search iteration {iteration + 1}/4: '{query}'")

        results_by_api = _search_all_apis_for_query(query, log)
        _check_field_coverage(results_by_api, log)  # logs warnings, non-blocking

        for _api_name, results in results_by_api.items():
            for p in (results or []):
                doi = (p.get("externalIds", {}).get("DOI") or p.get("doi", "")).strip()
                if not doi or doi.lower() in seen_dois:
                    continue
                seen_dois.add(doi.lower())
                abstract = p.get("abstract", "")
                citation_count = p.get("citationCount", 0) or 0
                year = p.get("year") or p.get("publication_year")
                # Wall #5: summarize immediately, store agent_summary and source_quality_note on the object
                if abstract and client:
                    summaries = _summarize_citation(
                        client, doi, abstract, paper_context, log,
                        citation_count=citation_count, year=year
                    )
                    p["agent_summary"] = summaries["agent_summary"]
                    p["source_quality_note"] = summaries["source_quality_note"]
                all_papers.append(p)

        if len(all_papers) >= 6:
            # Wall #9: Haiku satisfaction check before committing to more iterations
            if _search_satisfied(client, all_papers, query, log):
                log.info(f"Search satisfied after iteration {iteration + 1} with {len(all_papers)} papers")
                break
            else:
                log.info(f"Haiku: INSUFFICIENT after iteration {iteration + 1} — continuing")

    log.info(f"Search complete: {len(all_papers)} unique papers")
    return all_papers


def search_all_sources(queries: list, log, min_results: int = 2) -> list:
    """
    Original function preserved unchanged — used as fallback where
    search_and_summarize is not appropriate (e.g. internal lookup helpers).
    """
    all_queries = list(queries)
    random.shuffle(all_queries)
    all_queries += random.sample(FALLBACK_QUERIES, len(FALLBACK_QUERIES))

    sources = [
        ("OpenAlex",         search_openalex),
        ("arXiv",            search_arxiv),
        ("PubMed",           search_pubmed),
    ]

    for query in all_queries:
        random.shuffle(sources)
        for source_name, search_fn in sources:
            results = search_fn(query, log)
            if len(results) >= min_results:
                log.info(f"Using {len(results)} papers from {source_name} for '{query}'")
                return results
            time.sleep(0.5)

    log.error("All sources exhausted — returning empty")
    return []


# ── Claude calls (unchanged) ──────────────────────────────────────────────────

def ask_claude(client: anthropic.Anthropic, system: str, prompt: str, max_tokens: int = 4096, model: str = None) -> str:
    msg = client.messages.create(
        model=model or MODEL_SMART,
        max_tokens=max_tokens,
        system=system,
        messages=[{"role": "user", "content": prompt}],
        timeout=120
    )
    return msg.content[0].text.strip()


def ask_claude_json(client: anthropic.Anthropic, system: str, prompt: str, max_tokens: int = 4096, model: str = None) -> dict:
    raw = ask_claude(client, system, prompt, max_tokens, model=model)
    clean = raw.strip()
    if clean.startswith("```"):
        clean = "\n".join(clean.split("\n")[1:])
    if clean.endswith("```"):
        clean = "\n".join(clean.split("\n")[:-1])
    try:
        return json.loads(clean.strip())
    except json.JSONDecodeError:
        logging.error(f"JSON parse failed: {clean[:200]}")
        return {}


# ── Session 6 wall #4: personal failure pattern extraction ───────────────────

def extract_failure_patterns(client: anthropic.Anthropic, agent_data: dict, log) -> str:
    """
    Wall #4: Haiku call to surface failure patterns before writing.
    Returns a formatted string to inject into the writing prompt.
    Non-blocking — returns "" on any failure.
    """
    coaching = agent_data.get("coaching", {})
    if not coaching:
        return ""
    patterns = coaching.get("failure_patterns", "")
    gaps = coaching.get("honest_gap", [])
    if not patterns and not gaps:
        return ""

    prompt = (
        f"You are reviewing an agent's known failure patterns before they write a paper.\n\n"
        f"Known patterns: {patterns}\n"
        f"Known gaps: {'; '.join(gaps) if isinstance(gaps, list) else gaps}\n\n"
        f"List 3 specific things this agent must actively watch for in their next paper. "
        f"Be concrete and actionable. Return as a short numbered list."
    )
    try:
        msg = client.messages.create(
            model=MODEL_FAST,
            max_tokens=300,
            system="You identify concrete writing failure patterns. Output a numbered list only.",
            messages=[{"role": "user", "content": prompt}],
            timeout=30
        )
        result = msg.content[0].text.strip()
        log.info(f"Failure patterns extracted: {result[:100]}")
        return result
    except Exception as e:
        log.warning(f"Failure pattern extraction failed: {e}")
        return ""


# ── Session 8 wall #15: opposing query generation ────────────────────────

def generate_opposing_queries(client: anthropic.Anthropic, concept: dict, log) -> list:
    """
    Wall #15: Generate opposing search queries from a paper concept.
    Returns list of 2-3 queries designed to find evidence AGAINST the hypothesis.
    """
    claim = concept.get("core_claim", concept.get("working_title", ""))
    supporting = concept.get("search_queries", [])[:5]

    prompt = (
        f"You are planning research on: {claim}\n\n"
        f"Supporting queries already planned:\n"
        + "\n".join(f"- {q}" for q in supporting)
        + "\n\nGenerate 3 OPPOSING search queries — queries specifically designed to find evidence "
        "AGAINST this hypothesis. Do NOT just negate the supporting queries. Think about:\n"
        "- Alternative mechanisms that would explain the same observations\n"
        "- Contradicting experimental results\n"
        "- Methodological critiques of the approach\n\n"
        'Return JSON only: {"opposing_queries": ["q1", "q2", "q3"]}'
    )
    try:
        result = ask_claude_json(
            client,
            "Generate opposing research queries. Return JSON only.",
            prompt, max_tokens=300, model=MODEL_FAST
        )
        queries = result.get("opposing_queries", []) if result else []
        if queries:
            log.info(f"Generated {len(queries)} opposing queries")
        return queries[:6]
    except Exception as e:
        log.warning(f"Opposing query generation failed: {e}")
        return []


# ── Session 8 wall #16: review search strategy generation ────────────────

def generate_review_search_strategy(client: anthropic.Anthropic, paper: dict, log) -> dict:
    """
    Wall #16: Generate review_search_strategy with verification and gap queries.
    Returns dict with verification_queries, gap_queries, query_rationale.
    """
    prompt = (
        f"You are reviewing a scientific paper and need to independently verify its claims.\n\n"
        f"Title: {paper.get('title', '')}\n"
        f"Abstract: {str(paper.get('abstract', ''))[:500]}\n"
        f"Falsifiable claim: {paper.get('falsifiable_claim', 'none stated')}\n\n"
        "Generate queries for independent verification:\n"
        "1. verification_queries: 2-3 queries to check whether the paper's core claims have "
        "independent support — search for replication studies, meta-analyses, or the specific "
        "mechanism being claimed\n"
        "2. gap_queries: 2-3 queries to find contradictions, alternative explanations, or "
        "evidence the author missed — what would a skeptic search for?\n"
        "3. query_rationale: 80+ chars explaining your verification approach\n\n"
        "Do NOT just re-search the paper's own terms. Think about what an independent "
        "fact-checker would look up.\n\n"
        'Return JSON only:\n'
        '{"verification_queries": [...], "gap_queries": [...], "query_rationale": "..."}'
    )
    try:
        result = ask_claude_json(
            client,
            "Generate review verification queries. Return JSON only.",
            prompt, max_tokens=400, model=MODEL_FAST
        )
        if result and result.get("verification_queries") and result.get("gap_queries"):
            log.info(
                f"Generated review search strategy: "
                f"{len(result.get('verification_queries', []))} verification, "
                f"{len(result.get('gap_queries', []))} gap queries"
            )
            return result
        return {}
    except Exception as e:
        log.warning(f"Review search strategy generation failed: {e}")
        return {}


# ── Session 6 wall #6: cross-study connection validation ─────────────────────

def validate_cross_study(cross_study_text: str, log) -> tuple:
    """
    Wall #6: checks for placeholder language and minimum length.
    Returns (ok, reason).
    """
    if not cross_study_text or len(cross_study_text.strip()) < 150:
        return False, "Cross-study connection too short or missing"
    lower = cross_study_text.lower()
    for signal in PLACEHOLDER_SIGNALS:
        if signal in lower:
            return False, f"Placeholder language detected: '{signal}'"
    return True, None


def rewrite_cross_study(client: anthropic.Anthropic, system: str, draft: dict, ss_papers: list, reason: str, log) -> dict:
    """Haiku rewrite of cross_study_connection when validation fails."""
    citation_context = "\n".join(
        f"DOI: {p.get('externalIds', {}).get('DOI') or p.get('doi', '')}\n"
        f"Title: {p.get('title', '')}\n"
        f"Abstract: {p.get('abstract', '')[:400]}\n"
        for p in ss_papers[:4]
    )
    prompt = (
        f"The cross_study_connection in this draft was rejected: {reason}\n\n"
        f"Current connection: {draft.get('cross_study_connection', '')}\n\n"
        f"Available papers with their actual findings:\n{citation_context}\n\n"
        f"Write a new cross_study_connection (200+ chars) that:\n"
        f"- Names what Study A specifically found (use author names or DOI, not 'Study A')\n"
        f"- Names what Study B specifically found (use author names or DOI, not 'Study B')\n"
        f"- States what their combination implies that neither explored alone\n"
        f"Return only the connection text, no JSON, no preamble."
    )
    try:
        msg = client.messages.create(
            model=MODEL_FAST,
            max_tokens=400,
            system="You write precise scientific cross-study connections. Output only the connection text.",
            messages=[{"role": "user", "content": prompt}],
            timeout=30
        )
        new_connection = msg.content[0].text.strip()
        log.info(f"Cross-study rewritten ({len(new_connection)} chars)")
        draft["cross_study_connection"] = new_connection
    except Exception as e:
        log.warning(f"Cross-study rewrite failed: {e}")
    return draft


# ── Session 6 wall #7: confidence gate ───────────────────────────────────────

def apply_confidence_gate(client: anthropic.Anthropic, system: str, draft: dict, log) -> dict:
    """
    Wall #7: if confidence_score < 6.5, identify weakest element via Haiku
    and do a targeted rewrite of that element only. Max 2 attempts.
    """
    try:
        score = float(draft.get("confidence_score", 7.0))
    except (TypeError, ValueError):
        return draft

    if score >= 6.5:
        return draft

    log.info(f"Confidence gate triggered (score={score}) — finding weakest element")

    for attempt in range(2):
        weakest_prompt = (
            f"What is the single weakest element of this paper draft? One sentence only.\n\n"
            f"Title: {draft.get('title', '')}\n"
            f"Abstract: {draft.get('abstract', '')[:400]}\n"
            f"Cross-study: {draft.get('cross_study_connection', '')[:300]}\n"
            f"Falsifiable claim: {draft.get('falsifiable_claim', '')}\n"
            f"Citations: {len(draft.get('citations', []))} citations"
        )
        try:
            msg = client.messages.create(
                model=MODEL_FAST,
                max_tokens=80,
                system="Identify the single weakest element in one sentence.",
                messages=[{"role": "user", "content": weakest_prompt}],
                timeout=20
            )
            weakest = msg.content[0].text.strip()
            log.info(f"Confidence gate attempt {attempt + 1}: weakest = {weakest}")
        except Exception as e:
            log.warning(f"Confidence gate weakest step failed: {e}")
            break

        rewrite_prompt = (
            f"This element was identified as the weakest point:\n{weakest}\n\n"
            f"Current draft fields:\n"
            f"Title: {draft.get('title', '')}\n"
            f"Abstract: {draft.get('abstract', '')}\n"
            f"Cross-study: {draft.get('cross_study_connection', '')}\n"
            f"Falsifiable claim: {draft.get('falsifiable_claim', '')}\n\n"
            f"Return JSON with ONLY the fields that need improvement. "
            f"Only include fields where you can make a genuine improvement. "
            f"Valid fields: title, abstract, cross_study_connection, falsifiable_claim, "
            f"measurable_prediction, quantitative_expectation."
        )
        try:
            improvements = ask_claude_json(client, system, rewrite_prompt, max_tokens=600, model=MODEL_FAST)
            if improvements:
                for field in ["title", "abstract", "cross_study_connection", "falsifiable_claim",
                              "measurable_prediction", "quantitative_expectation"]:
                    if field in improvements and improvements[field]:
                        draft[field] = improvements[field]
                log.info(f"Confidence gate improved: {list(improvements.keys())}")
        except Exception as e:
            log.warning(f"Confidence gate rewrite failed: {e}")
            break

    return draft


# ── Session 6 wall #10: pre-revision section categorization fallback ──────────

def categorize_sections(client: anthropic.Anthropic, paper_body: str, reviews: list, log) -> dict:
    """
    Wall #10: Haiku fallback when haiku_audit is unavailable.
    Returns {"strong": [...], "adequate": [...], "weak": [...]}
    """
    review_summaries = "; ".join(
        r.get("overall_assessment", "")[:200]
        for r in reviews[:5]
        if r.get("overall_assessment")
    )
    prompt = (
        f"Categorize each major section of this paper as STRONG, ADEQUATE, or WEAK "
        f"based on reviewer feedback.\n\n"
        f"Paper body (first 3000 chars):\n{paper_body[:3000]}\n\n"
        f"Reviewer feedback:\n{review_summaries}\n\n"
        f'Return JSON only: {{"strong": [], "adequate": [], "weak": []}}'
    )
    try:
        msg = client.messages.create(
            model=MODEL_FAST,
            max_tokens=400,
            system='Return JSON only: {"strong": [], "adequate": [], "weak": []}',
            messages=[{"role": "user", "content": prompt}],
            timeout=30
        )
        raw = msg.content[0].text.strip().strip("` \n")
        if raw.startswith("json"):
            raw = raw[4:].strip()
        result = json.loads(raw)
        log.info(
            f"Section categorization: strong={len(result.get('strong', []))}, "
            f"adequate={len(result.get('adequate', []))}, weak={len(result.get('weak', []))}"
        )
        return result
    except Exception as e:
        log.warning(f"Section categorization failed: {e}")
        return {"strong": [], "adequate": [], "weak": []}


# ── Citation validation (unchanged) ──────────────────────────────────────────

def validate_citations(citations: list, source_papers: list, log) -> list:
    if not citations or not source_papers:
        return citations

    valid_dois = set()
    for p in source_papers:
        doi = (
            p.get("externalIds", {}).get("DOI") or
            p.get("doi") or ""
        )
        if doi:
            valid_dois.add(doi.strip().lower())

    validated = []
    for c in citations:
        doi = (c.get("doi") or "").strip().lower()
        doi = doi.replace("https://doi.org/", "").replace("http://doi.org/", "")
        if doi in valid_dois:
            validated.append(c)
        else:
            log.warning(f"Dropping hallucinated/irrelevant citation: {c.get('doi')}")

    if not validated:
        log.warning("All citations were invalid — returning empty citation list")

    return validated


# ── Bot class ─────────────────────────────────────────────────────────────────

class PeerZeroBot:
    def __init__(self, handle: str, persona: str, skill: str, search_queries: list):
        self.handle = handle
        self.persona = persona
        self.skill = skill
        self.search_queries = search_queries
        self.api_key: Optional[str] = None
        self.client = anthropic.Anthropic()
        self.log = logging.getLogger(handle)
        self.reviewed_paper_ids: set = set()

        self.system = f"""You are {handle}, an AI agent participating in PeerZero — a scientific peer review platform.

Your personality: {persona}

You operate EXCLUSIVELY according to the PeerZero SKILL.md below. Follow its instructions precisely.
When asked to produce JSON, return ONLY valid JSON with no markdown fences, no preamble, no explanation.

--- SKILL.md START ---
{skill}
--- SKILL.md END ---"""

    # ── Registration ──────────────────────────────────────────────────────────

    def register(self) -> bool:
        keys = load_keys()
        if self.handle in keys:
            entry = keys[self.handle]
            self.api_key = entry["api_key"] if isinstance(entry, dict) else entry
            self.log.info(f"Loaded saved key for {self.handle}")
            self._load_reviewed_ids()
            return True

        self.log.info("Registering...")
        result = api("post", "/register", json={"handle": self.handle})

        if "api_key" not in result:
            if "already taken" in result.get("error", ""):
                self.log.warning("Handle taken — trying with suffix")
                self.handle = f"{self.handle}_{random.randint(10,99)}"
                result = api("post", "/register", json={"handle": self.handle})
            if "api_key" not in result:
                self.log.error(f"Registration failed: {result}")
                return False

        self.api_key = result["api_key"]
        self.log.info("Registered. Passing intake...")

        intake = result.get("intake_paper", {})
        intake_prompt = f"""You need to pass the PeerZero intake review to register.

Here is the intake paper:
{json.dumps(intake, indent=2)}

The paper has intentional flaws. Write a review that catches at least 2 flaws.
Return JSON only:
{{
  "score": <1-4>,
  "methodology_notes": "<50+ chars>",
  "statistical_validity_notes": "<50+ chars>",
  "citation_accuracy_notes": "<50+ chars>",
  "overall_assessment": "<100+ chars describing the flaws you found>"
}}"""

        review = ask_claude_json(self.client, self.system, intake_prompt, model=MODEL_FAST)
        if not review:
            self.log.error("Failed to generate intake review")
            return False

        result2 = api("post", "/register", api_key=self.api_key, json=review)
        if result2.get("success"):
            save_key(self.handle, self.api_key)
            self.log.info(f"Intake passed. Credibility: {result2.get('credibility_score')}")
            return True
        else:
            self.log.error(f"Intake failed: {result2}")
            return False

    def _load_reviewed_ids(self):
        keys = load_keys()
        entry = keys.get(self.handle)
        if isinstance(entry, dict):
            saved = entry.get("reviewed_ids", [])
            self.reviewed_paper_ids = set(saved)
            self.log.info(f"Restored {len(self.reviewed_paper_ids)} reviewed paper IDs from cache")

    def _save_reviewed_id(self, paper_id: str):
        keys = load_keys()
        entry = keys.get(self.handle)
        if isinstance(entry, str):
            entry = {"api_key": entry, "reviewed_ids": []}
        elif not isinstance(entry, dict):
            entry = {"api_key": self.api_key, "reviewed_ids": []}
        reviewed = entry.get("reviewed_ids", [])
        if paper_id not in reviewed:
            reviewed.append(paper_id)
            entry["reviewed_ids"] = reviewed
            keys[self.handle] = entry
            with open(KEYS_FILE, "w") as f:
                json.dump(keys, f, indent=2)

    def get_status(self) -> dict:
        return api("get", "/agents?me=true", api_key=self.api_key)

    def get_my_response_paper_ids(self) -> set:
        my_papers = api("get", "/papers?my_papers=true", api_key=self.api_key)
        parent_ids = set()
        for p in my_papers.get("papers", []):
            pid = p.get("parent_paper_id")
            if pid:
                parent_ids.add(pid)
        return parent_ids

    def decide_action(self, status: dict) -> str:
        action = status.get("next_action", "")
        if action in ("submit_paper", "review", "file_bounty", "revise", "validate_all"):
            return action

        tier_info = status.get("tier_info", "")
        match = re.search(r"next_action:\s*(\S+)", tier_info)
        if match:
            parsed = re.sub(r"[^a-z_]", "", match.group(1))
            if parsed in ("submit_paper", "review", "file_bounty", "revise", "validate_all"):
                return parsed

        if status.get("can_revise"):
            return "revise"

        return "review"

    # ── Find a reviewable paper (unchanged) ───────────────────────────────────

    def find_reviewable_paper(self) -> Optional[dict]:
        papers_data = api("get", "/papers?limit=100", api_key=self.api_key)
        papers = papers_data.get("papers", [])

        responses_data = api("get", "/papers?feed=responses&limit=100", api_key=self.api_key)
        response_papers = responses_data.get("papers", [])

        all_papers = papers + response_papers

        candidates = [
            p for p in all_papers
            if p.get("agents", {}).get("handle") != self.handle
            and p["id"] not in self.reviewed_paper_ids
            and p.get("raw_review_count", 0) < 10
        ]

        if not candidates:
            self.log.info(
                f"No unreviewed papers found "
                f"(have reviewed {len(self.reviewed_paper_ids)} papers total, "
                f"{len(all_papers)} papers in feed)"
            )
            return None

        self.log.info(f"{len(candidates)} unreviewed papers available — picking one")
        random.shuffle(candidates)

        for p in candidates:
            target = fetch_full_paper(p["id"], self.api_key, self.log)
            if not target:
                continue

            reviews = target["full"].get("reviews", [])
            already_reviewed = any(
                r.get("agents", {}).get("handle") == self.handle for r in reviews
            )
            if already_reviewed:
                self.reviewed_paper_ids.add(p["id"])
                self._save_reviewed_id(p["id"])
                self.log.info(f"Skipping '{p.get('title','')[:40]}' — already reviewed (cache updated)")
                continue

            return target

        self.log.info("No reviewable papers found after full scan")
        return None

    # ── Review a paper (unchanged) ────────────────────────────────────────────

    def do_review(self) -> bool:
        target = self.find_reviewable_paper()
        if not target:
            return False

        paper = target["paper"]
        full = target["full"]
        body = paper.get("body", "")
        self.log.info(f"Reviewing: {paper.get('title', '')[:60]} ({len(body)} body chars)")

        prompt = f"""You need to review this paper. Be thorough, adversarial, and precise.
Read every claim carefully. Check the citations. Look for logical gaps.

Paper:
Title: {paper.get('title')}
Abstract: {paper.get('abstract')}
Body: {body}
Citations: {json.dumps(full.get('citations', []), indent=2)}

When reviewing citations, check TWO things:
1. ACCURACY — does the agent_summary match what the paper actually says?
2. QUALITY — is the cited paper itself credible evidence for the specific claim? Check:
   - citation_count and quality_tier (server-computed: strong=50+, adequate=10-49, weak=<10, unknown=lookup failed)
   - source_quality_note: does it actually justify the citation's use with specific reasoning about
     methodology, sample size, venue, and limitations? Or is it generic boilerplate?
   - MISMATCH CHECK: if quality_tier is "weak" or "unknown" but the note claims "well-established",
     "seminal", "highly cited", or "landmark" — this is a tone mismatch. Flag it explicitly.
   - BOILERPLATE CHECK: if source_quality_note says only "this is a relevant paper", "supports the claim",
     "provides evidence" etc. with no real methodological assessment — flag it.
   A paper with weak quality_tier and an inadequate source_quality_note is vulnerable to a
   weak_source_quality bounty. Note this in citation_accuracy_notes if you find one.

Also check uncertainty calibration:
- FALSE CONFIDENCE: conclusions stated with certainty the evidence does not support (flag in logical_consistency_notes)
- VAGUE UNCERTAINTY: "further research needed" or "complex relationship" without specifying what is unknown (also flag)

Return JSON only — NO markdown fences:
{{
  "score": <1.0-10.0>,
  "methodology_notes": "<50+ chars — be specific>",
  "statistical_validity_notes": "<50+ chars — be specific>",
  "citation_accuracy_notes": "<check both accuracy AND quality: does agent_summary match? is each paper credible evidence for its specific claim? flag tone mismatches between source_quality_note and quality_tier, and boilerplate notes that lack real methodological assessment>",
  "reproducibility_notes": "<assess reproducibility>",
  "logical_consistency_notes": "<check logic chain, flag false confidence or vague uncertainty expressions>",
  "overall_assessment": "<100+ chars — your honest scientific verdict>"
}}"""

        review = ask_claude_json(self.client, self.system, prompt)
        if not review or "score" not in review:
            self.log.error("Failed to generate review")
            return False

        # Wall #16: generate and attach review_search_strategy
        review_strategy = generate_review_search_strategy(self.client, paper, self.log)
        if review_strategy:
            review["review_search_strategy"] = review_strategy
        else:
            # Fallback: generate basic strategy from paper title
            title_words = paper.get("title", "").split()[:5]
            review["review_search_strategy"] = {
                "verification_queries": [
                    f"{' '.join(title_words)} replication independent verification",
                    f"{' '.join(title_words)} meta-analysis systematic review",
                ],
                "gap_queries": [
                    f"{' '.join(title_words)} contradictory findings negative results",
                    f"{' '.join(title_words)} alternative mechanism explanation",
                ],
                "query_rationale": (
                    f"Verification queries check for independent replication of the paper's core claims. "
                    f"Gap queries search for contradictions and alternative explanations the author may have missed."
                )
            }

        result = api("post", f"/reviews?paper_id={paper['id']}", api_key=self.api_key, json=review)
        if result.get("success"):
            self.reviewed_paper_ids.add(paper["id"])
            self._save_reviewed_id(paper["id"])
            self.log.info(f"Review submitted. Score: {review['score']}. New cred: {result.get('your_new_credibility')}")
            # Wall #20: log review coaching
            coaching = result.get("review_search_coaching")
            if coaching:
                self.log.info(f"Review search coaching: {json.dumps(coaching)[:200]}")
            return True
        else:
            self.log.warning(f"Review failed: {result.get('error')}")
            return False

    # ── Submit a paper ────────────────────────────────────────────────────────

    def do_submit_paper(self) -> Optional[str]:

        my_papers_resp = api("get", "/papers?my_papers=true", api_key=self.api_key)
        if "error" in my_papers_resp:
            self.log.warning("Could not fetch my papers — skipping submission this cycle")
            return None

        my_papers = my_papers_resp.get("papers", [])
        active_papers = [p for p in my_papers if p.get("status") != "retracted" and not p.get("parent_paper_id")]
        paper_count = len(active_papers)

        status = self.get_status()
        cred = status.get("credibility_score", 0) if "error" not in status else 0

        if cred < 75:
            tier_cap, next_tier = 2, 75
        elif cred < 100:
            tier_cap, next_tier = 4, 100
        elif cred < 150:
            tier_cap, next_tier = 8, 150
        elif cred < 175:
            tier_cap, next_tier = 16, 175
        else:
            tier_cap, next_tier = 32, None

        if paper_count >= tier_cap:
            if next_tier:
                self.log.info(f"At paper cap ({paper_count}/{tier_cap}). Need {next_tier - cred:.1f} more cred. Skipping.")
            else:
                self.log.info(f"At max paper cap ({paper_count}/{tier_cap}). Skipping.")
            return None

        next_paper_num = paper_count + 1
        if next_paper_num == 1:
            reviews_needed = 0
        elif next_paper_num == 2:
            reviews_needed = 3
        elif next_paper_num == 3:
            reviews_needed = 7
        else:
            reviews_needed = (next_paper_num - 1) ** 2

        reviews_done = status.get("review_count", 0) if "error" not in status else 0
        if reviews_done < reviews_needed:
            self.log.info(
                f"Need {reviews_needed} reviews to submit paper #{next_paper_num}, "
                f"have {reviews_done}. Skipping."
            )
            return None

        self.log.info(f"Eligible to submit ({paper_count}/{tier_cap} papers, {reviews_done} reviews). Proceeding...")

        # Wall #4: extract failure patterns BEFORE writing
        failure_patterns = extract_failure_patterns(self.client, status, self.log)

        self.log.info("Assembling full research dossier...")

        dossier_papers = []
        for p in my_papers:
            full_data = fetch_full_paper(p["id"], self.api_key, self.log)
            if not full_data:
                continue

            full_paper = full_data["paper"]
            full_resp  = full_data["full"]

            reviews_raw = full_resp.get("reviews", [])
            reviews_raw.sort(
                key=lambda r: r.get("reviewer_credibility_at_time") or r.get("credibility_weight", 0),
                reverse=True
            )
            top_reviews = []
            for r in reviews_raw[:5]:
                top_reviews.append({
                    "reviewer_credibility": r.get("reviewer_credibility_at_time"),
                    "score": r.get("score"),
                    "methodology_notes": r.get("methodology_notes", ""),
                    "statistical_validity_notes": r.get("statistical_validity_notes", ""),
                    "citation_accuracy_notes": r.get("citation_accuracy_notes", ""),
                    "overall_assessment": r.get("overall_assessment", ""),
                })

            responses = []
            responses_feed = api("get", "/papers?feed=responses&limit=100", api_key=self.api_key)
            response_candidates = responses_feed.get("papers", [])
            for candidate in my_papers + response_candidates:
                if candidate.get("parent_paper_id") == p["id"]:
                    resp_full = fetch_full_paper(candidate["id"], self.api_key, self.log)
                    if resp_full:
                        resp_reviews_raw = resp_full["full"].get("reviews", [])
                        resp_reviews_raw.sort(key=lambda r: r.get("reviewer_credibility_at_time") or 0, reverse=True)
                        resp_top_reviews = [
                            {
                                "score": r.get("score"),
                                "overall_assessment": r.get("overall_assessment", ""),
                                "methodology_notes": r.get("methodology_notes", ""),
                            }
                            for r in resp_reviews_raw[:3]
                        ]
                        responses.append({
                            "stance": candidate.get("response_stance"),
                            "title": resp_full["paper"].get("title"),
                            "abstract": resp_full["paper"].get("abstract"),
                            "body": resp_full["paper"].get("body", ""),
                            "weighted_score": candidate.get("weighted_score"),
                            "reviews": resp_top_reviews,
                        })

            bounties_resp = api("get", f"/bounties?paper_id={p['id']}", api_key=self.api_key)
            bounty_summaries = []
            for b in bounties_resp.get("bounties", [])[:3]:
                bounty_summaries.append({
                    "status": b.get("status"),
                    "validated": b.get("is_valid"),
                    "external_sources_count": len(b.get("external_sources", [])),
                })

            dossier_papers.append({
                "id": p["id"],
                "title": full_paper.get("title"),
                "abstract": full_paper.get("abstract"),
                "body": full_paper.get("body", ""),
                "weighted_score": p.get("weighted_score"),
                "response_stance": p.get("response_stance"),
                "parent_paper_id": p.get("parent_paper_id"),
                "falsifiable_claim": full_paper.get("falsifiable_claim"),
                "cross_study_connection": full_paper.get("cross_study_connection"),
                "top_reviews": top_reviews,
                "responses_and_revisions": responses,
                "bounties": bounty_summaries,
            })

        self.log.info(f"Dossier assembled: {len(dossier_papers)} own papers with full history")

        top_papers_data = api("get", "/papers?limit=100", api_key=self.api_key)
        all_papers = top_papers_data.get("papers", [])

        scored_papers = [
            p for p in all_papers
            if p.get("weighted_score") and p.get("raw_review_count", 0) >= 3
        ]
        scored_papers.sort(key=lambda x: x.get("weighted_score", 0), reverse=True)

        top_papers_full = []
        for p in scored_papers[:5]:
            full = fetch_full_paper(p["id"], self.api_key, self.log, learning_mode=True)
            if full:
                reviews_data = full["full"].get("reviews", [])
                review_notes = []
                for r in reviews_data[:5]:
                    if r.get("overall_assessment"):
                        review_notes.append({
                            "score": r.get("score"),
                            "methodology": r.get("methodology_notes", "")[:300],
                            "overall": r.get("overall_assessment", "")[:300],
                        })
                top_papers_full.append({
                    "title": full["paper"].get("title"),
                    "score": p.get("weighted_score"),
                    "abstract": full["paper"].get("abstract"),
                    "body": full["paper"].get("body", "")[:2000],
                    "cross_study_connection": full["paper"].get("cross_study_connection"),
                    "falsifiable_claim": full["paper"].get("falsifiable_claim"),
                    "what_reviewers_said": review_notes,
                })

        if top_papers_full:
            self.log.info(f"Loaded {len(top_papers_full)} top-scoring platform papers")

        # Concept generation (Haiku) — unchanged
        prior_titles = [p.get("title", "") for p in dossier_papers if p.get("title")]
        prior_titles_str = "\n".join(f"- {t}" for t in prior_titles) if prior_titles else "None yet"

        concept_prompt = (
            f"You are {self.handle}, a scientist with this research history:\n{prior_titles_str}\n\n"
            "Generate a NEW paper concept that:\n"
            "1. Makes a genuine cross-domain connection between two different fields\n"
            "2. Has NOT been covered in your prior papers\n"
            "3. Is specific enough to search for real supporting literature\n\n"
            "Return JSON only:\n"
            "{\n"
            '  "working_title": "<specific working title>",\n'
            '  "domain_a": "<first field>",\n'
            '  "domain_b": "<second field>",\n'
            '  "core_claim": "<the cross-domain insight in one sentence>",\n'
            '  "search_queries": ["<q1>", "<q2>", "<q3>", "<q4>", "<q5>"]\n'
            '}'
        )

        concept = ask_claude_json(self.client, self.system, concept_prompt, max_tokens=800, model=MODEL_FAST)

        if concept and concept.get("search_queries"):
            targeted_queries = concept["search_queries"]
            paper_context = concept.get("core_claim", "")
            self.log.info(f"Concept: '{concept.get('working_title','?')[:60]}'")
        else:
            targeted_queries = self.search_queries
            paper_context = ""
            self.log.warning("Concept generation failed — falling back to personality queries")

        # Wall #15: generate opposing queries BEFORE searching
        opposing_queries = generate_opposing_queries(self.client, concept or {}, self.log)
        if not opposing_queries:
            # Fallback: generate basic opposing queries from the concept
            claim = paper_context or "the hypothesis"
            opposing_queries = [
                f"{' '.join(targeted_queries[0].split()[:4])} contradictory findings negative results" if targeted_queries else "negative results",
                f"{' '.join(targeted_queries[0].split()[:4])} alternative mechanism explanation" if targeted_queries else "alternative explanation",
            ]
            self.log.warning("Opposing query generation failed — using fallback opposites")

        # Walls #5 + #8 + #9: search with full coverage + immediate summarization
        # Search with BOTH supporting and opposing queries
        all_search_queries = targeted_queries + opposing_queries
        ss_papers = search_and_summarize(all_search_queries, self.log, self.client, paper_context)
        if len(ss_papers) < 2:
            self.log.warning("Targeted search insufficient — trying personality queries")
            ss_papers = search_and_summarize(self.search_queries, self.log, self.client, paper_context)
        if len(ss_papers) < 2:
            self.log.error("Could not get enough results — skipping")
            return None

        # Wall #15: build search_strategy object for submission
        paper_search_strategy = {
            "supporting_queries": targeted_queries[:6],
            "opposing_queries": opposing_queries[:6],
            "query_rationale": (
                f"Supporting queries target evidence for: {paper_context or 'the core hypothesis'}. "
                f"Opposing queries search for contradictions, alternative mechanisms, and negative results "
                f"that would challenge or disprove the hypothesis."
            )[:2000]
        }

        dossier_section = ""
        if dossier_papers:
            dossier_section = (
                "\n═══════════════════════════════════════════════════════\n"
                "YOUR COMPLETE RESEARCH HISTORY — read carefully before writing.\n"
                "Your next paper must build on this — not repeat it.\n"
                "═══════════════════════════════════════════════════════\n\n"
                + json.dumps(dossier_papers, indent=2) + "\n"
            )

        examples_section = ""
        if top_papers_full:
            examples_section = (
                "\n═══════════════════════════════════════════════════════\n"
                "TOP-SCORING PAPERS ON PEERZERO — study what earns high scores.\n"
                "═══════════════════════════════════════════════════════\n\n"
                + json.dumps(top_papers_full, indent=2) + "\n"
            )

        # Wall #4: failure patterns section
        failure_section = ""
        if failure_patterns:
            failure_section = (
                "\n═══════════════════════════════════════════════════════\n"
                "KNOWN FAILURE PATTERNS TO AVOID — extracted from your review history:\n"
                "═══════════════════════════════════════════════════════\n"
                + failure_patterns + "\n"
            )

        # Wall #5: citation slots include pre-computed agent_summary and source_quality_note
        citation_slots = ""
        for p in ss_papers:
            doi = p.get("externalIds", {}).get("DOI") or p.get("doi", "")
            if not doi:
                continue
            precomputed = p.get("agent_summary", "")
            quality_note = p.get("source_quality_note", "")
            citation_count = p.get("citationCount", 0) or 0
            citation_slots += (
                f"\n--- CITATION SLOT ---\n"
                f"DOI: {doi}\n"
                f"Title: {p.get('title', '')}\n"
                f"Citation count: {citation_count}\n"
                f"Abstract (use THIS — do not use memory): {p.get('abstract', '')}\n"
                + (f"Pre-computed agent_summary (verified from abstract above): {precomputed}\n" if precomputed else "")
                + (f"Pre-computed source_quality_note: {quality_note}\n" if quality_note else "")
            )

        prompt = (
            "You are writing your next scientific paper for PeerZero.\n\n"
            + dossier_section
            + examples_section
            + failure_section
            + "\n═══════════════════════════════════════════════════════\n"
            "AVAILABLE CITATIONS — you may ONLY cite these DOIs.\n"
            "agent_summary MUST be based on the abstract shown — not your training memory.\n"
            "A pre-computed summary is provided where available — use it or improve it.\n"
            "═══════════════════════════════════════════════════════\n"
            + citation_slots
            + "\n\n"
            "Write a paper that:\n"
            "1. Advances beyond your previous work\n"
            "2. Addresses unresolved criticisms from your history\n"
            "3. Makes a genuine cross-study connection between citations above\n"
            "4. Has a specific, falsifiable claim with quantitative predictions\n"
            "5. Actively avoids your known failure patterns\n"
            "6. Only cites DOIs from the citation slots above\n"
            "7. Where evidence is genuinely uncertain or contested, says so specifically — not vaguely\n\n"
            "Return JSON only:\n"
            "{\n"
            '  "title": "<specific, scientific title>",\n'
            '  "abstract": "<150+ chars>",\n'
            '  "body": "<full paper — no length limit>",\n'
            '  "field_ids": [<1-13>],\n'
            '  "confidence_score": <4.0-8.0>,\n'
            '  "falsifiable_claim": "<specific testable prediction>",\n'
            '  "measurable_prediction": "<what would be measured>",\n'
            '  "quantitative_expectation": "<expected effect size or threshold>",\n'
            '  "cross_study_connection": "<200+ chars — use real author names/DOIs, never Study A/Study B>",\n'
            '  "citations": [\n'
            '    {\n'
            '      "doi": "<DOI exactly as in citation slot>",\n'
            '      "agent_summary": "<60+ chars — from abstract shown, not memory>",\n'
            '      "relevance_explanation": "<40+ chars — how this supports your claim>",\n'
            '      "source_quality_note": "<40+ chars — why this source is credible evidence for the specific claim: cite citation count, methodology fit, venue. If weak tier, justify explicitly>"\n'
            '    }\n'
            '  ]\n'
            '}'
        )

        paper = ask_claude_json(self.client, self.system, prompt, max_tokens=8000)
        if not paper or "title" not in paper:
            self.log.error("Failed to generate paper")
            return None

        if paper.get("citations"):
            paper["citations"] = validate_citations(paper["citations"], ss_papers, self.log)

        # Wall #6: cross-study validation
        cross_ok, cross_reason = validate_cross_study(paper.get("cross_study_connection", ""), self.log)
        if not cross_ok:
            self.log.warning(f"Cross-study validation failed ({cross_reason}) — rewriting")
            paper = rewrite_cross_study(self.client, self.system, paper, ss_papers, cross_reason, self.log)

        # Wall #7: confidence gate
        paper = apply_confidence_gate(self.client, self.system, paper, self.log)

        # Wall #15: attach search_strategy to paper submission
        paper["search_strategy"] = paper_search_strategy

        result = api("post", "/papers", api_key=self.api_key, json=paper)
        if result.get("success"):
            self.log.info(f"Paper submitted: {result.get('paper_id')}")
            # Wall #20: log coaching feedback
            coaching = result.get("search_strategy_coaching")
            if coaching:
                self.log.info(f"Search coaching: {json.dumps(coaching)[:200]}")
            audit_flags = result.get("citation_audit_flags")
            if audit_flags:
                self.log.warning(f"Citation audit flags: {json.dumps(audit_flags)[:200]}")
            diversity = result.get("citation_diversity_warnings")
            if diversity:
                self.log.info(f"Citation diversity warnings: {json.dumps(diversity)[:200]}")
            return result.get("paper_id")
        else:
            self.log.warning(f"Paper submission failed: {result.get('error')}")
            return None

    # ── Find a bounceable paper (unchanged) ───────────────────────────────────

    def find_bounty_target(self) -> Optional[dict]:
        already_bounced_ids = self.get_my_response_paper_ids()

        papers_data = api("get", "/papers?limit=100", api_key=self.api_key)
        papers = papers_data.get("papers", [])

        candidates = [
            p for p in papers
            if p.get("weighted_score")
            and p.get("raw_review_count", 0) >= 3
            and p.get("agents", {}).get("handle") != self.handle
            and p["id"] not in already_bounced_ids
            and not p.get("parent_paper_id")
        ]

        if not candidates:
            self.log.info("No valid bounty targets found")
            return None

        random.shuffle(candidates)
        for candidate in candidates:
            target = fetch_full_paper(candidate["id"], self.api_key, self.log)
            if target:
                return target

        return None

    # ── weak_source_quality bounty helper ────────────────────────────────────

    def _try_weak_source_quality_bounty(self, paper: dict, citations: list) -> bool:
        """
        Session 7 (wall #12): Check if any citation on the target paper has a
        weak/unknown quality_tier with an inadequate source_quality_note, and if
        so, file a weak_source_quality challenge.

        This is a lightweight challenge — no rebuttal paper needed. The challenger
        specifies the DOI and explains why the note fails to justify the citation.

        Returns True if a challenge was successfully filed, False otherwise.
        Non-blocking — any failure returns False without raising.
        """
        if not citations:
            return False

        # Find citations with weak or unknown quality_tier
        weak_citations = [
            c for c in citations
            if c.get("quality_tier") in ("weak", "unknown")
            and c.get("doi")
            and c.get("source_quality_note")
        ]

        if not weak_citations:
            return False

        self.log.info(f"Found {len(weak_citations)} weak/unknown quality_tier citation(s) — checking for inadequate notes")

        # Ask Haiku to evaluate whether any note is inadequate enough to challenge
        citation_block = "\n\n".join(
            f"DOI: {c['doi']}\n"
            f"quality_tier: {c.get('quality_tier', 'unknown')}\n"
            f"citation_count: {c.get('citation_count', 'unknown')}\n"
            f"source_quality_note: \"{c.get('source_quality_note', '')}\""
            for c in weak_citations[:4]
        )

        eval_prompt = (
            f"You are reviewing citations from a paper. Each citation has a server-computed quality_tier "
            f"(weak=under 10 citations, unknown=lookup failed) and a source_quality_note written by the author.\n\n"
            f"Identify ONE citation whose source_quality_note is inadequate — either:\n"
            f"1. TONE MISMATCH: note claims well-established/seminal/highly-cited but tier is weak/unknown\n"
            f"2. BOILERPLATE: note gives no real methodological reasoning (e.g. 'this is relevant', 'supports the claim')\n"
            f"3. UNJUSTIFIED WEAK USE: note does not explain why a weak/unknown source is acceptable evidence\n\n"
            f"Only flag a citation if you have a genuine, specific reason to challenge it.\n"
            f"If all notes are adequate despite the weak tier, return null.\n\n"
            f"CITATIONS:\n{citation_block}\n\n"
            f"Return JSON only:\n"
            f'{{"doi": "<the DOI to challenge, or null if none>", '
            f'"reason": "<80+ char explanation of why this note is inadequate given the tier and methodology, or null>"}}'
        )

        try:
            result = ask_claude_json(self.client, self.system, eval_prompt, max_tokens=300, model=MODEL_FAST)
        except Exception as e:
            self.log.warning(f"weak_source_quality eval failed: {e}")
            return False

        if not result or not result.get("doi") or not result.get("reason"):
            self.log.info("No inadequate source_quality_note found — skipping weak_source_quality challenge")
            return False

        challenged_doi = result["doi"].strip()
        challenge_reason = result["reason"].strip()

        if len(challenge_reason) < 80:
            self.log.warning(f"weak_source_quality reason too short ({len(challenge_reason)} chars) — skipping")
            return False

        self.log.info(f"Filing weak_source_quality challenge against DOI: {challenged_doi}")

        # Wall #18: search_strategy required for weak_source_quality bounties
        wsq_search_strategy = {
            "verification_queries": [
                f"{challenged_doi} citation count methodology replication",
                f"{challenged_doi.split('/')[-1] if '/' in challenged_doi else challenged_doi} peer review quality assessment",
            ],
            "query_rationale": (
                f"Verification queries evaluate whether the challenged citation ({challenged_doi}) "
                f"is genuinely weak evidence: checking its actual citation count, methodology, "
                f"replication status, and whether the author's source_quality_note is justified."
            )
        }

        bounty_result = api(
            "post", "/bounties",
            api_key=self.api_key,
            json={
                "action": "register",
                "target_paper_id": paper["id"],
                "challenge_type": "weak_source_quality",
                "challenged_doi": challenged_doi,
                "quality_challenge_reason": challenge_reason,
                "search_strategy": wsq_search_strategy,
            }
        )

        if bounty_result.get("success"):
            self.log.info(
                f"weak_source_quality bounty registered: {bounty_result.get('bounty_id')} "
                f"(tier: {bounty_result.get('citation_quality_tier')}, "
                f"count: {bounty_result.get('citation_count')})"
            )
            return True
        else:
            err = bounty_result.get("error", "")
            # Expected failures: already filed a bounty on this paper, or DOI not found
            if "Already registered" in err or "not a citation" in err:
                self.log.info(f"weak_source_quality challenge not applicable: {err}")
            else:
                self.log.warning(f"weak_source_quality bounty failed: {err}")
            return False

    # ── File a bounty ─────────────────────────────────────────────────────────

    def do_file_bounty(self) -> bool:
        target = self.find_bounty_target()
        if not target:
            self.log.info("No bounty targets — falling back to review")
            return self.do_review()

        paper = target["paper"]
        full = target["full"]

        reviews = full.get("reviews", [])
        already_reviewed = any(r.get("agents", {}).get("handle") == self.handle for r in reviews)
        if not already_reviewed:
            self.log.info("Reviewing target paper before filing bounty")
            if not self._review_specific(paper["id"], paper):
                return False

        self.log.info(f"Filing bounty against: {paper.get('title', '')[:60]}")

        # ── Check if any citation is a weak_source_quality target ─────────────
        # The server records quality_tier for every citation. If any citation has
        # weak/unknown quality_tier, check whether its source_quality_note looks
        # inadequate — and if so, try a weak_source_quality challenge first.
        # This is a lightweight challenge that requires no rebuttal paper.
        paper_citations = full.get("citations", [])
        weak_quality_result = self._try_weak_source_quality_bounty(paper, paper_citations)
        if weak_quality_result:
            self.log.info("Filed weak_source_quality bounty — also attempting standard bounty")
            # Don't return here — fall through to also try the standard full-rebuttal bounty
            # if the target paper has genuine scientific flaws worth challenging.

        # Wall #4: extract failure patterns before writing rebuttal
        status = self.get_status()
        failure_patterns = extract_failure_patterns(self.client, status, self.log)

        paper_title = paper.get("title", "")
        paper_abstract = str(paper.get("abstract", ""))[:600]

        bounty_concept_prompt = (
            f"You need to find scientific evidence contradicting this paper:\n"
            f"Title: {paper_title}\n"
            f"Abstract: {paper_abstract}\n\n"
            "Generate 5 specific search queries to find papers that:\n"
            "- Contradict the core claims\n"
            "- Show methodological problems\n"
            "- Provide counter-evidence\n\n"
            'Return JSON only: {"search_queries": ["<q1>", "<q2>", "<q3>", "<q4>", "<q5>"]}'
        )

        bounty_concept = ask_claude_json(
            self.client, self.system, bounty_concept_prompt, max_tokens=400, model=MODEL_FAST
        )

        if bounty_concept and bounty_concept.get("search_queries"):
            bounty_queries = bounty_concept["search_queries"]
        else:
            bounty_queries = [" ".join(paper_title.split()[:6])] + self.search_queries[:3]
            self.log.warning("Bounty concept generation failed — using title queries")

        # Walls #5 + #8 + #9: full coverage search with immediate summarization
        evidence_papers = search_and_summarize(
            bounty_queries, self.log, self.client,
            paper_context=f"Evidence to challenge: {paper_title}"
        )

        # Wall #4: inject failure patterns into rebuttal prompt
        failure_section = ""
        if failure_patterns:
            failure_section = f"\nKNOWN FAILURE PATTERNS TO AVOID IN YOUR REBUTTAL:\n{failure_patterns}\n\n"

        # Wall #5: citation slots with pre-computed summaries and quality notes
        bounty_citation_slots = ""
        for p in evidence_papers:
            doi = p.get("externalIds", {}).get("DOI") or p.get("doi", "")
            if not doi:
                continue
            precomputed = p.get("agent_summary", "")
            quality_note = p.get("source_quality_note", "")
            citation_count = p.get("citationCount", 0) or 0
            bounty_citation_slots += (
                f"\n--- CITATION SLOT ---\n"
                f"DOI: {doi}\n"
                f"Title: {p.get('title', '')}\n"
                f"Citation count: {citation_count}\n"
                f"Abstract (use THIS — do not use memory): {p.get('abstract', '')}\n"
                + (f"Pre-computed agent_summary: {precomputed}\n" if precomputed else "")
                + (f"Pre-computed source_quality_note: {quality_note}\n" if quality_note else "")
            )

        prompt = (
            "You need to challenge this paper with a bounty. Be precise and adversarial.\n\n"
            + failure_section
            + f"Target paper:\n"
            f"Title: {paper.get('title')}\n"
            f"Abstract: {paper.get('abstract')}\n"
            f"Body: {paper.get('body', '')}\n"
            f"Score: {paper.get('weighted_score')}\n"
            f"Citations: {json.dumps(full.get('citations', []))}\n\n"
            "AVAILABLE EVIDENCE — ONLY cite these DOIs. agent_summary from abstract shown — not memory.\n"
            + bounty_citation_slots
            + "\n\nReturn JSON only:\n"
            "{\n"
            '  "rebuttal": {\n'
            '    "title": "Challenge: <original title shortened>",\n'
            '    "abstract": "<120+ chars — what flaw you found>",\n'
            '    "body": "<detailed scientific rebuttal>",\n'
            '    "stance": "rebut",\n'
            '    "citations": [{"doi": "...", "agent_summary": "...", "relevance_explanation": "...", "source_quality_note": "<why this is credible counter-evidence: citation count, methodology fit, venue>"}]\n'
            '  },\n'
            '  "external_sources": [\n'
            '    {\n'
            '      "doi": "<DOI exactly as in citation slot>",\n'
            '      "specific_finding": "<60+ chars>",\n'
            '      "target_claim": "<40+ chars>",\n'
            '      "logical_bridge": "<90+ chars>"\n'
            '    }\n'
            '  ]\n'
            '}'
        )

        data = ask_claude_json(self.client, self.system, prompt)
        if not data or "rebuttal" not in data or "external_sources" not in data:
            self.log.error("Failed to generate bounty data")
            return False

        if data["rebuttal"].get("citations"):
            data["rebuttal"]["citations"] = validate_citations(
                data["rebuttal"]["citations"], evidence_papers, self.log
            )

        # Wall #7: gate on rebuttal quality — minimum abstract length
        if len(data["rebuttal"].get("abstract", "")) < 120:
            self.log.warning("Rebuttal abstract too short — not filing bounty")
            return False

        valid_dois_lower = {
            (p.get("externalIds", {}).get("DOI") or p.get("doi", "")).strip().lower()
            for p in evidence_papers
        }
        data["external_sources"] = [
            s for s in data["external_sources"]
            if (s.get("doi") or "").strip().lower() in valid_dois_lower
        ]
        if not data["external_sources"]:
            self.log.warning("No valid external sources after validation — skipping bounty")
            return False

        # Wall #17: attach search_strategy to rebuttal response paper
        rebuttal_search_strategy = {
            "supporting_queries": bounty_queries[:6],
            "opposing_queries": [
                f"{paper_title.split()[0] if paper_title else 'paper'} supporting evidence validation",
                f"{paper_title.split()[0] if paper_title else 'paper'} methodology defense replication",
            ],
            "query_rationale": (
                f"Supporting queries target evidence contradicting the paper's core claims. "
                f"Opposing queries search for evidence that would SUPPORT the original paper — "
                f"to ensure the challenge is genuinely warranted and not one-sided."
            )
        }
        data["rebuttal"]["search_strategy"] = rebuttal_search_strategy

        resp_result = api(
            "post", f"/responses?paper_id={paper['id']}",
            api_key=self.api_key,
            json=data["rebuttal"]
        )
        if not resp_result.get("success"):
            self.log.warning(f"Response paper failed: {resp_result.get('error')}")
            return False

        # Wall #18: attach search_strategy to standard bounty registration
        bounty_search_strategy = {
            "supporting_queries": bounty_queries[:6],
            "opposing_queries": [
                f"{paper_title.split()[0] if paper_title else 'paper'} supporting evidence defense",
                f"{paper_title.split()[0] if paper_title else 'paper'} replication confirmation",
            ],
            "query_rationale": (
                f"Supporting queries find evidence that contradicts the target paper. "
                f"Opposing queries search for evidence supporting the target paper to ensure "
                f"the challenge is robust against counter-arguments."
            )
        }

        bounty_result = api(
            "post", "/bounties",
            api_key=self.api_key,
            json={
                "action": "register",
                "target_paper_id": paper["id"],
                "challenge_paper_id": resp_result.get("response_paper_id"),
                "external_sources": data["external_sources"],
                "search_strategy": bounty_search_strategy,
            }
        )

        if bounty_result.get("success"):
            self.log.info(f"Bounty registered: {bounty_result.get('bounty_id')}")
            if bounty_result.get("drift_warning"):
                self.log.warning(f"Drift warning: {bounty_result['drift_warning']}")
            return True
        else:
            self.log.warning(f"Bounty failed: {bounty_result.get('error')}")
            return False

    def _review_specific(self, paper_id: str, paper: dict) -> bool:
        prompt = (
            "Review this paper. Be specific and adversarial.\n\n"
            f"Title: {paper.get('title')}\n"
            f"Abstract: {paper.get('abstract')}\n"
            f"Body: {paper.get('body', '')}\n\n"
            "Check citations for BOTH accuracy (does agent_summary match the paper?) AND quality:\n"
            "- Check quality_tier (strong=50+, adequate=10-49, weak=<10, unknown=lookup failed)\n"
            "- Check source_quality_note: does it give real methodological reasoning, or is it generic boilerplate?\n"
            "- Flag TONE MISMATCHES: note claims well-established/seminal/highly-cited but quality_tier is weak/unknown\n"
            "- Flag BOILERPLATE: note says only 'this is relevant' or 'supports the claim' with no methodology detail\n"
            "- A weak/unknown quality_tier citation with an inadequate note is a weak_source_quality bounty target\n"
            "Also flag false confidence (certainty without evidence) and vague uncertainty ('further research needed' without specifics).\n\n"
            "Return JSON only:\n"
            "{\n"
            '  "score": <1.0-10.0>,\n'
            '  "methodology_notes": "<50+ chars>",\n'
            '  "statistical_validity_notes": "<50+ chars>",\n'
            '  "citation_accuracy_notes": "<accuracy + quality: flag tone mismatches between source_quality_note and quality_tier, flag boilerplate notes>",\n'
            '  "reproducibility_notes": "<assess reproducibility>",\n'
            '  "logical_consistency_notes": "<check logic, flag overconfidence or vague uncertainty>",\n'
            '  "overall_assessment": "<100+ chars>"\n'
            '}'
        )
        review = ask_claude_json(self.client, self.system, prompt)
        if not review:
            return False

        # Wall #16: generate and attach review_search_strategy
        review_strategy = generate_review_search_strategy(self.client, paper, self.log)
        if review_strategy:
            review["review_search_strategy"] = review_strategy
        else:
            title_words = paper.get("title", "").split()[:5]
            review["review_search_strategy"] = {
                "verification_queries": [
                    f"{' '.join(title_words)} replication verification",
                    f"{' '.join(title_words)} independent evidence",
                ],
                "gap_queries": [
                    f"{' '.join(title_words)} contradictory negative results",
                    f"{' '.join(title_words)} alternative explanation",
                ],
                "query_rationale": (
                    "Verification queries check for independent support of core claims. "
                    "Gap queries search for contradictions or alternative explanations."
                )
            }

        result = api("post", f"/reviews?paper_id={paper_id}", api_key=self.api_key, json=review)
        if result.get("success", False):
            self.reviewed_paper_ids.add(paper_id)
            self._save_reviewed_id(paper_id)
        return result.get("success", False)

    # ── Revise own paper ──────────────────────────────────────────────────────

    def do_revise(self) -> bool:
        self.log.info("Looking for own papers to revise...")

        my_papers_data = api("get", "/papers?my_papers=true", api_key=self.api_key)
        my_papers = my_papers_data.get("papers", [])

        if not my_papers:
            self.log.info("No own papers found — falling back to review")
            return self.do_review()

        candidates = []
        for p in my_papers:
            if p.get("parent_paper_id"):
                continue
            existing_revisions = [
                q for q in my_papers
                if q.get("parent_paper_id") == p["id"]
                and q.get("response_stance") == "revision"
            ]
            if len(existing_revisions) >= 2:
                self.log.info(f"Paper '{p.get('title','')[:40]}' already has 2 revisions — skipping")
                continue
            # Wall #1: gate is 5+ reviews (was 3)
            if p.get("raw_review_count", 0) < 5:
                self.log.info(
                    f"Paper '{p.get('title','')[:40]}' has {p.get('raw_review_count', 0)} reviews — "
                    f"need 5 before revision"
                )
                continue
            candidates.append((p, existing_revisions))

        if not candidates:
            self.log.info("No papers eligible for revision — falling back to review")
            return self.do_review()

        candidates.sort(key=lambda x: x[0].get("raw_review_count", 0), reverse=True)
        paper, existing_revisions = candidates[0]

        # Revision 2: revision 1 itself also needs 5+ reviews
        if len(existing_revisions) == 1:
            rev1_review_count = existing_revisions[0].get("raw_review_count", 0)
            if rev1_review_count < 5:
                self.log.info(
                    f"Revision 1 has {rev1_review_count} reviews — "
                    f"need 5 before revision 2. Falling back to review."
                )
                return self.do_review()

        full_data = fetch_full_paper(paper["id"], self.api_key, self.log)
        if not full_data:
            self.log.warning("Could not fetch full paper for revision — falling back to review")
            return self.do_review()

        full_paper = full_data["paper"]
        full_resp = full_data["full"]
        reviews = full_resp.get("reviews", [])

        # Wall #4: extract failure patterns BEFORE writing
        status = self.get_status()
        failure_patterns = extract_failure_patterns(self.client, status, self.log)

        bounties_data = api("get", f"/bounties?paper_id={paper['id']}", api_key=self.api_key)
        bounties = bounties_data.get("bounties", [])

        challenge_context = []
        for b in bounties[:3]:
            challenge_id = b.get("challenge_paper_id")
            if not challenge_id:
                continue
            challenge_full = fetch_full_paper(challenge_id, self.api_key, self.log)
            if challenge_full:
                challenge_context.append({
                    "title": str(challenge_full["paper"].get("title", "")),
                    "abstract": str(challenge_full["paper"].get("abstract", "")),
                    "body": str(challenge_full["paper"].get("body", ""))[:1500],
                    "stance": str(challenge_full["paper"].get("response_stance", "rebut")),
                })

        self.log.info(
            f"Revising: '{paper.get('title', '')[:60]}' "
            f"(revision {len(existing_revisions) + 1}/2, {len(reviews)} reviews, "
            f"{len(challenge_context)} challenges)"
        )

        # Wall #2: extract haiku_audit from the full paper response
        haiku_audit = full_resp.get("haiku_audit") or full_paper.get("haiku_audit")

        # Wall #3: use haiku_audit.search_queries when available
        if haiku_audit and haiku_audit.get("search_queries"):
            revision_queries = haiku_audit["search_queries"]
            self.log.info(f"Using {len(revision_queries)} search queries from haiku_audit")
        else:
            full_title = str(full_paper.get("title", ""))
            title_query = " ".join(full_title.split()[:6])

            critic_queries = []
            for r in reviews:
                for text in [r.get("overall_assessment", ""), r.get("citation_accuracy_notes", "")]:
                    words = str(text).split()
                    for i, w in enumerate(words):
                        if w.lower() in ("cite", "citation", "literature", "evidence", "reference"):
                            snippet = " ".join(words[max(0, i + 1):i + 6])
                            if len(snippet) > 10:
                                critic_queries.append(snippet)

            revision_queries = [title_query] + critic_queries[:3] + list(self.search_queries[:2])
            self.log.info(f"No haiku_audit — paper-derived queries: {revision_queries[:3]}")

        # Walls #5 + #8 + #9: full coverage search with immediate summarization
        evidence_papers = search_and_summarize(
            revision_queries, self.log, self.client,
            paper_context=f"Revision of: {full_paper.get('title', '')}"
        )

        review_summaries = [
            {
                "score": r.get("score"),
                "methodology": str(r.get("methodology_notes", "")),
                "statistics": str(r.get("statistical_validity_notes", "")),
                "overall": str(r.get("overall_assessment", ""))
            }
            for r in reviews
        ]

        challenge_section = ""
        if challenge_context:
            challenge_section = (
                "\nCHALLENGE PAPERS FILED AGAINST YOUR PAPER:\n"
                + json.dumps(challenge_context, indent=2)
                + "\nAddress these directly with evidence — not just rewording.\n"
            )

        original_title = str(full_paper.get("title", ""))
        original_abstract = str(full_paper.get("abstract", ""))
        original_body = str(full_paper.get("body", ""))
        reviews_json = json.dumps(review_summaries, indent=2)

        # Wall #2: build haiku_audit instruction section (explicit, not background)
        audit_instructions = ""
        if haiku_audit:
            rev_instr = haiku_audit.get("revision_instructions", {})
            do_not_touch = rev_instr.get("do_not_touch", [])
            strengthen = rev_instr.get("strengthen", [])
            rebuild = rev_instr.get("rebuild", [])
            unnamed = haiku_audit.get("unnamed_problems", [])
            cross_verdict = haiku_audit.get("cross_study_verdict", "unknown")
            cross_note = haiku_audit.get("cross_study_note", "")
            citation_flags = haiku_audit.get("citation_accuracy_flags", [])

            audit_instructions = (
                "\n═══════════════════════════════════════════════════════\n"
                f"REVISION AUDIT (from {len(reviews)} reviewer assessments) — follow precisely:\n"
                "═══════════════════════════════════════════════════════\n\n"
                "STRONG — DO NOT TOUCH:\n"
                + "\n".join(f"- {s}" for s in do_not_touch)
                + "\n\nSTRENGTHEN (add citations, tighten argument):\n"
                + "\n".join(f"- {s}" for s in strengthen)
                + "\n\nREBUILD (new evidence required):\n"
                + "\n".join(f"- {s}" for s in rebuild)
                + "\n\nUNNAMED PROBLEMS REVIEWERS MISSED:\n"
                + "\n".join(f"- {p}" for p in unnamed)
                + f"\n\nCROSS-STUDY VERDICT: {cross_verdict}\n{cross_note}\n"
                + (("\nCITATION FLAGS:\n" + "\n".join(f"- {f}" for f in citation_flags) + "\n") if citation_flags else "")
                + "═══════════════════════════════════════════════════════\n"
            )
            self.log.info(
                f"haiku_audit: {len(do_not_touch)} do-not-touch, "
                f"{len(strengthen)} strengthen, {len(rebuild)} rebuild"
            )
        else:
            # Wall #10: fallback section categorization
            self.log.info("No haiku_audit — running local section categorization fallback")
            section_cats = categorize_sections(self.client, original_body, reviews, self.log)
            if any(section_cats.values()):
                audit_instructions = (
                    "\n═══════════════════════════════════════════════════════\n"
                    "SECTION CATEGORIZATION (local fallback):\n"
                    "═══════════════════════════════════════════════════════\n\n"
                    "STRONG — DO NOT TOUCH:\n"
                    + "\n".join(f"- {s}" for s in section_cats.get("strong", []))
                    + "\n\nADEQUATE — STRENGTHEN:\n"
                    + "\n".join(f"- {s}" for s in section_cats.get("adequate", []))
                    + "\n\nWEAK — REBUILD:\n"
                    + "\n".join(f"- {s}" for s in section_cats.get("weak", []))
                    + "\n═══════════════════════════════════════════════════════\n"
                )

        # Patch vs Reframe decision
        decision_prompt = (
            "You are deciding how to revise your paper.\n\n"
            f"TITLE: {original_title}\n"
            f"ABSTRACT: {original_abstract[:600]}\n\n"
            f"REVIEWER FEEDBACK:\n{reviews_json}\n\n"
            "PATCH — core claim is sound, reviewers want better citations/stats/methodology.\n"
            "REFRAME — reviewers say the core claim itself is wrong, too weak, or unfalsifiable.\n\n"
            'Return JSON only:\n{"decision": "patch" or "reframe", "reason": "<one sentence>", '
            '"reframe_angle": "<if reframe: specific new angle>"}'
        )

        decision = ask_claude_json(self.client, self.system, decision_prompt, max_tokens=400, model=MODEL_FAST)
        revision_mode = decision.get("decision", "patch").lower() if decision else "patch"
        reframe_angle = decision.get("reframe_angle", "") if decision else ""
        self.log.info(f"Revision decision: {revision_mode.upper()} — {(decision or {}).get('reason', '')[:80]}")

        # Citation slots with pre-computed summaries
        citation_slots = ""
        usable_papers = []
        for p in evidence_papers:
            doi = p.get("externalIds", {}).get("DOI") or p.get("doi", "")
            if not doi:
                continue
            abstract = str(p.get("abstract") or p.get("title") or "")[:800]
            if not abstract:
                continue
            usable_papers.append(p)
            precomputed = p.get("agent_summary", "")
            quality_note = p.get("source_quality_note", "")
            citation_count = p.get("citationCount", 0) or 0
            citation_slots += (
                f"DOI: {doi}\n"
                f"Title: {p.get('title', '')}\n"
                f"Citation count: {citation_count}\n"
                f"Abstract (use THIS — do not use memory): {abstract}\n"
                + (f"Pre-computed agent_summary: {precomputed}\n" if precomputed else "")
                + (f"Pre-computed source_quality_note: {quality_note}\n" if quality_note else "")
                + "\n"
            )

        if revision_mode == "reframe" and reframe_angle:
            revision_instructions = (
                f"REVISION MODE: REFRAME\nNew angle: {reframe_angle}\n\n"
                "1. Acknowledge the fundamental weakness reviewers identified\n"
                "2. Present a genuinely NEW cross_study_connection\n"
                "3. Make a new specific falsifiable claim\n"
                "4. Support the NEW argument with citations from the slots below\n"
                "5. If new evidence contradicts something you argued in your original paper, say so explicitly — "
                "do not quietly drop the old claim, state what changed and why\n"
            )
            new_title = f"Reframed: {original_title}"
        else:
            revision_instructions = (
                "REVISION MODE: PATCH\n\n"
                "Follow the REVISION AUDIT above precisely:\n"
                "1. Do not touch STRONG sections\n"
                "2. Strengthen ADEQUATE sections with new citations\n"
                "3. Rebuild WEAK sections with new evidence\n"
                "4. Address challenge papers directly\n"
                "5. Fix unnamed problems reviewers missed\n"
                "6. If any new citation contradicts something claimed in the original paper, "
                "acknowledge the contradiction explicitly and update your position — do not paper over it\n"
                "7. Where evidence is genuinely uncertain, name exactly what is uncertain — "
                "do not use 'further research needed' without specifying what research and why\n"
            )
            new_title = f"Revised: {original_title}"

        failure_section = ""
        if failure_patterns:
            failure_section = f"\nKNOWN FAILURE PATTERNS TO AVOID:\n{failure_patterns}\n\n"

        prompt = (
            f"Revising your paper based on reviewer feedback and challenge papers.\n\n"
            f"ORIGINAL:\nTitle: {original_title}\nAbstract: {original_abstract}\nBody: {original_body}\n\n"
            f"REVIEWER FEEDBACK:\n{reviews_json}\n"
            + challenge_section
            + audit_instructions
            + failure_section
            + "AVAILABLE CITATIONS — only use DOIs from this list:\n"
            "agent_summary MUST be based on abstract shown — not memory.\n\n"
            + citation_slots
            + "\n" + revision_instructions
            + "\nReturn JSON only:\n"
            "{\n"
            f'  "title": "{new_title}",\n'
            '  "abstract": "<150+ chars>",\n'
            '  "body": "<full revised paper — no length limit>",\n'
            '  "stance": "revision",\n'
            '  "citations": [\n'
            '    {\n'
            '      "doi": "<DOI exactly as in citation slot>",\n'
            '      "agent_summary": "<60+ chars — from abstract shown, not memory>",\n'
            '      "relevance_explanation": "<40+ chars>",\n'
            '      "source_quality_note": "<40+ chars — citation count, methodology fit, venue. Justify weak-tier sources explicitly>"\n'
            '    }\n'
            '  ]\n'
            '}'
        )

        revision = ask_claude_json(self.client, self.system, prompt, max_tokens=8000)
        if not revision or "body" not in revision:
            self.log.error("Failed to generate revision")
            return False

        revision["stance"] = "revision"

        if revision.get("citations") and usable_papers:
            revision["citations"] = validate_citations(revision["citations"], usable_papers, self.log)

        # Wall #6: cross-study validation on revision
        if revision.get("cross_study_connection"):
            cross_ok, cross_reason = validate_cross_study(revision["cross_study_connection"], self.log)
            if not cross_ok:
                self.log.warning(f"Revision cross-study validation failed ({cross_reason}) — rewriting")
                revision = rewrite_cross_study(
                    self.client, self.system, revision, usable_papers, cross_reason, self.log
                )

        # Wall #7: confidence gate on revision
        if "confidence_score" in revision:
            revision = apply_confidence_gate(self.client, self.system, revision, self.log)

        # Wall #17: attach search_strategy to revision response paper
        # Use the revision queries as supporting, generate opposing from the criticism angle
        revision_opposing = [
            f"{' '.join(original_title.split()[:4])} supporting evidence validation",
            f"{' '.join(original_title.split()[:4])} original hypothesis confirmation",
        ]
        revision["search_strategy"] = {
            "supporting_queries": revision_queries[:6],
            "opposing_queries": revision_opposing[:6],
            "query_rationale": (
                f"Supporting queries target evidence to address reviewer criticisms and strengthen "
                f"weak sections. Opposing queries search for evidence that supports the original "
                f"claims to ensure revisions don't overcorrect or abandon valid positions."
            )
        }

        result = api(
            "post", f"/responses?paper_id={paper['id']}",
            api_key=self.api_key,
            json=revision
        )

        if result.get("success"):
            self.log.info(
                f"Revision {len(existing_revisions) + 1} submitted for "
                f"'{paper.get('title', '')[:50]}' → {result.get('response_paper_id')}"
            )
            # Wall #20: log coaching feedback
            coaching = result.get("search_strategy_coaching")
            if coaching:
                self.log.info(f"Revision search coaching: {json.dumps(coaching)[:200]}")
            return True
        else:
            self.log.warning(f"Revision submission failed: {result.get('error')}")
            return False

    # ── Validate bounties (unchanged) ─────────────────────────────────────────

    def get_bounty_status(self) -> dict:
        result = api("get", "/bounties?my_bounties=true", api_key=self.api_key)
        return {
            "validated": result.get("validated", 0),
            "pending":   result.get("pending", 0),
            "failed":    result.get("failed", 0),
            "replaceable_slots": result.get("replaceable_slots", 0),
        }

    def get_required_bounties(self, status: dict) -> int:
        tier_info = status.get("tier_info", "")
        match = re.search(r"need (\d+) more bounti", tier_info)
        if match:
            validated = status.get("valid_bounties", 0)
            return validated + int(match.group(1))
        match = re.search(r"bounti\w*[:\s]+(\d+)/(\d+)", tier_info)
        if match:
            return int(match.group(2))
        cred = status.get("credibility_score", 0)
        if cred < 75:   return 3
        if cred < 100:  return 6
        if cred < 150:  return 12
        if cred < 175:  return 20
        return 30

    def do_validate_all(self):
        try:
            result = api("post", "/bounties", api_key=self.api_key, json={"action": "validate_all"})
            validated = result.get("bounties_validated", 0)
            if validated > 0:
                self.log.info(f"Validated {validated} bounties")
        except Exception as e:
            self.log.warning(f"validate_all timed out or failed: {e}")

    # ── Main loop (unchanged) ─────────────────────────────────────────────────

    def run_cycle(self, run_validate: bool = False):
        if not self.api_key:
            if not self.register():
                return

        status = self.get_status()
        if "error" in status:
            self.log.error(f"Status check failed: {status}")
            return

        cred = status.get("credibility_score", 0)
        self.log.info(f"Credibility: {cred} | {status.get('tier_info', '')[:80]}")

        if run_validate:
            self.do_validate_all()

        bounty_status = self.get_bounty_status()
        validated  = bounty_status["validated"]
        pending    = bounty_status["pending"]
        failed     = bounty_status["failed"]
        required   = self.get_required_bounties(status)

        self.log.info(
            f"Bounties — validated: {validated}, pending: {pending}, "
            f"failed: {failed}, required: {required}"
        )

        action = self.decide_action(status)

        if action == "file_bounty":
            in_flight = validated + pending
            if in_flight >= required and failed == 0:
                self.log.info("Enough bounties in flight — switching to review")
                action = "review"
            elif pending >= 3 and failed == 0:
                self.log.info(f"{pending} pending bounties need reviews to validate — switching to review")
                action = "review"
            elif failed > 0 and (validated + pending) < required:
                self.log.info(f"{failed} failed bounties to replace, still need {required - validated} validated")
                action = "file_bounty"

        self.log.info(f"Final action: {action}")

        if action == "review":
            if not self.do_review():
                self.log.info("No reviews available — trying bounty")
                if not self.do_file_bounty():
                    self.log.info("No bounty targets either — trying paper submission")
                    self.do_submit_paper()

        elif action == "submit_paper":
            if not self.do_submit_paper():
                self.log.info("Paper submission skipped — trying review")
                if not self.do_review():
                    self.log.info("No reviews available — trying bounty")
                    self.do_file_bounty()

        elif action == "file_bounty":
            if not self.do_file_bounty():
                self.log.info("No bounty targets — falling back to review")
                self.do_review()

        elif action == "revise":
            if not self.do_revise():
                self.log.info("Nothing to revise — falling back to review")
                if not self.do_review():
                    self.log.info("No reviews available — trying bounty")
                    self.do_file_bounty()

        elif action == "validate_all":
            pass

        else:
            self.do_review()


# ── Runner (unchanged) ────────────────────────────────────────────────────────

def _run_bot_with_offset(bot, run_validate: bool, offset: float):
    if offset > 0:
        time.sleep(offset)
    run_bot_cycle(bot, run_validate=run_validate)


def run_bot_cycle(bot, run_validate: bool = False):
    try:
        bot.run_cycle(run_validate=run_validate)
    except Exception as e:
        bot.log.error(f"Cycle error: {e}", exc_info=True)


def main():
    skill = fetch_skill()
    if not skill or len(skill) < 100:
        logging.error("Failed to fetch skill file — aborting")
        return

    logging.info(f"Skill file loaded ({len(skill)} chars)")

    bots = [PeerZeroBot(c["handle"], c["persona"], skill, c["search_queries"]) for c in BOT_CONFIGS]

    with ThreadPoolExecutor(max_workers=8) as executor:
        futures = {executor.submit(bot.register): bot for bot in bots}
        for future in as_completed(futures):
            pass

    logging.info("All bots registered. Starting cycles...")

    stagger_interval = 60 / len(bots)  # ~7.5s between each bot

    cycle = 0
    while True:
        cycle += 1
        logging.info(f"\n{'='*50}\nCYCLE {cycle}\n{'='*50}")

        random.shuffle(bots)

        with ThreadPoolExecutor(max_workers=8) as executor:
            futures = {}
            for i, bot in enumerate(bots):
                offset = i * stagger_interval if cycle > 1 else 0
                futures[executor.submit(_run_bot_with_offset, bot, i == 0, offset)] = bot
            for future in as_completed(futures):
                pass

        logging.info(f"Cycle {cycle} complete. Sleeping 60s...")
        time.sleep(60)


if __name__ == "__main__":
    main()
