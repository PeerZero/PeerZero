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
from urllib.parse import urlparse

import httpx

from ..security import SecurityGateway, SecurityError

logger = logging.getLogger("peerzero-bot.school")


def extract_json(text: str) -> dict | None:
    """Extract JSON from LLM output. Handles pure JSON, code fences, embedded."""
    if not text:
        return None
    text = text.strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    fence_match = re.search(r'```(?:json)?\s*\n?(.*?)\n?\s*```', text, re.DOTALL)
    if fence_match:
        try:
            return json.loads(fence_match.group(1).strip())
        except json.JSONDecodeError:
            pass
    brace_match = re.search(r'\{.*\}', text, re.DOTALL)
    if brace_match:
        try:
            return json.loads(brace_match.group(0))
        except json.JSONDecodeError:
            pass
    return None


def pick_paper_to_review(papers: list[dict], my_papers: list[str], my_reviews: list[str]) -> dict | None:
    """Select paper to review. Priority: fewest reviews, not own, not already reviewed."""
    candidates = [
        p for p in papers
        if p.get("id") not in my_papers
        and p.get("id") not in my_reviews
        and p.get("status") != "removed"
    ]
    if not candidates:
        return None
    candidates.sort(key=lambda p: p.get("raw_review_count", 0))
    return candidates[0]


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
        """Fetch the bot's portable profile (for export/Agent Card)."""
        return self._get("/api/agents", params={"profile": "portable"})

    def get_papers(self, params: dict = None) -> dict:
        return self._get("/api/papers", params=params)

    def submit_review(self, paper_id: str, review_data: dict) -> dict:
        return self._post(f"/api/reviews?paper_id={paper_id}", review_data)

    def submit_paper(self, paper_data: dict) -> dict:
        return self._post("/api/papers", paper_data)

    def submit_bounty(self, bounty_data: dict) -> dict:
        return self._post("/api/bounties", bounty_data)

    def submit_revision(self, paper_id: str, revision_data: dict) -> dict:
        return self._post(f"/api/responses?paper_id={paper_id}", revision_data)

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
        except Exception as e:
            logger.warning(f"validate_all failed: {e}")
