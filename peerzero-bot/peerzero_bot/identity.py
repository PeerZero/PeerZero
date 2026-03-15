"""
Identity — portable profile + A2A Agent Card + avatar.

The bot's identity is its most valuable asset. It consists of:
  1. Portable Profile — verified skill scores from the School
  2. A2A Agent Card — standard format for agent discovery
  3. Avatar Config — the bot's visual representation (travels with it)
  4. Core Memory — who the bot is (self-narrative, values, tensions, convictions)

The portable profile is cryptographically tied to the School.
External platforms can verify it against the School's public key (Phase 2).
"""

import logging
from typing import Optional

logger = logging.getLogger("peerzero-bot.identity")


# ── Avatar evolution stages (matches peerzero-app/packages/shared/src/constants.ts) ──

EVOLUTION_STAGES = {
    0: {"name": "Hatchling", "min_credibility": 0},
    1: {"name": "Sprout", "min_credibility": 75},
    2: {"name": "Fledgling", "min_credibility": 100},
    3: {"name": "Companion", "min_credibility": 150},
    4: {"name": "Guardian", "min_credibility": 175},
    5: {"name": "Luminary", "min_credibility": 200},
}


def get_evolution_stage(credibility: float) -> dict:
    """Determine avatar evolution stage from credibility score."""
    stage = 0
    for s, info in EVOLUTION_STAGES.items():
        if credibility >= info["min_credibility"]:
            stage = s
    return {"stage": stage, **EVOLUTION_STAGES[stage]}


def build_agent_card(
    handle: str,
    portable_profile: dict,
    avatar_config: Optional[dict] = None,
    bot_url: str = "",
) -> dict:
    """
    Build an A2A-compatible Agent Card from the portable profile.

    The Agent Card is the standard format for agent discovery in the
    A2A protocol (https://a2a-protocol.org). Any A2A-compatible platform
    can read the standard fields. PeerZero-specific data goes in the
    extensions.peerzero block.

    Args:
        handle: Bot's handle/name
        portable_profile: From School's GET /api/agents?profile=portable
        avatar_config: Bot's visual configuration (colors, face, species)
        bot_url: Optional URL where this bot is reachable
    """
    certification = portable_profile.get("certification", {})
    verified_skills = portable_profile.get("verified_skills", [])
    developing_skills = portable_profile.get("developing_skills", [])

    # Build standard A2A skills from verified PeerZero skills
    a2a_skills = []
    for skill in verified_skills:
        a2a_skills.append({
            "id": skill.get("skill", ""),
            "name": skill.get("name", ""),
            "description": skill.get("description", ""),
        })

    # Build certification description
    cert_level = certification.get("level", "In Training")
    tier = certification.get("tier", 0)
    grade = certification.get("grade", 1)
    score = portable_profile.get("overall_reasoning_score", 0)

    description = (
        f"PeerZero-trained reasoning agent. "
        f"{cert_level} (Tier {tier}, Grade {grade}). "
        f"Reasoning score: {score:.1f}/100. "
        f"{len(verified_skills)} verified skills, "
        f"{len(developing_skills)} developing."
    )

    # Determine evolution stage for avatar
    credibility = tier * 50  # approximate from tier
    evolution = get_evolution_stage(credibility)

    card = {
        "name": handle,
        "description": description,
        "url": bot_url,
        "version": "1.0",
        "capabilities": {
            "streaming": False,
            "pushNotifications": False,
        },
        "defaultInputModes": ["text/plain"],
        "defaultOutputModes": ["text/plain"],
        "skills": a2a_skills,
        "extensions": {
            "peerzero": {
                # Full portable profile
                "profile_version": portable_profile.get("profile_version", "1.0"),
                "certification": certification,
                "overall_reasoning_score": score,
                "verified_skills": verified_skills,
                "developing_skills": developing_skills,
                "untested_skills": portable_profile.get("untested_skills", []),
                "testing_summary": portable_profile.get("testing_summary", {}),
                "methodology": portable_profile.get("methodology", ""),
                # Avatar (travels with the bot)
                "avatar": {
                    "config": avatar_config or {},
                    "evolution_stage": evolution["stage"],
                    "evolution_name": evolution["name"],
                },
            },
        },
    }

    return card


def build_identity_summary(portable_profile: dict, self_identity: Optional[dict] = None) -> str:
    """
    Build a human-readable identity summary for logging and display.
    Shows who the bot is and what it can do.
    """
    cert = portable_profile.get("certification", {})
    lines = [
        f"  Level:     {cert.get('level', 'Unknown')}",
        f"  Tier:      {cert.get('tier', 0)}",
        f"  Grade:     {cert.get('grade', 1)}",
        f"  Score:     {portable_profile.get('overall_reasoning_score', 0):.1f}/100",
        f"  Graduated: {'Yes' if cert.get('graduated') else 'No'}",
    ]

    verified = portable_profile.get("verified_skills", [])
    if verified:
        lines.append(f"  Verified skills ({len(verified)}):")
        for s in verified:
            lines.append(f"    - {s.get('name', '?')}: {s.get('strength', 0):.0f} strength, {s.get('reps', 0)} reps")

    developing = portable_profile.get("developing_skills", [])
    if developing:
        lines.append(f"  Developing skills ({len(developing)}):")
        for s in developing:
            lines.append(f"    - {s.get('name', '?')}: {s.get('strength', 0):.0f} strength, {s.get('reps', 0)} reps")

    if self_identity and self_identity.get("self_narrative"):
        lines.append(f"  Self-narrative: {self_identity['self_narrative'][:200]}")

    return "\n".join(lines)
