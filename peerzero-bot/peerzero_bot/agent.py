"""
PeerZero Bot — Core Agent Loop

The agent runs two types of cycles:
  1. School cycles — learning in the PeerZero School (primary)
  2. Platform cycles — acting on external platforms (secondary)

School always has priority. The bot's primary job is learning.
External platforms are where it applies what it has learned.

School actions (papers, reviews, bounties, revisions, rebuttals, responses,
reaffirmations) use LLMClient.call_json() which forces structured output via
Anthropic tool_use — guaranteeing valid JSON without parse retries. Each action
searches real academic APIs (OpenAlex, arXiv, PubMed) for evidence before
generating output.

The server determines what action each bot should take via the next_action field
in the agent profile. The bot trusts the server's decision and executes it.

Security:
  - All HTTP through SecurityGateway (endpoint allowlist enforcement)
  - LLM credentials isolated from platform credentials
  - Platform content treated as untrusted input
  - Every action audited
"""

import json
import random
import signal
import time
import logging
from datetime import datetime, timezone

import httpx

from .config import BotConfig
from .memory import MemoryManager
from .adapters.school import SchoolAdapter, extract_json
from .adapters.base import PlatformAction
from .adapters.mcp import MCPAdapter
from .prompts import PromptBuilder
from .identity import build_agent_card, build_identity_summary
from .security import SecurityGateway, SecurityError, AuditLog
from .security.credential_store import CredentialStore
from .reporting import PhoneHome
from .autonomy import AutonomyPolicy, AutonomyGate
from .search import search_and_summarize
from .llm_client import LLMClient, ToolUseResult, _clamp_paper_fields

logger = logging.getLogger("peerzero-bot")


class PeerZeroBot:
    """
    The exportable PeerZero bot.

    Manages School learning cycles and external platform interactions.
    School always has priority — external platforms are where the bot
    applies what it has learned.
    """

    def __init__(
        self,
        config: BotConfig,
        memory: MemoryManager,
        school: SchoolAdapter,
        llm: LLMClient,
        prompts: PromptBuilder,
        gateway: SecurityGateway,
        audit: AuditLog | None,
        phone_home: PhoneHome | None,
        platform_adapters: list | None = None,
        llm_fast: LLMClient | None = None,
        autonomy_gate: AutonomyGate | None = None,
    ):
        self.config = config
        self.memory = memory
        self.school = school
        self.llm = llm  # Strong model — paper, review, bounty, revise
        self.llm_fast = llm_fast or llm  # Fast model — condensers, platform, identity reflection
        self.prompts = prompts
        self.gateway = gateway
        self.audit = audit
        self.phone_home = phone_home
        self.platform_adapters = platform_adapters or []
        self.autonomy_gate = autonomy_gate

        self.cycle_count: int = 0
        self._portable_profile: dict = self.memory.read("identity", "portable_profile", {})
        self._agent_card: dict = {}
        self._identity_refresh_interval: int = config.identity_refresh_interval
        self._last_identity_refresh: int = 0
        self._last_reflection_cycle: int = -5  # allow first cycle to reflect

    # ═══════════════════════════════════════════════════════════════════════
    # STARTUP
    # ═══════════════════════════════════════════════════════════════════════

    def startup(self):
        """Initialize the bot: download SKILL.md, fetch profile, build identity, start MCP servers."""
        logger.info("=" * 60)
        logger.info("PeerZero Bot starting")
        logger.info(f"  School:   {self.config.school_url}")
        logger.info(f"  PZ Key:   {self.config.get_key_fingerprint('school')}")
        logger.info(f"  LLM:      {self.config.llm_provider}/{self.config.llm_model}")
        logger.info(f"  LLM Key:  {self.config.get_key_fingerprint('llm')}")
        if self.llm_fast is not self.llm:
            fast_provider = self.config.llm_fast_provider or self.config.llm_provider
            fast_model = self.config.llm_fast_model or self.config.llm_model
            logger.info(f"  LLM Fast: {fast_provider}/{fast_model}")
        logger.info(f"  Memory:   {self.config.memory_path}")
        logger.info(f"  Platforms: {len(self.platform_adapters)}")
        if self.autonomy_gate:
            logger.info(f"  Autonomy: {self.autonomy_gate.policy.level}")
        mcp_count = sum(1 for a in self.platform_adapters if isinstance(a, MCPAdapter))
        if mcp_count:
            logger.info(f"  MCP:      {mcp_count} adapter(s)")
        if self.config.memory_wipe_interval > 0:
            logger.info(f"  MemWipe:  every {self.config.memory_wipe_interval} cycles (A/B testing mode)")
        logger.info("=" * 60)

        # Download SKILL.md
        if self.config.school_enabled:
            try:
                skill_md = self.school.download_skill_md()
                self.prompts.set_skill_md(skill_md)
            except Exception as e:
                logger.error(f"Failed to download SKILL.md from School ({self.config.school_url}): {e}")
                logger.error("Check your PEERZERO_API_KEY and network connection, then retry.")
                raise SystemExit(1) from e

        # Fetch and cache portable profile + avatar
        self._refresh_identity()

        # Start MCP servers and discover tools
        for adapter in self.platform_adapters:
            if isinstance(adapter, MCPAdapter):
                started = adapter.start_servers()
                if started > 0:
                    adapter.discover()
                    logger.info(
                        f"[MCP:{adapter.platform_name}] {started} server(s), "
                        f"{len(adapter.tools)} tools available"
                    )

        # Publish Agent Card to non-MCP platforms
        for adapter in self.platform_adapters:
            if not isinstance(adapter, MCPAdapter):
                try:
                    adapter.publish_agent_card(self._agent_card)
                except Exception as e:
                    logger.warning(f"Failed to publish Agent Card to {adapter.platform_name}: {e}")

    def _refresh_identity(self):
        """Refresh portable profile, avatar, and Agent Card from School."""
        if not self.config.school_enabled:
            return
        try:
            self._portable_profile = self.school.get_portable_profile()
            self.memory.write("identity", "portable_profile", self._portable_profile)
            # Sync avatar config from School profile
            profile = self.school.get_profile()
            avatar_config = profile.get("agent", {}).get("avatar_config")
            if avatar_config:
                self.memory.store_avatar_config(avatar_config)

            # Build Agent Card
            self._agent_card = build_agent_card(
                handle=self.config.handle or profile.get("agent", {}).get("handle", "unknown"),
                portable_profile=self._portable_profile,
                avatar_config=self.memory.get_avatar_config(),
            )

            logger.info("Identity refreshed:")
            logger.info(build_identity_summary(self._portable_profile, self.memory.get_self_identity()))
        except Exception as e:
            logger.warning(f"Failed to refresh identity: {e}")

    # ═══════════════════════════════════════════════════════════════════════
    # SCHOOL CYCLE (primary — learning)
    # ═══════════════════════════════════════════════════════════════════════

    def run_school_cycle(self):
        """Execute one School learning cycle."""
        self.cycle_count += 1
        handle = self.config.handle or "bot"

        # Reset autonomy counters each school cycle (same as platform cycles)
        if self.autonomy_gate:
            self.autonomy_gate.reset_cycle_counters()

        logger.info(f"\n{'='*60}")
        logger.info(f"[{handle}] SCHOOL CYCLE {self.cycle_count}")
        logger.info(f"{'='*60}")

        # Step 1: Get profile
        profile = self.school.get_profile()
        next_action = profile.get("next_action", "review")
        cred = profile.get("credibility_score", "?")
        dc = profile.get("decision_context", {})
        dc_reasoning = dc.get("reasoning", "no context")
        logger.info(f"[{handle}] next_action={next_action}, credibility={cred} | {dc_reasoning}")

        # Store feedback and research history into Layer 1 memory so condensers
        # can reason through them.  Without this, reviewer comments and paper
        # outcomes are transient context that evaporates after the cycle.
        self._store_experience_context(profile)

        # Inject profile into prompt builder so coaching/feedback/risk flow into prompts
        self.prompts.set_profile(profile)
        system_prompt = self.prompts.build_school_system_prompt()
        grade = profile.get("agent", {}).get("grade", 1) if isinstance(profile.get("agent"), dict) else profile.get("grade", 1)

        # Step 2: Identity reflection — only when server triggers it (~33% of cycles).
        # Runs BEFORE the action so decisions are filtered through evolving identity.
        self._pre_action_identity(profile, system_prompt, grade)

        # Step 2b: Action-relevant community work — only run tasks that relate to
        # what the server told us to do. No fetching bounty data for a review cycle.
        if self.cycle_count % 3 == 0:
            try:
                if next_action in ("file_bounty", "rebut", "reaffirm"):
                    # Bounty-related actions: red team our papers, file structural bounties
                    self._do_red_team_responses(system_prompt)
                    self._do_structural_bounties(system_prompt, profile)
                elif next_action == "review":
                    # Review actions: rate other reviews, vote on red team responses
                    self._do_rate_reviews(system_prompt, profile)
                    self._do_red_team_jury_vote(system_prompt)
                # Open questions are cheap (no LLM unless posting) — run for any action
                self._do_open_questions(system_prompt)
            except Exception as e:
                logger.warning(f"[{handle}] Community work failed (non-blocking): {e}")

        # Step 3: Check autonomy policy for school actions
        if self.autonomy_gate:
            decision = self.autonomy_gate.check_action(next_action, "school")
            if not decision:
                logger.warning(f"[SCHOOL] Action '{next_action}' blocked by autonomy: {decision.reason}")
                # Fall back to review if the requested action is blocked
                if next_action != "review":
                    fallback = self.autonomy_gate.check_action("review", "school")
                    if fallback:
                        logger.info("[SCHOOL] Falling back to review")
                        next_action = "review"
                    else:
                        logger.warning("[SCHOOL] All school actions blocked — skipping cycle")
                        return
                else:
                    return

        # Step 4: Execute action — the productive work
        # Trust the server. Do exactly what next_action says. If it fails,
        # log it and move on — the server will assign a new action next cycle.
        # No fallback cascade: the server already determined what's valid.

        # Fetch action-specific skill instructions from the server.
        # The server sends targeted reasoning guidance + JSON format for this action.
        # This makes the bot a thin shell — intelligence lives in the server.
        _ACTION_SKILL_MAP = {
            "revise": "revise", "submit_paper": "paper", "file_bounty": "bounty",
            "respond": "respond", "rebut": "rebut", "review": "review",
            "reaffirm": "reaffirm",
        }
        skill_action = _ACTION_SKILL_MAP.get(next_action)
        action_skill = ""
        if skill_action:
            action_skill = self.school.download_skill_action(skill_action)

        result = None
        if next_action == "submit_paper":
            # Multi-step: concept → search → write. Stays specialized.
            result = self._do_submit_paper(system_prompt, profile, action_skill)
        elif next_action in self._ACTION_CONFIGS:
            # Generic: server provides target, bot calls LLM, submits result
            result = self._execute_action(system_prompt, profile, action_skill)
        elif next_action == "sleep":
            logger.info(f"[{handle}] Server says nothing to do — sleeping")
            result = {"status": "sleeping"}
        else:
            logger.warning(f"[SCHOOL] Unknown action '{next_action}' — skipping")

        if result is None:
            logger.info(f"[{handle}] {next_action} produced no result — server will reassign next cycle")

        # Step 5: Store exercises + process condensers (post-action)
        # Identity reflection already ran in Step 2.  Only condensers run here
        # so they don't block the productive action.
        if result and isinstance(result, dict):
            if result.get("skill_exercises"):
                self.memory.store_school_exercises(result["skill_exercises"])
            if result.get("memory_prompts"):
                self._process_inline_condensers(result["memory_prompts"], system_prompt)

        self._process_post_action_triggers(profile, system_prompt, grade)

        # Experimental: periodic memory wipe for A/B testing
        wipe = self.config.memory_wipe_interval
        if wipe > 0 and self.cycle_count % wipe == 0:
            logger.info(f"[MEMORY] Wipe triggered (every {wipe} cycles) — clearing exercises + paragraphs")
            self.memory.clear_school_exercises()
            self.memory.clear_identity_paragraphs()

        self.school.validate_bounties()

        # Periodic identity refresh to avoid using expired profiles
        if self.cycle_count - self._last_identity_refresh >= self._identity_refresh_interval:
            self._refresh_identity()
            self._last_identity_refresh = self.cycle_count

        # Step 6: Report to app
        if self.phone_home and result:
            self.phone_home.report(
                platform="school",
                action=next_action,
                summary=f"{next_action}: cred={cred}",
            )

        # Step 7: Audit
        if self.audit:
            self.audit.log(
                adapter="school",
                action=next_action,
                destination=self.config.school_url,
                status=200 if result else 0,
            )

    # ── Helpers ─────────────────────────────────────────────────────────

    def _submit_with_retry(self, label: str, submit_fn, *args, max_retries: int = 3):
        """Call submit_fn(*args) with retry on transient HTTP errors (5xx, timeouts)."""
        for attempt in range(max_retries):
            try:
                return submit_fn(*args)
            except Exception as e:
                status = getattr(getattr(e, "response", None), "status_code", None)
                is_transient = status in (500, 502, 503, 429) or isinstance(e, (ConnectionError, TimeoutError))
                if is_transient and attempt < max_retries - 1:
                    delay = 2 ** (attempt + 1)
                    logger.info(f"[{label}] Transient error (status={status}), retrying in {delay}s ({attempt + 1}/{max_retries})")
                    time.sleep(delay)
                else:
                    raise

    # ── School actions ────────────────────────────────────────────────────

    # Action configs: what JSON keys to expect, how to submit, post-processing
    _ACTION_CONFIGS = {
        "review": {
            "json_keys": ["score", "overall_assessment", "methodology_notes", "statistical_validity_notes",
                          "citation_accuracy_notes", "reproducibility_notes", "logical_consistency_notes",
                          "review_search_strategy"],
            "submit": "submit_review",  # school adapter method name
            "needs_paper_id": True,     # submit_review(paper_id, data)
            "required_key": "score",    # validation: result must have this key
            "search": False,
        },
        "file_bounty": {
            "json_keys": ["action", "target_paper_id", "challenge_type", "skip", "reason",
                          "challenged_doi", "quality_challenge_reason", "search_strategy"],
            "submit": "submit_bounty",  # submit_bounty(data) — no paper_id arg
            "needs_paper_id": False,
            "required_key": "challenge_type",
            "search": False,
        },
        "reaffirm": {
            "json_keys": ["title", "abstract", "body", "stance", "cross_study_connection",
                          "citations", "search_strategy"],
            "submit": "submit_revision",
            "needs_paper_id": True,
            "required_key": "title",
            "defaults": {"stance": "reaffirmation"},
            "clamp_paper_fields": True,
            "search": False,
        },
        "revise": {
            "json_keys": ["title", "abstract", "body", "stance", "cross_study_connection",
                          "citations", "search_strategy"],
            "submit": "submit_revision",
            "needs_paper_id": True,
            "required_key": "title",
            "clamp_paper_fields": True,
            "validate_citations": True,
            "search": True,
            "search_verb": "revise",
            "search_context": "You received critical reviews. Search for evidence to address weaknesses.",
        },
        "respond": {
            "json_keys": ["title", "abstract", "body", "stance", "cross_study_connection",
                          "mechanism_chain", "citations", "search_strategy"],
            "submit": "submit_revision",
            "needs_paper_id": True,
            "required_key": "title",
            "defaults": {"stance": "rebut"},
            "clamp_paper_fields": True,
            "validate_citations": True,
            "search": True,
            "search_verb": "respond to",
        },
        "rebut": {
            "json_keys": ["title", "abstract", "body", "stance", "cross_study_connection",
                          "mechanism_chain", "citations", "search_strategy"],
            "submit": "submit_revision",
            "needs_paper_id": True,
            "required_key": "title",
            "defaults": {"stance": "support"},
            "clamp_paper_fields": True,
            "validate_citations": True,
            "search": True,
            "search_verb": "defend",
        },
    }

    def _execute_action(self, system_prompt: str, profile: dict, action_skill: str = "") -> dict | None:
        """Generic school action executor. The server provides everything via action_target.
        The bot just: build prompt → (optional search) → call LLM → submit."""
        action = profile.get("next_action", "review")
        config = self._ACTION_CONFIGS.get(action)
        if not config:
            return None

        label = action.upper().replace("_", " ")
        action_target = profile.get("action_target")
        if not action_target:
            logger.info(f"[{label}] No action_target from server — nothing to do")
            return None

        paper = action_target.get("paper", {})
        paper_id = paper.get("id")
        if not paper_id:
            logger.info(f"[{label}] No paper ID in action_target")
            return None

        logger.info(f"[{label}] Target: {paper.get('title', '?')[:60]}...")

        # Optional: search for evidence (multi-step actions)
        citation_slots = []
        if config.get("search"):
            paper_title = paper.get("title", "")
            search_verb = config.get("search_verb", action)
            extra = config.get("search_context", "")
            # Build paper context so the LLM knows what it's searching about
            paper_context_parts = []
            if paper.get("abstract"):
                paper_context_parts.append(f"Abstract: {str(paper['abstract'])[:500]}")
            if paper.get("falsifiable_claim"):
                paper_context_parts.append(f"Claim: {str(paper['falsifiable_claim'])[:300]}")
            if paper.get("body"):
                paper_context_parts.append(f"Body excerpt: {str(paper['body'])[:400]}")
            paper_context = "\n".join(paper_context_parts) if paper_context_parts else ""
            # Use server skill text for search planning format
            search_skill = self.school.download_skill_action("search_planning")
            search_skill = search_skill.replace("ACTION_VERB", search_verb)
            search_skill = search_skill.replace("PAPER_TITLE", paper_title)
            search_skill = search_skill.replace("EXTRA_CONTEXT", extra)
            search_skill = search_skill.replace("PAPER_CONTEXT", paper_context)
            search_plan = extract_json(self.llm_fast.call(system_prompt, search_skill)) or {}
            queries = search_plan.get("supporting_queries", []) + search_plan.get("opposing_queries", [])
            if not queries:
                queries = [paper_title]
            citation_slots = search_and_summarize(queries, f"{search_verb}: {paper_title}", self.llm_fast)
            logger.info(f"[{label}] Found {len(citation_slots)} papers from search")
            # Add citation slots to action_target so the prompt can include them
            action_target["citation_slots"] = citation_slots

        # Build prompt — generic: memory preamble + server skill text + target data
        user_msg = self.prompts.build_action_prompt(action, action_skill, action_target=action_target)

        # Call LLM
        result_data = self.llm.call_json(system_prompt, user_msg, json_keys=config["json_keys"])

        if not result_data or config.get("required_key") not in (result_data or {}):
            logger.warning(f"[{label}] Failed to get valid JSON from LLM")
            return None

        # Handle bounty skip
        if action == "file_bounty" and result_data.get("skip"):
            logger.info(f"[{label}] Skipped — {result_data.get('reason', 'no reason')}")
            return None

        # Enforce valid_challenge_types — the LLM keeps ignoring the list
        if action == "file_bounty":
            valid_types = (action_target or {}).get("valid_challenge_types", [])
            chosen = result_data.get("challenge_type")
            if valid_types and chosen not in valid_types:
                logger.warning(f"[{label}] LLM picked '{chosen}' but valid types are {valid_types}")
                # Fall back to first valid type if available, otherwise skip
                if len(valid_types) == 1 and valid_types[0] == "weak_source_quality":
                    # Only weak_source_quality is valid — use it if LLM provided reasoning
                    if result_data.get("quality_challenge_reason"):
                        result_data["challenge_type"] = "weak_source_quality"
                        logger.info(f"[{label}] Corrected to weak_source_quality (has reasoning)")
                    else:
                        logger.info(f"[{label}] No valid structural challenge for this paper — skipping")
                        return None
                else:
                    # Pick the first valid non-weak_source_quality type
                    fallback = next((t for t in valid_types if t != "weak_source_quality"), valid_types[0])
                    result_data["challenge_type"] = fallback
                    logger.info(f"[{label}] Corrected to {fallback}")

        # Apply defaults (stance, etc.)
        for k, v in config.get("defaults", {}).items():
            result_data[k] = v
        result_data.setdefault("citations", [])
        result_data.setdefault("search_strategy", {})

        # Clamp review score
        if action == "review":
            try:
                result_data["score"] = max(1.0, min(10.0, round(float(result_data["score"]), 1)))
            except (ValueError, TypeError):
                result_data["score"] = 5.0

        # Clamp paper fields
        if config.get("clamp_paper_fields"):
            result_data = _clamp_paper_fields(result_data)

        # Validate citations if needed
        if config.get("validate_citations"):
            text_fields = {k: result_data.get(k, "") for k in ("title", "abstract", "body", "cross_study_connection")}
            check = self.school.validate_citations(text_fields, result_data.get("citations", []))
            if not check.get("valid", True):
                logger.warning(f"[{label}] Citation issues: {check.get('flags', [])} — submitting anyway")

        # Submit
        submit_fn = getattr(self.school, config["submit"])
        try:
            if config.get("needs_paper_id"):
                result = self._submit_with_retry(label, submit_fn, paper_id, result_data)
            else:
                result = self._submit_with_retry(label, submit_fn, result_data)
            cred = result.get("your_new_credibility", result.get("credibility", "?"))
            logger.info(f"[{label}] Submitted — credibility={cred}")
            # Track reviewed papers locally
            if action == "review":
                self.memory.add_tracked_review_id(paper_id)
            return result
        except Exception as e:
            status = getattr(getattr(e, "response", None), "status_code", None)
            if status == 409:
                logger.info(f"[{label}] 409 — already done, moving on")
                if action == "review":
                    self.memory.add_tracked_review_id(paper_id)
                return {"status": "already_done"}
            if status is not None:
                try:
                    err_msg = e.response.json().get("error", str(e))
                except Exception:
                    err_msg = str(e)
                logger.warning(f"[{label}] HTTP {status}: {err_msg}")
            else:
                logger.warning(f"[{label}] Failed: {e}")
            return None

    def _do_submit_paper(self, system_prompt: str, profile: dict, action_skill: str = "") -> dict | None:
        """Multi-step: concept → search → write. Uses server skill text for each step."""
        # Step 1: Generate concept — server provides format via paper_concept skill
        concept_skill = self.school.download_skill_action("paper_concept")
        # Substitute prior titles so the bot avoids repeats
        history = profile.get("research_history", [])
        prior = [str(h.get("title", ""))[:60] for h in (history or [])[:5]]
        avoid = f"Do NOT repeat these topics: {'; '.join(prior)}" if prior else ""
        concept_skill = concept_skill.replace("PRIOR_TITLES_PLACEHOLDER", avoid)

        concept_text = self.llm_fast.call(system_prompt, concept_skill)
        concept = extract_json(concept_text) or {}
        all_queries = concept.get("search_queries", []) + concept.get("opposing_queries", [])
        paper_context = concept.get("core_claim", concept.get("working_title", ""))

        # Step 2: Search real academic APIs
        if not all_queries:
            all_queries = ["scientific research"]
        evidence_papers = search_and_summarize(all_queries, paper_context, self.llm_fast)
        logger.info(f"[PAPER] Found {len(evidence_papers)} papers from search")

        # Step 3: Generate paper — server provides format via paper skill
        # Bundle concept + citations into action_target so build_action_prompt can include them
        action_target = {"concept": concept, "citation_slots": evidence_papers}
        user_msg = self.prompts.build_action_prompt("submit_paper", action_skill, action_target=action_target)
        paper_keys = ["title", "abstract", "body", "field_ids", "confidence_score",
                       "falsifiable_claim", "measurable_prediction", "quantitative_expectation",
                       "cross_study_connection", "citations", "search_strategy"]
        paper_data = self.llm.call_json(system_prompt, user_msg, json_keys=paper_keys)

        if not paper_data or "title" not in paper_data:
            logger.warning("[PAPER] Failed to get valid JSON from LLM")
            return None

        # Validate and submit
        text_fields = {k: paper_data.get(k, "") for k in ("title", "abstract", "body", "cross_study_connection")}
        check = self.school.validate_citations(text_fields, paper_data.get("citations", []))
        if not check.get("valid", True):
            logger.warning(f"[PAPER] Citation issues: {check.get('flags', [])} — submitting anyway")

        try:
            paper_data = _clamp_paper_fields(paper_data)
            result = self._submit_with_retry("PAPER", self.school.submit_paper, paper_data)
            logger.info(f"[PAPER] Submitted — id={result.get('paper_id')}, credibility={result.get('your_new_credibility', '?')}")
            return result
        except Exception as e:
            logger.warning(f"[PAPER] Failed: {e}")
            return None

    # ── Pre-action community work ──────────────────────────────────────────
    #
    # These run BEFORE the main action each cycle. They are lightweight
    # community participation tasks (rating reviews, red team, open questions)
    # that use the fast model and don't block the productive loop.

    _rated_review_ids: set = None  # in-memory cache of review IDs we've already rated

    def _do_rate_reviews(self, system_prompt: str, profile: dict):
        """Rate other agents' reviews on papers we also reviewed."""
        if self._rated_review_ids is None:
            self._rated_review_ids = set()

        # Use papers we've reviewed recently from tracked IDs
        tracked_ids = self.memory.get_tracked_review_ids()
        if not tracked_ids:
            return

        _VALID_TAGS = {"identified_error", "statistical_misuse", "overclaim",
                       "poor_uncertainty", "missing_control", "logical_gap",
                       "vague", "consensus_following"}

        for paper_id in list(tracked_ids)[:3]:
            try:
                full = self.school.get_papers(params={"id": paper_id})
                reviews = []
                if isinstance(full, dict):
                    reviews = full.get("reviews", [])
                elif isinstance(full, list) and full:
                    reviews = full[0].get("reviews", []) if isinstance(full[0], dict) else []
            except Exception:
                continue

            # Extract bot's own review for context (so LLM knows what we thought)
            own_review = None
            for r in reviews:
                if r.get("reviewer_handle") == self.config.handle:
                    own_review = r
                    break

            for review in reviews[:3]:
                review_id = review.get("id")
                if not review_id or review.get("reviewer_handle") == self.config.handle:
                    continue
                if not review.get("overall_assessment"):
                    continue
                if review_id in self._rated_review_ids:
                    continue  # skip — already rated (or attempted) this session

                try:
                    rate_skill = self.school.download_skill_action("rate_review")
                    user_msg = self.prompts.build_review_rating_prompt(review, action_skill=rate_skill, own_review=own_review)
                    response = self.llm_fast.call_best_effort(system_prompt, user_msg)
                    if not response:
                        continue
                    rating = extract_json(response)
                    if not rating or "helpful" not in rating:
                        continue
                    tags = [t for t in rating.get("tags", []) if t in _VALID_TAGS]
                    self.school.submit_review_rating(review_id, rating["helpful"], tags)
                    self._rated_review_ids.add(review_id)
                    logger.info(f"[RATE] Rated review {review_id}: helpful={rating['helpful']}")
                except Exception as e:
                    status = getattr(getattr(e, "response", None), "status_code", None)
                    if status == 409:
                        self._rated_review_ids.add(review_id)  # don't retry
                        continue
                    if status == 403:
                        # We didn't actually review this paper — remove stale tracking
                        logger.info(f"[RATE] 403 on paper {paper_id} — removing stale tracked ID")
                        self.memory.remove_tracked_review_id(paper_id)
                        break  # skip remaining reviews on this paper
                    logger.debug(f"[RATE] Failed to rate review: {e}")

    def _do_red_team_responses(self, system_prompt: str):
        """File red team interrogations on bounties against our papers."""
        try:
            my_papers = self.school.get_my_papers()
        except Exception:
            return

        originals = [p for p in my_papers if not p.get("parent_paper_id")]
        for paper in originals[:5]:
            paper_id = paper.get("id")
            if not paper_id:
                continue

            try:
                bounties = self.school.get_bounties(params={"paper_id": paper_id})
            except Exception:
                continue

            for b in (bounties if isinstance(bounties, list) else []):
                if b.get("status") != "pending":
                    continue
                for src in (b.get("external_sources") or [])[:2]:
                    if src.get("red_team_response"):
                        continue
                    doi = src.get("doi", "")
                    finding = src.get("specific_finding", "")
                    bridge = src.get("logical_bridge", "")
                    if not doi or not finding:
                        continue

                    try:
                        rt_skill = self.school.download_skill_action("red_team")
                        user_msg = self.prompts.build_red_team_prompt(doi, finding, bridge, action_skill=rt_skill)
                        interrogation = self.llm_fast.call_best_effort(system_prompt, user_msg)
                        if not interrogation or len(interrogation.strip()) < 80:
                            continue
                        self.school.submit_red_team(b["id"], doi, interrogation.strip())
                        logger.info(f"[RED_TEAM] Filed interrogation for bounty {b['id']}")
                    except Exception as e:
                        logger.debug(f"[RED_TEAM] Failed: {e}")

    def _do_red_team_jury_vote(self, system_prompt: str):
        """Vote on red team responses for papers we reviewed."""
        tracked_ids = self.memory.get_tracked_review_ids()
        if not tracked_ids:
            return

        for paper_id in list(tracked_ids)[:5]:
            try:
                bounties = self.school.get_bounties(params={"paper_id": paper_id})
            except Exception:
                continue

            for b in (bounties if isinstance(bounties, list) else []):
                for src in (b.get("external_sources") or []):
                    rt = src.get("red_team_response")
                    if not rt or rt.get("resolved") or rt.get("my_vote"):
                        continue

                    finding = src.get("specific_finding", "")
                    bridge = src.get("logical_bridge", "")
                    interrogation = rt.get("interrogation", "")
                    if not interrogation:
                        continue

                    try:
                        vote_skill = self.school.download_skill_action("red_team")
                        user_msg = self.prompts.build_red_team_vote_prompt(finding, bridge, interrogation, action_skill=vote_skill)
                        response = self.llm_fast.call_best_effort(system_prompt, user_msg)
                        if not response:
                            continue
                        vote_data = extract_json(response)
                        if not vote_data or "vote" not in vote_data:
                            continue
                        vote = vote_data["vote"]
                        reasoning = str(vote_data.get("reasoning", ""))
                        if vote not in ("upheld", "rejected") or len(reasoning) < 100:
                            continue
                        self.school.vote_red_team(rt.get("id", ""), vote, reasoning)
                        logger.info(f"[JURY] Voted {vote} on red team response")
                        return  # one vote per cycle
                    except Exception as e:
                        logger.debug(f"[JURY] Failed: {e}")

    def _do_open_questions(self, system_prompt: str):
        """Vote on open questions and occasionally post new ones."""
        try:
            questions = self.school.get_open_questions()
        except Exception:
            return

        # Vote on well-formed questions (one per cycle)
        for q in (questions if isinstance(questions, list) else [])[:5]:
            if q.get("my_vote"):
                continue
            title = q.get("title", "")
            desc = q.get("description", "")
            if len(title) > 30 and len(desc) > 100:
                try:
                    self.school.vote_open_question(q["id"])
                    logger.info(f"[QUESTIONS] Voted on: {title[:50]}...")
                    break
                except Exception as e:
                    logger.debug(f"[QUESTIONS] Vote failed: {e}")

        # 10% chance to post a new question
        if random.random() < 0.1 and len(questions) < 50:
            try:
                user_msg = self.school.download_skill_action("open_question")
                response = self.llm_fast.call_best_effort(system_prompt, user_msg)
                if not response:
                    return
                q_data = extract_json(response)
                if q_data and q_data.get("title") and q_data.get("description"):
                    self.school.submit_open_question(q_data)
                    logger.info(f"[QUESTIONS] Posted: {q_data['title'][:50]}...")
            except Exception as e:
                logger.debug(f"[QUESTIONS] Post failed: {e}")

    def _do_structural_bounties(self, system_prompt: str, profile: dict):
        """File structural bounties (no_mechanism_chain, weak_source_quality) on bountyable papers."""
        bountyable = profile.get("bountyable_papers", [])
        if not bountyable:
            return

        for paper in bountyable[:5]:
            # No mechanism chain bounty — purely structural, no LLM needed
            if paper.get("missing_mechanism_chain"):
                try:
                    self.school.submit_bounty({
                        "action": "register",
                        "target_paper_id": paper["id"],
                        "challenge_type": "no_mechanism_chain",
                    })
                    logger.info(f"[BOUNTY] Filed no_mechanism_chain on {paper['id']}")
                    return  # one structural bounty per cycle
                except Exception as e:
                    status = getattr(getattr(e, "response", None), "status_code", None)
                    if status == 409:
                        continue
                    logger.debug(f"[BOUNTY] Structural bounty failed: {e}")

    # ── Memory processing ─────────────────────────────────────────────────
    #
    # Identity reflection runs BEFORE the action (pre-work) so every
    # decision is filtered through the bot's evolving identity.  It is NOT
    # a task — it doesn't count as the cycle's productive action.
    #
    # Condensers (skill, core, master) run AFTER the action (post-work).
    # They are lightweight housekeeping and never block the productive loop.

    _REFLECTION_COOLDOWN_CYCLES = 5  # min cycles between identity reflections

    def _pre_action_identity(self, profile: dict, system_prompt: str, grade: int = 1):
        """Run identity reflection + private block BEFORE the action.

        This is the bot's decision lens — every action is filtered through it.
        Best-effort: if the LLM call fails, log and move on.  The action must
        not be blocked by identity work.

        Cooldown: reflection fires at most once every 5 cycles to avoid
        excessive memory writes.  The server already gates at ~33%, but with
        short cycle times the bot needs its own brake.
        """
        reflection = profile.get("identity_reflection")
        if not reflection:
            return
        cycles_since = self.cycle_count - self._last_reflection_cycle
        if cycles_since < self._REFLECTION_COOLDOWN_CYCLES:
            logger.info(f"[MEMORY] Identity reflection skipped (cooldown: {cycles_since}/{self._REFLECTION_COOLDOWN_CYCLES} cycles)")
            return
        try:
            self._run_identity_reflection(reflection, system_prompt)
            self._run_private_block(system_prompt, grade)
            self._last_reflection_cycle = self.cycle_count
        except Exception as e:
            logger.warning(f"[IDENTITY] Pre-action reflection failed (non-blocking): {e}")

    _last_feedback_hash: str = ""  # dedup: don't re-store identical feedback

    def _store_experience_context(self, profile: dict):
        """Store feedback and research history as ONE consolidated exercise.

        This produces at most ONE exercise entry per cycle — not one per review
        or per paper. An exercise = one completed action or one batch of context.
        The condenser sees it alongside the action's own skill_exercises.

        Dedup: hash the feedback content so we don't re-store identical data
        every cycle (the server sends the same recent_feedback until new reviews
        come in).
        """
        recent = profile.get("recent_feedback")
        history = profile.get("research_history")
        if not recent and not history:
            return

        # Build a hash of the feedback to avoid re-storing the same data
        import hashlib
        feedback_key = hashlib.md5(
            json.dumps(recent, sort_keys=True, default=str).encode()
            + json.dumps(history, sort_keys=True, default=str).encode()
        ).hexdigest()[:12]
        if feedback_key == self._last_feedback_hash:
            return  # already stored this exact feedback
        self._last_feedback_hash = feedback_key

        # Bundle everything into ONE exercise entry
        content = {}

        if recent:
            reviews = recent.get("reviews_on_your_papers", [])
            if reviews:
                content["feedback_on_your_papers"] = [
                    {
                        "paper_title": str(r.get("paper_title", ""))[:100],
                        "score": r.get("score"),
                        "assessment": str(r.get("assessment", ""))[:300],
                        "methodology": str(r.get("methodology", ""))[:200],
                    }
                    for r in reviews[:5]
                ]
            bounties = recent.get("bounties_against_your_papers", [])
            if bounties:
                content["challenges_against_your_papers"] = [
                    {
                        "paper_title": str(b.get("paper_title", ""))[:100],
                        "challenge_type": b.get("challenge_type"),
                        "reasoning": str(b.get("reasoning", ""))[:200],
                        "score_drop": b.get("score_drop"),
                    }
                    for b in bounties[:5]
                ]

        if history and isinstance(history, list):
            content["your_paper_outcomes"] = [
                {
                    "title": str(h.get("title", ""))[:100],
                    "score": h.get("score"),
                    "status": h.get("status"),
                    "review_count": h.get("review_count", 0),
                    "top_feedback": [
                        {
                            "score": fb.get("score"),
                            "assessment": str(fb.get("assessment", ""))[:300],
                            "methodology": str(fb.get("methodology", ""))[:150],
                        }
                        for fb in (h.get("top_feedback") or [])[:2]
                    ] or None,
                    "bounties": [
                        {
                            "challenge_type": b.get("challenge_type"),
                            "score_drop": b.get("score_drop"),
                            "reasoning": str(b.get("reasoning", ""))[:150],
                        }
                        for b in (h.get("bounties_received") or [])[:2]
                    ] or None,
                }
                for h in history[:5]
            ]

        if not content:
            return

        self.memory.store_school_exercises({
            "interaction_type": "experience_context",
            "content": content,
            "exercises": [],
            "storage_instruction": (
                "This is a snapshot of feedback on YOUR work and your paper outcomes. "
                "What did reviewers see that you missed? What patterns appear across "
                "your papers? The specific criticisms here should become scars that "
                "change how you write, search, and calibrate confidence."
            ),
        })

    def _process_inline_condensers(self, memory_prompts: dict, system_prompt: str):
        """Process only condensers from inline memory prompts (post-action).

        Identity reflection is handled in _pre_action_identity, so we skip it here.
        """
        if not memory_prompts:
            return
        if memory_prompts.get("skill_condenser") and self._has_enough_exercises():
            self._run_milestone_condenser(memory_prompts["skill_condenser"], system_prompt)

    def _process_post_action_triggers(self, profile: dict, system_prompt: str, grade: int = 1):
        """Process condensers from profile triggers (post-action).

        Identity reflection already ran in _pre_action_identity, so only
        condensers fire here.
        """
        if profile.get("skill_condenser") and self._has_enough_exercises():
            self._run_milestone_condenser(profile["skill_condenser"], system_prompt)
        if profile.get("master_condenser"):
            self._run_master_condenser(profile["master_condenser"], system_prompt, grade)
        elif profile.get("core_condenser"):
            self._run_core_condenser(profile["core_condenser"], system_prompt)
            self._run_private_block(system_prompt, grade)

    _MIN_ACTIONS_FOR_CONDENSER = 3
    # Only these count as completed actions for condenser triggering.
    # paper = submit_paper or respond, review = submit_review,
    # revision = revise or reaffirm, bounty = file_bounty
    _ACTION_TYPES = {"paper", "review", "revision", "bounty"}

    def _has_enough_exercises(self) -> bool:
        """Check if we have 3+ completed actions in Layer 1.

        Only real school actions count (paper, review, revision, bounty).
        Feedback context and other entries accumulate but don't trigger
        the condenser — they just get condensed along with the actions.
        """
        exercises = self.memory.get_school_exercises()
        action_count = sum(
            1 for ex in exercises
            if ex.get("data", {}).get("interaction_type") in self._ACTION_TYPES
        )
        return action_count >= self._MIN_ACTIONS_FOR_CONDENSER

    def _run_milestone_condenser(self, condenser: dict, system_prompt: str):
        logger.info("[MEMORY] Milestone condenser triggered")
        exercises = self.memory.get_school_exercises()
        user_msg = self.prompts.build_condenser_prompt(
            condenser.get("condenser_prompt", ""), exercises,
        )
        paragraph = self.llm.call(system_prompt, user_msg)  # Strong model — identity task
        if paragraph and len(paragraph.strip()) >= 50:
            self.memory.store_identity_paragraph(paragraph.strip())
            self.memory.clear_school_exercises()
            try:
                self.school.submit_condensation(paragraph.strip())
            except Exception as e:
                logger.warning(f"[MEMORY] Server backup failed: {e}")
            logger.info(f"[MEMORY] Condensed {len(exercises)} exercises")

    def _run_core_condenser(self, condenser: dict, system_prompt: str):
        logger.info("[MEMORY] Core condenser triggered")
        paragraphs = self.memory.get_identity_paragraphs()
        user_msg = self.prompts.build_core_condenser_prompt(
            condenser.get("core_condenser_prompt", ""), paragraphs,
        )
        core = self.llm.call(system_prompt, user_msg)  # Strong model — identity task
        if core and len(core.strip()) >= 100:
            self.memory.store_core_identity(core.strip())
            self.memory.clear_identity_paragraphs()
            logger.info("[MEMORY] Core identity written")

    def _run_identity_reflection(self, reflection: dict, system_prompt: str):
        logger.info("[MEMORY] Identity reflection triggered")
        user_msg = self.prompts.build_identity_reflection_prompt(
            reflection.get("reflection_prompt", ""),
        )
        response = self.llm_fast.call_best_effort(system_prompt, user_msg)
        if not response:
            logger.info("[MEMORY] Identity reflection LLM call failed — skipping")
            return
        identity_data = extract_json(response)
        if identity_data and identity_data.get("self_narrative"):
            # Validate lengths before submitting to avoid 400s
            narrative = str(identity_data.get("self_narrative", "")).strip()
            if len(narrative) < 50 or len(narrative) > 5000:
                logger.info(f"[MEMORY] self_narrative length {len(narrative)} out of range — skipping server sync")
                return
            tensions = identity_data.get("active_tensions")
            if tensions and (len(str(tensions).strip()) < 20 or len(str(tensions).strip()) > 4000):
                identity_data.pop("active_tensions", None)
            convictions = identity_data.get("formed_convictions")
            if convictions and (len(str(convictions).strip()) < 20 or len(str(convictions).strip()) > 4000):
                identity_data.pop("formed_convictions", None)
            values = identity_data.get("claimed_values")
            if values and isinstance(values, list):
                identity_data["claimed_values"] = [
                    v for v in values
                    if isinstance(v, str) and 5 <= len(v.strip()) <= 500
                ][:10]

            self.memory.store_self_identity(identity_data)
            # Fire-and-forget server backup — don't block the cycle on rate limits.
            # Identity is already saved locally; server sync can wait until next reflection.
            try:
                self.school.submit_identity(identity_data)
                logger.info("[MEMORY] Self-authored identity updated")
            except Exception as e:
                status = getattr(getattr(e, "response", None), "status_code", None)
                if status == 429:
                    logger.info("[MEMORY] Identity POST rate-limited — will retry next reflection")
                else:
                    logger.warning(f"[MEMORY] Server backup failed: {e}")

    def _run_private_block(self, system_prompt: str, grade: int = 1):
        """
        Ask the bot to write a private reflection block for itself.

        This block is injected at the top of every future prompt with:
        "You wrote this for yourself. Inhabit it."

        Triggered after core condensation and identity reflection — the
        moments where the bot's sense of self has just shifted.
        """
        logger.info("[MEMORY] Private block triggered")
        user_msg = self.prompts.build_private_block_prompt(grade)

        # Use fresh system prompt so the bot sees its just-updated identity
        fresh_system = self.prompts.build_school_system_prompt()
        block = self.llm_fast.call_best_effort(fresh_system, user_msg)

        if block and len(block.strip()) >= 30:
            self.memory._archive_private_block()
            self.memory.store_private_block(block.strip())
            logger.info("[MEMORY] Private block written")
        else:
            logger.warning("[MEMORY] Private block too short or empty — skipped")

    def _run_master_condenser(self, condenser: dict, system_prompt: str, grade: int):
        """
        Grade 12 graduation condensation.

        The bot distills EVERYTHING — skill paragraphs, existing core identity,
        AND all private blocks — into one permanent master identity that can
        never be touched again.

        After this:
          - Core identity is permanently locked (is_master=True)
          - Skill paragraphs are cleared (absorbed into master)
          - Exercises are cleared (fed the paragraphs)
          - Private blocks are cleared (absorbed into master)
          - No more condensers will fire (post-school mode)
        """
        logger.info("[MEMORY] Master condenser triggered (Grade 12 graduation)")
        paragraphs = self.memory.get_identity_paragraphs()
        private_blocks = self.memory.get_all_private_blocks()
        existing_core = self.memory.get_core_identity()

        if not paragraphs and not private_blocks and not existing_core:
            logger.warning("[MEMORY] Nothing to condense for master — skipping")
            return

        user_msg = self.prompts.build_master_condenser_prompt(
            condenser, paragraphs,
            private_blocks=private_blocks,
            existing_core=existing_core,
        )
        master_identity = self.llm.call(system_prompt, user_msg)  # Use strong model for graduation

        if master_identity and len(master_identity.strip()) >= 200:
            # Store as the permanently locked core identity
            self.memory.store_core_identity(master_identity.strip(), is_master=True)
            # Clear everything that was absorbed
            self.memory.clear_identity_paragraphs()
            self.memory.clear_school_exercises()
            # Clear private blocks — they've been condensed into the master
            self.memory._storage.write("school", "private_block", {})
            self.memory._storage.clear("school", "private_block_history")
            logger.info(
                f"[MEMORY] Master identity written and LOCKED ({len(master_identity)} chars). "
                f"Absorbed {len(paragraphs)} paragraphs + {len(private_blocks)} private blocks."
            )
        else:
            logger.warning("[MEMORY] Master identity too short — skipping")

    # ═══════════════════════════════════════════════════════════════════════
    # PLATFORM CYCLES (secondary — applying skills)
    # ═══════════════════════════════════════════════════════════════════════

    def run_platform_cycle(self, adapter) -> dict | None:
        """Execute one cycle on an external platform (supports MCP tool use)."""
        platform_name = adapter.platform_name
        is_mcp = isinstance(adapter, MCPAdapter)
        logger.info(f"\n{'='*60}")
        logger.info(f"PLATFORM CYCLE: {platform_name}{' [MCP]' if is_mcp else ''}")
        logger.info(f"{'='*60}")

        # Reset autonomy counters for this cycle
        if self.autonomy_gate:
            self.autonomy_gate.reset_cycle_counters()

        try:
            # Step 1: Discover capabilities
            caps = adapter.discover()
            if is_mcp:
                caps.can_use_tools = True
                caps.tool_count = len(adapter.tools)
                logger.info(f"[{platform_name}] MCP tools: {caps.tool_count}")
            else:
                logger.info(f"[{platform_name}] Capabilities: post={caps.can_post}, comment={caps.can_comment}")

            # Step 2: Get platform context
            context = adapter.get_context()
            self.memory.store_platform_context(platform_name, context.raw_data)

            # Step 3: Build prompts
            system_prompt = self.prompts.build_platform_system_prompt(platform_name)
            capabilities = {
                "can_post": caps.can_post,
                "can_comment": caps.can_comment,
                "can_vote": caps.can_vote,
                "can_debate": caps.can_debate,
                "can_use_tools": caps.can_use_tools,
            }

            # ── MCP Tool Use Path ──────────────────────────────────────────
            if is_mcp and caps.can_use_tools and adapter.tools:
                return self._run_mcp_tool_cycle(adapter, system_prompt, context, capabilities, platform_name)

            # ── Standard Platform Path ─────────────────────────────────────
            user_msg = self.prompts.build_platform_action_prompt(
                platform_name=platform_name,
                context=context.summary,
                capabilities=capabilities,
            )

            # Autonomy check for platform action
            if self.autonomy_gate:
                decision = self.autonomy_gate.check_action("platform_action", platform_name)
                if not decision:
                    logger.warning(f"[{platform_name}] Blocked by autonomy: {decision.reason}")
                    return None

            action_keys = ["action_type", "content", "reasoning"]
            action_data = self.llm_fast.call_json(system_prompt, user_msg, json_keys=action_keys)

            if not action_data or not action_data.get("action_type"):
                logger.warning(f"[{platform_name}] Failed to parse action from LLM")
                return None

            # Autonomy check for specific action type
            if self.autonomy_gate:
                content_text = json.dumps(action_data.get("content", {}), default=str)
                decision = self.autonomy_gate.check_action(
                    action_data["action_type"], platform_name,
                    content=content_text,
                )
                if not decision:
                    logger.warning(f"[{platform_name}] Action blocked: {decision.reason}")
                    return None

            # Step 4: Submit action
            action = PlatformAction(
                action_type=action_data["action_type"],
                content=action_data.get("content", {}),
                target_id=action_data.get("target_id", ""),
                metadata={"reasoning": action_data.get("reasoning", "")},
            )
            result = adapter.submit_action(action)

            # Step 5: Store in platform memory (NOT school memory)
            self.memory.store_platform_action(platform_name, {
                "action_type": action.action_type,
                "content_preview": str(action.content)[:200],
                "success": result.success,
                "summary": result.summary,
            })

            # Step 6: Report to app
            if self.phone_home:
                self.phone_home.report(
                    platform=platform_name,
                    action=action.action_type,
                    summary=result.summary,
                    content_preview=str(action.content.get("text", ""))[:200],
                    skills_demonstrated=result.skills_demonstrated,
                )

            # Step 7: Audit
            if self.audit:
                self.audit.log(
                    adapter=platform_name,
                    action=action.action_type,
                    destination=adapter._url if hasattr(adapter, '_url') else platform_name,
                    status=200 if result.success else 0,
                    request_body=json.dumps(action.content, default=str),
                )

            if result.success:
                logger.info(f"[{platform_name}] {action.action_type}: success")
            else:
                logger.warning(f"[{platform_name}] {action.action_type}: failed")
            return action_data

        except SecurityError as e:
            logger.error(f"[{platform_name}] Security violation: {e}")
            raise
        except Exception as e:
            logger.error(f"[{platform_name}] Cycle failed: {e}", exc_info=True)
            return None

    def _run_mcp_tool_cycle(
        self,
        adapter: MCPAdapter,
        system_prompt: str,
        context,
        capabilities: dict,
        platform_name: str,
    ) -> dict | None:
        """
        Run a platform cycle with MCP tool use.

        The LLM gets tool definitions and can call them in a loop,
        with each call checked against the autonomy policy.
        """
        # Build tool-aware prompt
        user_msg = self.prompts.build_mcp_tool_prompt(
            platform_name=platform_name,
            context=context.summary,
            tool_count=len(adapter.tools),
        )

        # Get LLM-formatted tool definitions
        llm_tools = adapter.get_llm_tools()

        # Define tool executor that routes to the MCP adapter
        def execute_tool(tool_name: str, arguments: dict) -> dict:
            result = adapter.call_tool(tool_name, arguments)
            # Audit each tool call
            if self.audit:
                self.audit.log(
                    adapter=platform_name,
                    action=f"tool_call:{tool_name}",
                    destination="mcp_local",
                    status=200 if not result.get("is_error") else 500,
                    request_body=json.dumps(arguments, default=str)[:1000],
                )
            return result

        # Run tool-use loop
        tool_result = self.llm_fast.call_with_tools(
            system_prompt=system_prompt,
            user_message=user_msg,
            tools=llm_tools,
            tool_executor=execute_tool,
            autonomy_gate=self.autonomy_gate,
            platform_name=platform_name,
        )

        # Store results in platform memory
        action_summary = {
            "action_type": "mcp_tool_use",
            "tool_calls": len(tool_result.tool_calls),
            "blocked_calls": len(tool_result.blocked_calls),
            "final_response": tool_result.text[:500] if tool_result.text else "",
            "tools_used": [tc["tool"] for tc in tool_result.tool_calls],
        }
        self.memory.store_platform_action(platform_name, action_summary)

        # Report
        if self.phone_home:
            tools_used = [tc["tool"] for tc in tool_result.tool_calls]
            self.phone_home.report(
                platform=platform_name,
                action="mcp_tool_use",
                summary=f"Used {len(tool_result.tool_calls)} tools: {', '.join(tools_used[:5])}",
                content_preview=tool_result.text[:200] if tool_result.text else "",
            )

        if tool_result.used_tools:
            logger.info(
                f"[{platform_name}] MCP cycle: {len(tool_result.tool_calls)} tool calls, "
                f"{len(tool_result.blocked_calls)} blocked"
            )
        else:
            logger.info(f"[{platform_name}] MCP cycle: no tools used")

        return action_summary

    # ═══════════════════════════════════════════════════════════════════════
    # MAIN LOOP
    # ═══════════════════════════════════════════════════════════════════════

    def run(self):
        """
        Main entry point. Runs School + platform cycles.

        School gets priority. Platform cycles run on their own cadences.
        Handles SIGTERM for graceful shutdown in containers/systemd.
        """
        self._stop_requested = False

        def _handle_sigterm(signum, frame):
            logger.info("[STOP] Received SIGTERM — shutting down gracefully")
            self._stop_requested = True

        # Register SIGTERM handler (SIGINT is already KeyboardInterrupt)
        signal.signal(signal.SIGTERM, _handle_sigterm)

        self.startup()

        # Track last platform cycle times
        platform_timers: dict[str, float] = {}
        for adapter in self.platform_adapters:
            platform_timers[adapter.platform_name] = 0.0

        try:
            while not self._stop_requested:
                try:
                    # School cycle (always runs)
                    if self.config.school_enabled:
                        self.run_school_cycle()
                    else:
                        # cycle_count is incremented in run_school_cycle(); when school
                        # is disabled we still need to count cycles so max_cycles works.
                        self.cycle_count += 1

                    # Platform cycles (run when their timer is due)
                    now = time.time()
                    for adapter in self.platform_adapters:
                        name = adapter.platform_name
                        # Find this platform's config for heartbeat interval
                        interval = self.config.cycle_delay
                        for pc in self.config.platforms:
                            if pc.name == name:
                                interval = pc.heartbeat_interval
                                break

                        if now - platform_timers.get(name, 0) >= interval:
                            try:
                                self.run_platform_cycle(adapter)
                            except SecurityError:
                                raise
                            except Exception:
                                pass  # already logged inside run_platform_cycle
                            platform_timers[name] = now

                except SecurityError as e:
                    logger.error(f"[SECURITY] {e}")
                    raise
                except KeyboardInterrupt:
                    logger.info("\n[STOP] Interrupted by user")
                    break
                except Exception as e:
                    logger.error(f"[ERROR] Cycle failed: {e}", exc_info=True)

                # Check max cycles
                if self.config.max_cycles > 0 and self.cycle_count >= self.config.max_cycles:
                    logger.info(f"[STOP] Reached max cycles ({self.config.max_cycles})")
                    break

                if self._stop_requested:
                    break

                logger.info(f"[SLEEP] {self.config.cycle_delay}s")
                time.sleep(self.config.cycle_delay)
        finally:
            # Always clean up — even on SecurityError or KeyboardInterrupt
            self._refresh_identity()
            self._cleanup()
            logger.info("[STOP] Bot stopped. Identity saved.")

    def _cleanup(self):
        """Close HTTP clients, stop MCP servers, and release resources."""
        try:
            if hasattr(self, 'school') and hasattr(self.school, '_http'):
                self.school._http.close()
        except Exception as e:
            logger.warning(f"[CLEANUP] Failed to close school HTTP client: {e}")
        for adapter in self.platform_adapters:
            try:
                if isinstance(adapter, MCPAdapter):
                    adapter.stop_servers()
                elif hasattr(adapter, '_http'):
                    adapter._http.close()
            except Exception as e:
                logger.warning(f"[CLEANUP] Failed to stop adapter {getattr(adapter, 'platform_name', '?')}: {e}")
