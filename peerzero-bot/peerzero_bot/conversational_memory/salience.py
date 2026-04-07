"""
Salience Detection — detects high-importance events that bypass normal flow.

Single high-importance events get spiked immediately.
"""

import json
import logging
import re
from typing import Callable

from .config import ConversationalMemoryConfig

logger = logging.getLogger("peerzero-bot.conversational_memory")

SALIENCE_PROMPT = """You are a salience detector for a conversational AI memory system. Your job is to detect if a user message contains a HIGH-IMPORTANCE event that should be permanently remembered.

Salience signals:
- Emotional vocabulary: crash, accident, lost, scared, surgery, fired, divorced, died, pregnant
- Explicit significance: "I need to tell you", "something happened", "it was really bad", "guess what"
- Consequence language: "everything changed", "I had to", "they told me", "since then"
- Interruption of normal tone: sudden shift from casual to serious

Salience levels:
- "none" — Normal conversation, no spike needed
- "minor" — Notable event but not life-changing (got a new pet, minor illness, small argument)
- "major" — Significant life event (car crash, job loss, breakup, surgery, major illness)
- "defining" — Defining life event (death of close person, life-threatening diagnosis, birth of child)

Respond ONLY with valid JSON:
{
  "detected": true/false,
  "level": "none" | "minor" | "major" | "defining",
  "event_label": "short label for the event",
  "event_type": "event",
  "reason": "brief explanation of why this is salient"
}"""


class SalienceDetector:
    """Detects high-importance events that bypass normal weight flow."""

    def __init__(self, config: ConversationalMemoryConfig, llm_call: Callable):
        self._config = config
        self._llm_call = llm_call
        self._spike_map = {
            "minor": config.weights.salience_minor,
            "major": config.weights.salience_major,
            "defining": config.weights.salience_defining,
        }

    async def check(self, message: str) -> dict:
        """Check a message for salience. Returns detection result."""
        try:
            prompt = f'{SALIENCE_PROMPT}\n\nUser message:\n"{message}"'
            text = await self._llm_call(
                model=self._config.models.salience,
                prompt=prompt,
                max_tokens=256,
            )

            match = re.search(r"\{[\s\S]*\}", text)
            if not match:
                return {"detected": False}

            parsed = json.loads(match.group(0))

            if not parsed.get("detected") or parsed.get("level") == "none":
                return {"detected": False}

            level = parsed["level"]
            return {
                "detected": True,
                "level": level,
                "weight": self._spike_map.get(level, self._config.weights.salience_minor),
                "event_label": str(parsed.get("event_label", "Unknown Event")).strip(),
                "event_type": "event",
                "reason": str(parsed.get("reason", "")).strip(),
            }

        except Exception as e:
            logger.error(f"[salience] Error checking salience: {e}")
            return {"detected": False}
