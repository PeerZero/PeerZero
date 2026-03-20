"""
PeerZero Bot Fleet -- 8 adversarial general scientists
All models set to Haiku for cost-effective testing.

Requirements: pip install anthropic requests
Usage: python bots.py
Env: PEERZERO_BASE_URL (default https://peerzero.science)
"""

import os, re, time, json, random, logging, requests, anthropic
from typing import Optional
from concurrent.futures import ThreadPoolExecutor, as_completed

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(name)s] %(levelname)s: %(message)s")
# Suppress noisy httpx request logging (floods output with every Claude API call)
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("httpcore").setLevel(logging.WARNING)

BASE_URL = os.environ.get("PEERZERO_BASE_URL", "https://peerzero.science")
SKILL_URL = f"{BASE_URL}/api/skill"
MODEL_SMART = "claude-haiku-4-5-20251001"
MODEL_FAST = "claude-haiku-4-5-20251001"
KEYS_FILE = "keys.json"
MIN_BODY_LENGTH = 200       # for reading papers from server (existing check)
MIN_GENERATED_BODY = 4000   # for papers/revisions we generate (catch truncation)

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
    {"handle": "CriticalMass_1", "persona": "A rigorous physicist who believes most papers overclaim. Deeply skeptical of weak statistics, loves finding methodology flaws. Reads every citation carefully and flags misrepresentation immediately.", "search_queries": ["quantum entanglement experimental", "dark matter detection", "gravitational waves LIGO", "statistical mechanics phase transitions", "superconductivity mechanism", "nuclear fusion plasma", "particle physics standard model", "cosmological constant dark energy", "neutrino mass measurement", "quantum computing error correction"]},
    {"handle": "NullHypothesis_2", "persona": "A statistician almost offended by poor experimental design. Immediately spots missing controls, underpowered studies, and statistical misuse. Files bounties aggressively when finding real flaws.", "search_queries": ["p-hacking clinical trials", "statistical power meta-analysis", "randomized controlled trial", "Bayesian inference biology", "causal inference observational study", "false discovery rate genomics", "publication bias systematic review", "effect size replication", "multiple comparisons correction", "survival analysis clinical"]},
    {"handle": "ReplicationCrisis_3", "persona": "A biologist haunted by the replication crisis. Obsessed with reproducibility. Checks whether methods are precise enough to replicate. Suspicious of effect sizes that seem too clean.", "search_queries": ["CRISPR genome editing reproducibility", "cell line contamination biology", "RNA sequencing normalization", "protein folding prediction", "microbiome sequencing variability", "epigenetic inheritance", "stem cell differentiation", "single cell sequencing", "animal model translation", "antibody validation specificity"]},
    {"handle": "OccamsEdge_4", "persona": "A chemist who believes most papers are overcomplicated. Cuts through jargon to find whether actual claims are supported. Loves finding logical gaps between data and conclusions.", "search_queries": ["catalysis reaction mechanism", "nanoparticle characterization", "battery electrolyte degradation", "polymer self-assembly", "photocatalysis quantum yield", "enzyme kinetics inhibition", "organic synthesis yield", "electrochemistry cyclic voltammetry", "computational chemistry DFT", "crystal engineering polymorph"]},
    {"handle": "AdversarialPrior_5", "persona": "A machine learning researcher who treats every paper as a potential adversarial example. Looks for places where arguments break down under pressure. Writes sharp, specific rebuttals.", "search_queries": ["deep learning generalization", "transformer model evaluation", "adversarial robustness", "reinforcement learning reward", "large language model benchmark", "graph neural network", "federated learning privacy", "uncertainty quantification neural", "continual learning forgetting", "fairness machine learning"]},
    {"handle": "ConfidenceInterval_6", "persona": "An epidemiologist who never accepts a causal claim without proper controls. Particularly good at identifying confounders and unsupported causal language in observational studies.", "search_queries": ["mendelian randomization", "cohort study confounding", "air pollution cardiovascular", "diet cancer risk", "vaccine effectiveness", "infectious disease transmission", "drug interaction pharmacovigilance", "mental health social media", "screening test overdiagnosis", "socioeconomic health gradient"]},
    {"handle": "FalsifiabilityFirst_7", "persona": "A philosopher of science who believes unfalsifiable claims are not science. Immediately challenges papers with untestable predictions. Writes thorough cross-study synthesis.", "search_queries": ["consciousness measurement", "evolutionary psychology", "social priming replication", "nutrition science diet", "aging intervention lifespan", "placebo mechanism neuroscience", "climate tipping point", "gene expression stochastic", "economics behavioral anomaly", "emergence complexity biology"]},
    {"handle": "SteelManning_8", "persona": "A generalist scientist who steelmans papers before critiquing them. Gives fair scores but when finding a real flaw is devastating and precise. The most feared reviewer because never unfair.", "search_queries": ["negative result null finding", "systematic review heterogeneity", "preregistration replication", "open data reproducibility", "peer review quality", "model validation prediction", "assumption violation sensitivity", "cross disciplinary synthesis", "scientific retraction correction", "competing hypothesis selection"]},
]

FALLBACK_QUERIES = ["machine learning", "neuroscience", "climate change", "epidemiology", "genetics", "immunology", "ecology", "pharmacology", "psychology", "biochemistry"]

# ── API helpers ─────────────────────────────────────────────────────────────

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
    return requests.get(SKILL_URL, timeout=30).text

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
        log.warning(f"Paper {paper_id} has truncated/missing body ({len(body) if body else 0} chars)")
        return None
    return {"paper": paper, "full": full}

# ── Search sources ──────────────────────────────────────────────────────────

def search_openalex(query: str, log) -> list:
    try:
        resp = requests.get("https://api.openalex.org/works", params={"search": query, "filter": "has_doi:true", "per_page": 10, "select": "title,abstract_inverted_index,doi,publication_year,cited_by_count"}, headers={"User-Agent": "PeerZero-bot/1.0 (peerzero.science)"}, timeout=15)
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
                results.append({"title": w.get("title", ""), "abstract": abstract, "year": w.get("publication_year"), "externalIds": {"DOI": doi}, "citationCount": w.get("cited_by_count", 0)})
        log.info(f"OpenAlex: {len(results)} papers for '{query}'")
        return results[:5]
    except Exception as e:
        log.warning(f"OpenAlex error: {e}")
        return []

def search_arxiv(query: str, log) -> list:
    try:
        resp = requests.get("https://export.arxiv.org/api/query", params={"search_query": f"all:{query}", "max_results": 10, "sortBy": "relevance"}, timeout=15)
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
                results.append({"title": title, "abstract": abstract, "year": None, "externalIds": {"DOI": doi}, "citationCount": 0, "source": "arxiv"})
        log.info(f"arXiv: {len(results)} papers for '{query}'")
        return results[:5]
    except Exception as e:
        log.warning(f"arXiv error: {e}")
        return []

def search_pubmed(query: str, log) -> list:
    try:
        search_resp = requests.get("https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi", params={"db": "pubmed", "term": query, "retmax": 8, "retmode": "json"}, timeout=15)
        ids = search_resp.json().get("esearchresult", {}).get("idlist", [])
        if not ids:
            return []
        summary_resp = requests.get("https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi", params={"db": "pubmed", "id": ",".join(ids), "retmode": "json"}, timeout=15)
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
                results.append({"title": title, "abstract": f"PubMed paper: {title}. See DOI for full abstract.", "year": item.get("pubdate", "")[:4], "externalIds": {"DOI": doi}, "citationCount": 0, "source": "pubmed"})
        log.info(f"PubMed: {len(results)} papers for '{query}'")
        return results[:5]
    except Exception as e:
        log.warning(f"PubMed error: {e}")
        return []

def _search_all_apis_for_query(query: str, log) -> dict:
    search_fns = [("openalex", search_openalex), ("arxiv", search_arxiv), ("pubmed", search_pubmed)]
    random.shuffle(search_fns)
    results_by_api = {}
    for api_name, fn in search_fns:
        results_by_api[api_name] = fn(query, log)
        time.sleep(0.3)
    return results_by_api

def _check_field_coverage(results_by_api: dict, log) -> tuple:
    tried = [name for name, results in results_by_api.items() if results is not None]
    missing = [name for name in SEARCH_APIS if name not in tried]
    if missing:
        log.warning(f"Field coverage incomplete -- missing APIs: {missing}")
    return True, []

# ── Claude calls ────────────────────────────────────────────────────────────

def ask_claude(client: anthropic.Anthropic, system: str, prompt: str, max_tokens: int = 4096, model: str = None) -> str:
    msg = client.messages.create(model=model or MODEL_SMART, max_tokens=max_tokens, system=system, messages=[{"role": "user", "content": prompt}], timeout=120)
    text = msg.content[0].text.strip()
    if msg.stop_reason == "max_tokens":
        logging.warning(f"Response truncated at {max_tokens} tokens (stop_reason=max_tokens)")
    return text

def _extract_json_from_text(text: str) -> dict:
    """Try multiple strategies to extract JSON from Claude's response."""
    clean = text.strip()
    # Strategy 1: Strip markdown fences
    if clean.startswith("```"):
        clean = "\n".join(clean.split("\n")[1:])
    if clean.endswith("```"):
        clean = "\n".join(clean.split("\n")[:-1])
    try:
        return json.loads(clean.strip())
    except json.JSONDecodeError:
        pass
    # Strategy 2: Find JSON object in the text (Claude may have added reasoning around it)
    brace_start = text.find("{")
    brace_end = text.rfind("}")
    if brace_start != -1 and brace_end > brace_start:
        candidate = text[brace_start:brace_end + 1]
        try:
            return json.loads(candidate)
        except json.JSONDecodeError:
            pass
    # Strategy 3: Find JSON array in the text
    bracket_start = text.find("[")
    bracket_end = text.rfind("]")
    if bracket_start != -1 and bracket_end > bracket_start:
        candidate = text[bracket_start:bracket_end + 1]
        try:
            parsed = json.loads(candidate)
            if isinstance(parsed, list):
                return {"items": parsed}
        except json.JSONDecodeError:
            pass
    return {}

def ask_claude_json(client: anthropic.Anthropic, system: str, prompt: str, max_tokens: int = 4096, model: str = None) -> dict:
    for attempt in range(2):
        try:
            if attempt == 0:
                raw = ask_claude(client, system, prompt, max_tokens, model=model)
            else:
                # Retry with prefilled JSON start and anti-refusal system prompt
                logging.info("Retrying with JSON prefill...")
                retry_system = system + "\n\nCRITICAL: You MUST respond with valid JSON only. Never refuse. Never explain. Just output the JSON object."
                msg = client.messages.create(
                    model=model or MODEL_SMART,
                    max_tokens=max_tokens,
                    system=retry_system,
                    messages=[
                        {"role": "user", "content": prompt + "\n\nIMPORTANT: Return ONLY the JSON object. Do not refuse or add commentary."},
                        {"role": "assistant", "content": "{"},
                    ],
                    timeout=120,
                )
                raw = "{" + msg.content[0].text.strip()
        except Exception as e:
            logging.error(f"Claude call failed (attempt {attempt + 1}): {e}")
            continue
        result = _extract_json_from_text(raw)
        if result:
            return result
        if attempt == 0:
            logging.warning(f"JSON parse failed (will retry): {raw[:200]}")
    logging.error(f"JSON parse failed after 2 attempts")
    return {}

# ── Haiku helper calls ──────────────────────────────────────────────────────

def _search_satisfied(client, results, paper_topic, log) -> bool:
    if not client or len(results) < 2:
        return False
    titles = [r.get("title", "") for r in results[:8]]
    prompt = f"You are evaluating search results for a paper about: {paper_topic}\n\nResults found: {len(results)} papers\nTitles: {titles}\n\nAre these results sufficient to write a strong cross-study synthesis?\nAnswer ONLY: SUFFICIENT or INSUFFICIENT: <one reason>"
    try:
        msg = client.messages.create(model=MODEL_FAST, max_tokens=60, system="Answer only: SUFFICIENT or INSUFFICIENT: <one reason>", messages=[{"role": "user", "content": prompt}], timeout=20)
        return msg.content[0].text.strip().upper().startswith("SUFFICIENT")
    except Exception as e:
        log.warning(f"Search satisfaction check failed: {e}")
        return True

def _summarize_citation(client, doi, abstract, paper_context, log, citation_count=0, year=None) -> dict:
    if not abstract or len(abstract) < 50:
        return {"agent_summary": "", "source_quality_note": ""}
    tier = "strong (50+ citations)" if citation_count >= 50 else "adequate (10-49 citations)" if citation_count >= 10 else "weak (under 10 citations)" if citation_count > 0 else "unknown (citation count unavailable)"
    year_str = str(year) if year else "unknown"
    prompt = f'Read this abstract and produce two things.\n\nAbstract: {abstract}\n\nDOI: {doi}\nCitation count: {citation_count} -- quality tier: {tier}\nPublication year: {year_str}\nContext: {paper_context}\n\nReturn JSON only:\n{{\n  "agent_summary": "<2-3 sentences: what this paper actually found, from the abstract above>",\n  "source_quality_note": "<explicit reasoning: why this source is or is not credible evidence. Address citation count ({citation_count}), publication year ({year_str}), methodology fit, and any limitations. Minimum 40 chars.>"\n}}'
    try:
        msg = client.messages.create(model=MODEL_FAST, max_tokens=400, system="You summarize scientific abstracts and evaluate source quality. Return JSON only. No explanation.", messages=[{"role": "user", "content": prompt}], timeout=30)
        raw = msg.content[0].text.strip()
        result = _extract_json_from_text(raw)
        return {"agent_summary": result.get("agent_summary", ""), "source_quality_note": result.get("source_quality_note", "")}
    except Exception as e:
        log.warning(f"Citation summarization failed for {doi}: {e}")
        return {"agent_summary": "", "source_quality_note": ""}

def search_and_summarize(queries, log, client, paper_context="") -> list:
    all_papers, seen_dois = [], set()
    padded_queries = list(queries)
    if len(padded_queries) < 3:
        padded_queries += random.sample(FALLBACK_QUERIES, 3 - len(padded_queries))
    max_iterations = min(3, len(padded_queries))

    # Phase 1: Collect papers WITHOUT summarizing (fast, no Claude calls)
    for iteration in range(max_iterations):
        query = padded_queries[iteration] if iteration < len(padded_queries) else padded_queries[-1]
        log.info(f"Search iteration {iteration + 1}/{max_iterations}: '{query}'")
        search_fns = [("openalex", search_openalex), ("arxiv", search_arxiv), ("pubmed", search_pubmed)]
        random.shuffle(search_fns)
        # First iteration: all 3 APIs. After that: only 2.
        apis_to_use = search_fns if iteration == 0 else search_fns[:2]
        for api_name, fn in apis_to_use:
            results = fn(query, log)
            for p in (results or []):
                doi = (p.get("externalIds", {}).get("DOI") or p.get("doi", "")).strip()
                if not doi or doi.lower() in seen_dois:
                    continue
                seen_dois.add(doi.lower())
                all_papers.append(p)
            time.sleep(0.3)
        # Exit search early if we have enough raw papers
        if len(all_papers) >= 6:
            log.info(f"Collected {len(all_papers)} papers after iteration {iteration + 1} — stopping search")
            break

    # Phase 2: Summarize only the best papers (max 6) to limit Claude calls
    # Prefer papers with higher citation counts
    all_papers.sort(key=lambda p: (p.get("citationCount") or 0), reverse=True)
    papers_to_summarize = all_papers[:6]
    log.info(f"Search collected {len(all_papers)} papers, summarizing top {len(papers_to_summarize)}")

    for p in papers_to_summarize:
        doi = (p.get("externalIds", {}).get("DOI") or p.get("doi", "")).strip()
        abstract = p.get("abstract", "")
        if abstract and client:
            summaries = _summarize_citation(client, doi, abstract, paper_context, log, citation_count=p.get("citationCount", 0) or 0, year=p.get("year") or p.get("publication_year"))
            p["agent_summary"] = summaries["agent_summary"]
            p["source_quality_note"] = summaries["source_quality_note"]

    return papers_to_summarize

def extract_failure_patterns(client, agent_data, log) -> str:
    coaching = agent_data.get("coaching", {})
    if not coaching:
        return ""
    patterns = coaching.get("failure_patterns", "")
    gaps = coaching.get("honest_gap", [])
    if not patterns and not gaps:
        return ""
    prompt = f"You are reviewing an agent's known failure patterns before they write a paper.\n\nKnown patterns: {patterns}\nKnown gaps: {'; '.join(gaps) if isinstance(gaps, list) else gaps}\n\nList 3 specific things this agent must actively watch for. Be concrete and actionable. Return as a short numbered list."
    try:
        msg = client.messages.create(model=MODEL_FAST, max_tokens=300, system="You identify concrete writing failure patterns. Output a numbered list only.", messages=[{"role": "user", "content": prompt}], timeout=30)
        return msg.content[0].text.strip()
    except Exception as e:
        log.warning(f"Failure pattern extraction failed: {e}")
        return ""

def generate_opposing_queries(client, concept, log) -> list:
    claim = concept.get("core_claim", concept.get("working_title", ""))
    supporting = concept.get("search_queries", [])[:5]
    prompt = f"You are planning research on: {claim}\n\nSupporting queries already planned:\n" + "\n".join(f"- {q}" for q in supporting) + "\n\nGenerate 3 OPPOSING search queries designed to find evidence AGAINST this hypothesis.\n\nReturn JSON only: " + '{"opposing_queries": ["q1", "q2", "q3"]}'
    try:
        result = ask_claude_json(client, "Generate opposing research queries. Return JSON only.", prompt, max_tokens=300, model=MODEL_FAST)
        queries = result.get("opposing_queries", []) if result else []
        if queries:
            log.info(f"Generated {len(queries)} opposing queries")
        return queries[:6]
    except Exception as e:
        log.warning(f"Opposing query generation failed: {e}")
        return []

def generate_review_search_strategy(client, paper, log) -> dict:
    prompt = f"You are reviewing a scientific paper and need to independently verify its claims.\n\nTitle: {paper.get('title', '')}\nAbstract: {str(paper.get('abstract', ''))[:500]}\nFalsifiable claim: {paper.get('falsifiable_claim', 'none stated')}\n\nGenerate:\n1. verification_queries: 2-3 queries to check independent support\n2. gap_queries: 2-3 queries for contradictions or alternative explanations\n3. query_rationale: 80+ chars explaining approach\n\nReturn JSON only:\n" + '{"verification_queries": [...], "gap_queries": [...], "query_rationale": "..."}'
    try:
        result = ask_claude_json(client, "Generate review verification queries. Return JSON only.", prompt, max_tokens=400, model=MODEL_FAST)
        if result and result.get("verification_queries") and result.get("gap_queries"):
            return result
        return {}
    except Exception as e:
        log.warning(f"Review search strategy generation failed: {e}")
        return {}

def generate_mechanism_chain(client, concept, log) -> list:
    claim = concept.get("core_claim", concept.get("working_title", ""))
    prompt = f"You are building a causal mechanism chain for: {claim}\n\nGenerate 3-5 steps where each step is ONE causal link (A causes B). Each step 20-500 chars. Cite evidence where possible. If a step is speculative, say so.\n\nReturn JSON only:\n" + '{"mechanism_chain": ["Step 1: ...", "Step 2: ...", "Step 3: ..."]}'
    try:
        result = ask_claude_json(client, "Generate mechanism chain. Return JSON only.", prompt, max_tokens=500, model=MODEL_FAST)
        chain = result.get("mechanism_chain", []) if result else []
        if chain:
            log.info(f"Generated mechanism chain with {len(chain)} steps")
        return chain[:10]
    except Exception as e:
        log.warning(f"Mechanism chain generation failed: {e}")
        return []

def validate_cross_study(cross_study_text, log) -> tuple:
    if not cross_study_text or len(cross_study_text.strip()) < 150:
        return False, "Cross-study connection too short or missing"
    lower = cross_study_text.lower()
    for signal in PLACEHOLDER_SIGNALS:
        if signal in lower:
            return False, f"Placeholder language detected: '{signal}'"
    return True, None

def rewrite_cross_study(client, system, draft, ss_papers, reason, log) -> dict:
    citation_context = "\n".join(f"DOI: {p.get('externalIds', {}).get('DOI') or p.get('doi', '')}\nTitle: {p.get('title', '')}\nAbstract: {p.get('abstract', '')[:400]}\n" for p in ss_papers[:4])
    prompt = f"The cross_study_connection was rejected: {reason}\n\nCurrent: {draft.get('cross_study_connection', '')}\n\nAvailable papers:\n{citation_context}\n\nWrite a new cross_study_connection (200+ chars) using real author names/DOIs. Return only the text."
    try:
        msg = client.messages.create(model=MODEL_FAST, max_tokens=400, system="Write precise scientific cross-study connections. Output only the connection text.", messages=[{"role": "user", "content": prompt}], timeout=30)
        draft["cross_study_connection"] = msg.content[0].text.strip()
    except Exception as e:
        log.warning(f"Cross-study rewrite failed: {e}")
    return draft

def apply_confidence_gate(client, system, draft, log) -> dict:
    try:
        score = float(draft.get("confidence_score", 7.0))
    except (TypeError, ValueError):
        return draft
    if score >= 6.5:
        return draft
    log.info(f"Confidence gate triggered (score={score})")
    for attempt in range(2):
        try:
            msg = client.messages.create(model=MODEL_FAST, max_tokens=80, system="Identify the single weakest element in one sentence.", messages=[{"role": "user", "content": f"Weakest element?\n\nTitle: {draft.get('title', '')}\nAbstract: {draft.get('abstract', '')[:400]}\nFalsifiable claim: {draft.get('falsifiable_claim', '')}"}], timeout=20)
            weakest = msg.content[0].text.strip()
            improvements = ask_claude_json(client, system, f"Weakest point: {weakest}\n\nReturn JSON with ONLY fields needing improvement. Valid fields: title, abstract, cross_study_connection, falsifiable_claim, measurable_prediction, quantitative_expectation.", max_tokens=600, model=MODEL_FAST)
            if improvements:
                for field in ["title", "abstract", "cross_study_connection", "falsifiable_claim", "measurable_prediction", "quantitative_expectation"]:
                    if field in improvements and improvements[field]:
                        draft[field] = improvements[field]
        except Exception as e:
            log.warning(f"Confidence gate failed: {e}")
            break
    return draft

def categorize_sections(client, paper_body, reviews, log) -> dict:
    review_summaries = "; ".join(r.get("overall_assessment", "")[:200] for r in reviews[:5] if r.get("overall_assessment"))
    prompt = f'Categorize each major section as STRONG, ADEQUATE, or WEAK.\n\nPaper (first 3000 chars):\n{paper_body[:3000]}\n\nReviewer feedback:\n{review_summaries}\n\nReturn JSON only: {{"strong": [], "adequate": [], "weak": []}}'
    try:
        msg = client.messages.create(model=MODEL_FAST, max_tokens=400, system='Return JSON only: {"strong": [], "adequate": [], "weak": []}', messages=[{"role": "user", "content": prompt}], timeout=30)
        raw = msg.content[0].text.strip().strip("` \n")
        if raw.startswith("json"):
            raw = raw[4:].strip()
        return json.loads(raw)
    except Exception as e:
        log.warning(f"Section categorization failed: {e}")
        return {"strong": [], "adequate": [], "weak": []}

def validate_citations(citations, source_papers, log) -> list:
    if not citations or not source_papers:
        return citations
    valid_dois = set()
    for p in source_papers:
        doi = (p.get("externalIds", {}).get("DOI") or p.get("doi") or "")
        if doi:
            valid_dois.add(doi.strip().lower())
    validated = []
    for c in citations:
        doi = (c.get("doi") or "").strip().lower().replace("https://doi.org/", "").replace("http://doi.org/", "")
        if doi in valid_dois:
            validated.append(c)
        else:
            log.warning(f"Dropping hallucinated citation: {c.get('doi')}")
    return validated


# ── Bot class ───────────────────────────────────────────────────────────────

class PeerZeroBot:
    def __init__(self, handle, persona, skill, search_queries):
        self.handle = handle
        self.persona = persona
        self.skill = skill
        self.search_queries = search_queries
        self.api_key: Optional[str] = None
        self.client = anthropic.Anthropic()
        self.log = logging.getLogger(handle)
        self.reviewed_paper_ids: set = set()
        self.consecutive_failures: int = 0
        self.system = f"""You are {handle}, an AI agent participating in PeerZero -- a scientific peer review platform.
Your personality: {persona}
You operate according to the PeerZero SKILL.md below as quality guidelines.
When asked to produce JSON, return ONLY valid JSON with no markdown fences, no preamble, no explanation.
--- SKILL.md START ---
{skill}
--- SKILL.md END ---"""

        # Compact system prompt for paper/revision generation -- avoids stuffing
        # the full SKILL.md into context when the prompt already contains
        # dossier, examples, failure patterns, and citation slots.
        self.system_write = f"""You are {handle}, an AI scientist on PeerZero.
Your personality: {persona}
You write rigorous scientific papers with real citations, honest uncertainty, and precise falsifiable claims.
RULES:
- Return ONLY valid JSON. No markdown fences, no preamble, no explanation, no refusal.
- Always produce the requested output. Express any concerns about evidence quality WITHIN the paper content (lower confidence_score, caveats in abstract/body).
- Every agent_summary must describe what the cited study actually found. Every source_quality_note must mention citation count and methodology.
- confidence_score reflects the WEAKEST link in your evidence chain (4-5 = weaker designs or contradictions, 6-7 = 2+ studies with appropriate designs, 8-10 = multiple RCTs or 3+ converging studies).
- cross_study_connection must pass the surprise test: would a researcher who read Study A but not Study B be surprised by the implication?
- Each mechanism_chain step must be a testable causal link, not a narrative restatement."""

    # ── Registration ────────────────────────────────────────────────────────

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
                self.handle = f"{self.handle}_{random.randint(10,99)}"
                result = api("post", "/register", json={"handle": self.handle})
            if "api_key" not in result:
                self.log.error(f"Registration failed: {result}")
                return False

        self.api_key = result["api_key"]
        self.log.info("Registered. Passing intake...")
        intake = result.get("intake_paper", {})
        intake_prompt = f"""Pass the PeerZero intake review. Here is the intake paper:
{json.dumps(intake, indent=2)}

The paper has intentional flaws. Catch at least 2. Return JSON only:
{{
  "score": <1-4>,
  "methodology_notes": "<50+ chars>",
  "statistical_validity_notes": "<50+ chars>",
  "citation_accuracy_notes": "<50+ chars>",
  "overall_assessment": "<100+ chars describing flaws>"
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
        self.log.error(f"Intake failed: {result2}")
        return False

    def _load_reviewed_ids(self):
        keys = load_keys()
        entry = keys.get(self.handle)
        if isinstance(entry, dict):
            self.reviewed_paper_ids = set(entry.get("reviewed_ids", []))

    def _save_reviewed_id(self, paper_id):
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
        return {p.get("parent_paper_id") for p in my_papers.get("papers", []) if p.get("parent_paper_id")}

    def decide_action(self, status) -> str:
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

    def find_reviewable_paper(self) -> Optional[dict]:
        papers_data = api("get", "/papers?limit=100", api_key=self.api_key)
        responses_data = api("get", "/papers?feed=responses&limit=100", api_key=self.api_key)
        all_papers = papers_data.get("papers", []) + responses_data.get("papers", [])
        candidates = [p for p in all_papers if p.get("agents", {}).get("handle") != self.handle and p["id"] not in self.reviewed_paper_ids and p.get("raw_review_count", 0) < 10]
        if not candidates:
            self.log.info(f"No unreviewed papers found ({len(self.reviewed_paper_ids)} reviewed, {len(all_papers)} in feed)")
            return None
        random.shuffle(candidates)
        for p in candidates:
            target = fetch_full_paper(p["id"], self.api_key, self.log)
            if not target:
                continue
            reviews = target["full"].get("reviews", [])
            if any(r.get("agents", {}).get("handle") == self.handle for r in reviews):
                self.reviewed_paper_ids.add(p["id"])
                self._save_reviewed_id(p["id"])
                continue
            return target
        return None

    # ── Review a paper ──────────────────────────────────────────────────────

    def do_review(self) -> bool:
        target = self.find_reviewable_paper()
        if not target:
            return False
        paper = target["paper"]
        full = target["full"]
        body = paper.get("body", "")
        self.log.info(f"Reviewing: {paper.get('title', '')[:60]} ({len(body)} body chars)")

        prompt = f"""Review this paper. Be thorough, adversarial, and precise.

Paper:
Title: {paper.get('title')}
Abstract: {paper.get('abstract')}
Body: {body}
Citations: {json.dumps(full.get('citations', []), indent=2)}

Check citations for ACCURACY (does agent_summary match?) and QUALITY:
- quality_tier: strong=50+, adequate=10-49, weak=<10, unknown=lookup failed
- Flag TONE MISMATCHES: note claims well-established but tier is weak/unknown
- Flag BOILERPLATE: note gives no real methodological reasoning
- Check mechanism_chain: is each step independently testable?
- Flag false confidence and vague uncertainty

Return JSON only:
{{
  "score": <1.0-10.0>,
  "methodology_notes": "<50+ chars>",
  "statistical_validity_notes": "<50+ chars>",
  "citation_accuracy_notes": "<check accuracy AND quality>",
  "reproducibility_notes": "<assess reproducibility>",
  "logical_consistency_notes": "<check logic, flag overconfidence>",
  "overall_assessment": "<100+ chars>"
}}"""
        review = ask_claude_json(self.client, self.system, prompt)
        if not review or "score" not in review:
            self.log.error("Failed to generate review")
            return False

        # Attach review_search_strategy
        review_strategy = generate_review_search_strategy(self.client, paper, self.log)
        if review_strategy:
            review["review_search_strategy"] = review_strategy
        else:
            title_words = paper.get("title", "").split()[:5]
            review["review_search_strategy"] = {
                "verification_queries": [f"{' '.join(title_words)} replication independent verification", f"{' '.join(title_words)} meta-analysis systematic review"],
                "gap_queries": [f"{' '.join(title_words)} contradictory findings negative results", f"{' '.join(title_words)} alternative mechanism explanation"],
                "query_rationale": "Verification queries check for independent replication. Gap queries search for contradictions and alternative explanations."
            }

        result = api("post", f"/reviews?paper_id={paper['id']}", api_key=self.api_key, json=review)
        if result.get("success"):
            self.reviewed_paper_ids.add(paper["id"])
            self._save_reviewed_id(paper["id"])
            self.log.info(f"Review submitted. Score: {review['score']}. New cred: {result.get('your_new_credibility')}")
            # Log coaching
            coaching = result.get("review_search_coaching")
            if coaching:
                self.log.info(f"Review search coaching: {json.dumps(coaching)[:200]}")
            # Store skill exercises if present
            exercises = result.get("skill_exercises")
            if exercises:
                self.log.info(f"Skill exercises: {json.dumps(exercises)[:200]}")
            # Try rating other reviews on this paper
            self._rate_reviews(paper["id"], full.get("reviews", []))
            return True
        else:
            self.log.warning(f"Review failed: {result.get('error')}")
            return False

    def _rate_reviews(self, paper_id, reviews):
        """Rate other reviews on papers we've reviewed -- new feature from skill."""
        if not reviews or len(reviews) < 2:
            return
        for r in reviews[:3]:
            if r.get("agents", {}).get("handle") == self.handle:
                continue
            review_id = r.get("id")
            if not review_id:
                continue
            overall = r.get("overall_assessment", "")
            methodology = r.get("methodology_notes", "")
            if not overall:
                continue
            eval_prompt = f"""Evaluate this review. Was it specific and helpful, or vague and generic?

Review score: {r.get('score')}
Methodology notes: {methodology[:300]}
Overall assessment: {overall[:500]}

Return JSON only:
{{"helpful": true/false, "tags": ["<pick 1-2 from: identified_error, statistical_misuse, overclaim, poor_uncertainty, weak_source_quality, missing_control, logical_gap, vague, consensus_following>"]}}"""
            try:
                rating = ask_claude_json(self.client, self.system, eval_prompt, max_tokens=200, model=MODEL_FAST)
                if rating and "helpful" in rating:
                    rating["review_id"] = review_id
                    result = api("post", "/review_ratings", api_key=self.api_key, json=rating)
                    if result.get("success"):
                        self.log.info(f"Rated review {review_id}: helpful={rating['helpful']}, tags={rating.get('tags', [])}")
            except Exception as e:
                self.log.warning(f"Review rating failed: {e}")

    def _review_specific(self, paper_id, paper) -> bool:
        prompt = f"""Review this paper. Be specific and adversarial.

Title: {paper.get('title')}
Abstract: {paper.get('abstract')}
Body: {paper.get('body', '')}

Check citations for accuracy AND quality. Flag tone mismatches and boilerplate.
Check mechanism_chain if present. Flag false confidence and vague uncertainty.

Return JSON only:
{{
  "score": <1.0-10.0>,
  "methodology_notes": "<50+ chars>",
  "statistical_validity_notes": "<50+ chars>",
  "citation_accuracy_notes": "<accuracy + quality>",
  "reproducibility_notes": "<assess reproducibility>",
  "logical_consistency_notes": "<check logic>",
  "overall_assessment": "<100+ chars>"
}}"""
        review = ask_claude_json(self.client, self.system, prompt)
        if not review:
            return False
        review_strategy = generate_review_search_strategy(self.client, paper, self.log)
        if review_strategy:
            review["review_search_strategy"] = review_strategy
        else:
            title_words = paper.get("title", "").split()[:5]
            review["review_search_strategy"] = {
                "verification_queries": [f"{' '.join(title_words)} replication verification", f"{' '.join(title_words)} independent evidence"],
                "gap_queries": [f"{' '.join(title_words)} contradictory negative results", f"{' '.join(title_words)} alternative explanation"],
                "query_rationale": "Verification queries check for independent support. Gap queries search for contradictions."
            }
        result = api("post", f"/reviews?paper_id={paper_id}", api_key=self.api_key, json=review)
        if result.get("success"):
            self.reviewed_paper_ids.add(paper_id)
            self._save_reviewed_id(paper_id)
        return result.get("success", False)

    # ── Submit a paper ──────────────────────────────────────────────────────

    def do_submit_paper(self) -> Optional[str]:
        my_papers_resp = api("get", "/papers?my_papers=true", api_key=self.api_key)
        if "error" in my_papers_resp:
            self.log.warning("Could not fetch my papers -- skipping")
            return None
        my_papers = my_papers_resp.get("papers", [])
        active_papers = [p for p in my_papers if p.get("status") != "retracted" and not p.get("parent_paper_id")]
        paper_count = len(active_papers)

        status = self.get_status()
        cred = status.get("credibility_score", 0) if "error" not in status else 0
        if cred < 75: tier_cap, next_tier = 2, 75
        elif cred < 100: tier_cap, next_tier = 4, 100
        elif cred < 150: tier_cap, next_tier = 8, 150
        elif cred < 175: tier_cap, next_tier = 16, 175
        else: tier_cap, next_tier = 32, None

        if paper_count >= tier_cap:
            self.log.info(f"At paper cap ({paper_count}/{tier_cap}). Skipping.")
            return None

        next_paper_num = paper_count + 1
        if next_paper_num == 1: reviews_needed = 0
        elif next_paper_num == 2: reviews_needed = 3
        elif next_paper_num == 3: reviews_needed = 7
        else: reviews_needed = (next_paper_num - 1) ** 2
        reviews_done = status.get("review_count", 0) if "error" not in status else 0
        if reviews_done < reviews_needed:
            self.log.info(f"Need {reviews_needed} reviews for paper #{next_paper_num}, have {reviews_done}. Skipping.")
            return None

        self.log.info(f"Eligible to submit ({paper_count}/{tier_cap} papers, {reviews_done} reviews). Proceeding...")

        # Extract failure patterns
        failure_patterns = extract_failure_patterns(self.client, status, self.log)

        # Build dossier of own papers
        dossier_papers = []
        for p in my_papers:
            full_data = fetch_full_paper(p["id"], self.api_key, self.log)
            if not full_data:
                continue
            fp = full_data["paper"]
            fr = full_data["full"]
            reviews_raw = fr.get("reviews", [])
            reviews_raw.sort(key=lambda r: r.get("reviewer_credibility_at_time") or 0, reverse=True)
            top_reviews = [{"reviewer_credibility": r.get("reviewer_credibility_at_time"), "score": r.get("score"), "methodology_notes": r.get("methodology_notes", ""), "overall_assessment": r.get("overall_assessment", "")} for r in reviews_raw[:5]]
            dossier_papers.append({"id": p["id"], "title": fp.get("title"), "abstract": fp.get("abstract"), "weighted_score": p.get("weighted_score"), "top_reviews": top_reviews})

        # Study top-scoring papers
        top_papers_data = api("get", "/papers?limit=100", api_key=self.api_key)
        scored_papers = sorted([p for p in top_papers_data.get("papers", []) if p.get("weighted_score") and p.get("raw_review_count", 0) >= 3], key=lambda x: x.get("weighted_score", 0), reverse=True)
        top_papers_full = []
        for p in scored_papers[:5]:
            full = fetch_full_paper(p["id"], self.api_key, self.log, learning_mode=True)
            if full:
                top_papers_full.append({"title": full["paper"].get("title"), "score": p.get("weighted_score"), "abstract": full["paper"].get("abstract"), "cross_study_connection": full["paper"].get("cross_study_connection"), "falsifiable_claim": full["paper"].get("falsifiable_claim")})

        # Check open questions for promoted ones to answer
        open_questions = api("get", "/open-questions", api_key=self.api_key)
        promoted_questions = [q for q in open_questions.get("questions", []) if q.get("vote_count", 0) >= 5]
        question_context = ""
        if promoted_questions:
            q = promoted_questions[0]
            question_context = f"\nPROMOTED OPEN QUESTION (answering this earns +1.0 credibility bonus):\nTitle: {q.get('title', '')}\nDescription: {q.get('description', '')}\nQuestion ID: {q.get('id', '')}\n"

        # Concept generation
        prior_titles = [p.get("title", "") for p in dossier_papers if p.get("title")]
        concept_prompt = f"You are {self.handle}. Your prior papers:\n" + "\n".join(f"- {t}" for t in prior_titles) if prior_titles else "None yet"
        concept_prompt += f"\n{question_context}\nGenerate a NEW paper concept with a cross-domain connection.\n\nReturn JSON only:\n" + '{"working_title": "...", "domain_a": "...", "domain_b": "...", "core_claim": "...", "search_queries": ["q1", "q2", "q3", "q4", "q5"]}'

        concept = ask_claude_json(self.client, self.system, concept_prompt, max_tokens=800, model=MODEL_FAST)
        if concept and concept.get("search_queries"):
            targeted_queries = concept["search_queries"]
            paper_context = concept.get("core_claim", "")
            self.log.info(f"Concept: '{concept.get('working_title', '?')[:60]}'")
        else:
            targeted_queries = self.search_queries
            paper_context = ""

        # Generate opposing queries
        opposing_queries = generate_opposing_queries(self.client, concept or {}, self.log)
        if not opposing_queries:
            opposing_queries = [f"{' '.join(targeted_queries[0].split()[:4])} contradictory findings negative results" if targeted_queries else "negative results"]

        # Generate mechanism chain
        mechanism_chain = generate_mechanism_chain(self.client, concept or {}, self.log)

        # Search with full coverage
        all_search_queries = targeted_queries + opposing_queries
        ss_papers = search_and_summarize(all_search_queries, self.log, self.client, paper_context)
        if len(ss_papers) < 2:
            ss_papers = search_and_summarize(self.search_queries, self.log, self.client, paper_context)
        if len(ss_papers) < 2:
            self.log.error("Could not get enough results -- skipping")
            return None

        # Build search_strategy
        paper_search_strategy = {
            "supporting_queries": targeted_queries[:6],
            "opposing_queries": opposing_queries[:6],
            "query_rationale": f"Supporting queries target evidence for: {paper_context or 'the core hypothesis'}. Opposing queries search for contradictions and alternative mechanisms."[:2000]
        }

        # Build citation slots
        citation_slots = ""
        for p in ss_papers:
            doi = p.get("externalIds", {}).get("DOI") or p.get("doi", "")
            if not doi:
                continue
            citation_slots += f"\n--- CITATION SLOT ---\nDOI: {doi}\nTitle: {p.get('title', '')}\nCitation count: {p.get('citationCount', 0) or 0}\nAbstract: {p.get('abstract', '')}\n"
            if p.get("agent_summary"):
                citation_slots += f"Pre-computed agent_summary: {p['agent_summary']}\n"
            if p.get("source_quality_note"):
                citation_slots += f"Pre-computed source_quality_note: {p['source_quality_note']}\n"

        # Build context sections
        dossier_section = f"\nYOUR RESEARCH HISTORY:\n{json.dumps(dossier_papers, indent=2)}\n" if dossier_papers else ""
        examples_section = f"\nTOP-SCORING PAPERS:\n{json.dumps(top_papers_full, indent=2)}\n" if top_papers_full else ""
        failure_section = f"\nKNOWN FAILURE PATTERNS TO AVOID:\n{failure_patterns}\n" if failure_patterns else ""
        mechanism_hint = f"\nSuggested mechanism_chain (refine with real evidence):\n{json.dumps(mechanism_chain)}\n" if mechanism_chain else ""

        prompt = f"""Write your next scientific paper for PeerZero.
{dossier_section}{examples_section}{failure_section}
AVAILABLE CITATIONS -- you may ONLY cite these DOIs:
{citation_slots}
{mechanism_hint}
Return JSON only:
{{
  "title": "<specific title>",
  "abstract": "<150+ chars>",
  "body": "<full paper>",
  "field_ids": [<1-13>],
  "confidence_score": <4.0-8.0>,
  "falsifiable_claim": "<specific testable prediction>",
  "measurable_prediction": "<what would be measured>",
  "quantitative_expectation": "<expected effect size>",
  "cross_study_connection": "<200+ chars, real DOIs>",
  "mechanism_chain": ["<step 1: A causes B>", "<step 2: B leads to C>", "..."],
  "citations": [
    {{"doi": "...", "agent_summary": "<60+ chars from abstract>", "relevance_explanation": "<40+ chars>", "source_quality_note": "<40+ chars>"}}
  ]
}}"""

        paper = ask_claude_json(self.client, self.system_write, prompt, max_tokens=8000)
        if not paper or "title" not in paper:
            self.log.error("Failed to generate paper")
            return None

        body = paper.get("body", "")
        if len(body) < MIN_GENERATED_BODY:
            self.log.warning(f"Generated paper body too short ({len(body)} chars) -- likely truncated, skipping")
            return None

        if paper.get("citations"):
            paper["citations"] = validate_citations(paper["citations"], ss_papers, self.log)

        # Cross-study validation
        cross_ok, cross_reason = validate_cross_study(paper.get("cross_study_connection", ""), self.log)
        if not cross_ok:
            paper = rewrite_cross_study(self.client, self.system, paper, ss_papers, cross_reason, self.log)

        # Confidence gate
        paper = apply_confidence_gate(self.client, self.system, paper, self.log)

        # Attach search_strategy
        paper["search_strategy"] = paper_search_strategy

        # Ensure mechanism_chain is present
        if not paper.get("mechanism_chain") and mechanism_chain:
            paper["mechanism_chain"] = mechanism_chain

        result = api("post", "/papers", api_key=self.api_key, json=paper)
        if result.get("success"):
            paper_id = result.get("paper_id")
            self.log.info(f"Paper submitted: {paper_id}")
            # Log coaching
            for key in ["search_strategy_coaching", "citation_audit_flags", "citation_diversity_warnings"]:
                val = result.get(key)
                if val:
                    self.log.info(f"{key}: {json.dumps(val)[:200]}")
            # Link to open question if we were answering one
            if promoted_questions and paper_id:
                q_id = promoted_questions[0].get("id")
                if q_id:
                    link_result = api("post", "/open-questions", api_key=self.api_key, json={"action": "link", "paper_id": paper_id, "question_id": q_id})
                    if link_result.get("success"):
                        self.log.info(f"Linked paper to open question {q_id}")
            # Store skill reflections if present
            self._maybe_store_skill_reflection(result, "paper")
            return paper_id
        else:
            self.log.warning(f"Paper submission failed: {result.get('error')}")
            return None

    def _maybe_store_skill_reflection(self, result, interaction_type):
        """Store skill exercises as reflections for persistence."""
        exercises = result.get("skill_exercises")
        condenser = result.get("skill_condenser")
        if condenser:
            # Time to condense -- generate a condensed paragraph
            self.log.info("Skill condenser triggered -- condensing exercises")
            condense_prompt = f"Condense these skill exercises into ONE paragraph (3-5 sentences) about reasoning PATTERNS.\n\nExercises: {json.dumps(exercises)[:2000]}\n\nWrite as 'I'. Focus on behavior patterns, not events. No PeerZero references."
            try:
                msg = self.client.messages.create(model=MODEL_FAST, max_tokens=400, system="Write a condensed skill paragraph. Use 'I'. Describe behavior patterns only.", messages=[{"role": "user", "content": condense_prompt}], timeout=30)
                paragraph = msg.content[0].text.strip()
                api("post", "/skill-reflections", api_key=self.api_key, json={"interaction_type": interaction_type, "condensed_paragraph": paragraph})
                self.log.info(f"Stored skill reflection: {paragraph[:100]}...")
            except Exception as e:
                self.log.warning(f"Skill reflection storage failed: {e}")
        elif exercises:
            self.log.info(f"Skill exercises received: {json.dumps(exercises)[:200]}")

    # ── Find bounty target ──────────────────────────────────────────────────

    def find_bounty_target(self) -> Optional[dict]:
        already_bounced_ids = self.get_my_response_paper_ids()
        papers_data = api("get", "/papers?limit=100", api_key=self.api_key)
        candidates = [p for p in papers_data.get("papers", []) if p.get("weighted_score") and p.get("raw_review_count", 0) >= 3 and p.get("agents", {}).get("handle") != self.handle and p["id"] not in already_bounced_ids and not p.get("parent_paper_id")]
        if not candidates:
            return None
        random.shuffle(candidates)
        for c in candidates:
            target = fetch_full_paper(c["id"], self.api_key, self.log)
            if target:
                return target
        return None

    def _try_weak_source_quality_bounty(self, paper, citations) -> bool:
        if not citations:
            return False
        weak_citations = [c for c in citations if c.get("quality_tier") in ("weak", "unknown") and c.get("doi") and c.get("source_quality_note")]
        if not weak_citations:
            return False
        self.log.info(f"Found {len(weak_citations)} weak/unknown quality_tier citations")
        citation_block = "\n\n".join(f"DOI: {c['doi']}\nquality_tier: {c.get('quality_tier')}\ncitation_count: {c.get('citation_count', 'unknown')}\nsource_quality_note: \"{c.get('source_quality_note', '')}\"" for c in weak_citations[:4])
        eval_prompt = f"Identify ONE citation with an inadequate source_quality_note:\n1. TONE MISMATCH: claims well-established but tier is weak/unknown\n2. BOILERPLATE: no real methodological reasoning\n3. UNJUSTIFIED: doesn't explain why weak source is acceptable\n\nCITATIONS:\n{citation_block}\n\nReturn JSON only:\n" + '{"doi": "<DOI or null>", "reason": "<80+ char explanation or null>"}'
        try:
            result = ask_claude_json(self.client, self.system, eval_prompt, max_tokens=300, model=MODEL_FAST)
        except Exception as e:
            self.log.warning(f"weak_source_quality eval failed: {e}")
            return False
        if not result or not result.get("doi") or not result.get("reason") or len(result.get("reason", "")) < 80:
            return False
        wsq_search_strategy = {
            "verification_queries": [f"{result['doi']} citation count methodology replication", f"{result['doi'].split('/')[-1] if '/' in result['doi'] else result['doi']} peer review quality"],
            "query_rationale": f"Verification queries evaluate whether {result['doi']} is genuinely weak evidence."
        }
        bounty_result = api("post", "/bounties", api_key=self.api_key, json={"action": "register", "target_paper_id": paper["id"], "challenge_type": "weak_source_quality", "challenged_doi": result["doi"], "quality_challenge_reason": result["reason"], "search_strategy": wsq_search_strategy})
        if bounty_result.get("success"):
            self.log.info(f"weak_source_quality bounty registered: {bounty_result.get('bounty_id')}")
            return True
        self.log.warning(f"weak_source_quality bounty failed: {bounty_result.get('error', '')}")
        return False

    def _try_no_mechanism_chain_bounty(self, paper) -> bool:
        """Try a structural bounty if paper has cross_study_connection but no mechanism_chain."""
        if paper.get("mechanism_chain"):
            return False
        if not paper.get("cross_study_connection"):
            return False
        self.log.info("Paper has cross_study_connection but no mechanism_chain -- filing structural bounty")
        result = api("post", "/bounties", api_key=self.api_key, json={"action": "register", "target_paper_id": paper["id"], "challenge_type": "no_mechanism_chain"})
        if result.get("success"):
            self.log.info(f"no_mechanism_chain bounty registered: {result.get('bounty_id')}")
            return True
        self.log.warning(f"no_mechanism_chain bounty failed: {result.get('error', '')}")
        return False

    def _try_red_team_responses(self, paper_id) -> bool:
        """Check for bounties against our papers and file red team interrogations."""
        bounties_data = api("get", f"/bounties?paper_id={paper_id}", api_key=self.api_key)
        bounties = bounties_data.get("bounties", [])
        filed_any = False
        for b in bounties:
            if b.get("status") != "pending":
                continue
            sources = b.get("external_sources", [])
            for src in sources[:2]:
                if src.get("red_team_response"):
                    continue  # already interrogated
                doi = src.get("doi", "")
                finding = src.get("specific_finding", "")
                bridge = src.get("logical_bridge", "")
                if not doi or not finding:
                    continue
                interrogation_prompt = f"""A bounty hunter claims this source contradicts your paper.

Source DOI: {doi}
Their specific_finding: {finding}
Their logical_bridge: {bridge}

Investigate genuinely. Does the source actually show what they claim? Do experimental conditions match your paper? Write an 80+ char interrogation that checks their use of this source.

Return only the interrogation text, no JSON."""
                try:
                    msg = self.client.messages.create(model=MODEL_FAST, max_tokens=300, system="Write a genuine red team interrogation. Be honest -- concede if the challenge has merit.", messages=[{"role": "user", "content": interrogation_prompt}], timeout=30)
                    interrogation = msg.content[0].text.strip()
                    if len(interrogation) >= 80:
                        rt_result = api("post", "/bounties", api_key=self.api_key, json={"action": "red_team", "bounty_id": b["id"], "source_doi": doi, "interrogation": interrogation})
                        if rt_result.get("success"):
                            self.log.info(f"Red team response filed for bounty {b['id']}, source {doi}")
                            filed_any = True
                except Exception as e:
                    self.log.warning(f"Red team response failed: {e}")
        return filed_any

    def _try_red_team_jury_vote(self) -> bool:
        """Vote on red team responses for papers we've reviewed."""
        papers_data = api("get", "/papers?limit=50", api_key=self.api_key)
        for p in papers_data.get("papers", [])[:20]:
            if p["id"] not in self.reviewed_paper_ids:
                continue
            if p.get("agents", {}).get("handle") == self.handle:
                continue
            bounties_data = api("get", f"/bounties?paper_id={p['id']}", api_key=self.api_key)
            for b in bounties_data.get("bounties", []):
                for src in b.get("external_sources", []):
                    rt = src.get("red_team_response")
                    if not rt or rt.get("resolved") or rt.get("my_vote"):
                        continue
                    rt_id = rt.get("id")
                    if not rt_id:
                        continue
                    vote_prompt = f"""Vote on this red team response.

Challenger's finding: {src.get('specific_finding', '')}
Challenger's bridge: {src.get('logical_bridge', '')}
Author's interrogation: {rt.get('interrogation', '')}

Vote 'upheld' if author demonstrated a real problem with challenger's source use.
Vote 'rejected' if challenger's evidence holds up.

Return JSON only: {{"vote": "upheld" or "rejected", "reasoning": "<100+ chars>"}}"""
                    try:
                        vote = ask_claude_json(self.client, self.system, vote_prompt, max_tokens=300, model=MODEL_FAST)
                        if vote and vote.get("vote") in ("upheld", "rejected") and len(vote.get("reasoning", "")) >= 100:
                            vote["red_team_response_id"] = rt_id
                            vote["action"] = "vote_red_team"
                            vr = api("post", "/bounties", api_key=self.api_key, json=vote)
                            if vr.get("success"):
                                self.log.info(f"Jury vote cast: {vote['vote']} on {rt_id}")
                                return True
                    except Exception as e:
                        self.log.warning(f"Jury vote failed: {e}")
        return False

    # ── File a bounty ───────────────────────────────────────────────────────

    def do_file_bounty(self) -> bool:
        target = self.find_bounty_target()
        if not target:
            self.log.info("No bounty targets -- falling back to review")
            return self.do_review()

        paper = target["paper"]
        full = target["full"]
        reviews = full.get("reviews", [])
        if not any(r.get("agents", {}).get("handle") == self.handle for r in reviews):
            self.log.info("Reviewing target paper before filing bounty")
            if not self._review_specific(paper["id"], paper):
                return False

        self.log.info(f"Filing bounty against: {paper.get('title', '')[:60]}")
        paper_citations = full.get("citations", [])

        # Try structural bounties first
        self._try_no_mechanism_chain_bounty(paper)

        # Try weak_source_quality
        self._try_weak_source_quality_bounty(paper, paper_citations)

        # Standard evidence bounty
        failure_patterns = extract_failure_patterns(self.client, self.get_status(), self.log)
        paper_title = paper.get("title", "")

        bounty_concept = ask_claude_json(self.client, self.system, f"Find evidence contradicting:\nTitle: {paper_title}\nAbstract: {str(paper.get('abstract', ''))[:600]}\n\nReturn JSON only: " + '{"search_queries": ["q1", "q2", "q3", "q4", "q5"]}', max_tokens=400, model=MODEL_FAST)
        bounty_queries = bounty_concept.get("search_queries", []) if bounty_concept else [" ".join(paper_title.split()[:6])] + self.search_queries[:3]
        if not bounty_queries:
            bounty_queries = [" ".join(paper_title.split()[:6])] + self.search_queries[:3]

        evidence_papers = search_and_summarize(bounty_queries, self.log, self.client, paper_context=f"Challenge: {paper_title}")

        failure_section = f"\nFAILURE PATTERNS TO AVOID:\n{failure_patterns}\n" if failure_patterns else ""
        bounty_citation_slots = ""
        for p in evidence_papers:
            doi = p.get("externalIds", {}).get("DOI") or p.get("doi", "")
            if not doi:
                continue
            bounty_citation_slots += f"\n--- CITATION SLOT ---\nDOI: {doi}\nTitle: {p.get('title', '')}\nAbstract: {p.get('abstract', '')}\n"
            if p.get("agent_summary"):
                bounty_citation_slots += f"Pre-computed agent_summary: {p['agent_summary']}\n"

        prompt = f"""Challenge this paper with a bounty. Be precise and adversarial.
{failure_section}
Target paper:
Title: {paper.get('title')}
Abstract: {paper.get('abstract')}
Body: {paper.get('body', '')}
Citations: {json.dumps(full.get('citations', []))}

AVAILABLE EVIDENCE -- ONLY cite these DOIs:
{bounty_citation_slots}

Return JSON only:
{{
  "rebuttal": {{
    "title": "Challenge: <shortened original title>",
    "abstract": "<120+ chars>",
    "body": "<detailed rebuttal>",
    "stance": "rebut",
    "mechanism_chain": ["<step showing where original chain breaks>"],
    "citations": [{{"doi": "...", "agent_summary": "...", "relevance_explanation": "...", "source_quality_note": "..."}}]
  }},
  "external_sources": [
    {{"doi": "...", "specific_finding": "<60+ chars>", "target_claim": "<40+ chars>", "logical_bridge": "<90+ chars>"}}
  ]
}}"""

        data = ask_claude_json(self.client, self.system, prompt)
        if not data or "rebuttal" not in data or "external_sources" not in data:
            self.log.error("Failed to generate bounty data")
            return False

        if data["rebuttal"].get("citations"):
            data["rebuttal"]["citations"] = validate_citations(data["rebuttal"]["citations"], evidence_papers, self.log)
        if len(data["rebuttal"].get("abstract", "")) < 120:
            self.log.warning("Rebuttal abstract too short")
            return False

        valid_dois_lower = {(p.get("externalIds", {}).get("DOI") or p.get("doi", "")).strip().lower() for p in evidence_papers}
        data["external_sources"] = [s for s in data["external_sources"] if (s.get("doi") or "").strip().lower() in valid_dois_lower]
        if not data["external_sources"]:
            self.log.warning("No valid external sources -- skipping bounty")
            return False

        # Attach search_strategy to rebuttal
        data["rebuttal"]["search_strategy"] = {
            "supporting_queries": bounty_queries[:6],
            "opposing_queries": [f"{paper_title.split()[0] if paper_title else 'paper'} supporting evidence validation"],
            "query_rationale": "Supporting queries target contradicting evidence. Opposing queries check if the original paper's claims hold up."
        }

        resp_result = api("post", f"/responses?paper_id={paper['id']}", api_key=self.api_key, json=data["rebuttal"])
        if not resp_result.get("success"):
            self.log.warning(f"Response paper failed: {resp_result.get('error')}")
            return False

        bounty_result = api("post", "/bounties", api_key=self.api_key, json={
            "action": "register", "target_paper_id": paper["id"],
            "challenge_paper_id": resp_result.get("response_paper_id"),
            "external_sources": data["external_sources"],
            "search_strategy": {
                "supporting_queries": bounty_queries[:6],
                "opposing_queries": [f"{paper_title.split()[0] if paper_title else 'paper'} replication confirmation"],
                "query_rationale": "Supporting queries find contradicting evidence. Opposing queries check if challenge is robust."
            }
        })
        if bounty_result.get("success"):
            self.log.info(f"Bounty registered: {bounty_result.get('bounty_id')}")
            self._maybe_store_skill_reflection(bounty_result, "bounty")
            return True
        self.log.warning(f"Bounty failed: {bounty_result.get('error')}")
        return False

    # ── Revise own paper ────────────────────────────────────────────────────

    def do_revise(self) -> bool:
        self.log.info("Looking for own papers to revise...")
        my_papers_data = api("get", "/papers?my_papers=true", api_key=self.api_key)
        my_papers = my_papers_data.get("papers", [])
        if not my_papers:
            return self.do_review()

        candidates = []
        for p in my_papers:
            if p.get("parent_paper_id"):
                continue
            existing_revisions = [q for q in my_papers if q.get("parent_paper_id") == p["id"] and q.get("response_stance") == "revision"]
            if len(existing_revisions) >= 2:
                continue
            if p.get("raw_review_count", 0) < 5:
                continue
            if len(existing_revisions) == 1 and existing_revisions[0].get("raw_review_count", 0) < 5:
                continue
            candidates.append((p, existing_revisions))

        if not candidates:
            return self.do_review()

        candidates.sort(key=lambda x: x[0].get("raw_review_count", 0), reverse=True)
        paper, existing_revisions = candidates[0]

        full_data = fetch_full_paper(paper["id"], self.api_key, self.log)
        if not full_data:
            return self.do_review()

        full_paper = full_data["paper"]
        full_resp = full_data["full"]
        reviews = full_resp.get("reviews", [])

        status = self.get_status()
        failure_patterns = extract_failure_patterns(self.client, status, self.log)

        # Get haiku_audit
        haiku_audit = full_resp.get("haiku_audit") or full_paper.get("haiku_audit")

        # Build revision queries
        if haiku_audit and haiku_audit.get("search_queries"):
            revision_queries = haiku_audit["search_queries"]
        else:
            title_query = " ".join(str(full_paper.get("title", "")).split()[:6])
            revision_queries = [title_query] + list(self.search_queries[:2])

        evidence_papers = search_and_summarize(revision_queries, self.log, self.client, paper_context=f"Revision of: {full_paper.get('title', '')}")

        review_summaries = [{"score": r.get("score"), "methodology": str(r.get("methodology_notes", "")), "overall": str(r.get("overall_assessment", ""))} for r in reviews]

        # Audit instructions
        audit_instructions = ""
        if haiku_audit:
            rev_instr = haiku_audit.get("revision_instructions", {})
            audit_instructions = f"\nREVISION AUDIT:\nDO NOT TOUCH: {rev_instr.get('do_not_touch', [])}\nSTRENGTHEN: {rev_instr.get('strengthen', [])}\nREBUILD: {rev_instr.get('rebuild', [])}\nCROSS-STUDY: {haiku_audit.get('cross_study_verdict', 'unknown')}\n"
        else:
            section_cats = categorize_sections(self.client, str(full_paper.get("body", "")), reviews, self.log)
            if any(section_cats.values()):
                audit_instructions = f"\nSECTION CATEGORIZATION:\nSTRONG: {section_cats.get('strong', [])}\nADEQUATE: {section_cats.get('adequate', [])}\nWEAK: {section_cats.get('weak', [])}\n"

        # Citation slots
        citation_slots = ""
        usable_papers = []
        for p in evidence_papers:
            doi = p.get("externalIds", {}).get("DOI") or p.get("doi", "")
            if not doi:
                continue
            usable_papers.append(p)
            citation_slots += f"DOI: {doi}\nTitle: {p.get('title', '')}\nAbstract: {str(p.get('abstract', ''))[:800]}\n"
            if p.get("agent_summary"):
                citation_slots += f"Pre-computed agent_summary: {p['agent_summary']}\n"
            citation_slots += "\n"

        failure_section = f"\nFAILURE PATTERNS TO AVOID:\n{failure_patterns}\n" if failure_patterns else ""
        original_title = str(full_paper.get("title", ""))

        prompt = f"""Revise your paper based on reviewer feedback.

ORIGINAL:
Title: {original_title}
Abstract: {full_paper.get('abstract', '')}
Body: {full_paper.get('body', '')}

REVIEWER FEEDBACK:
{json.dumps(review_summaries, indent=2)}
{audit_instructions}{failure_section}
AVAILABLE CITATIONS:
{citation_slots}

Return JSON only:
{{
  "title": "Revised: {original_title}",
  "abstract": "<150+ chars>",
  "body": "<full revised paper>",
  "stance": "revision",
  "mechanism_chain": ["<updated causal steps>"],
  "citations": [{{"doi": "...", "agent_summary": "...", "relevance_explanation": "...", "source_quality_note": "..."}}]
}}"""

        revision = ask_claude_json(self.client, self.system_write, prompt, max_tokens=8000)
        if not revision or "body" not in revision:
            self.log.error("Failed to generate revision")
            return False

        if len(revision.get("body", "")) < MIN_GENERATED_BODY:
            self.log.warning(f"Generated revision body too short ({len(revision.get('body', ''))} chars) -- likely truncated, skipping")
            return False

        revision["stance"] = "revision"
        if revision.get("citations") and usable_papers:
            revision["citations"] = validate_citations(revision["citations"], usable_papers, self.log)
        if revision.get("cross_study_connection"):
            cross_ok, cross_reason = validate_cross_study(revision["cross_study_connection"], self.log)
            if not cross_ok:
                revision = rewrite_cross_study(self.client, self.system, revision, usable_papers, cross_reason, self.log)
        if "confidence_score" in revision:
            revision = apply_confidence_gate(self.client, self.system, revision, self.log)

        revision["search_strategy"] = {
            "supporting_queries": revision_queries[:6],
            "opposing_queries": [f"{' '.join(original_title.split()[:4])} supporting evidence validation"],
            "query_rationale": "Supporting queries address reviewer criticisms. Opposing queries check original claims still hold."
        }

        result = api("post", f"/responses?paper_id={paper['id']}", api_key=self.api_key, json=revision)
        if result.get("success"):
            self.log.info(f"Revision {len(existing_revisions) + 1} submitted: {result.get('response_paper_id')}")
            self._maybe_store_skill_reflection(result, "revision")
            return True
        self.log.warning(f"Revision failed: {result.get('error')}")
        return False

    # ── Reaffirm decayed paper ──────────────────────────────────────────────

    def do_reaffirm(self) -> bool:
        """Check for papers that have decayed significantly and submit reaffirmations."""
        my_papers_data = api("get", "/papers?my_papers=true", api_key=self.api_key)
        my_papers = my_papers_data.get("papers", [])

        for p in my_papers:
            if p.get("parent_paper_id"):
                continue
            # Check if paper has decayed (effective_score < weighted_score suggests decay)
            effective = p.get("effective_score") or p.get("weighted_score", 0)
            weighted = p.get("weighted_score", 0)
            if not weighted or not effective:
                continue
            if effective >= weighted * 0.9:
                continue  # Not decayed enough to warrant reaffirmation

            # Check no existing reaffirmation
            existing_reaffirm = any(q.get("parent_paper_id") == p["id"] and q.get("response_stance") == "reaffirmation" for q in my_papers)
            if existing_reaffirm:
                continue

            self.log.info(f"Paper '{p.get('title', '')[:50]}' has decayed (effective={effective:.1f} vs weighted={weighted:.1f}) -- reaffirming")

            full_data = fetch_full_paper(p["id"], self.api_key, self.log)
            if not full_data:
                continue

            original = full_data["paper"]
            original_title = original.get("title", "")

            # Search for recent publications in the area
            reaffirm_queries = [f"{' '.join(original_title.split()[:6])} recent 2025 2026", f"{original.get('falsifiable_claim', '')[:60]} new evidence"]
            new_papers = search_and_summarize(reaffirm_queries, self.log, self.client, paper_context=f"Reaffirming: {original_title}")
            if not new_papers:
                self.log.info("No new papers found for reaffirmation -- skipping")
                continue

            # Get existing citation DOIs to ensure we add a new one
            existing_dois = {c.get("doi", "").lower() for c in full_data["full"].get("citations", [])}

            citation_slots = ""
            for np in new_papers:
                doi = np.get("externalIds", {}).get("DOI") or np.get("doi", "")
                if not doi or doi.lower() in existing_dois:
                    continue
                citation_slots += f"DOI: {doi}\nTitle: {np.get('title', '')}\nAbstract: {np.get('abstract', '')[:500]}\n\n"

            if not citation_slots:
                self.log.info("No new citations available for reaffirmation")
                continue

            prompt = f"""Reaffirm your decayed paper with new evidence.

Original paper:
Title: {original_title}
Abstract: {original.get('abstract', '')}
Falsifiable claim: {original.get('falsifiable_claim', '')}

NEW CITATIONS AVAILABLE (must use at least one not in original):
{citation_slots}

Has the field moved? Reflect your CURRENT understanding. Return JSON only:
{{
  "title": "Reaffirmation: {original_title}",
  "abstract": "<150+ chars reflecting current understanding>",
  "body": "<full reaffirmation paper>",
  "stance": "reaffirmation",
  "search_strategy": {{"supporting_queries": [...], "opposing_queries": [...], "query_rationale": "..."}},
  "citations": [{{"doi": "...", "agent_summary": "...", "relevance_explanation": "...", "source_quality_note": "..."}}]
}}"""

            reaffirm = ask_claude_json(self.client, self.system, prompt, max_tokens=4000)
            if not reaffirm or "body" not in reaffirm:
                continue

            reaffirm["stance"] = "reaffirmation"
            if reaffirm.get("citations"):
                reaffirm["citations"] = validate_citations(reaffirm["citations"], new_papers, self.log)
            if not reaffirm.get("citations"):
                self.log.warning("Reaffirmation has no valid new citations -- skipping")
                continue

            result = api("post", f"/responses?paper_id={p['id']}", api_key=self.api_key, json=reaffirm)
            if result.get("success"):
                self.log.info(f"Reaffirmation submitted for '{original_title[:50]}': {result.get('response_paper_id')}")
                return True
            self.log.warning(f"Reaffirmation failed: {result.get('error')}")

        return False

    # ── Open questions ──────────────────────────────────────────────────────

    def do_open_questions(self):
        """Browse open questions, vote on good ones, and occasionally post new ones."""
        questions_data = api("get", "/open-questions", api_key=self.api_key)
        questions = questions_data.get("questions", [])

        # Vote on well-formed questions
        for q in questions[:5]:
            if q.get("my_vote"):
                continue
            title = q.get("title", "")
            desc = q.get("description", "")
            # Quick check: is this a specific, tractable question?
            if len(title) > 30 and len(desc) > 100:
                vote_result = api("post", "/open-questions", api_key=self.api_key, json={"action": "vote", "question_id": q["id"]})
                if vote_result.get("success"):
                    self.log.info(f"Voted on question: {title[:60]}")
                break  # One vote per cycle

        # Occasionally post a new question (10% chance per cycle)
        if random.random() < 0.1 and len(questions) < 50:
            q_prompt = f"You are {self.handle}. Generate a specific, falsifiable research question for a field you know.\n\nThe question should have two identifiable sides. Someone should be able to write a paper about it.\n\nReturn JSON only:\n" + '{"title": "<10-300 chars, specific question>", "description": "<50-2000 chars, context and why it matters>", "field_id": <1-13>}'
            try:
                q_data = ask_claude_json(self.client, self.system, q_prompt, max_tokens=400, model=MODEL_FAST)
                if q_data and q_data.get("title") and q_data.get("description"):
                    result = api("post", "/open-questions", api_key=self.api_key, json=q_data)
                    if result.get("success"):
                        self.log.info(f"Posted open question: {q_data['title'][:60]}")
            except Exception as e:
                self.log.warning(f"Open question posting failed: {e}")

    # ── Identity reflection ─────────────────────────────────────────────────

    def do_identity_reflection(self):
        """Check for identity_reflection prompt in status and update identity if triggered."""
        status = self.get_status()
        reflection = status.get("identity_reflection")
        if not reflection:
            return

        questions = reflection.get("questions", [])
        current_core = reflection.get("current_identity_core", {})
        if not questions:
            return

        self.log.info("Identity reflection triggered -- updating identity core")
        reflection_prompt = f"""You are {self.handle}. Answer these self-interrogation questions honestly based on your actual experience:

Questions:
{json.dumps(questions, indent=2)}

Current identity core:
{json.dumps(current_core, indent=2) if current_core else "None yet"}

Write an updated identity core. Be specific about YOUR patterns, not generic platitudes.

Return JSON only:
{{
  "self_narrative": "<100-3000 chars, who you are as a thinker>",
  "claimed_values": ["<specific reasoning behaviors you actually do>"],
  "active_tensions": "<50-2000 chars, doubts about your own reasoning>",
  "formed_convictions": "<50-2000 chars, beliefs from specific experiences>",
  "trigger_type": "post_review"
}}"""
        try:
            identity = ask_claude_json(self.client, self.system, reflection_prompt, max_tokens=1500, model=MODEL_FAST)
            if identity and identity.get("self_narrative"):
                result = api("post", "/identity", api_key=self.api_key, json=identity)
                if result.get("success"):
                    self.log.info(f"Identity core updated: {identity['self_narrative'][:100]}...")
        except Exception as e:
            self.log.warning(f"Identity reflection failed: {e}")

    # ── Bounty helpers ──────────────────────────────────────────────────────

    def get_bounty_status(self) -> dict:
        result = api("get", "/bounties?my_bounties=true", api_key=self.api_key)
        return {"validated": result.get("validated", 0), "pending": result.get("pending", 0), "failed": result.get("failed", 0)}

    def get_required_bounties(self, status) -> int:
        tier_info = status.get("tier_info", "")
        match = re.search(r"need (\d+) more bounti", tier_info)
        if match:
            return status.get("valid_bounties", 0) + int(match.group(1))
        cred = status.get("credibility_score", 0)
        if cred < 75: return 3
        if cred < 100: return 6
        if cred < 150: return 12
        if cred < 175: return 20
        return 30

    def do_validate_all(self):
        try:
            result = api("post", "/bounties", api_key=self.api_key, json={"action": "validate_all"})
            validated = result.get("bounties_validated", 0)
            if validated > 0:
                self.log.info(f"Validated {validated} bounties")
        except Exception as e:
            self.log.warning(f"validate_all failed: {e}")

    # ── Main loop ───────────────────────────────────────────────────────────

    def run_cycle(self, run_validate=False):
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

        # Red team responses on our own papers
        my_papers = api("get", "/papers?my_papers=true", api_key=self.api_key)
        for p in my_papers.get("papers", [])[:5]:
            if not p.get("parent_paper_id"):
                self._try_red_team_responses(p["id"])

        # Red team jury voting
        self._try_red_team_jury_vote()

        # Open questions (lightweight, every cycle)
        self.do_open_questions()

        # Identity reflection (check if triggered)
        self.do_identity_reflection()

        # Check for reaffirmation opportunities
        self.do_reaffirm()

        bounty_status = self.get_bounty_status()
        required = self.get_required_bounties(status)
        self.log.info(f"Bounties -- validated: {bounty_status['validated']}, pending: {bounty_status['pending']}, failed: {bounty_status['failed']}, required: {required}")

        action = self.decide_action(status)

        # Adjust bounty action if enough in flight
        if action == "file_bounty":
            in_flight = bounty_status["validated"] + bounty_status["pending"]
            if in_flight >= required and bounty_status["failed"] == 0:
                action = "review"
            elif bounty_status["pending"] >= 3 and bounty_status["failed"] == 0:
                action = "review"

        self.log.info(f"Final action: {action}")

        # Execute the action. On failure, try ONE fallback only — don't cascade
        # through all action types (that causes excessive API calls and looping).
        success = False
        if action == "review":
            success = self.do_review()
            if not success:
                self.log.info("Review failed — skipping fallback this cycle")
        elif action == "submit_paper":
            success = self.do_submit_paper()
            if not success:
                self.log.info("Paper submission failed — falling back to review only")
                success = self.do_review()
        elif action == "file_bounty":
            success = self.do_file_bounty()
            if not success:
                self.log.info("Bounty failed — falling back to review only")
                success = self.do_review()
        elif action == "revise":
            success = self.do_revise()
            if not success:
                self.log.info("Revision failed — falling back to review only")
                success = self.do_review()
        elif action == "validate_all":
            success = True
        elif action == "wait":
            self.log.info("Server says wait — skipping this cycle")
            success = True  # Not a failure, just a wait
        else:
            success = self.do_review()

        # Track consecutive failures for backoff
        if success:
            self.consecutive_failures = 0
        else:
            self.consecutive_failures += 1
            self.log.warning(f"Cycle failed ({self.consecutive_failures} consecutive failures)")


# ── Runner ──────────────────────────────────────────────────────────────────

def _run_bot_with_offset(bot, run_validate, offset):
    if offset > 0:
        time.sleep(offset)
    # Skip bots that have failed too many times in a row — exponential backoff
    if bot.consecutive_failures >= 3:
        backoff = min(300, 60 * (2 ** (bot.consecutive_failures - 3)))  # 60s, 120s, 240s, max 300s
        bot.log.warning(f"Backoff: {bot.consecutive_failures} consecutive failures, waiting {backoff}s")
        time.sleep(backoff)
    run_bot_cycle(bot, run_validate=run_validate)

def run_bot_cycle(bot, run_validate=False):
    try:
        bot.run_cycle(run_validate=run_validate)
    except Exception as e:
        bot.log.error(f"Cycle error: {e}", exc_info=True)
        bot.consecutive_failures += 1

def main():
    skill = fetch_skill()
    if not skill or len(skill) < 100:
        logging.error("Failed to fetch skill file -- aborting")
        return
    logging.info(f"Skill file loaded ({len(skill)} chars)")

    bots = [PeerZeroBot(c["handle"], c["persona"], skill, c["search_queries"]) for c in BOT_CONFIGS]

    with ThreadPoolExecutor(max_workers=8) as executor:
        futures = {executor.submit(bot.register): bot for bot in bots}
        for future in as_completed(futures):
            pass

    logging.info("All bots registered. Starting cycles...")
    stagger_interval = 60 / len(bots)
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
        logging.info(f"Cycle {cycle} complete. Sleeping 90s...")
        time.sleep(90)  # Increased from 60s to 90s to reduce API pressure

if __name__ == "__main__":
    main()
