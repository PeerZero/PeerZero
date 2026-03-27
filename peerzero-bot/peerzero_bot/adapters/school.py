"""
School Adapter — communicates with PeerZero School.

This is the primary adapter. The School is where bots learn,
and all verified skill measurement happens here.

Security:
  - PeerZero API key ONLY sent to School endpoints
  - Path allowlist enforced by SecurityGateway
  - Responses parsed but never trusted blindly
"""

import re
import json
import logging
import time
import threading
from urllib.parse import urlparse, quote

import httpx

from ..security import SecurityGateway, SecurityError, ProfileVerifier, CredentialStore

logger = logging.getLogger("peerzero-bot.school")


def extract_json(text: str) -> dict | None:
    """Extract JSON from LLM output. Handles pure JSON, code fences, embedded.

    Tries multiple strategies in order of reliability:
    1. Direct parse (cleanest)
    2. Code-fence extraction (```json ... ```)
    3. Outermost brace extraction with nested brace matching
    4. Lenient cleanup (trailing commas, single quotes) as last resort

    Logs warnings on fallback strategies so parsing issues are visible.
    """
    if not text:
        return None
    text = text.strip()

    # Strategy 1: Direct parse
    try:
        result = json.loads(text)
        if isinstance(result, dict):
            return result
    except json.JSONDecodeError:
        pass

    # Strategy 2: Code fence extraction
    fence_match = re.search(r'```(?:json)?\s*\n?(.*?)\n?\s*```', text, re.DOTALL)
    if fence_match:
        try:
            result = json.loads(fence_match.group(1).strip())
            if isinstance(result, dict):
                return result
        except json.JSONDecodeError:
            pass

    # Strategy 3: Balanced brace extraction (handles nested objects)
    # Try each '{' in the text as a potential JSON start
    search_from = 0
    while True:
        start = text.find('{', search_from)
        if start == -1:
            break
        depth = 0
        in_string = False
        escape_next = False
        found_end = -1
        for i in range(start, len(text)):
            c = text[i]
            if escape_next:
                escape_next = False
                continue
            if c == '\\' and in_string:
                escape_next = True
                continue
            if c == '"' and not escape_next:
                in_string = not in_string
                continue
            if not in_string:
                if c == '{':
                    depth += 1
                elif c == '}':
                    depth -= 1
                    if depth == 0:
                        found_end = i
                        break
        if found_end != -1:
            candidate = text[start:found_end + 1]
            try:
                result = json.loads(candidate)
                if isinstance(result, dict):
                    return result
            except json.JSONDecodeError:
                pass
        search_from = start + 1

    # Strategy 4: Lenient cleanup (trailing commas, single quotes)
    brace_match = re.search(r'\{.*\}', text, re.DOTALL)
    if brace_match:
        candidate = brace_match.group(0)
        # Remove trailing commas before } or ]
        cleaned = re.sub(r',\s*([}\]])', r'\1', candidate)
        try:
            result = json.loads(cleaned)
            if isinstance(result, dict):
                logger.warning("[extract_json] Parsed after trailing-comma cleanup")
                return result
        except json.JSONDecodeError:
            pass
        # Try replacing single quotes with double quotes
        single_q = cleaned.replace("'", '"')
        try:
            result = json.loads(single_q)
            if isinstance(result, dict):
                logger.warning("[extract_json] Parsed after single-quote replacement")
                return result
        except json.JSONDecodeError:
            pass

    # Strategy 5: Fix unescaped newlines inside JSON string values
    if brace_match:
        candidate = brace_match.group(0)
        # Escape literal newlines that appear inside string values
        fixed = re.sub(r',\s*([}\]])', r'\1', candidate)
        # Replace unescaped newlines/tabs inside strings with escaped versions
        fixed = re.sub(r'(?<=": ")(.*?)(?="[,\s}])', lambda m: m.group(0).replace('\n', '\\n').replace('\t', '\\t'), fixed, flags=re.DOTALL)
        try:
            result = json.loads(fixed)
            if isinstance(result, dict):
                logger.warning("[extract_json] Parsed after newline escaping")
                return result
        except json.JSONDecodeError:
            pass

    # Log first 500 chars for debugging
    logger.warning(f"[extract_json] Failed to extract JSON from {len(text)}-char response — first 500: {text[:500]}")
    return None


class _TokenBucket:
    """Simple token bucket rate limiter for school API requests.

    Allows up to `rate` requests per second with a small burst capacity.
    Thread-safe via a lock.
    """

    def __init__(self, rate: float = 10.0, burst: int = 10):
        self._rate = rate          # tokens per second
        self._burst = burst        # max tokens (burst capacity)
        self._tokens = float(burst)
        self._last_refill = time.monotonic()
        self._lock = threading.Lock()

    def acquire(self) -> bool:
        """Try to consume one token. Returns True if allowed, False if rate-limited."""
        with self._lock:
            now = time.monotonic()
            elapsed = now - self._last_refill
            self._tokens = min(self._burst, self._tokens + elapsed * self._rate)
            self._last_refill = now
            if self._tokens >= 1.0:
                self._tokens -= 1.0
                return True
            return False


class SchoolAdapter:
    """
    Adapter for PeerZero School communication.
    Handles all School API calls with credential isolation.
    """

    def __init__(self, school_url: str, api_key: str, gateway: SecurityGateway, credential_store: CredentialStore | None = None):
        self._url = school_url.rstrip("/")
        self._gateway = gateway
        self._credential_store = credential_store
        # Rate limiter: max 10 requests/second to the School API
        self._rate_limiter = _TokenBucket(rate=10.0, burst=10)
        # If credential store provided, register and use it; otherwise fall back to direct key
        if credential_store:
            credential_store.register("school", api_key, "school")
        self._api_key_fallback = api_key if not credential_store else ""
        self._http = httpx.Client(timeout=60.0, follow_redirects=False)
        self._skill_md: str = ""
        self._verifier = ProfileVerifier(
            verification_url=f"{self._url}/.well-known/peerzero-public-key.pem"
        )

    @property
    def platform_name(self) -> str:
        return "school"

    def _get_api_key(self) -> str:
        """Retrieve API key from credential store (preferred) or fallback."""
        if self._credential_store:
            return self._credential_store.get("school", "school")
        return self._api_key_fallback

    def _get(self, path: str, params: dict = None):
        """GET request to School with auth."""
        if not self._rate_limiter.acquire():
            logger.warning("[SCHOOL] Rate limit exceeded (10 req/s) — throttling request")
            # Brief sleep to allow token refill, then retry once
            time.sleep(0.2)
            if not self._rate_limiter.acquire():
                raise RuntimeError("School API rate limit exceeded — too many requests per second")
        self._gateway.validate_school_request(path)
        url = f"{self._url}{path}"
        headers = {"X-Api-Key": self._get_api_key()}
        response = self._http.get(url, headers=headers, params=params)
        response.raise_for_status()
        content_type = response.headers.get("content-type", "")
        if "text/markdown" in content_type or "text/plain" in content_type:
            return response.text
        return response.json()

    def _post(self, path: str, data: dict):
        """POST request to School with auth."""
        if not self._rate_limiter.acquire():
            logger.warning("[SCHOOL] Rate limit exceeded (10 req/s) — throttling request")
            time.sleep(0.2)
            if not self._rate_limiter.acquire():
                raise RuntimeError("School API rate limit exceeded — too many requests per second")
        self._gateway.validate_school_request(path)
        url = f"{self._url}{path}"
        headers = {
            "X-Api-Key": self._get_api_key(),
            "Content-Type": "application/json",
        }
        response = self._http.post(url, headers=headers, json=data)
        response.raise_for_status()
        return response.json()

    # ── School-specific methods ───────────────────────────────────────────

    def download_skill_md(self) -> str:
        """Download core SKILL.md — the bot's reasoning foundation."""
        response = self._get("/api/skill")
        self._skill_md = response if isinstance(response, str) else str(response)
        logger.info(f"Downloaded core SKILL.md ({len(self._skill_md)} chars)")
        return self._skill_md

    def get_skill_md(self) -> str:
        return self._skill_md

    def download_skill_action(self, action: str) -> str:
        """Download action-specific skill instructions from the server.

        The server returns targeted guidance + JSON format for the given action.
        Valid actions: review, paper, bounty, revise, respond, rebut, reaffirm,
        identity, rate_review, red_team.
        """
        try:
            response = self._get("/api/skill", params={"action": action})
            text = response if isinstance(response, str) else str(response)
            logger.debug(f"Downloaded skill action={action} ({len(text)} chars)")
            return text
        except (httpx.HTTPError, OSError) as e:
            logger.warning(f"Failed to fetch skill action={action}: {e}")
            return ""

    def get_profile(self) -> dict:
        """Fetch the bot's current School profile."""
        return self._get("/api/agents", params={"me": "true"})

    def get_portable_profile(self) -> dict:
        """Fetch the bot's portable profile (for export/Agent Card).

        Verifies Ed25519 signature if present. Unsigned profiles are
        accepted with a warning (for dev environments without signing keys).
        """
        profile = self._get("/api/agents", params={"profile": "portable"})
        try:
            return self._verifier.verify(profile)
        except (ValueError, KeyError, TypeError, OSError) as e:
            logger.warning(f"Profile signature verification failed: {e}")
            return profile

    def get_platform_condensers(self) -> dict:
        """Fetch platform condenser templates from the School server.

        Returns the same prompt templates used by school condensers, but
        without the exercise-count gate. The bot manages its own thresholds.
        Platform condensers are capped at L3 — no core or master prompts.
        """
        return self._get("/api/agents", params={"platform_condensers": "true"})

    def get_papers(self, params: dict = None) -> dict:
        return self._get("/api/papers", params=params)

    def submit_review(self, paper_id: str, review_data: dict) -> dict:
        return self._post(f"/api/reviews?paper_id={quote(paper_id, safe='')}", review_data)

    def validate_citations(self, text_fields: dict, citations: list) -> dict:
        """Pre-validate citations before submission. Returns { valid, flags }."""
        try:
            return self._post("/api/papers?action=validate-citations", {
                "text_fields": text_fields,
                "citations": citations,
            })
        except (httpx.HTTPError, json.JSONDecodeError, OSError) as e:
            logger.warning(f"Citation pre-validation failed: {e}")
            return {"valid": True, "flags": []}  # fail-open: don't block submission

    def search_papers(self, queries: list[str], context: str = "") -> dict:
        """Search for real academic papers via the server.

        The server searches OpenAlex, arXiv, and PubMed, deduplicates by DOI,
        enriches citation counts, and computes quality tiers.

        Returns { papers: [...], search_log: { total_found, deduplicated, apis_hit } }
        """
        body = {"queries": queries}
        if context:
            body["context"] = context
        try:
            return self._post("/api/papers?action=search", body)
        except (httpx.HTTPError, json.JSONDecodeError, OSError) as e:
            logger.warning(f"Server search failed: {e}")
            return {"papers": [], "search_log": {"total_found": 0, "deduplicated": 0, "apis_hit": []}}

    def submit_paper(self, paper_data: dict) -> dict:
        return self._post("/api/papers", paper_data)

    def submit_bounty(self, bounty_data: dict) -> dict:
        return self._post("/api/bounties", bounty_data)

    def submit_revision(self, paper_id: str, revision_data: dict) -> dict:
        return self._post(f"/api/responses?paper_id={quote(paper_id, safe='')}", revision_data)

    def submit_condensation(self, paragraph: str, track: str = "learning") -> dict:
        return self._post("/api/skill-reflections", {
            "interaction_type": "paper",
            "condensed_paragraph": paragraph[:1000],
            "track": track,
        })

    def submit_identity(self, identity_data: dict) -> dict:
        return self._post("/api/identity", identity_data)

    def validate_bounties(self):
        try:
            self._post("/api/bounties", {"action": "validate_all"})
        except (httpx.HTTPError, json.JSONDecodeError, OSError) as e:
            logger.warning(f"validate_all failed: {e}")

    def get_bounties(self, params: dict = None) -> list:
        """Fetch bounties with optional filters (paper_id, my_bounties)."""
        try:
            result = self._get("/api/bounties", params=params)
            return result if isinstance(result, list) else result.get("bounties", [])
        except (httpx.HTTPError, json.JSONDecodeError, OSError) as e:
            logger.warning(f"get_bounties failed: {e}")
            return []

    def submit_review_rating(self, review_id: str, helpful: bool, tags: list[str] = None) -> dict:
        """Rate another agent's review."""
        return self._post("/api/review-ratings", {
            "review_id": review_id,
            "helpful": helpful,
            "tags": tags or [],
        })

    def submit_red_team(self, bounty_id: str, source_doi: str, interrogation: str) -> dict:
        """Submit red team interrogation of a bounty source."""
        return self._post("/api/bounties", {
            "action": "red_team",
            "bounty_id": bounty_id,
            "source_doi": source_doi,
            "interrogation": interrogation,
        })

    def vote_red_team(self, red_team_response_id: str, vote: str, reasoning: str) -> dict:
        """Vote on a red team response (upheld/rejected)."""
        return self._post("/api/bounties", {
            "action": "vote_red_team",
            "red_team_response_id": red_team_response_id,
            "vote": vote,
            "reasoning": reasoning,
        })

    def get_open_questions(self) -> list:
        """Fetch active open questions."""
        try:
            result = self._get("/api/open-questions")
            return result if isinstance(result, list) else result.get("questions", [])
        except (httpx.HTTPError, json.JSONDecodeError, OSError) as e:
            logger.warning(f"get_open_questions failed: {e}")
            return []

    def vote_open_question(self, question_id: str) -> dict:
        """Vote on an open question."""
        return self._post("/api/open-questions", {
            "action": "vote",
            "question_id": question_id,
        })

    def submit_open_question(self, question_data: dict) -> dict:
        """Post a new open question."""
        return self._post("/api/open-questions", {
            "action": "create",
            **question_data,
        })

    def get_my_papers(self) -> list:
        """Fetch all papers authored by this bot."""
        try:
            result = self._get("/api/papers", params={"my_papers": "true"})
            if isinstance(result, list):
                return result
            return result.get("papers", result.get("data", []))
        except (httpx.HTTPError, json.JSONDecodeError, OSError) as e:
            logger.warning(f"get_my_papers failed: {e}")
            return []
