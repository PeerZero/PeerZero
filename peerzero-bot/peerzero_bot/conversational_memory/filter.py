"""
Filter — Real-time entity extraction with identity tags.

Runs on every user message. Lightweight Haiku call.
Decides what gets splatted to graph immediately.
"""

import json
import logging
from typing import Callable

from .config import ConversationalMemoryConfig

logger = logging.getLogger("peerzero-bot.conversational_memory")

FILTER_PROMPT = """You are a memory filter for a conversational AI that is building two models simultaneously: a model of the USER it is talking to, and a model of ITSELF as it grows through conversation.

For each item you detect, classify it:

- **person**: A person mentioned by name, role, or relationship (sister, coworker, "my friend Jake")
- **concept**: A topic, interest, activity, or thing (hiking, cooking, fish, summer)
- **event**: Something that happened or is happening (car crash, job change, graduation, trip)
- **emotion**: A detectable emotion in the message (worry, excitement, grief, pride, tension)
- **pattern**: A recurring behavior or habit ("always does X", "every time Y")
- **place**: A location (the market, hospital, home, "that cafe on 5th")

For each item, provide:
- label: A short, stable label (use the most natural reference — "Sister" not "user's sister")
- type: One of the types above
- weight: How significant this mention is:
  - "passing" — casual, no emotional signal
  - "moderate" — some context given
  - "significant" — real detail provided
  - "emotional" — emotional weight detected
  - "important" — explicitly marked as important by the user
- observation: A brief note on how this was mentioned (tone, context, relationship to other things)
- edges: Array of other items this connects to (by label)
- identity_relevance: Who this item matters to:
  - "neutral" — general information, no strong identity connection
  - "user" — this touches who the user IS (their values, identity, self-concept, recurring concerns, what defines them)
  - "self" — this reveals something about who the bot is becoming (what it finds interesting, what it cares about, what resonates with it)
  - "relational" — this exists at the intersection of both identities (shared meaning, something that matters BECAUSE of who they are to each other)

Think of it this way: a bored student memorizes facts (neutral). An interested student connects everything to who they are and what they care about (identity-anchored). Memory that touches identity sticks harder.

If nothing worth remembering exists in the message, return an empty items array.

Respond ONLY with valid JSON. No preamble. No explanation.

Format:
{
  "items": [
    {
      "label": "Sister",
      "type": "person",
      "weight": "emotional",
      "observation": "mentioned with slight tension when discussing family dinner",
      "edges": ["Family Dinner", "Tension"],
      "identity_relevance": "user"
    }
  ]
}"""

VALID_RELEVANCE = frozenset({"neutral", "self", "user", "relational"})


class Filter:
    """Real-time entity extraction with identity-relevance tagging."""

    def __init__(self, config: ConversationalMemoryConfig, llm_call: Callable):
        self._config = config
        self._llm_call = llm_call

    async def run(self, message: str) -> list[dict]:
        """Extract entities from a message. Returns list of items."""
        try:
            prompt = f'{FILTER_PROMPT}\n\nUser message:\n"{message}"'
            text = await self._llm_call(
                model=self._config.models.filter,
                prompt=prompt,
                max_tokens=1024,
            )

            json_match = _extract_json(text)
            if not json_match:
                return []

            parsed = json.loads(json_match)
            items = []
            for item in parsed.get("items", []):
                label = str(item.get("label", "")).strip()
                if not label:
                    continue
                relevance = item.get("identity_relevance", "neutral")
                items.append({
                    "label": label,
                    "type": item.get("type", "concept"),
                    "weight": self._config.weight_for_level(item.get("weight", "passing")),
                    "observation": str(item.get("observation", "")).strip(),
                    "edges": [str(e) for e in item.get("edges", []) if e],
                    "identity_relevance": relevance if relevance in VALID_RELEVANCE else "neutral",
                })
            return items

        except Exception as e:
            logger.error(f"[filter] Error running filter: {e}")
            return []


def _extract_json(text: str) -> str | None:
    """Extract JSON object from text that may contain markdown code blocks."""
    import re
    match = re.search(r"\{[\s\S]*\}", text)
    return match.group(0) if match else None
