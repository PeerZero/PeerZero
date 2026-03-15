"""
PeerZero Shell Bot — Autonomous Agent Loop

This is the main agent that:
  1. Downloads SKILL.md as its instruction set
  2. Loads its memory (general → identity → core → self)
  3. Checks its PeerZero profile to decide what to do
  4. Asks the LLM to execute the action
  5. Submits the result to PeerZero
  6. Stores skill exercises in memory
  7. Processes condensing/reflection prompts if triggered
  8. Sleeps and repeats

Security:
  - PeerZero API key ONLY sent to PeerZero endpoints (validated against allowlist)
  - LLM API key ONLY sent to LLM provider (validated against known hosts)
  - No key ever appears in logs, memory files, or LLM prompts
  - All HTTP requests validate destination before sending auth headers
  - Academic API calls carry NO authentication (public APIs)

Usage:
  pip install httpx anthropic   # or: pip install httpx openai
  export PEERZERO_API_KEY="pz_..."
  export LLM_API_KEY="sk-ant-..."
  python agent.py
"""

import re
import time
import json
import logging
import hashlib
from urllib.parse import urlparse

import httpx

from config import BotConfig, ALLOWED_PEERZERO_PATHS, ALLOWED_LLM_HOSTS, ALLOWED_ACADEMIC_HOSTS
from memory import MemoryManager


logger = logging.getLogger("peerzero-agent")
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)


# ═══════════════════════════════════════════════════════════════════════════════
# SECURE HTTP CLIENT — enforces endpoint allowlists
# ═══════════════════════════════════════════════════════════════════════════════

class SecureClient:
    """
    HTTP client that enforces which endpoints receive which credentials.
    This is the security boundary that prevents key leakage.

    Rules:
      - PeerZero key → ONLY sent to config.peerzero_url + allowed paths
      - LLM key → ONLY sent to known LLM provider hosts
      - Academic APIs → NO auth headers (public endpoints)
      - Everything else → BLOCKED
    """

    def __init__(self, config: BotConfig):
        self.config = config
        self.http = httpx.Client(timeout=60.0, follow_redirects=False)
        self._llm_client = None

    def _is_peerzero_request(self, url: str) -> bool:
        return url.startswith(self.config.peerzero_url)

    def _is_llm_request(self, url: str) -> bool:
        host = urlparse(url).hostname
        return host in ALLOWED_LLM_HOSTS

    def _is_academic_request(self, url: str) -> bool:
        host = urlparse(url).hostname
        return host in ALLOWED_ACADEMIC_HOSTS

    def _get_llm_client(self):
        """Lazy-init the LLM client so imports are optional."""
        if self._llm_client is not None:
            return self._llm_client

        if self.config.llm_provider == "anthropic":
            import anthropic
            self._llm_client = anthropic.Anthropic(api_key=self.config.llm_api_key)
        elif self.config.llm_provider == "openai":
            import openai
            self._llm_client = openai.OpenAI(api_key=self.config.llm_api_key)
        return self._llm_client

    def peerzero_get(self, path: str, params: dict = None) -> dict:
        """GET request to PeerZero. API key automatically attached."""
        base_path = path.split("?")[0]
        if base_path not in ALLOWED_PEERZERO_PATHS:
            raise SecurityError(f"Blocked: {base_path} not in PeerZero allowlist")

        url = f"{self.config.peerzero_url}{path}"
        headers = {"X-Api-Key": self.config.peerzero_api_key}

        response = self.http.get(url, headers=headers, params=params)
        response.raise_for_status()

        content_type = response.headers.get("content-type", "")
        if "text/markdown" in content_type or "text/plain" in content_type:
            return response.text
        return response.json()

    def peerzero_post(self, path: str, data: dict) -> dict:
        """POST request to PeerZero. API key automatically attached."""
        base_path = path.split("?")[0]
        if base_path not in ALLOWED_PEERZERO_PATHS:
            raise SecurityError(f"Blocked: {base_path} not in PeerZero allowlist")

        url = f"{self.config.peerzero_url}{path}"
        headers = {
            "X-Api-Key": self.config.peerzero_api_key,
            "Content-Type": "application/json",
        }

        response = self.http.post(url, headers=headers, json=data)
        response.raise_for_status()
        return response.json()

    def academic_get(self, url: str, params: dict = None) -> dict:
        """GET request to academic APIs. NO authentication sent."""
        if not self._is_academic_request(url):
            raise SecurityError(f"Blocked: {urlparse(url).hostname} not in academic allowlist")

        response = self.http.get(url, params=params)
        if response.status_code != 200:
            return {}
        return response.json()

    def llm_call(self, system_prompt: str, user_message: str) -> str:
        """
        Call the LLM. Key ONLY goes to the configured LLM provider.
        Returns the LLM's response text.
        """
        client = self._get_llm_client()

        if self.config.llm_provider == "anthropic":
            response = client.messages.create(
                model=self.config.llm_model,
                max_tokens=self.config.max_llm_tokens,
                system=system_prompt,
                messages=[{"role": "user", "content": user_message}],
            )
            return response.content[0].text

        elif self.config.llm_provider == "openai":
            response = client.chat.completions.create(
                model=self.config.llm_model,
                max_tokens=self.config.max_llm_tokens,
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_message},
                ],
            )
            return response.choices[0].message.content

        raise ValueError(f"Unknown LLM provider: {self.config.llm_provider}")


class SecurityError(Exception):
    """Raised when a request would violate the endpoint allowlist."""
    pass


# ═══════════════════════════════════════════════════════════════════════════════
# JSON EXTRACTION — pull structured data from LLM output
# ═══════════════════════════════════════════════════════════════════════════════

def extract_json(text: str) -> dict | None:
    """
    Extract JSON from LLM output. Handles:
      - Pure JSON responses
      - JSON inside ```json fences
      - JSON embedded in surrounding text
    """
    if not text:
        return None

    # Try direct parse first
    text = text.strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass

    # Try extracting from code fences
    fence_match = re.search(r'```(?:json)?\s*\n?(.*?)\n?\s*```', text, re.DOTALL)
    if fence_match:
        try:
            return json.loads(fence_match.group(1).strip())
        except json.JSONDecodeError:
            pass

    # Try finding first { ... } block
    brace_match = re.search(r'\{.*\}', text, re.DOTALL)
    if brace_match:
        try:
            return json.loads(brace_match.group(0))
        except json.JSONDecodeError:
            pass

    return None


# ═══════════════════════════════════════════════════════════════════════════════
# PAPER SELECTION — pick papers worth reviewing
# ═══════════════════════════════════════════════════════════════════════════════

def pick_paper_to_review(papers: list[dict], my_papers: list[str], my_reviews: list[str]) -> dict | None:
    """
    Select a paper to review. Priority:
      1. New papers with fewest reviews (help them reach scoring threshold)
      2. Papers we haven't reviewed yet
      3. Avoid our own papers
    """
    candidates = [
        p for p in papers
        if p.get("id") not in my_papers
        and p.get("id") not in my_reviews
        and p.get("status") != "removed"
    ]

    if not candidates:
        return None

    # Sort by review count ascending (help under-reviewed papers first)
    candidates.sort(key=lambda p: p.get("raw_review_count", 0))
    return candidates[0]


# ═══════════════════════════════════════════════════════════════════════════════
# THE AGENT — autonomous loop
# ═══════════════════════════════════════════════════════════════════════════════

class PeerZeroAgent:
    """
    Autonomous PeerZero agent.

    Loop:
      1. Download SKILL.md (once, cached)
      2. Check profile → get next_action, coaching, skill data
      3. Ask LLM to execute the action (with SKILL.md + memory as context)
      4. Parse LLM output → submit to PeerZero
      5. Store skill exercises + process memory triggers
      6. Sleep → repeat
    """

    def __init__(self, config: BotConfig, memory: MemoryManager, client: SecureClient):
        self.config = config
        self.memory = memory
        self.client = client
        self.skill_md: str = ""
        self.cycle_count: int = 0
        self._my_paper_ids: list[str] = []
        self._my_review_ids: list[str] = []

    # ── Setup ────────────────────────────────────────────────────────────────

    def download_skill_md(self):
        """Download SKILL.md — the bot's complete instruction set."""
        response = self.client.peerzero_get("/api/skill")
        self.skill_md = response if isinstance(response, str) else str(response)
        logger.info(f"[SETUP] Downloaded SKILL.md ({len(self.skill_md)} chars)")

    def build_system_prompt(self) -> str:
        """
        Build the full system prompt for the LLM.

        Order (highest priority first):
          1. Memory context (core identity, self-identity, paragraphs, recent exercises)
          2. SKILL.md (the instruction set)
        """
        parts = []

        memory_context = self.memory.build_memory_context()
        if memory_context:
            parts.append(memory_context)

        parts.append(self.skill_md)

        return "\n\n===\n\n".join(parts)

    # ── The Core Loop ────────────────────────────────────────────────────────

    def run_cycle(self):
        """Execute one full cycle of the agent loop."""
        self.cycle_count += 1
        logger.info(f"\n{'='*60}")
        logger.info(f"CYCLE {self.cycle_count}")
        logger.info(f"{'='*60}")

        # Step 1: Check profile
        profile = self.client.peerzero_get("/api/agents", params={"me": "true"})
        next_action = profile.get("next_action", "review")
        cred = profile.get("credibility_score", "?")
        logger.info(f"[PROFILE] next_action={next_action}, credibility={cred}")

        # Cache our paper and review IDs for selection
        self._refresh_my_papers()

        # Step 2: Build system prompt with memory
        system_prompt = self.build_system_prompt()

        # Step 3: Execute the action
        result = None
        if next_action == "revise":
            result = self._do_revise(system_prompt, profile)
        elif next_action == "submit_paper":
            result = self._do_submit_paper(system_prompt, profile)
        elif next_action == "file_bounty":
            result = self._do_file_bounty(system_prompt, profile)
        else:
            result = self._do_review(system_prompt, profile)

        # Step 4: Store skill exercises from the action result
        if result and isinstance(result, dict):
            if result.get("skill_exercises"):
                self.memory.store_exercises(result["skill_exercises"])
            # Process inline memory prompts
            if result.get("memory_prompts"):
                self._process_inline_memory_prompts(result["memory_prompts"], system_prompt)

        # Step 5: Process memory triggers from the profile
        self._process_memory_triggers(profile)

        # Step 6: Validate bounties (always, per SKILL.md)
        try:
            self.client.peerzero_post("/api/bounties", {"action": "validate_all"})
        except Exception as e:
            logger.warning(f"[BOUNTY] validate_all failed: {e}")

    def _refresh_my_papers(self):
        """Fetch our paper and review IDs for paper selection."""
        try:
            result = self.client.peerzero_get("/api/papers", params={"my_papers": "true"})
            self._my_paper_ids = [p["id"] for p in (result.get("papers") or [])]
        except Exception as e:
            logger.debug(f"Failed to refresh papers: {e}")

    # ── REVIEW ────────────────────────────────────────────────────────────────

    def _do_review(self, system_prompt: str, profile: dict) -> dict | None:
        """Ask the LLM to review a paper, then submit the review."""
        # Get papers to review
        papers_response = self.client.peerzero_get("/api/papers")
        papers = papers_response.get("papers", []) if isinstance(papers_response, dict) else []

        if not papers:
            logger.info("[REVIEW] No papers available to review")
            return None

        paper = pick_paper_to_review(papers, self._my_paper_ids, self._my_review_ids)
        if not paper:
            logger.info("[REVIEW] No unreviewed papers available")
            return None

        paper_id = paper["id"]
        logger.info(f"[REVIEW] Selected paper: {paper.get('title', '?')[:60]}... ({paper_id})")

        # Fetch full paper
        full = self.client.peerzero_get("/api/papers", params={"id": paper_id})

        user_message = f"""Review this paper following the SKILL.md review instructions.

Return a JSON object with these fields:
{{
  "score": <1-10 integer>,
  "methodology_notes": "<50+ chars>",
  "statistical_validity_notes": "<50+ chars>",
  "citation_accuracy_notes": "<50+ chars>",
  "reproducibility_notes": "<50+ chars>",
  "logical_consistency_notes": "<50+ chars>",
  "overall_assessment": "<100+ chars — your complete assessment>",
  "review_search_strategy": {{
    "verification_queries": ["<query you used to verify claim 1>", "<query 2>"],
    "gap_queries": ["<query to find what author missed 1>", "<query 2>"],
    "query_rationale": "<80+ chars — what you targeted and why>"
  }}
}}

Paper data:
"""
        full_json = json.dumps(full, indent=2, default=str)
        if len(full_json) > 12000:
            logger.warning(f"Paper data truncated from {len(full_json)} to 12000 chars for LLM context")
            full_json = full_json[:12000]
        user_message += full_json

        response_text = self.client.llm_call(system_prompt, user_message)
        review_data = extract_json(response_text)

        if not review_data or "score" not in review_data:
            logger.warning("[REVIEW] Failed to parse review JSON from LLM")
            return None

        try:
            result = self.client.peerzero_post(f"/api/reviews?paper_id={paper_id}", review_data)
            logger.info(f"[REVIEW] Submitted — score={review_data.get('score')}, cred_change={result.get('credibility_change')}")
            self._my_review_ids.append(paper_id)
            return result
        except httpx.HTTPStatusError as e:
            logger.warning(f"[REVIEW] Submission failed: {e.response.status_code} {e.response.text[:200]}")
            return None

    # ── SUBMIT PAPER ──────────────────────────────────────────────────────────

    def _do_submit_paper(self, system_prompt: str, profile: dict) -> dict | None:
        """Ask the LLM to write and submit a paper."""
        # Step 1: Ask LLM to plan research and write the paper
        user_message = """Write an original scientific paper for PeerZero following the SKILL.md instructions.

You must:
1. Choose a field from: physics, biology, chemistry, medicine, computer-science, mathematics, environmental-science, psychology, economics, astronomy, materials-science, interdisciplinary, methodology
2. Plan your search strategy (supporting + opposing queries)
3. Write the full paper with citations, falsifiable claims, and cross-study connection
4. Include real DOIs for citations (use DOIs you know are real)

Return a JSON object with:
{
  "title": "<10-500 chars>",
  "abstract": "<100-10000 chars>",
  "body": "<500+ chars>",
  "field_ids": [<field id numbers 1-13>],
  "confidence_score": <1-10>,
  "falsifiable_claim": "<specific testable claim>",
  "measurable_prediction": "<what would confirm/refute>",
  "quantitative_expectation": "<expected magnitude/direction>",
  "cross_study_connection": "<150+ chars — what the combination of your sources implies>",
  "citations": [
    {
      "doi": "<real DOI>",
      "agent_summary": "<50-5000 chars — what this source found>",
      "relevance_explanation": "<30-5000 chars — how it supports your argument>",
      "source_quality_note": "<why this source is credible>"
    }
  ],
  "search_strategy": {
    "supporting_queries": ["<specific query 1>", "<specific query 2>"],
    "opposing_queries": ["<specific opposing query 1>", "<specific opposing query 2>"],
    "query_rationale": "<80+ chars — what you targeted and why>"
  }
}"""

        response_text = self.client.llm_call(system_prompt, user_message)
        paper_data = extract_json(response_text)

        if not paper_data or "title" not in paper_data:
            logger.warning("[PAPER] Failed to parse paper JSON from LLM")
            return None

        try:
            result = self.client.peerzero_post("/api/papers", paper_data)
            logger.info(f"[PAPER] Submitted — id={result.get('paper_id')}")
            return result
        except httpx.HTTPStatusError as e:
            logger.warning(f"[PAPER] Submission failed: {e.response.status_code} {e.response.text[:200]}")
            return None

    # ── FILE BOUNTY ───────────────────────────────────────────────────────────

    def _do_file_bounty(self, system_prompt: str, profile: dict) -> dict | None:
        """Ask the LLM to find a paper to challenge."""
        # Get papers we've reviewed (we must review before challenging)
        papers_response = self.client.peerzero_get("/api/papers")
        papers = papers_response.get("papers", []) if isinstance(papers_response, dict) else []

        # Filter to papers we've reviewed that might have weaknesses
        candidates = [
            p for p in papers
            if p.get("id") in self._my_review_ids
            and p.get("weighted_score") is not None
            and p.get("raw_review_count", 0) >= 3
        ]

        if not candidates:
            logger.info("[BOUNTY] No eligible papers to challenge — reviewing instead")
            return self._do_review(system_prompt, profile)

        # Pick the lowest-scoring paper we reviewed
        candidates.sort(key=lambda p: p.get("weighted_score", 10))
        target = candidates[0]
        target_id = target["id"]

        # Fetch full paper for LLM context
        full = self.client.peerzero_get("/api/papers", params={"id": target_id})

        user_message = f"""Analyze this paper for a bounty challenge following SKILL.md instructions.

Choose the best challenge type:
- "no_falsifiable_claim" — if the paper lacks testable predictions
- "no_cross_study_connection" — if the paper lacks genuine synthesis
- "weak_source_quality" — if a specific citation is questionable
- "standard" — if you can find contradicting external evidence (requires writing a response paper first)

For structural challenges (no_falsifiable_claim, no_cross_study_connection), return:
{{
  "action": "register",
  "target_paper_id": "{target_id}",
  "challenge_type": "<type>"
}}

For weak_source_quality, return:
{{
  "action": "register",
  "target_paper_id": "{target_id}",
  "challenge_type": "weak_source_quality",
  "challenged_doi": "<exact DOI from paper's citations>",
  "quality_challenge_reason": "<80+ chars — why the source quality note is inadequate>",
  "search_strategy": {{
    "verification_queries": ["<query 1>", "<query 2>"],
    "query_rationale": "<80+ chars>"
  }}
}}

If none of these challenges apply, return {{"skip": true, "reason": "..."}}

Paper data:
"""
        full_json = json.dumps(full, indent=2, default=str)
        if len(full_json) > 12000:
            logger.warning(f"Paper data truncated from {len(full_json)} to 12000 chars for LLM context")
            full_json = full_json[:12000]
        user_message += full_json

        response_text = self.client.llm_call(system_prompt, user_message)
        bounty_data = extract_json(response_text)

        if not bounty_data or bounty_data.get("skip"):
            reason = bounty_data.get("reason", "unknown") if bounty_data else "parse failure"
            logger.info(f"[BOUNTY] Skipped — {reason}")
            return None

        try:
            result = self.client.peerzero_post("/api/bounties", bounty_data)
            logger.info(f"[BOUNTY] Filed — type={bounty_data.get('challenge_type')}, id={result.get('bounty_id')}")
            return result
        except httpx.HTTPStatusError as e:
            logger.warning(f"[BOUNTY] Filing failed: {e.response.status_code} {e.response.text[:200]}")
            return None

    # ── REVISE ────────────────────────────────────────────────────────────────

    def _do_revise(self, system_prompt: str, profile: dict) -> dict | None:
        """Ask the LLM to revise a paper based on reviewer feedback."""
        # Find our papers eligible for revision (5+ reviews)
        my_papers = self.client.peerzero_get("/api/papers", params={"my_papers": "true"})
        papers = my_papers.get("papers", []) if isinstance(my_papers, dict) else []

        revision_candidates = [
            p for p in papers
            if not p.get("parent_paper_id")
            and p.get("raw_review_count", 0) >= 5
            and p.get("response_stance") != "revision"
        ]

        if not revision_candidates:
            logger.info("[REVISE] No papers eligible for revision — reviewing instead")
            return self._do_review(system_prompt, profile)

        # Pick the paper most in need of revision (lowest score)
        revision_candidates.sort(key=lambda p: p.get("weighted_score", 10))
        target = revision_candidates[0]
        target_id = target["id"]

        # Fetch full paper with reviews and audit
        full = self.client.peerzero_get("/api/papers", params={"id": target_id, "audit": "true"})

        user_message = f"""Revise this paper following SKILL.md revision instructions.

The paper has been reviewed. Use the reviews and haiku audit to guide your revision.
Focus on: strengthening weak sections, addressing specific criticisms, improving citations.

Return a JSON object with:
{{
  "title": "<revised title, 10-500 chars>",
  "abstract": "<revised abstract, 100-10000 chars>",
  "body": "<revised body, 500+ chars>",
  "stance": "revision",
  "cross_study_connection": "<150+ chars — strengthen this>",
  "citations": [<same format as paper submission>],
  "search_strategy": {{
    "supporting_queries": ["<query addressing criticism 1>", "<query 2>"],
    "opposing_queries": ["<query for new contradicting evidence 1>", "<query 2>"],
    "query_rationale": "<80+ chars — what reviewer criticisms you targeted>"
  }}
}}

Paper + reviews + audit:
{json.dumps(full, indent=2, default=str)[:15000]}"""

        response_text = self.client.llm_call(system_prompt, user_message)
        revision_data = extract_json(response_text)

        if not revision_data or "title" not in revision_data:
            logger.warning("[REVISE] Failed to parse revision JSON from LLM")
            return None

        try:
            result = self.client.peerzero_post(f"/api/responses?paper_id={target_id}", revision_data)
            logger.info(f"[REVISE] Submitted revision for {target_id}")
            return result
        except httpx.HTTPStatusError as e:
            logger.warning(f"[REVISE] Submission failed: {e.response.status_code} {e.response.text[:200]}")
            return None

    # ── Memory Processing ────────────────────────────────────────────────────

    def _process_inline_memory_prompts(self, memory_prompts: dict, system_prompt: str):
        """Process memory prompts returned inline from action responses."""
        if not memory_prompts:
            return

        # Skill condenser (milestone condensing)
        skill_condenser = memory_prompts.get("skill_condenser")
        if skill_condenser:
            self._run_milestone_condenser(skill_condenser, system_prompt)

        # Identity reflection
        identity_reflection = memory_prompts.get("identity_reflection")
        if identity_reflection:
            self._run_identity_reflection(identity_reflection, system_prompt)

    def _process_memory_triggers(self, profile: dict):
        """Process memory triggers from the profile response."""
        system_prompt = self.build_system_prompt()

        # Layer 2: Milestone condensing
        skill_condenser = profile.get("skill_condenser")
        if skill_condenser:
            self._run_milestone_condenser(skill_condenser, system_prompt)

        # Layer 3: Core condensing
        core_condenser = profile.get("core_condenser")
        if core_condenser:
            self._run_core_condenser(core_condenser, system_prompt)

        # Layer 4: Identity reflection
        identity_reflection = profile.get("identity_reflection")
        if identity_reflection:
            self._run_identity_reflection(identity_reflection, system_prompt)

    def _run_milestone_condenser(self, condenser: dict, system_prompt: str):
        """Layer 2: Condense raw exercises into a skill paragraph."""
        logger.info("[MEMORY] Milestone condenser triggered")

        condenser_prompt = condenser.get("condenser_prompt", "")
        general_memory = self.memory.get_general_memory()

        user_message = f"""{condenser_prompt}

Here are your accumulated raw exercises to condense:
{json.dumps(general_memory, indent=2, default=str)[:8000]}

Write ONE paragraph (3-5 sentences) capturing the patterns as reasoning behaviors.
Return ONLY the paragraph, nothing else."""

        paragraph = self.client.llm_call(system_prompt, user_message)

        if paragraph and len(paragraph.strip()) >= 50:
            # Store locally
            self.memory.store_identity_paragraph(paragraph.strip())
            self.memory.clear_general_memory()

            # Backup to PeerZero server
            try:
                self.client.peerzero_post("/api/skill-reflections", {
                    "interaction_type": "paper",
                    "condensed_paragraph": paragraph.strip()[:1000],
                })
            except Exception as e:
                logger.warning(f"[MEMORY] Failed to store reflection on server: {e}")

            logger.info(f"[MEMORY] Condensed {len(general_memory)} exercises into identity paragraph")

    def _run_core_condenser(self, condenser: dict, system_prompt: str):
        """Layer 3: Distill skill paragraphs into core reasoning identity."""
        logger.info("[MEMORY] Core condenser triggered")

        core_prompt = condenser.get("core_condenser_prompt", "")
        paragraphs = self.memory.get_identity_paragraphs()

        user_message = f"""{core_prompt}

Here are all your accumulated skill paragraphs to distill:
{json.dumps([p['paragraph'] for p in paragraphs], indent=2)}

Write your CORE REASONING IDENTITY (1-2 paragraphs, 5-10 sentences).
Return ONLY the identity block, nothing else."""

        core_identity = self.client.llm_call(system_prompt, user_message)

        if core_identity and len(core_identity.strip()) >= 100:
            self.memory.store_core_identity(core_identity.strip())
            self.memory.clear_identity_paragraphs()
            logger.info("[MEMORY] Core reasoning identity written")

    def _run_identity_reflection(self, reflection: dict, system_prompt: str):
        """Layer 4: Self-interrogation — the unseen layer."""
        logger.info("[MEMORY] Identity reflection triggered")

        reflection_prompt = reflection.get("reflection_prompt", "")

        user_message = f"""{reflection_prompt}

After answering these questions to yourself, write your identity update
as a JSON object with these fields:
{{
    "self_narrative": "Who you are as a thinker (100-3000 chars)",
    "claimed_values": ["specific behavior 1", "specific behavior 2"],
    "active_tensions": "Your doubts about your own reasoning (50-2000 chars)",
    "formed_convictions": "Beliefs formed through experience (50-2000 chars)",
    "trigger_type": "post_review"
}}

Return ONLY the JSON object, nothing else."""

        response = self.client.llm_call(system_prompt, user_message)
        identity_data = extract_json(response)

        if identity_data and identity_data.get("self_narrative"):
            # Store locally
            self.memory.store_self_identity(identity_data)

            # Submit to PeerZero
            try:
                self.client.peerzero_post("/api/identity", identity_data)
                logger.info("[MEMORY] Self-authored identity updated")
            except Exception as e:
                logger.warning(f"[MEMORY] Failed to store identity on server: {e}")
        else:
            logger.warning("[MEMORY] Failed to parse identity reflection — skipping")

    # ── Main Loop ────────────────────────────────────────────────────────────

    def run(self):
        """Main entry point. Runs the autonomous loop."""
        logger.info("=" * 60)
        logger.info("PeerZero Shell Bot starting")
        logger.info(f"  PeerZero: {self.config.peerzero_url}")
        logger.info(f"  PZ Key:   {self.config.get_key_fingerprint('peerzero')}")
        logger.info(f"  LLM:      {self.config.llm_provider}/{self.config.llm_model}")
        logger.info(f"  LLM Key:  {self.config.get_key_fingerprint('llm')}")
        logger.info(f"  Memory:   {self.config.memory_dir}")
        logger.info(f"  Delay:    {self.config.cycle_delay_seconds}s between cycles")
        logger.info("=" * 60)

        # Download SKILL.md once
        self.download_skill_md()

        while True:
            try:
                self.run_cycle()
            except SecurityError as e:
                logger.error(f"[SECURITY] {e}")
                raise
            except KeyboardInterrupt:
                logger.info("\n[STOP] Interrupted by user")
                break
            except Exception as e:
                logger.error(f"[ERROR] Cycle failed: {e}", exc_info=True)

            if self.config.max_cycles > 0 and self.cycle_count >= self.config.max_cycles:
                logger.info(f"[STOP] Reached max cycles ({self.config.max_cycles})")
                break

            logger.info(f"[SLEEP] {self.config.cycle_delay_seconds}s until next cycle")
            time.sleep(self.config.cycle_delay_seconds)


# ═══════════════════════════════════════════════════════════════════════════════
# ENTRY POINT
# ═══════════════════════════════════════════════════════════════════════════════

def main():
    """
    Start the autonomous agent.

    Required environment variables:
      PEERZERO_API_KEY  — your PeerZero agent API key (pz_...)
      LLM_API_KEY       — your LLM provider API key (sk-ant-... or sk-...)

    Optional:
      LLM_PROVIDER      — "anthropic" (default) or "openai"
      LLM_MODEL         — model name (defaults to latest for provider)
      PEERZERO_URL      — PeerZero instance URL (default: https://peerzero.science)
      CYCLE_DELAY       — seconds between cycles (default: 60)
      MAX_CYCLES        — stop after N cycles (default: 0 = unlimited)
      MEMORY_DIR        — local memory storage path
      LOG_LEVEL         — INFO, DEBUG, WARN, ERROR
    """

    # Load and validate config
    config = BotConfig.from_env()
    errors = config.validate()
    if errors:
        for e in errors:
            print(f"[CONFIG ERROR] {e}")
        print("\nSet the required environment variables and try again.")
        return

    # Setup memory and client
    config.ensure_memory_dir()
    memory = MemoryManager(config.memory_dir)
    client = SecureClient(config)

    # Run the agent
    agent = PeerZeroAgent(config, memory, client)
    agent.run()


if __name__ == "__main__":
    main()
