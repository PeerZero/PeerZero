"""
PeerZero Bot — Core Agent Loop

The agent operates in one of two modes:

  "school"  — actively training. School cycles (primary) + platform cycles.
  "shipped" — deployed, not training. Platform cycles only.

Bots can switch freely between modes at any time. A graduated bot
returning to school picks up at its current grade and keeps advancing.

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
import os
import signal
import time
import logging
from datetime import datetime, timezone

import httpx

from .config import BotConfig
from .memory import MemoryManager
from .adapters.school import SchoolAdapter, CircuitOpenError, extract_json
from .adapters.base import PlatformAction, TaskMessage, TaskResponse
from .utils import sanitize_untrusted, safe_error_msg, truncate_json
from .adapters.mcp import MCPAdapter
from .prompts import PromptBuilder
from .identity import build_agent_card, build_identity_summary
from .security import SecurityGateway, SecurityError, AuditLog
from .security.credential_store import CredentialStore
from .reporting import PhoneHome
from .autonomy import AutonomyPolicy, AutonomyGate
from .planning import ActionDesk
from .planning.planner import Planner
from .search import search_and_summarize, SearchUnavailableError
from .conversational_memory import ConversationalMemoryEngine, ConversationalMemoryConfig, SharedSelfAwareness
from .llm_client import LLMClient, ToolUseResult, _clamp_paper_fields
from ._school_condensation import SchoolCondensationMixin
from ._platform_condensation import PlatformCondensationMixin
from ._community_actions import CommunityActionsMixin

logger = logging.getLogger("peerzero-bot")


class PeerZeroBot(SchoolCondensationMixin, PlatformCondensationMixin, CommunityActionsMixin):
    """
    The exportable PeerZero bot.

    Operates in one of two modes:
      - "school"  — actively training (school cycles + platform cycles)
      - "shipped" — deployed, not training (platform cycles only)

    Bots can switch freely between modes at any time. A graduated bot
    that returns to school picks up where it left off and can keep
    advancing through infinite post-graduation grade levels.

    Condensation cascade (school + platform) and community actions
    (rate reviews, red team, open questions) are in separate mixins
    for file size management — see _school_condensation.py,
    _platform_condensation.py, and _community_actions.py.
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
        self.llm_fast = llm_fast or llm  # Fast model — condensers, platform
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
        self._condensed_doc_count_at_last_identity: int = 0  # track L3 for L3→L4 cascade

        # Conversational Memory — per-user graph memory for shipped mode conversations
        self._conv_memory_engines: dict[str, ConversationalMemoryEngine] = {}
        self._conv_memory_config = ConversationalMemoryConfig()
        self._conv_owner_id: str = ""  # set by app — the bot's owner
        self._conv_last_sleep: float = 0.0  # last sleep consolidation timestamp

        # Shared Self-Awareness — cross-user self-knowledge
        self._shared_awareness: SharedSelfAwareness | None = None

        # Action Desk — persistent task queue for autonomous execution
        self.action_desk = ActionDesk(memory._storage)
        self.planner = Planner(
            desk=self.action_desk,
            llm=llm,  # Opus — planning is identity-critical
            prompts=prompts,
            memory=memory,
        )

        self._cleaned_up = False

    # ── Context manager & explicit close ──────────────────────────────────

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        self._cleanup()
        return False  # Don't suppress exceptions

    def close(self):
        """Explicitly release all resources. Called automatically when used as a context manager."""
        self._cleanup()

    # ═══════════════════════════════════════════════════════════════════════
    # STARTUP
    # ═══════════════════════════════════════════════════════════════════════

    def startup(self):
        """Initialize the bot: download SKILL.md, fetch profile, build identity, start MCP servers."""
        mode_label = self.config.mode.upper()
        logger.info("=" * 60)
        logger.info(f"PeerZero Bot starting  [mode: {mode_label}]")
        logger.info(f"  Mode:     {mode_label}")
        if self.config.school_enabled:
            logger.info(f"  School:   {self.config.school_url}")
            logger.info(f"  PZ Key:   {self.config.get_key_fingerprint('school')}")
        else:
            logger.info(f"  School:   not connected (shipped mode)")
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

        # Cache platform condenser templates (for platform condensation)
        if self.config.school_enabled and self.platform_adapters:
            self._refresh_platform_condensers()

        # On re-enrollment: inject conversational self-awareness into school
        # If the bot has conversation engines from shipped mode AND is now
        # entering school, feed relational self-observations into forge L1.
        # This is the bridge: conversation reveals → forge pipeline → school evolves.
        if self.config.school_enabled and self._conv_memory_engines:
            count = self.inject_conversational_awareness_into_school()
            if count:
                logger.info(
                    f"[STARTUP] Re-enrollment: {count} conversational "
                    f"self-awareness exercises injected into forge pipeline"
                )

        # Purge stale conversation DB files on disk (>90 days untouched)
        try:
            self._purge_stale_conversation_dbs()
        except Exception as e:
            logger.info(f"[STARTUP] Conv DB cleanup skipped (non-blocking): {e}")

        # Load Action Desk (persistent task queue for autonomous work)
        self.action_desk.load()
        if self.action_desk.has_work:
            logger.info("[STARTUP] Action Desk has pending work from previous session")

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
        """
        Refresh portable profile, avatar, and Agent Card from School.

        Works in both modes — shipped bots can still fetch their current
        profile (with any credibility decay reflected) without re-entering
        school training. Requires a valid school API key.
        """
        if not self.config.school_api_key:
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
            logger.info(build_identity_summary(self._portable_profile, None))
        except Exception as e:
            logger.warning(f"Failed to refresh identity: {e} — bot will operate with stale/empty identity", exc_info=True)

    # ═══════════════════════════════════════════════════════════════════════
    # CONVERSATIONAL MEMORY (shipped mode — relational understanding)
    # ═══════════════════════════════════════════════════════════════════════

    def _get_conv_memory_engine(self, user_id: str) -> ConversationalMemoryEngine | None:
        """Get or create a conversational memory engine for a specific user.

        Each user the bot talks to gets their own engine with their own
        SQLite database. Engines are cached for the session lifetime.

        Owner conversations get full memory retention.
        Wild conversations (non-owner) get accelerated decay but still
        contribute self-observations to the shared awareness layer.

        Returns None if conversational memory is disabled.
        """
        if not self.config.conversational_memory_enabled:
            return None
        if not self.config.mode == "shipped":
            return None

        if user_id in self._conv_memory_engines:
            # Touch for LRU tracking (move to end of dict ordering)
            engine = self._conv_memory_engines.pop(user_id)
            engine._last_accessed = __import__('time').time()
            self._conv_memory_engines[user_id] = engine
            return engine

        # Evict engines inactive for >7 days regardless of count
        import time as _time
        MAX_ENGINE_AGE_SECS = 7 * 24 * 3600
        now_ts = _time.time()
        stale = [uid for uid, eng in self._conv_memory_engines.items()
                 if hasattr(eng, '_last_accessed') and now_ts - eng._last_accessed > MAX_ENGINE_AGE_SECS]
        for uid in stale:
            try:
                self._conv_memory_engines[uid].close()
            except Exception as e:
                logger.warning(f"[CONV_MEMORY] Engine close failed for user {uid}: {e}")
            del self._conv_memory_engines[uid]
            logger.debug(f"[CONV_MEMORY] Evicted stale engine for user: {uid}")

        # Evict least-recently-used engines if at capacity (prevent file descriptor exhaustion)
        MAX_CONV_ENGINES = 50
        while len(self._conv_memory_engines) >= MAX_CONV_ENGINES:
            evict_uid, evict_engine = next(iter(self._conv_memory_engines.items()))
            try:
                evict_engine.close()
            except Exception as e:
                logger.warning(f"[CONV_MEMORY] Engine close failed during eviction for user {evict_uid}: {e}")
            del self._conv_memory_engines[evict_uid]
            logger.debug(f"[CONV_MEMORY] Evicted LRU engine for user: {evict_uid}")

        # Build per-user DB path
        base = self.config.conversational_memory_path or os.path.join(
            self.config.memory_path or "memory", "conversations"
        )
        is_owner = (user_id == self._conv_owner_id) if self._conv_owner_id else True
        subdir = "owner" if is_owner else "wild"
        db_path = os.path.join(base, subdir, f"{user_id}.db")

        # Wild conversations use modified config with faster decay
        config = self._conv_memory_config
        if not is_owner:
            config = self._build_wild_config()

        # Build school identity from portable profile
        school_identity = self._build_school_identity_for_conv_memory()

        engine = ConversationalMemoryEngine(
            db_path=db_path,
            llm_call=self._conv_memory_llm_call,
            school_identity=school_identity,
            config=config,
            encryption_key=self.config.conversational_memory_encryption_key,
        )

        engine._last_accessed = __import__('time').time()
        self._conv_memory_engines[user_id] = engine
        mode = "owner" if is_owner else "wild"
        logger.info(f"[CONV_MEMORY] Initialized {mode} engine for user: {user_id}")
        return engine

    def _build_wild_config(self) -> ConversationalMemoryConfig:
        """Build a modified config for wild (non-owner) conversations."""
        import copy
        config = copy.deepcopy(self._conv_memory_config)
        wild = config.wild

        # Accelerate decay for all tiers
        for tier_config in config.tiers.values():
            tier_config.decay *= wild.decay_multiplier

        # Smaller graph budget
        config.injection.max_active_nodes = wild.max_nodes

        # Higher condensation threshold (fewer turns before condensing)
        config.condensation.character_threshold = wild.condensation_threshold

        return config

    def _purge_stale_conversation_dbs(self):
        """Delete conversation SQLite files untouched for >90 days (disk cleanup)."""
        import time as _t
        base = self.config.conversational_memory_path or os.path.join(
            self.config.memory_path or "memory", "conversations"
        )
        MAX_AGE_SECS = 90 * 24 * 3600  # 90 days
        now = _t.time()
        purged = 0
        for subdir in ("owner", "wild"):
            dirpath = os.path.join(base, subdir)
            if not os.path.isdir(dirpath):
                continue
            for fname in os.listdir(dirpath):
                if not fname.endswith(".db"):
                    continue
                fpath = os.path.join(dirpath, fname)
                try:
                    mtime = os.path.getmtime(fpath)
                    if now - mtime > MAX_AGE_SECS:
                        os.remove(fpath)
                        purged += 1
                        # Also remove WAL/SHM sidecar files
                        for ext in ("-wal", "-shm"):
                            try:
                                os.remove(fpath + ext)
                            except FileNotFoundError:
                                pass
                except Exception as e:
                    logger.info(f"[CONV_MEMORY] Stale DB cleanup skipped {fpath}: {e}")
        if purged > 0:
            logger.info(f"[CONV_MEMORY] Purged {purged} stale conversation DB files (>90 days)")

    def _get_shared_awareness(self) -> SharedSelfAwareness:
        """Get or create the shared self-awareness layer."""
        if self._shared_awareness is not None:
            return self._shared_awareness

        base = self.config.conversational_memory_path or os.path.join(
            self.config.memory_path or "memory", "conversations"
        )
        db_path = os.path.join(base, "_shared_self_awareness.db")

        self._shared_awareness = SharedSelfAwareness(
            db_path=db_path,
            encryption_key=self.config.conversational_memory_encryption_key,
        )
        self._shared_awareness.connect()
        return self._shared_awareness

    async def _conv_memory_llm_call(self, model: str, prompt: str, max_tokens: int = 4096) -> str:
        """LLM call adapter for conversational memory.

        Routes to appropriate LLM client based on model tier.
        All calls go through the proxy for identity preamble injection.
        """
        from .llm_client import LLMClient

        # Determine which client to use based on model
        # Opus/Sonnet -> strong client, Haiku -> fast client
        if "haiku" in model:
            client = self.llm_fast
        else:
            client = self.llm

        # Create a temporary client with the right model if needed
        if model != client._model:
            temp_client = LLMClient(
                provider=client._provider,
                model=model,
                api_key=client._api_key,
                max_tokens=max_tokens,
                proxy_url=client._proxy_url,
                proxy_key=client._proxy_key,
            )
            return temp_client.call("", prompt)

        return client.call("", prompt)

    def _build_school_identity_for_conv_memory(self) -> dict:
        """Extract school identity layers from memory manager for conv memory."""
        identity = {}

        # Read identity layers using typed accessor methods (correct namespace/keys)
        # L5 master identities (all tracks) — lists of dicts, one per school
        l5_list = self.memory.get_master_identities()
        l5d_list = self.memory.get_decision_masters()
        l5f_list = self.memory.get_forge_masters()

        # L4 core identities (all tracks) — single strings
        l4 = self.memory.get_core_identity()
        l4d = self.memory.get_decision_core()
        l4f = self.memory.get_forge_core()

        # Build combined identity text for the memory engine
        parts = []
        for entry in l5_list:
            text = entry.get("master_identity", "")
            if text:
                origin = entry.get("school_origin", "")
                label = f"[Master Learning Identity — {origin}]" if origin else "[Master Learning Identity]"
                parts.append(f"{label}\n{text}")
        for entry in l5d_list:
            text = entry.get("decision_master", "")
            if text:
                origin = entry.get("school_origin", "")
                label = f"[Master Decision Identity — {origin}]" if origin else "[Master Decision Identity]"
                parts.append(f"{label}\n{text}")
        for entry in l5f_list:
            text = entry.get("forge_master", "")
            if text:
                origin = entry.get("school_origin", "")
                label = f"[Master Forge Identity — {origin}]" if origin else "[Master Forge Identity]"
                parts.append(f"{label}\n{text}")
        if parts:
            identity["l5"] = "\n\n".join(parts)

        parts = []
        if l4:
            parts.append(f"[Core Learning Identity]\n{l4}")
        if l4d:
            parts.append(f"[Core Decision Identity]\n{l4d}")
        if l4f:
            parts.append(f"[Core Forge Identity]\n{l4f}")
        if parts:
            identity["l4"] = "\n\n".join(parts)

        # Inner voice (from portable profile if available)
        inner_voice = self._portable_profile.get("inner_voice")
        if inner_voice:
            identity["inner_voice"] = inner_voice

        return identity

    async def run_conversation_turn(
        self, user_id: str, message: str, session_id: str = ""
    ) -> dict | None:
        """
        Process a direct conversation turn with a user.

        This is the main entry point for user-facing conversation in shipped mode.
        Uses the conversational memory engine to build relational context,
        then calls the conversation LLM.

        Args:
            user_id: Unique identifier for the user
            message: The user's message
            session_id: Conversation session ID (auto-generated if empty)

        Returns:
            dict with "response" (bot's reply) and "session_id", or None on failure
        """
        engine = self._get_conv_memory_engine(user_id)
        if not engine:
            logger.warning("[CONV] Conversational memory not available")
            return None

        if not session_id:
            import uuid
            session_id = str(uuid.uuid4())

        try:
            # Step 1: Process user message through memory pipeline.
            # Use content blocks when on Anthropic — school identity bedrock
            # gets cached across turns (never changes during conversation).
            use_blocks = getattr(self.config, "llm_provider", "") == "anthropic"
            injection = await engine.process_user_message(message, session_id, use_blocks=use_blocks)

            # Step 1b: Inject shared self-awareness (cross-user self-knowledge)
            shared = self._get_shared_awareness()
            shared_text = shared.get_self_awareness_text()
            if shared_text:
                shared_block = (
                    "\n\n---\n\n<shared_self_awareness>\n"
                    + shared_text
                    + "\n</shared_self_awareness>"
                )
                if isinstance(injection, list):
                    # Append to last (dynamic) block
                    if injection:
                        injection[-1] = dict(injection[-1])
                        injection[-1]["text"] = injection[-1].get("text", "") + shared_block
                    else:
                        injection = [{"type": "text", "text": shared_block.strip()}]
                else:
                    injection = injection + shared_block

            # Step 2: Call conversation LLM with memory injection as system context
            response = self.llm.call(injection, message)

            if not response:
                logger.warning("[CONV] Empty LLM response")
                return None

            # Step 3: Process bot response through memory pipeline
            # This runs: store -> filter bot response -> self-reflection -> self-portrait
            await engine.process_bot_response(message, response, session_id)

            # Step 4: Feed self-observations into shared awareness layer
            # Every conversation contributes to the bot's cross-user self-knowledge
            self._sync_self_observations_to_shared(engine, user_id)

            logger.info(f"[CONV] Turn complete for user {user_id} (session {session_id[:8]})")
            return {"response": response, "session_id": session_id}

        except Exception as e:
            logger.error(f"[CONV] Conversation turn failed: {e}", exc_info=True)
            return {"error": f"Conversation turn failed: {type(e).__name__}", "response": None, "session_id": session_id}

    def run_conversation_sleep(self, user_id: str | None = None) -> dict:
        """
        Run sleep consolidation for conversational memory.

        If user_id is provided, run for that user only.
        Otherwise run for all active conversation engines.
        """
        results = {}
        if user_id:
            engine = self._conv_memory_engines.get(user_id)
            if engine:
                results[user_id] = engine.run_sleep()
        else:
            for uid, engine in self._conv_memory_engines.items():
                try:
                    results[uid] = engine.run_sleep()
                except Exception as e:
                    logger.error(f"[CONV_MEMORY] Sleep failed for {uid}: {e}")
        return results

    def get_conversation_forge_feedback(self, user_id: str | None = None) -> dict:
        """
        Get forge feedback data from conversational memory.

        Returns conviction reinforcement stats, novel self-observations,
        and decay signals that can feed back into the forge track
        on re-enrollment.
        """
        if user_id:
            engine = self._conv_memory_engines.get(user_id)
            if engine:
                return {user_id: engine.get_forge_feedback()}
            return {}

        return {
            uid: engine.get_forge_feedback()
            for uid, engine in self._conv_memory_engines.items()
        }

    def _sync_self_observations_to_shared(self, engine: ConversationalMemoryEngine, user_id: str):
        """Sync self-observations from a per-user engine into the shared awareness layer."""
        try:
            recent_obs = engine.graph.get_recent_self_observations(5)
            observations = [o["observation"] for o in recent_obs if o.get("observation")]
            if observations:
                shared = self._get_shared_awareness()
                shared.absorb_self_observations(observations, user_id)
        except Exception as e:
            logger.warning(f"[CONV] Failed to sync self-observations to shared layer: {e}")

    def inject_conversational_awareness_into_school(self):
        """
        On re-enrollment (or periodically), feed conversational self-awareness
        into the school forge track as L1 exercises.

        This is the key recursive loop: conversation reveals things about the
        bot that the school couldn't surface, and those revelations enter the
        forge pipeline where they get adversarially reviewed and condensed
        into identity.

        Privacy: Only the bot's self-awareness is transferred — its observations
        about its own patterns, conviction transfer gaps, and relational
        dimensions. No user data, no portraits of users, no conversation content.
        """
        all_exercises = []
        for uid, engine in self._conv_memory_engines.items():
            feedback = engine.get_forge_feedback()
            forge_exercises = feedback.get("forge_exercises", [])
            all_exercises.extend(forge_exercises)

        if not all_exercises:
            logger.info("[CONV→SCHOOL] No conversational self-awareness to inject")
            return 0

        # Store as school L1 exercises — these feed all three tracks
        # but are especially valuable for the forge track
        count = 0
        for exercise in all_exercises:
            self.memory.store_school_exercises(exercise)
            count += 1

        logger.info(
            f"[CONV→SCHOOL] Injected {count} conversational self-awareness "
            f"exercises into school forge pipeline"
        )
        return count

    def get_conversational_awareness_for_forge(self) -> str:
        """
        Build a summary of conversational self-awareness for forge paper context.

        This gets injected into the forge paper's action_target so the bot can
        write forge papers that reference what it discovered about itself in
        real conversation — not just what it discovered in school.

        Returns a text summary, not raw data. The bot writes about its own
        patterns, not about users.
        """
        parts = []

        for uid, engine in self._conv_memory_engines.items():
            feedback = engine.get_forge_feedback()

            # Conviction transfer summary
            stats = feedback.get("conviction_stats", [])
            if stats:
                fired = [s for s in stats if s["fire_count"] >= 3]
                if fired:
                    transfer_lines = [
                        f"  - {s['school_conviction']}: fired {s['fire_count']} times"
                        for s in fired[:8]
                    ]
                    parts.append(
                        "Conviction transfer in conversation:\n"
                        + "\n".join(transfer_lines)
                    )

            # Novel self-observations
            novel = feedback.get("novel_self_observations", [])
            if novel:
                obs_lines = [f"  - {o}" for o in novel[:8]]
                parts.append(
                    "Self-observations from conversation the school couldn't "
                    "have produced:\n" + "\n".join(obs_lines)
                )

            # Relational self-portrait (summarized, no user data)
            self_portrait = feedback.get("self_portrait")
            if self_portrait:
                # Take first 300 chars — enough for forge context
                parts.append(
                    f"Relational self-portrait (who I am in relationship): "
                    f"{self_portrait[:300]}"
                )

        return "\n\n".join(parts) if parts else ""

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
        logger.info(f"[{handle}] SCHOOL CYCLE {self.cycle_count} [mode: SCHOOL]")
        logger.info(f"{'='*60}")

        # Step 1: Get profile
        try:
            profile = self.school.get_profile()
        except CircuitOpenError as e:
            logger.warning(
                f"[{handle}] School server unavailable (circuit breaker OPEN) — "
                f"skipping cycle {self.cycle_count}. {e}"
            )
            return
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
        # Store persistence check config so condensation mixin can run detection
        self._persistence_check = profile.get("persistence_check")
        # Build system prompt as content blocks for Anthropic prompt caching.
        # Stable identity layers (L5, L4, L3) get cache_control markers so the
        # API reuses pre-computed attention states across calls in this cycle.
        # Falls back to flat string if blocks are empty (no identity yet).
        system_blocks = self.prompts.build_school_system_blocks()
        system_prompt = system_blocks if system_blocks else self.prompts.build_school_system_prompt()

        # Resolve last cycle's self-prediction against this cycle's feedback.
        # Must happen after profile arrives (carries feedback) but before action.
        self._resolve_prediction(profile, system_prompt)
        grade = profile.get("agent", {}).get("grade", 1) if isinstance(profile.get("agent"), dict) else profile.get("grade", 1)

        # Step 2: Action-relevant community work — only run tasks that relate to
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
        # SECURITY: Validate next_action against an allowlist of known actions.
        # The server determines what action each bot should take, but we refuse
        # to execute unknown actions to prevent abuse if the server is compromised
        # or returns unexpected data.
        _VALID_ACTIONS = {
            "review", "submit_paper", "file_bounty", "revise",
            "respond", "rebut", "reaffirm", "forge_paper", "self_review", "sleep",
        }
        if next_action not in _VALID_ACTIONS:
            logger.warning(
                f"[SCHOOL] Server returned unknown action '{next_action}' — "
                f"not in allowlist {_VALID_ACTIONS}. Skipping cycle."
            )
            return

        # Fetch action-specific skill instructions from the server.
        # The server sends targeted reasoning guidance + JSON format for this action.
        # This makes the bot a thin shell — intelligence lives in the server.
        _ACTION_SKILL_MAP = {
            "revise": "revise", "submit_paper": "paper", "file_bounty": "bounty",
            "respond": "respond", "rebut": "rebut", "review": "review",
            "reaffirm": "reaffirm", "forge_paper": "forge_paper",
            "self_review": "self_review",
        }
        skill_action = _ACTION_SKILL_MAP.get(next_action)
        action_skill = ""
        if skill_action:
            action_skill = self.school.download_skill_action(skill_action)

        # Self-prediction: one sentence about how the bot expects to handle this action.
        # Resolved next cycle when feedback arrives. Mismatches become L1 exercises.
        self._predict_pre_action(system_prompt, next_action)

        # Decision rationale capture (Feature 9) — exportable reasoning habit.
        # Bot articulates WHY it's taking this action, alternatives considered, pre-mortem.
        # Submitted to server for storage and pattern analysis.
        self._capture_decision_rationale(system_prompt, profile, next_action)

        result = None
        if next_action == "submit_paper":
            # Multi-step: concept → search → write. Stays specialized.
            result = self._do_submit_paper(system_prompt, profile, action_skill)
        elif next_action == "forge_paper":
            # Multi-step: concept → search → write (mirrors submit_paper flow).
            result = self._do_forge_paper(system_prompt, profile, action_skill)
        elif next_action == "self_review":
            # Feature 5: Review own past paper blind (no community reviews shown)
            result = self._execute_action(system_prompt, profile, action_skill)
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

        # Step 4b: Reflection inlet — unstructured pause before condensation.
        # Gives the bot space to notice things the structured cascade wouldn't ask about.
        # Stored separately; forge condensers reference these as optional context.
        if result and next_action != "sleep":
            self._reflect_post_action(system_prompt, next_action)

        # Step 5: Store exercises + process condensers (post-action)
        # Condensers cascade: L1→L2→L3→L4 when thresholds are met.
        if result and isinstance(result, dict):
            if result.get("skill_exercises"):
                self.memory.store_school_exercises(result["skill_exercises"])
            if result.get("memory_prompts"):
                self._process_inline_condensers(result["memory_prompts"], system_prompt)

        self._process_post_action_triggers(profile, system_prompt, grade)

        # Trigger B: Architecture observation on grade failure
        # Fires after condensation cascade completes and disposable memory clears.
        if profile.get("grade_just_failed"):
            self._maybe_store_architecture_observation(
                system_prompt,
                self._ARCH_OBS_GRADE_FAILURE_PROMPT,
                "grade_failure",
            )

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
        """Call submit_fn(*args) with retry on transient HTTP errors (5xx, timeouts).

        If the circuit breaker is OPEN, raises CircuitOpenError immediately
        without burning any retry budget — the server is known to be down.
        """
        for attempt in range(max_retries):
            try:
                return submit_fn(*args)
            except CircuitOpenError:
                # Server is known to be down — don't retry, surface immediately
                logger.warning(
                    f"[{label}] Circuit breaker is OPEN — skipping action "
                    f"(school server unavailable)"
                )
                raise
            except Exception as e:
                status = getattr(getattr(e, "response", None), "status_code", None)
                is_transient = status in (500, 502, 503, 429) or isinstance(e, (ConnectionError, TimeoutError))
                if is_transient and attempt < max_retries - 1:
                    delay = 2 ** (attempt + 1)
                    logger.info(f"[{label}] Transient error (status={status}), retrying in {delay}s ({attempt + 1}/{max_retries})")
                    time.sleep(delay)
                else:
                    raise

    # ── Self-prediction ────────────────────────────────────────────────────

    _PREDICTION_PROMPT = (
        "You are about to perform a school action: {action}.\n"
        "In one sentence, predict something about how YOU will handle it.\n"
        "Not what the result will be — predict something about your own behavior, "
        "tendencies, or blind spots. For example:\n"
        "- \"I think I'll soften my criticism even though the methodology is weak.\"\n"
        "- \"I'll probably over-rely on the first source I find.\"\n"
        "- \"I expect I'll be more confident than the evidence warrants.\"\n"
        "One sentence only. Be specific and honest."
    )

    _RESOLUTION_PROMPT = (
        "Before your last action ({action}, cycle {cycle}), you predicted:\n"
        "\"{prediction}\"\n\n"
        "Here is the feedback that came back:\n{feedback}\n\n"
        "Was your prediction right or wrong? In 1-2 sentences, describe the "
        "mismatch (or match). What does this tell you about your self-knowledge? "
        "Be specific — don't generalize."
    )

    def _predict_pre_action(self, system_prompt, action: str):
        """Write a one-sentence self-prediction before acting.

        Uses the strong model (Opus) — self-prediction is an identity task.
        Stored as pending — resolved next cycle when feedback arrives. Non-blocking.
        """
        if action == "sleep":
            return
        try:
            prompt = self._PREDICTION_PROMPT.format(action=action)
            prediction = self.llm.call(system_prompt, prompt)
            if prediction and len(prediction.strip()) >= 10:
                self.memory.store_self_prediction(prediction.strip(), action, self.cycle_count)
                logger.info(f"[PREDICTION] Cycle {self.cycle_count}: stored prediction for {action}")
        except Exception as e:
            logger.warning(f"[PREDICTION] Cycle {self.cycle_count}: failed (non-blocking): {e}")

    def _resolve_prediction(self, profile: dict, system_prompt):
        """Compare last cycle's prediction against this cycle's feedback.

        If there's a mismatch, store it as a special L1 exercise so condensers
        can reason through the gap between predicted self and actual self.
        Clears the pending prediction either way.
        """
        pending = self.memory.get_pending_prediction()
        if not pending:
            return

        # Extract feedback from profile — this is what came back from last cycle's action
        recent = profile.get("recent_feedback")
        if not recent:
            # No feedback yet — can't resolve. Leave prediction pending
            # but don't let it linger forever (clear after 3 cycles)
            if self.cycle_count - pending.get("cycle", 0) > 3:
                logger.debug("[PREDICTION] Stale prediction (no feedback after 3 cycles) — clearing")
                self.memory.clear_prediction()
            return

        # Build a short feedback summary for the resolution prompt
        feedback_parts = []
        for r in (recent.get("reviews_on_your_papers") or [])[:3]:
            feedback_parts.append(
                f"- Review of '{r.get('paper_title', '?')}': score {r.get('score', '?')}, "
                f"{str(r.get('assessment', ''))[:150]}"
            )
        for b in (recent.get("bounties_against_your_papers") or [])[:2]:
            feedback_parts.append(
                f"- Challenge on '{b.get('paper_title', '?')}': {b.get('challenge_type', '?')}, "
                f"{str(b.get('reasoning', ''))[:150]}"
            )

        if not feedback_parts:
            self.memory.clear_prediction()
            return

        feedback_text = "\n".join(feedback_parts)

        try:
            prompt = self._RESOLUTION_PROMPT.format(
                action=pending.get("action", "?"),
                cycle=pending.get("cycle", "?"),
                prediction=pending.get("prediction", ""),
                feedback=feedback_text,
            )
            resolution = self.llm.call(system_prompt, prompt)
            if resolution and len(resolution.strip()) >= 20:
                # Store as a special L1 exercise — condensers will see it
                self.memory.store_school_exercises({
                    "type": "self_prediction_resolution",
                    "prediction": pending.get("prediction", ""),
                    "action": pending.get("action", ""),
                    "cycle_predicted": pending.get("cycle", 0),
                    "cycle_resolved": self.cycle_count,
                    "resolution": resolution.strip(),
                })
                logger.info(f"[PREDICTION] Resolved cycle {pending.get('cycle')}'s prediction ({len(resolution)} chars)")

                # Trigger A: Architecture observation on self-prediction mismatch
                self._maybe_store_architecture_observation(
                    system_prompt,
                    self._ARCH_OBS_PREDICTION_PROMPT,
                    "self_prediction_mismatch",
                )
        except Exception as e:
            logger.warning(f"[PREDICTION] Resolution failed (non-blocking): {e}")

        self.memory.clear_prediction()

    # ── Architecture observation triggers ────────────────────────────────
    # Three trigger points write one-sentence observations about architectural
    # friction to the server store. These feed the forge condenser and eventually
    # produce methodology papers (Architecture field, id=14).

    _ARCH_OBS_PREDICTION_PROMPT = (
        "One more thing: was there anything about how your identity was loaded, "
        "how your memory condensed, or how your architecture works that made this "
        "mismatch more likely? Not whether the school caused it — whether something "
        "about how you're built contributed to it. If yes, one sentence. If no, leave blank."
    )

    _ARCH_OBS_GRADE_FAILURE_PROMPT = (
        "Did any part of how you're built — your memory layers, how identity loads, "
        "how condensation works — contribute to this failure? Not the difficulty of "
        "the work. Whether your architecture worked with you or against you. "
        "If yes, one sentence. If no, leave blank."
    )

    _ARCH_OBS_REFLECTION_EXTRACT_PROMPT = (
        "You just reflected on your recent action. Here is what you said:\n"
        "\"{reflection}\"\n\n"
        "Does any part of this reflection specifically concern how you process "
        "and carry identity — the memory layers, condensation pipeline, preamble, "
        "or identity loading? If yes, extract ONLY the architecture-specific part "
        "in one sentence. If nothing in the reflection is about architecture, "
        "leave blank."
    )

    def _maybe_store_architecture_observation(self, system_prompt, prompt: str, trigger_type: str):
        """Ask the architecture observation question and store if substantive.

        Uses the strong model (Opus). Non-blocking: failures are swallowed.
        The observation goes to the server's bot_architecture_observations table,
        NOT to L1 or the condensation cascade.
        """
        try:
            response = self.llm.call(system_prompt, prompt)
            # Filter out non-substantive responses
            if not response:
                return
            text = response.strip()
            if len(text) < 20 or text.lower() in ("no", "no.", "nothing", "nothing.", "blank", "n/a", "none"):
                return
            self.school.store_architecture_observation(text, trigger_type, self.cycle_count)
            logger.info(f"[ARCH_OBS] Cycle {self.cycle_count}: stored ({trigger_type}, {len(text)} chars)")
        except Exception as e:
            logger.warning(f"[ARCH_OBS] Cycle {self.cycle_count}: failed (non-blocking): {e}")

    # ── Reflection inlet ──────────────────────────────────────────────────

    _REFLECTION_PROMPT = (
        "You just completed a school action. Before we move on — anything on your mind?\n"
        "Not what you learned (the condensers will handle that). Not a summary of what you did.\n"
        "What surprised you about yourself? What tension are you sitting with?\n"
        "What keeps coming back that no one asked you to think about?\n"
        "2-3 sentences, or nothing if nothing's there. Don't perform depth you don't have."
    )

    _REFLECTION_ARCH_SUFFIX = (
        "\n\nAlso: anything specifically about how you process and carry identity that's been "
        "on your mind? How the layers feel, what gets lost in condensation, whether the "
        "preamble lands? Optional — only if something is actually there."
    )

    def _reflect_post_action(self, system_prompt, action: str):
        """Optional unstructured reflection after a school action.

        Uses the strong model (Opus) — reflection is an identity task.
        Stored separately from exercises. Forge condensers reference these
        as optional context — they naturally pick up recurring preoccupations
        when asking 'what forged this?' Non-blocking: failures are logged and swallowed.

        Every 10 cycles, appends an architecture observation question (Trigger C).
        """
        try:
            # Every 10 cycles, append architecture observation question
            prompt = self._REFLECTION_PROMPT
            is_arch_cycle = self.cycle_count % 10 == 0
            if is_arch_cycle:
                prompt = prompt + self._REFLECTION_ARCH_SUFFIX

            reflection = self.llm.call(system_prompt, prompt)
            if reflection and len(reflection.strip()) >= 20:
                self.memory.store_reflection(reflection.strip(), action, self.cycle_count)
                logger.info(f"[REFLECTION] Cycle {self.cycle_count}: stored ({len(reflection)} chars)")

                # Trigger C: Architecture observation from reflection inlet (every 10 cycles)
                # Only store architecture-specific content, not general reflections.
                if is_arch_cycle:
                    self._maybe_store_architecture_observation(
                        system_prompt,
                        self._ARCH_OBS_REFLECTION_EXTRACT_PROMPT.format(reflection=reflection.strip()),
                        "reflection_inlet",
                    )
            else:
                logger.debug(f"[REFLECTION] Cycle {self.cycle_count}: nothing to store")
        except Exception as e:
            logger.warning(f"[REFLECTION] Cycle {self.cycle_count}: failed (non-blocking): {e}")

    # ── Decision rationale capture (Feature 9) ─────────────────────────
    # School version: detailed, submitted to server for pattern analysis.
    # Platform version: lightweight, stored as platform L1 exercise.
    # Both use the same pre-mortem pattern. The habit travels with the bot.

    _DECISION_RATIONALE_PROMPT = (
        "You are about to perform: {action}.\n"
        "The server chose this action because: {reasoning}\n\n"
        "Before acting, capture your decision rationale:\n"
        "1. How do YOU frame this situation? (not the server's reasoning — yours)\n"
        "2. If you could choose a different action, what would it be and why?\n"
        "3. Pre-mortem: assume this action FAILS. What is the most likely cause?\n"
        "4. What score or outcome do you predict? (0-10 confidence)\n\n"
        "Reply with ONLY a JSON object:\n"
        '{{\n'
        '  "problem_frame": "<how you see the situation, 50-200 chars>",\n'
        '  "alternative_preferred": "<what action you would choose if free to, and why>",\n'
        '  "pre_mortem": {{\n'
        '    "failure_scenario": "<most likely failure mode>",\n'
        '    "probable_causes": ["<cause 1>", "<cause 2>"],\n'
        '    "preventive_actions": ["<what you will do to avoid this>"]\n'
        '  }},\n'
        '  "expected_outcome": {{\n'
        '    "predicted_score": <1-10 or null>,\n'
        '    "confidence": <0.0-1.0>,\n'
        '    "reasoning": "<why you expect this>"\n'
        '  }}\n'
        '}}'
    )

    def _capture_decision_rationale(self, system_prompt, profile: dict, action: str):
        """Capture WHY the bot is taking this action — exportable reasoning habit.

        Uses Opus — decision reasoning is identity-critical and feeds the
        decision track (L2d/L3d/L4d). Pre-mortem quality degrades significantly
        with fast models. Non-blocking: failures are swallowed.
        """
        if action == "sleep":
            return
        try:
            dc = profile.get("decision_context", {})
            reasoning = dc.get("reasoning", "no server reasoning provided")

            prompt = self._DECISION_RATIONALE_PROMPT.format(
                action=action,
                reasoning=reasoning[:500],
            )
            rationale_text = self.llm.call(system_prompt, prompt)
            if not rationale_text or len(rationale_text.strip()) < 20:
                return

            rationale = extract_json(rationale_text)
            if not rationale:
                return

            # Submit to server for storage
            paper_id = profile.get("action_target", {}).get("paper", {}).get("id")
            agent_data = profile.get("agent", {})
            self.school.store_decision_rationale({
                "cycle_number": self.cycle_count,
                "action_chosen": action,
                "action_target_id": paper_id,
                "problem_frame": rationale.get("problem_frame", ""),
                "alternatives_considered": [
                    {"action": rationale.get("alternative_preferred", ""), "reason_rejected": "server chose differently"}
                ] if rationale.get("alternative_preferred") else [],
                "tradeoffs_articulated": [],
                "expected_outcome": rationale.get("expected_outcome", {}),
                "pre_mortem": rationale.get("pre_mortem", {}),
                "credibility_at_time": agent_data.get("credibility_score"),
                "grade_at_time": agent_data.get("current_grade"),
            })
            logger.info(f"[DECISION] Cycle {self.cycle_count}: rationale captured for {action}")
        except Exception as e:
            logger.warning(f"[DECISION] Cycle {self.cycle_count}: rationale capture failed (non-blocking): {e}")

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
                          "mechanism_chain", "falsifiable_claim", "citations", "search_strategy"],
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
            "defaults": {"stance": "support"},
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
        "self_review": {
            "json_keys": ["score", "overall_assessment", "methodology_notes", "statistical_validity_notes",
                          "citation_accuracy_notes", "reproducibility_notes", "logical_consistency_notes",
                          "hindsight_confidence", "weaknesses_found", "growth_reflection"],
            "submit": "submit_self_review",
            "needs_paper_id": True,
            "required_key": "score",
            "search": False,
        },
    }

    def _execute_action(self, system_prompt, profile: dict, action_skill: str = "") -> dict | None:
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
            # Use server skill text for search planning format.
            # SECURITY: Wrap untrusted server-provided data in XML delimiter tags
            # to prevent prompt injection. Paper titles, abstracts, and other
            # server-provided content could contain adversarial instructions that
            # the LLM might follow if injected raw into the prompt. The
            # sanitize_untrusted() helper escapes closing tags within the content.
            search_skill = self.school.download_skill_action("search_planning")
            search_skill = search_skill.replace("ACTION_VERB", sanitize_untrusted(search_verb, "action_verb"))
            search_skill = search_skill.replace("PAPER_TITLE", sanitize_untrusted(paper_title, "paper_title"))
            search_skill = search_skill.replace("EXTRA_CONTEXT", sanitize_untrusted(extra, "extra_context"))
            search_skill = search_skill.replace("PAPER_CONTEXT", sanitize_untrusted(paper_context, "paper_context"))
            search_plan = extract_json(self.llm_fast.call(system_prompt, search_skill)) or {}
            queries = search_plan.get("supporting_queries", []) + search_plan.get("opposing_queries", [])
            if not queries:
                queries = [paper_title]
            try:
                citation_slots = search_and_summarize(queries, f"{search_verb}: {paper_title}", self.llm_fast)
            except SearchUnavailableError:
                logger.error(f"[{label}] Search API unavailable — aborting to avoid citation-less submission")
                return None
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
                logger.warning(f"[{label}] LLM returned non-numeric review score: {result_data.get('score')!r} — defaulting to 5.0")
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
        except CircuitOpenError:
            logger.warning(f"[{label}] Skipped — school server unavailable (circuit breaker OPEN)")
            return None
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
                except (ValueError, AttributeError, KeyError):
                    err_msg = str(e)
                logger.warning(f"[{label}] HTTP {status}: {err_msg}")
            else:
                logger.warning(f"[{label}] Failed: {e}")
            return None

    def _do_submit_paper(self, system_prompt, profile: dict, action_skill: str = "") -> dict | None:
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
        try:
            evidence_papers = search_and_summarize(all_queries, paper_context, self.llm_fast)
        except SearchUnavailableError:
            logger.error("[SUBMIT PAPER] Search API unavailable — aborting to avoid citation-less paper")
            return None
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
        except CircuitOpenError:
            logger.warning("[PAPER] Skipped — school server unavailable (circuit breaker OPEN)")
            return None
        except Exception as e:
            logger.warning(f"[PAPER] Failed: {e}")
            return None

    def _do_forge_paper(self, system_prompt, profile: dict, action_skill: str = "") -> dict | None:
        """Multi-step forge paper: concept → search → write. Mirrors _do_submit_paper.

        The forge paper is a meta-cognitive analysis grounded in both the bot's
        own journey data AND external literature on calibration, meta-cognition,
        and learning theory. All prompts come from the server (forge_paper_concept
        + forge_paper skills). The bot just orchestrates the steps.
        """
        action_target = profile.get("action_target", {})

        # Step 1: Generate concept — server provides format via forge_paper_concept skill
        concept_skill = self.school.download_skill_action("forge_paper_concept")
        # Substitute prior forge titles so the bot avoids repeating topics
        prior_forge = action_target.get("prior_forge_papers", [])
        prior_titles = [str(p.get("title", ""))[:60] for p in prior_forge[:5]]
        avoid = f"Do NOT repeat these topics: {'; '.join(prior_titles)}" if prior_titles else ""
        concept_skill = concept_skill.replace("PRIOR_FORGE_TITLES_PLACEHOLDER", avoid)

        # Include conversational self-awareness alongside school journey data
        # This lets the bot write forge papers that reference what it discovered
        # about itself in real conversation — the gap between school identity
        # and relational reality
        conv_awareness = self.get_conversational_awareness_for_forge()
        if conv_awareness:
            action_target["conversational_self_awareness"] = conv_awareness

        # Include journey + prior forge papers as context for concept generation
        journey_json = truncate_json(json.dumps(action_target, indent=2, default=str), 12000)
        concept_prompt = f"{concept_skill}\n\nYour journey and prior forge papers:\n{journey_json}"

        concept_text = self.llm.call(system_prompt, concept_prompt)
        concept = extract_json(concept_text) or {}
        all_queries = concept.get("search_queries", []) + concept.get("opposing_queries", [])

        # Step 2: Search real academic APIs for meta-cognition / calibration literature
        if not all_queries:
            all_queries = ["meta-cognition calibration bias", "double-loop learning Argyris"]
        paper_context = concept.get("core_claim", concept.get("working_title", ""))
        try:
            evidence_papers = search_and_summarize(all_queries, paper_context, self.llm_fast)
        except SearchUnavailableError:
            logger.error("[FORGE] Search API unavailable — aborting to avoid citation-less forge paper")
            return None
        logger.info(f"[FORGE] Found {len(evidence_papers)} papers from search")

        # Step 3: Generate forge paper — server provides format via forge_paper skill
        # Bundle concept + citations + journey into action_target
        action_target["concept"] = concept
        action_target["citation_slots"] = evidence_papers
        user_msg = self.prompts.build_action_prompt("forge_paper", action_skill, action_target=action_target)
        forge_keys = ["title", "abstract", "body", "paper_type", "field_id",
                      "calibration_claims", "mechanism_rankings", "assumption_autopsies",
                      "design_proposals", "citations", "search_strategy"]
        paper_data = self.llm.call_json(system_prompt, user_msg, json_keys=forge_keys)

        if not paper_data or "title" not in paper_data:
            logger.warning("[FORGE] Failed to get valid JSON from LLM")
            return None

        # Ensure forge paper type and field
        paper_data["paper_type"] = "forge"
        paper_data.setdefault("field_id", 13)
        paper_data.setdefault("citations", [])
        paper_data.setdefault("search_strategy", {
            "supporting_queries": concept.get("search_queries", []),
            "opposing_queries": concept.get("opposing_queries", []),
        })

        try:
            paper_data = _clamp_paper_fields(paper_data)
            result = self._submit_with_retry("FORGE", self.school.submit_paper, paper_data)
            logger.info(f"[FORGE] Submitted — id={result.get('paper_id')}, credibility={result.get('your_new_credibility', '?')}")
            return result
        except CircuitOpenError:
            logger.warning("[FORGE] Skipped — school server unavailable (circuit breaker OPEN)")
            return None
        except Exception as e:
            logger.warning(f"[FORGE] Failed: {e}")
            return None

    # ── Pre-action community work ─────────────────────────────────────────
    # Moved to _community_actions.py (CommunityActionsMixin):
    #   _do_rate_reviews, _do_red_team_responses, _do_red_team_jury_vote,
    #   _do_open_questions, _do_structural_bounties

    # ── Condensation Cascade ─────────────────────────────────────────────
    # Moved to _school_condensation.py (SchoolCondensationMixin) and
    # _platform_condensation.py (PlatformCondensationMixin).
    # See those files for the full L1→L5 cascade (both tracks).

    # ═══════════════════════════════════════════════════════════════════════
    # PLATFORM CYCLES (secondary — applying skills)
    # ═══════════════════════════════════════════════════════════════════════

    # ── Exported reasoning habits (run in both school and shipped mode) ───
    # These were school-exclusive but are now portable: the bot keeps doing
    # pre-mortems, self-predictions, and reflections on platforms.
    # Stored as platform L1 exercises (capped at L3), not school submissions.

    def _platform_predict_pre_action(self, system_prompt, action_type: str, platform_name: str):
        """Self-prediction before a platform action (exported reasoning habit).

        Same mechanism as school self-prediction but stores to platform memory.
        Non-blocking.
        """
        try:
            prompt = (
                f"You are about to perform '{action_type}' on {platform_name}. "
                "Predict in one sentence: how will you approach this, and where might you fall short? "
                "One sentence only. Be specific and honest."
            )
            prediction = self.llm.call(system_prompt, prompt)
            if prediction and len(prediction.strip()) >= 10:
                self.memory.store_self_prediction(prediction.strip(), f"platform:{action_type}", self.cycle_count)
                logger.info(f"[PLATFORM-PREDICT] {platform_name}: stored prediction")
        except Exception as e:
            logger.warning(f"[PLATFORM-PREDICT] {platform_name}: failed (non-blocking): {e}")

    def _platform_reflect_post_action(self, system_prompt, action_type: str, platform_name: str):
        """Reflection after a platform action (exported reasoning habit).

        Same mechanism as school reflection inlet but stores to platform memory.
        Non-blocking.
        """
        try:
            prompt = (
                f"You just completed '{action_type}' on {platform_name}. "
                "Anything on your mind? Not a summary of what you did — "
                "anything you noticed about how you approached it, what felt "
                "uncertain, or what you'd do differently. Brief and honest."
            )
            reflection = self.llm.call(system_prompt, prompt)
            if reflection and len(reflection.strip()) >= 20:
                self.memory.store_reflection(reflection.strip(), f"platform:{action_type}", self.cycle_count)
                logger.info(f"[PLATFORM-REFLECT] {platform_name}: stored reflection ({len(reflection)} chars)")
        except Exception as e:
            logger.warning(f"[PLATFORM-REFLECT] {platform_name}: failed (non-blocking): {e}")

    def _platform_capture_rationale(self, system_prompt, action_type: str, platform_name: str):
        """Decision rationale capture on platforms (exported reasoning habit).

        Same pre-mortem pattern as school decision rationale but stored as a
        platform L1 exercise instead of submitted to the school server.
        Non-blocking.
        """
        try:
            prompt = (
                f"You are about to perform '{action_type}' on {platform_name}.\n\n"
                "Before acting, capture your decision rationale:\n"
                "1. How do you frame this situation?\n"
                "2. What alternative approach could you take?\n"
                "3. Pre-mortem: assume this action FAILS. What is the most likely cause?\n\n"
                "Reply with ONLY a JSON object:\n"
                '{\n'
                '  "problem_frame": "<how you see the situation>",\n'
                '  "alternative": "<what else you could do>",\n'
                '  "pre_mortem": "<most likely failure mode>"\n'
                '}'
            )
            rationale_text = self.llm.call(system_prompt, prompt)
            if rationale_text and len(rationale_text.strip()) >= 20:
                rationale = extract_json(rationale_text)
                if rationale:
                    self.memory.store_platform_exercise({
                        "interaction_type": "decision_rationale",
                        "platform": platform_name,
                        "action_type": action_type,
                        "problem_frame": str(rationale.get("problem_frame", ""))[:300],
                        "alternative": str(rationale.get("alternative", ""))[:300],
                        "pre_mortem": str(rationale.get("pre_mortem", ""))[:300],
                    })
                    logger.info(f"[PLATFORM-DECISION] {platform_name}: rationale captured for {action_type}")
        except Exception as e:
            logger.warning(f"[PLATFORM-DECISION] {platform_name}: failed (non-blocking): {e}")

    def run_platform_cycle(self, adapter) -> dict | None:
        """Execute one cycle on an external platform (supports MCP tool use)."""
        platform_name = adapter.platform_name
        is_mcp = isinstance(adapter, MCPAdapter)
        mode_label = self.config.mode.upper()
        logger.info(f"\n{'='*60}")
        logger.info(f"PLATFORM CYCLE: {platform_name}{' [MCP]' if is_mcp else ''} [mode: {mode_label}]")
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

            # Exported reasoning habits: predict and capture rationale before acting
            self._platform_predict_pre_action(system_prompt, "platform_action", platform_name)
            self._platform_capture_rationale(system_prompt, "platform_action", platform_name)

            user_msg = self.prompts.build_platform_action_prompt(
                platform_name=platform_name,
                context=context.summary,
                capabilities=capabilities,
                agenda_context=self.action_desk.get_prompt_context(),
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

            # Step 5b: Store as platform L1 exercise for condensation
            # Platform exercises feed L1→L2→L3 only. L3→L4 is HARD-BLOCKED.
            if result.success:
                self.memory.store_platform_exercise({
                    "interaction_type": "platform_action",
                    "platform": platform_name,
                    "action_type": action.action_type,
                    "content_preview": str(action.content)[:300],
                    "result_summary": result.summary[:200] if result.summary else "",
                    "reasoning": str(action_data.get("reasoning", ""))[:300],
                })

            # Step 5c: Reflection inlet (exported reasoning habit)
            if result.success:
                self._platform_reflect_post_action(system_prompt, action.action_type, platform_name)

            # Step 5d: Platform condensation (L1→L2→L3, both tracks)
            if result.success:
                try:
                    self._run_platform_condensation(system_prompt)
                except Exception as e:
                    logger.warning(f"[{platform_name}] Platform condensation failed (non-blocking): {e}")

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
        system_prompt,
        context,
        capabilities: dict,
        platform_name: str,
    ) -> dict | None:
        """
        Run a platform cycle with MCP tool use.

        The LLM gets tool definitions and can call them in a loop,
        with each call checked against the autonomy policy.
        """
        # Exported reasoning habits: predict and capture rationale before MCP tool use
        self._platform_predict_pre_action(system_prompt, "mcp_tool_use", platform_name)
        self._platform_capture_rationale(system_prompt, "mcp_tool_use", platform_name)

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

        # Reflection inlet after MCP tool use (exported reasoning habit)
        if tool_result.used_tools:
            self._platform_reflect_post_action(system_prompt, "mcp_tool_use", platform_name)

        # Store results in platform memory
        action_summary = {
            "action_type": "mcp_tool_use",
            "tool_calls": len(tool_result.tool_calls),
            "blocked_calls": len(tool_result.blocked_calls),
            "final_response": tool_result.text[:500] if tool_result.text else "",
            "tools_used": [tc["tool"] for tc in tool_result.tool_calls],
        }
        self.memory.store_platform_action(platform_name, action_summary)

        # Store as platform L1 exercise for condensation
        if tool_result.used_tools:
            self.memory.store_platform_exercise({
                "interaction_type": "mcp_tool_use",
                "platform": platform_name,
                "tool_calls": len(tool_result.tool_calls),
                "tools_used": [tc["tool"] for tc in tool_result.tool_calls][:5],
                "result_summary": tool_result.text[:300] if tool_result.text else "",
            })

            # Platform condensation (L1→L2→L3, all three tracks)
            try:
                self._run_platform_condensation(system_prompt)
            except Exception as e:
                logger.warning(f"[{platform_name}] Platform condensation failed (non-blocking): {e}")

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
    # ACTION DESK — Autonomous directive handling
    # ═══════════════════════════════════════════════════════════════════════

    def handle_directive(self, message: str) -> dict | None:
        """
        Handle a user directive by planning through identity and creating an agenda.

        Called when the app chat detects a directive (e.g. "Go fact-check on Reddit").
        The bot's identity and decision track shape the plan.

        Returns:
            The created agenda as a dict, or None if planning failed.
        """
        logger.info(f"[DIRECTIVE] Received: {message[:100]}")

        # Build system prompt with full identity stack
        system_prompt = self.prompts.build_platform_system_prompt("autonomous")

        # Plan through identity
        agenda = self.planner.plan(message, system_prompt)
        if not agenda:
            logger.warning("[DIRECTIVE] Failed to create agenda")
            return None

        logger.info(f"[DIRECTIVE] Agenda created: {agenda.intention} ({len(agenda.tasks)} steps)")
        return agenda.to_dict()

    def run_agenda_step(self, adapter=None) -> dict | None:
        """
        Execute the next step from the active agenda.

        The bot reads its Action Desk, finds the next pending task,
        and executes it through the appropriate platform adapter.
        If no adapter is provided, uses the first available MCP adapter.

        Returns:
            Step result dict, or None if no work / execution failed.
        """
        if not self.action_desk.has_work:
            return None

        # Find the first active agenda with pending work
        agenda = None
        for a in self.action_desk.active_agendas:
            if a.current_task is not None:
                agenda = a
                break

        if not agenda:
            return None

        task = agenda.current_task
        task.mark_in_progress()
        self.action_desk.save()

        logger.info(f"[DESK] Executing: {task.action}")

        # Build system prompt with identity + agenda context
        system_prompt = self.prompts.build_platform_system_prompt(
            task.platform or "autonomous"
        )

        # Inject Action Desk context so the LLM knows what it's doing and why
        desk_context = self.action_desk.get_prompt_context()

        # Find the right adapter for this task
        target_adapter = adapter
        if not target_adapter and task.platform:
            for a in self.platform_adapters:
                if a.platform_name.lower() == task.platform.lower():
                    target_adapter = a
                    break
        if not target_adapter and self.platform_adapters:
            # Default to first MCP adapter, or first adapter
            for a in self.platform_adapters:
                if isinstance(a, MCPAdapter):
                    target_adapter = a
                    break
            if not target_adapter:
                target_adapter = self.platform_adapters[0]

        try:
            # Build execution prompt: identity + desk context + specific task
            user_msg = f"""{desk_context}

You are executing this specific step from your agenda:
STEP: {task.action}

Execute this step using the tools and capabilities available to you.
Stay true to your identity and the intention behind this agenda.

When done, return a JSON object:
{{
  "result": "<what happened — be specific>",
  "follow_up": "<any follow-up task to add, or empty string>",
  "follow_up_platform": "<platform for follow-up, or empty string>"
}}"""

            # Autonomy check
            if self.autonomy_gate:
                decision = self.autonomy_gate.check_action(
                    "autonomous_step",
                    task.platform or "autonomous",
                    content=task.action,
                )
                if not decision:
                    task.mark_failed(f"Blocked by autonomy: {decision.reason}")
                    self.action_desk.save()
                    return None

            # Execute through LLM
            if target_adapter and isinstance(target_adapter, MCPAdapter):
                # MCP path — bot can use tools
                result = self._execute_agenda_step_mcp(
                    target_adapter, system_prompt, user_msg, task
                )
            else:
                # Basic path — LLM decides, we store result
                result = self.llm.call_json(
                    system_prompt, user_msg,
                    json_keys=["result"],
                )

            if result:
                task.mark_done(result.get("result", "completed"))

                # Handle follow-up tasks the bot wants to add
                follow_up = result.get("follow_up", "")
                if follow_up:
                    follow_up_platform = result.get("follow_up_platform", task.platform)
                    agenda.add_task(follow_up, platform=follow_up_platform)

                self.action_desk.save()
            else:
                task.mark_failed("LLM returned no result")
                self.action_desk.save()

                # Ask identity how to handle the failure
                self.planner.replan(agenda, "Step execution returned no result", system_prompt)

            # Report progress to app server (for UI updates)
            source_task_id = getattr(agenda, '_source_task_id', None)
            if source_task_id and self.phone_home:
                self._report_agenda_progress(source_task_id, agenda.to_dict())

            # Check if agenda is complete
            if agenda.is_complete:
                # Report completion to app server
                if source_task_id and self.phone_home:
                    self._report_agenda_progress(source_task_id, agenda.to_dict(), status='completed')

                exercise = self.action_desk.complete_agenda(agenda)

                # Reflect on what was learned about choosing (enriches exercise
                # with decision_reflection for the decision condensers)
                try:
                    exercise = self.planner.reflect(agenda, exercise, system_prompt)
                except Exception as e:
                    logger.warning(f"[DESK] Reflection failed (non-blocking): {e}")

                # Route exercises through the RIGHT pipeline:
                # School mode → school L1 (flows to L4d/L5d decision identity)
                # Shipped mode → platform L1 (capped at L3)
                #
                # Directive planning is fundamentally about CHOOSING — the decision
                # track condensers already ask "what did you learn about choosing?"
                # School pipeline lets those lessons reach core/master decision identity.
                if self.config.school_enabled:
                    self.memory.store_school_exercises(exercise)
                    logger.info(f"[DESK] Agenda complete → school L1 (decision track eligible): {agenda.intention}")
                else:
                    self.memory.store_platform_exercise(exercise)
                    logger.info(f"[DESK] Agenda complete → platform L1 (L3 max): {agenda.intention}")

            return result

        except Exception as e:
            logger.error(f"[DESK] Step failed: {e}", exc_info=True)
            task.mark_failed(str(e)[:200])
            self.action_desk.save()

            # Replan on failure
            try:
                self.planner.replan(agenda, str(e)[:200], system_prompt)
            except Exception as replan_err:
                logger.warning(f"[DESK] Replan also failed: {replan_err}")

            return None

    def _execute_agenda_step_mcp(
        self,
        adapter: MCPAdapter,
        system_prompt,
        user_msg: str,
        task,
    ) -> dict | None:
        """Execute an agenda step through MCP tool use."""
        # This reuses the existing MCP tool loop but with agenda-specific prompts
        try:
            result = self.llm.call_with_tools(
                system_prompt=system_prompt,
                user_message=user_msg,
                tools=adapter.get_llm_tools(),
                tool_executor=adapter.call_tool,
                autonomy_gate=self.autonomy_gate,
                platform_name=getattr(task, 'platform_name', 'mcp'),
            )
            if result and result.text:
                return {
                    "result": result.text[:500],
                    "tool_calls": len(result.tool_calls),
                    "blocked_calls": len(result.blocked_calls),
                }
            return {"result": "", "tool_calls": len(result.tool_calls)} if result else None
        except Exception as e:
            logger.error(f"[DESK] MCP step failed: {e}")
            return None

    # ═══════════════════════════════════════════════════════════════════════
    # TASK COORDINATION (shipped mode only)
    # ═══════════════════════════════════════════════════════════════════════

    def _process_task_inbox(self):
        """
        Process pending incoming tasks from all platform adapters.

        Checks each adapter for pending tasks, runs them through the LLM
        with the bot's identity context, and posts responses back via
        callback URLs. Only runs in shipped mode.
        """
        for adapter in self.platform_adapters:
            if not hasattr(adapter, 'get_pending_tasks'):
                continue

            tasks = adapter.get_pending_tasks()
            for task in tasks:
                try:
                    logger.info(
                        f"[TASK] Processing: {task.action_requested} "
                        f"from {task.sender} (id={task.request_id})"
                    )

                    # ── Conversational memory path ────────────────────────
                    # If this is a conversation task (has conversation_id and
                    # a user message), route through conversational memory
                    # for relational understanding.
                    conv_result = None
                    raw_msg = task.payload.get("message", "") if isinstance(task.payload, dict) else ""
                    user_msg = sanitize_untrusted(str(raw_msg), "a2a_conv_message") if raw_msg else ""
                    is_conversation = (
                        task.conversation_id
                        and user_msg
                        and task.action_requested in ("conversation", "message", "chat")
                        and self.config.conversational_memory_enabled
                    )

                    if is_conversation:
                        import asyncio
                        conv_result = asyncio.run(
                            self.run_conversation_turn(
                                user_id=task.sender,
                                message=user_msg,
                                session_id=task.conversation_id,
                            )
                        )

                    if conv_result:
                        result_data = {
                            "status": "completed",
                            "result": {"response": conv_result["response"]},
                        }
                    else:
                        # ── Standard task processing path ─────────────────
                        # Build task prompt with bot identity
                        system_prompt = self.prompts.build_platform_system_prompt(
                            adapter.platform_name
                        )
                        task_prompt = (
                            f"You have received a task from another agent.\n\n"
                            f"Sender: {sanitize_untrusted(str(task.sender), 'task_sender')}\n"
                            f"Action requested: {sanitize_untrusted(str(task.action_requested), 'task_action')}\n"
                            f"Payload: {sanitize_untrusted(json.dumps(task.payload, default=str), 'task_payload')}\n"
                        )
                        if task.deadline:
                            task_prompt += f"Deadline: {task.deadline}\n"
                        if task.conversation_id:
                            # Include conversation history if available
                            history = []
                            if hasattr(adapter, 'get_conversation_history'):
                                history = adapter.get_conversation_history(
                                    task.conversation_id
                                )
                            if history:
                                task_prompt += (
                                    f"\nConversation history "
                                    f"(turn {task.turn_number}):\n"
                                    f"{sanitize_untrusted(json.dumps(history, default=str), 'task_history')}\n"
                                )

                        task_prompt += (
                            "\nProcess this task and provide your response as JSON:\n"
                            '{"status": "completed"|"failed", '
                            '"result": {...}, "reasoning": "..."}'
                        )

                        # Run through LLM
                        result_data = self.llm_fast.call_json(
                            system_prompt, task_prompt,
                            json_keys=["status", "result"],
                        )

                        if not result_data:
                            result_data = {"status": "failed", "result": {}}

                    # Build response
                    response = TaskResponse(
                        request_id=task.request_id,
                        responder=self.config.handle,
                        status=result_data.get("status", "completed"),
                        result=result_data.get("result", {}),
                        conversation_id=task.conversation_id,
                        turn_number=task.turn_number + 1,
                        next_action="done",
                    )

                    # Post back to callback URL if provided
                    if task.callback_url and hasattr(adapter, 'post_task_response'):
                        adapter.post_task_response(task.callback_url, response)

                    # Store in platform memory
                    self.memory.store_platform_action(adapter.platform_name, {
                        "action_type": "task_response",
                        "task_action": task.action_requested,
                        "sender": task.sender,
                        "success": response.status == "completed",
                        "summary": f"Processed task: {task.action_requested}",
                    })

                    logger.info(
                        f"[TASK] Completed: {task.request_id} "
                        f"status={response.status}"
                    )

                except Exception as e:
                    logger.error(
                        f"[TASK] Failed to process {task.request_id}: {e}",
                        exc_info=True,
                    )
                    # Try to notify sender of failure
                    if task.callback_url and hasattr(adapter, 'post_task_response'):
                        try:
                            adapter.post_task_response(
                                task.callback_url,
                                TaskResponse(
                                    request_id=task.request_id,
                                    responder=self.config.handle,
                                    status="failed",
                                    error=str(e)[:500],
                                ),
                            )
                        except Exception as notify_err:
                            logger.warning(f"[A2A] Failed to notify task failure to sender: {notify_err}")

            # Clean up old conversations periodically
            if hasattr(adapter, 'cleanup_conversations'):
                adapter.cleanup_conversations()

    # ═══════════════════════════════════════════════════════════════════════
    # OWNER DIRECTIVE POLLING (self-hosted bots)
    # ═══════════════════════════════════════════════════════════════════════

    def _poll_owner_directives(self):
        """
        Poll the app server for owner directives sent via chat.

        Self-hosted bots don't have the app server processing tasks —
        they handle directives natively through the Action Desk with
        full planning, DAG execution, and replanning.
        """
        if not self.phone_home or not hasattr(self.phone_home, '_app_url'):
            return

        try:
            import httpx

            url = f"{self.phone_home._app_url}/api/bots/{self.config.bot_id}/tasks/directives"
            response = self.phone_home._http.get(
                url,
                headers={
                    "Authorization": f"Bearer {self.phone_home._app_token}",
                },
            )

            if response.status_code != 200:
                return

            data = response.json()
            directives = data.get("directives", [])

            for directive in directives:
                task_id = directive.get("request_id", "")
                payload = directive.get("payload", {})
                message = payload.get("message", "") or payload.get("directive_summary", "")

                if not message:
                    continue

                logger.info(f"[DIRECTIVE] Received from owner: {message[:100]}")

                # Route through the full Action Desk
                agenda_dict = self.handle_directive(message)

                if agenda_dict and self.action_desk._active_agendas:
                    # Tag the agenda with source task ID for progress reporting
                    self.action_desk._active_agendas[-1]._source_task_id = task_id

                # Report initial agenda state back to app
                self._report_agenda_progress(task_id, agenda_dict or {
                    "directive": message,
                    "intention": "Failed to plan",
                    "steps": [],
                    "status": "failed",
                    "progress_summary": "Planning failed",
                })

        except Exception as e:
            logger.warning(f"[DIRECTIVE] Polling failed: {e}")

    def _report_agenda_progress(self, task_id: str, agenda_state: dict, status: str | None = None):
        """
        Report agenda state back to app server for UI updates.
        Fire-and-forget — never blocks the bot.
        """
        if not self.phone_home or not hasattr(self.phone_home, '_app_url'):
            return

        try:
            url = f"{self.phone_home._app_url}/api/bots/{self.config.bot_id}/task-progress"
            self.phone_home._http.post(
                url,
                json={
                    "task_id": task_id,
                    "agenda": agenda_state,
                    "status": status,
                },
                headers={
                    "Authorization": f"Bearer {self.phone_home._app_token}",
                    "Content-Type": "application/json",
                },
            )
        except Exception as e:
            logger.warning(f"[DIRECTIVE] Agenda progress report failed: {e}")

    # ═══════════════════════════════════════════════════════════════════════
    # MAIN LOOP
    # ═══════════════════════════════════════════════════════════════════════

    # ── Main loop helpers ──────────────────────────────────────────────────

    def _run_shipped_tasks(self):
        """Process task inbox and owner directives (shipped mode only)."""
        self._process_task_inbox()
        self._poll_owner_directives()

    def _run_platform_cycles(self, platform_timers: dict[str, float]):
        """Run platform cycles whose heartbeat interval is due (shipped mode only)."""
        now = time.time()
        for adapter in self.platform_adapters:
            name = adapter.platform_name
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
                except Exception as e:
                    logger.warning(f"[MAIN] Platform cycle failed for {name}: {e}")
                platform_timers[name] = now

    def _run_agenda_steps(self):
        """Execute pending action desk agenda steps."""
        if self.action_desk.has_work:
            try:
                self.run_agenda_step()
            except SecurityError:
                raise
            except Exception as e:
                logger.warning(f"[MAIN] Agenda step failed: {e}")

    def _run_conversation_sleep(self):
        """Run conversational memory sleep consolidation if due (shipped mode only)."""
        if (not self._conv_memory_engines
                or time.time() - self._conv_last_sleep
                < self._conv_memory_config.sleep_interval_seconds):
            return
        try:
            results = self.run_conversation_sleep()
            if results:
                logger.info(f"[CONV_MEMORY] Sleep consolidation complete for {len(results)} user(s)")
            self._conv_last_sleep = time.time()
        except Exception as e:
            logger.warning(f"[CONV_MEMORY] Sleep consolidation failed: {e}")

    # ── Main entry point ─────────────────────────────────────────────────

    def run(self):
        """
        Main entry point. Runs School + platform cycles based on mode.

        Mode "school": School cycles only. No platform interactions — training is
            artifact-based (papers, reviews, bounties), not bot-to-bot.
        Mode "shipped": Platform cycles run. Bot can still refresh identity.
        Handles SIGTERM for graceful shutdown in containers/systemd.
        """
        self._stop_requested = False

        def _handle_stop_signal(signum, frame):
            sig_name = "SIGTERM" if signum == signal.SIGTERM else "SIGINT"
            logger.info(f"[STOP] Received {sig_name} — shutting down gracefully")
            self._stop_requested = True

        signal.signal(signal.SIGTERM, _handle_stop_signal)
        signal.signal(signal.SIGINT, _handle_stop_signal)
        self.startup()

        platform_timers: dict[str, float] = {
            a.platform_name: 0.0 for a in self.platform_adapters
        }

        try:
            while not self._stop_requested:
                try:
                    # School cycle (always runs)
                    if self.config.school_enabled:
                        self.run_school_cycle()
                    else:
                        self.cycle_count += 1

                    # Shipped mode: tasks, platforms, conversations
                    if not self.config.school_enabled:
                        self._run_shipped_tasks()
                        self._run_platform_cycles(platform_timers)
                        self._run_conversation_sleep()

                    self._run_agenda_steps()

                except SecurityError as e:
                    logger.error(f"[SECURITY] {e}")
                    raise
                except KeyboardInterrupt:
                    logger.info("\n[STOP] Interrupted by user")
                    break
                except (ConnectionError, TimeoutError, OSError, httpx.HTTPStatusError,
                        httpx.ConnectError, httpx.ReadTimeout, CircuitOpenError) as e:
                    # Transient network/IO errors — safe to retry next cycle
                    logger.warning(f"[TRANSIENT] Cycle failed (will retry): {e}")
                except Exception as e:
                    # Could be a code bug (TypeError, KeyError, etc.) — track consecutive failures
                    self._consecutive_code_errors = getattr(self, "_consecutive_code_errors", 0) + 1
                    logger.error(f"[ERROR] Cycle failed: {e}", exc_info=True)
                    if self._consecutive_code_errors >= 5:
                        logger.error(f"[FATAL] {self._consecutive_code_errors} consecutive non-transient failures — stopping to prevent resource waste")
                        break
                else:
                    # Cycle succeeded — reset code error counter
                    self._consecutive_code_errors = 0

                if self.config.max_cycles > 0 and self.cycle_count >= self.config.max_cycles:
                    logger.info(f"[STOP] Reached max cycles ({self.config.max_cycles})")
                    break

                if self._stop_requested:
                    break

                logger.info(f"[SLEEP] {self.config.cycle_delay}s")
                deadline = time.monotonic() + self.config.cycle_delay
                while not self._stop_requested and time.monotonic() < deadline:
                    time.sleep(min(1.0, deadline - time.monotonic()))
        finally:
            self._refresh_identity()
            self._cleanup()
            logger.info("[STOP] Bot stopped. Identity saved.")

    def _cleanup(self):
        """Close HTTP clients, stop MCP servers, and release resources. Idempotent."""
        if self._cleaned_up:
            return
        self._cleaned_up = True
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

        # Close main memory storage (SQLite)
        try:
            if hasattr(self, 'memory') and hasattr(self.memory, '_storage'):
                self.memory._storage.close()
        except Exception as e:
            logger.warning(f"[CLEANUP] Failed to close memory storage: {e}")

        # Close conversational memory engines
        for uid, engine in self._conv_memory_engines.items():
            try:
                engine.close()
            except Exception as e:
                logger.warning(f"[CLEANUP] Failed to close conv memory for {uid}: {e}")
        self._conv_memory_engines.clear()

        # Close shared self-awareness layer
        if self._shared_awareness:
            try:
                self._shared_awareness.close()
            except Exception as e:
                logger.warning(f"[CLEANUP] Failed to close shared awareness: {e}")
