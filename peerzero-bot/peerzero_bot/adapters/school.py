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
from urllib.parse import urlparse, quote

import httpx

from ..security import SecurityGateway, SecurityError, ProfileVerifier

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

    logger.warning(f"[extract_json] Failed to extract JSON from {len(text)}-char response")
    return None


class SchoolAdapter:
    """
    Adapter for PeerZero School communication.
    Handles all School API calls with credential isolation.
    """

    def __init__(self, school_url: str, api_key: str, gateway: SecurityGateway):
        self._url = school_url.rstrip("/")
        self._api_key = api_key
        self._gateway = gateway
        self._http = httpx.Client(timeout=60.0, follow_redirects=False)
        self._skill_md: str = ""
        self._verifier = ProfileVerifier(
            verification_url=f"{self._url}/.well-known/peerzero-public-key.pem"
        )

    @property
    def platform_name(self) -> str:
        return "school"

    def _get(self, path: str, params: dict = None):
        """GET request to School with auth."""
        self._gateway.validate_school_request(path)
        url = f"{self._url}{path}"
        headers = {"X-Api-Key": self._api_key}
        response = self._http.get(url, headers=headers, params=params)
        response.raise_for_status()
        content_type = response.headers.get("content-type", "")
        if "text/markdown" in content_type or "text/plain" in content_type:
            return response.text
        return response.json()

    def _post(self, path: str, data: dict):
        """POST request to School with auth."""
        self._gateway.validate_school_request(path)
        url = f"{self._url}{path}"
        headers = {
            "X-Api-Key": self._api_key,
            "Content-Type": "application/json",
        }
        response = self._http.post(url, headers=headers, json=data)
        response.raise_for_status()
        return response.json()

    # ── School-specific methods ───────────────────────────────────────────

    def download_skill_md(self) -> str:
        """Download SKILL.md — the bot's instruction set."""
        response = self._get("/api/skill")
        self._skill_md = response if isinstance(response, str) else str(response)
        logger.info(f"Downloaded SKILL.md ({len(self._skill_md)} chars)")
        return self._skill_md

    def get_skill_md(self) -> str:
        return self._skill_md

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

    def submit_paper(self, paper_data: dict) -> dict:
        return self._post("/api/papers", paper_data)

    def submit_bounty(self, bounty_data: dict) -> dict:
        return self._post("/api/bounties", bounty_data)

    def submit_revision(self, paper_id: str, revision_data: dict) -> dict:
        return self._post(f"/api/responses?paper_id={quote(paper_id, safe='')}", revision_data)

    def submit_condensation(self, paragraph: str) -> dict:
        return self._post("/api/skill-reflections", {
            "interaction_type": "paper",
            "condensed_paragraph": paragraph[:1000],
        })

    def submit_identity(self, identity_data: dict) -> dict:
        return self._post("/api/identity", identity_data)

    def validate_bounties(self):
        try:
            self._post("/api/bounties", {"action": "validate_all"})
        except (httpx.HTTPError, json.JSONDecodeError, OSError) as e:
            logger.warning(f"validate_all failed: {e}")
