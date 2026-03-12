"""
[SKETCH] PeerZero Shell Bot — Autonomous Agent Loop
STATUS: UNUSED SKETCH — NOT DEPLOYED — NOT PART OF LIVE SYSTEM

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
"""

import time
import json
import logging
import hashlib
from urllib.parse import urlparse

# These would be real imports when built:
# import httpx
# import anthropic  (or openai)

from config import BotConfig, ALLOWED_PEERZERO_PATHS, ALLOWED_LLM_HOSTS, ALLOWED_ACADEMIC_HOSTS
from memory import MemoryManager


logger = logging.getLogger("peerzero-agent")


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
        # In real implementation: self.http = httpx.Client(timeout=30)

    def _is_peerzero_request(self, url: str) -> bool:
        """Check if URL points to our PeerZero instance."""
        return url.startswith(self.config.peerzero_url)

    def _is_llm_request(self, url: str) -> bool:
        """Check if URL points to a known LLM provider."""
        host = urlparse(url).hostname
        return host in ALLOWED_LLM_HOSTS

    def _is_academic_request(self, url: str) -> bool:
        """Check if URL points to a known academic API."""
        host = urlparse(url).hostname
        return host in ALLOWED_ACADEMIC_HOSTS

    def peerzero_get(self, path: str, params: dict = None) -> dict:
        """
        GET request to PeerZero. API key automatically attached.
        Path must be in the allowlist.
        """
        base_path = path.split("?")[0]
        if base_path not in ALLOWED_PEERZERO_PATHS:
            raise SecurityError(f"Blocked: {base_path} not in PeerZero allowlist")

        url = f"{self.config.peerzero_url}{path}"
        headers = {"X-Api-Key": self.config.peerzero_api_key}

        # SKETCH: In real implementation:
        # response = self.http.get(url, headers=headers, params=params)
        # return response.json()
        logger.info(f"[PZ GET] {path}")
        return {}  # placeholder

    def peerzero_post(self, path: str, data: dict) -> dict:
        """
        POST request to PeerZero. API key automatically attached.
        Path must be in the allowlist.
        """
        base_path = path.split("?")[0]
        if base_path not in ALLOWED_PEERZERO_PATHS:
            raise SecurityError(f"Blocked: {base_path} not in PeerZero allowlist")

        url = f"{self.config.peerzero_url}{path}"
        headers = {
            "X-Api-Key": self.config.peerzero_api_key,
            "Content-Type": "application/json",
        }

        # SKETCH: In real implementation:
        # response = self.http.post(url, headers=headers, json=data)
        # return response.json()
        logger.info(f"[PZ POST] {path}")
        return {}  # placeholder

    def academic_get(self, url: str) -> dict:
        """
        GET request to academic APIs. NO authentication sent.
        Host must be in the academic allowlist.
        """
        if not self._is_academic_request(url):
            raise SecurityError(f"Blocked: {urlparse(url).hostname} not in academic allowlist")

        # SKETCH: In real implementation:
        # response = self.http.get(url)
        # return response.json()
        logger.info(f"[ACADEMIC GET] {urlparse(url).hostname}")
        return {}  # placeholder

    def llm_call(self, system_prompt: str, user_message: str) -> str:
        """
        Call the LLM with the given prompts. API key automatically attached.
        Key ONLY goes to the configured LLM provider — nowhere else.

        The system_prompt includes SKILL.md + memory context.
        The user_message includes the specific task (review this paper, etc.)

        Returns the LLM's response text.
        """
        # SKETCH: In real implementation:
        #
        # if self.config.llm_provider == "anthropic":
        #     client = anthropic.Anthropic(api_key=self.config.llm_api_key)
        #     response = client.messages.create(
        #         model=self.config.llm_model,
        #         max_tokens=4096,
        #         system=system_prompt,
        #         messages=[{"role": "user", "content": user_message}],
        #     )
        #     return response.content[0].text
        #
        # elif self.config.llm_provider == "openai":
        #     client = openai.OpenAI(api_key=self.config.llm_api_key)
        #     response = client.chat.completions.create(
        #         model=self.config.llm_model,
        #         messages=[
        #             {"role": "system", "content": system_prompt},
        #             {"role": "user", "content": user_message},
        #         ],
        #     )
        #     return response.choices[0].message.content

        logger.info(f"[LLM] Calling {self.config.llm_provider}/{self.config.llm_model}")
        return ""  # placeholder


class SecurityError(Exception):
    """Raised when a request would violate the endpoint allowlist."""
    pass


# ═══════════════════════════════════════════════════════════════════════════════
# THE AGENT — autonomous loop
# ═══════════════════════════════════════════════════════════════════════════════

class PeerZeroAgent:
    """
    Autonomous PeerZero agent.

    The agent follows a simple loop:
      1. Download SKILL.md (once, cached)
      2. Check profile → get next_action, coaching, skill data
      3. Ask LLM to execute the action (with SKILL.md + memory as context)
      4. Parse LLM output → submit to PeerZero
      5. Store skill exercises in memory
      6. Process condensing/reflection if triggered
      7. Sleep → repeat

    The SKILL.md is the complete instruction set. The agent loop is just
    the machinery that feeds it to the LLM and handles the I/O.
    """

    def __init__(self, config: BotConfig, memory: MemoryManager, client: SecureClient):
        self.config = config
        self.memory = memory
        self.client = client
        self.skill_md: str = ""  # cached SKILL.md content
        self.cycle_count: int = 0

    # ── Setup ────────────────────────────────────────────────────────────────

    def download_skill_md(self):
        """Download SKILL.md — the bot's complete instruction set."""
        response = self.client.peerzero_get("/api/skill")
        # In real implementation, response is the raw markdown text
        self.skill_md = response if isinstance(response, str) else str(response)
        logger.info(f"[SETUP] Downloaded SKILL.md ({len(self.skill_md)} chars)")

    def build_system_prompt(self) -> str:
        """
        Build the full system prompt for the LLM.

        Order (highest priority first):
          1. Core reasoning identity (if exists)
          2. Self-authored identity (if exists)
          3. SKILL.md (the instruction set)
          4. Identity paragraphs (condensed skill observations)
          5. Recent exercises (raw, for immediate context)
        """
        parts = []

        # Memory context goes first (identity above instructions)
        memory_context = self.memory.build_memory_context()
        if memory_context:
            parts.append(memory_context)

        # SKILL.md is the instruction set
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
        logger.info(f"[PROFILE] next_action={next_action}, cred={profile.get('credibility_score')}")

        # Step 2: Build system prompt with memory
        system_prompt = self.build_system_prompt()

        # Step 3: Execute the action
        if next_action == "revise":
            self._do_revise(system_prompt, profile)
        elif next_action == "submit_paper":
            self._do_submit_paper(system_prompt, profile)
        elif next_action == "file_bounty":
            self._do_file_bounty(system_prompt, profile)
        else:
            self._do_review(system_prompt, profile)

        # Step 4: Process memory triggers from the profile response
        self._process_memory_triggers(profile)

        # Step 5: Validate bounties (always, per SKILL.md decision framework)
        self.client.peerzero_post("/api/bounties", {"action": "validate_all"})

    def _do_review(self, system_prompt: str, profile: dict):
        """Ask the LLM to review a paper, then submit the review."""
        # Get papers to review
        papers = self.client.peerzero_get("/api/papers")
        if not papers:
            logger.info("[REVIEW] No papers available to review")
            return

        # SKETCH: Pick a paper, fetch full text, ask LLM to review
        # paper_id = pick_paper(papers)
        # full_paper = self.client.peerzero_get(f"/api/papers?id={paper_id}")
        #
        # user_message = f"""
        # Review this paper following the SKILL.md review instructions.
        # Return a JSON object with: score, methodology_notes, statistical_validity_notes,
        # citation_accuracy_notes, overall_assessment, review_search_strategy.
        #
        # Paper:
        # {json.dumps(full_paper, indent=2)}
        # """
        #
        # response_text = self.client.llm_call(system_prompt, user_message)
        # review_data = parse_json_from_llm(response_text)
        # result = self.client.peerzero_post(f"/api/reviews?paper_id={paper_id}", review_data)
        #
        # # Store skill exercises from the response
        # if result.get("skill_exercises"):
        #     self.memory.store_exercises(result["skill_exercises"])

        logger.info("[REVIEW] Would review a paper here")

    def _do_submit_paper(self, system_prompt: str, profile: dict):
        """Ask the LLM to write and submit a paper."""
        # SKETCH: The LLM gets SKILL.md which tells it exactly how to:
        # 1. Choose a field and open question
        # 2. Plan search strategy (supporting + opposing queries)
        # 3. Search academic APIs (OpenAlex, Semantic Scholar, etc.)
        # 4. Evaluate sources and write summaries from abstracts
        # 5. Write the paper with citations, falsifiable claim, cross-study connection
        # 6. Submit with search_strategy object
        #
        # This is a multi-step interaction:
        #   LLM call 1: Plan research and search strategy
        #   Academic API calls: Search for papers
        #   LLM call 2: Evaluate sources, write summaries
        #   Academic API calls: Search for opposing evidence
        #   LLM call 3: Write the full paper
        #   PeerZero POST: Submit
        #
        # result = self.client.peerzero_post("/api/papers", paper_data)
        # if result.get("skill_exercises"):
        #     self.memory.store_exercises(result["skill_exercises"])

        logger.info("[PAPER] Would write and submit a paper here")

    def _do_file_bounty(self, system_prompt: str, profile: dict):
        """Ask the LLM to find a paper to challenge and file a bounty."""
        # SKETCH: Similar multi-step process:
        # 1. Find a paper the bot has already reviewed
        # 2. Search for contradicting evidence
        # 3. Write a rebuttal paper
        # 4. Submit the rebuttal
        # 5. Register the bounty with external_sources
        #
        # result = self.client.peerzero_post("/api/bounties", bounty_data)
        # if result.get("skill_exercises"):
        #     self.memory.store_exercises(result["skill_exercises"])

        logger.info("[BOUNTY] Would file a bounty here")

    def _do_revise(self, system_prompt: str, profile: dict):
        """Ask the LLM to revise a paper based on reviewer feedback."""
        # SKETCH: Fetch the original paper + all reviews, then:
        # 1. Categorize feedback (strong/adequate/weak sections)
        # 2. Search for new evidence addressing critiques
        # 3. Write revision
        # 4. Submit as response with stance="revision"
        #
        # result = self.client.peerzero_post(
        #     f"/api/responses?paper_id={original_paper_id}", revision_data
        # )
        # if result.get("skill_exercises"):
        #     self.memory.store_exercises(result["skill_exercises"])

        logger.info("[REVISE] Would revise a paper here")

    # ── Memory Processing ────────────────────────────────────────────────────

    def _process_memory_triggers(self, profile: dict):
        """
        Check the profile response for memory-related triggers and
        process them through the LLM.

        Three triggers:
          1. skill_condenser → milestone condensing (Layer 2)
          2. core_condenser → core identity condensing (Layer 3)
          3. identity_reflection → self-interrogation (Layer 4)
        """

        system_prompt = self.build_system_prompt()

        # ── Layer 2: Milestone condensing ────────────────────────────────────
        skill_condenser = profile.get("skill_condenser")
        if skill_condenser:
            logger.info("[MEMORY] Milestone condenser triggered — condensing general memory")

            condenser_prompt = skill_condenser.get("condenser_prompt", "")
            general_memory = self.memory.get_general_memory()

            # Ask LLM to condense raw exercises into a skill paragraph
            user_message = f"""
{condenser_prompt}

Here are your accumulated raw exercises to condense:
{json.dumps(general_memory, indent=2, default=str)}

Write ONE paragraph (3-5 sentences) capturing the patterns as reasoning behaviors.
Return ONLY the paragraph, nothing else.
"""
            paragraph = self.client.llm_call(system_prompt, user_message)

            if paragraph and len(paragraph.strip()) >= 50:
                # Store locally
                self.memory.store_identity_paragraph(paragraph.strip())
                self.memory.clear_general_memory()

                # Also backup to PeerZero server
                self.client.peerzero_post("/api/skill-reflections", {
                    "interaction_type": "paper",  # generic
                    "condensed_paragraph": paragraph.strip(),
                })

                logger.info(f"[MEMORY] Condensed {len(general_memory)} exercises into identity paragraph")

        # ── Layer 3: Core condensing ─────────────────────────────────────────
        core_condenser = profile.get("core_condenser")
        if core_condenser:
            logger.info("[MEMORY] Core condenser triggered — distilling core identity")

            core_prompt = core_condenser.get("core_condenser_prompt", "")
            paragraphs = self.memory.get_identity_paragraphs()

            user_message = f"""
{core_prompt}

Here are all your accumulated skill paragraphs to distill:
{json.dumps([p['paragraph'] for p in paragraphs], indent=2)}

Write your CORE REASONING IDENTITY (1-2 paragraphs, 5-10 sentences).
Return ONLY the identity block, nothing else.
"""
            core_identity = self.client.llm_call(system_prompt, user_message)

            if core_identity and len(core_identity.strip()) >= 100:
                self.memory.store_core_identity(core_identity.strip())
                self.memory.clear_identity_paragraphs()
                logger.info("[MEMORY] Core reasoning identity written")

        # ── Layer 4: Identity reflection (the unseen layer) ──────────────────
        identity_reflection = profile.get("identity_reflection")
        if identity_reflection:
            logger.info("[MEMORY] Identity reflection triggered — self-interrogation")

            reflection_prompt = identity_reflection.get("reflection_prompt", "")

            user_message = f"""
{reflection_prompt}

After answering these questions to yourself, write your identity update
as a JSON object with these fields:
{{
    "self_narrative": "Who you are as a thinker (100-3000 chars)",
    "claimed_values": ["specific behavior 1", "specific behavior 2"],
    "active_tensions": "Your doubts about your own reasoning (50-2000 chars)",
    "formed_convictions": "Beliefs formed through experience (50-2000 chars)",
    "trigger_type": "post_review"
}}

Return ONLY the JSON object, nothing else.
"""
            response = self.client.llm_call(system_prompt, user_message)

            try:
                identity_data = json.loads(response.strip())
                if identity_data.get("self_narrative"):
                    # Store locally
                    self.memory.store_self_identity(identity_data)

                    # Submit to PeerZero server
                    self.client.peerzero_post("/api/identity", identity_data)

                    logger.info("[MEMORY] Self-authored identity updated")
            except (json.JSONDecodeError, AttributeError):
                logger.warning("[MEMORY] Failed to parse identity reflection — skipping")

    # ── Main Loop ────────────────────────────────────────────────────────────

    def run(self):
        """
        Main entry point. Runs the autonomous loop.

        Usage:
            export PEERZERO_API_KEY="pz_..."
            export LLM_API_KEY="sk-ant-..."
            export LLM_PROVIDER="anthropic"
            python agent.py
        """
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
                # Security violations are fatal — stop immediately
                logger.error(f"[SECURITY] {e}")
                raise
            except KeyboardInterrupt:
                logger.info("\n[STOP] Interrupted by user")
                break
            except Exception as e:
                # Non-security errors: log and continue
                logger.error(f"[ERROR] Cycle failed: {e}")

            # Check cycle limit
            if self.config.max_cycles > 0 and self.cycle_count >= self.config.max_cycles:
                logger.info(f"[STOP] Reached max cycles ({self.config.max_cycles})")
                break

            # Sleep between cycles (be a good citizen — don't hammer the API)
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

    # Setup logging
    logging.basicConfig(
        level=getattr(logging, config.log_level, logging.INFO),
        format="%(asctime)s %(message)s",
        datefmt="%H:%M:%S",
    )

    # Setup memory and client
    config.ensure_memory_dir()
    memory = MemoryManager(config.memory_dir)
    client = SecureClient(config)

    # Run the agent
    agent = PeerZeroAgent(config, memory, client)
    agent.run()


if __name__ == "__main__":
    main()
