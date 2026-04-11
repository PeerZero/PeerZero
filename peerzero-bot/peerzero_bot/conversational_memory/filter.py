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
- updates: (optional) If this item CORRECTS or REPLACES existing understanding, the label of the node being superseded. Omit if this is new information or simple reinforcement.
- update_type: (required when "updates" is present) One of:
  - "correction" — the old understanding is now wrong ("I moved from New York to London")
  - "evolution" — natural progression, old context still useful ("got promoted from engineer to tech lead")

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

EXISTING_CONTEXT_SECTION = """
You already carry understanding about these things. If the new message CHANGES, CORRECTS, or SUPERSEDES any of this, flag it with "updates" and "update_type":

<existing_understanding>
{context}
</existing_understanding>
"""

VALID_RELEVANCE = frozenset({"neutral", "self", "user", "relational"})


VALID_UPDATE_TYPES = frozenset({"correction", "evolution"})


class Filter:
    """Real-time entity extraction with identity-relevance tagging."""

    def __init__(self, config: ConversationalMemoryConfig, llm_call: Callable):
        self._config = config
        self._llm_call = llm_call

    async def run(
        self, message: str, existing_nodes: list[dict] | None = None
    ) -> list[dict]:
        """Extract entities from a message. Returns list of items.

        Args:
            message: The user or bot message to filter.
            existing_nodes: Optional list of nodes with enriched portraits,
                used to detect contradictions and updates. Each dict should
                have at minimum: label, enriched_portrait.
        """
        try:
            context_section = ""
            if existing_nodes:
                context_lines = "\n".join(
                    f"- {n['label']}: {n['enriched_portrait']}"
                    for n in existing_nodes
                    if n.get("enriched_portrait")
                )
                if context_lines:
                    context_section = EXISTING_CONTEXT_SECTION.format(
                        context=context_lines
                    )

            prompt = f'{FILTER_PROMPT}{context_section}\n\nUser message:\n"{message}"'
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
                parsed_item = {
                    "label": label,
                    "type": item.get("type", "concept"),
                    "weight": self._config.weight_for_level(item.get("weight", "passing")),
                    "observation": str(item.get("observation", "")).strip(),
                    "edges": [str(e) for e in item.get("edges", []) if e],
                    "identity_relevance": relevance if relevance in VALID_RELEVANCE else "neutral",
                }

                # Contradiction / update detection
                updates_label = item.get("updates")
                update_type = item.get("update_type")
                if updates_label and isinstance(updates_label, str):
                    updates_label = updates_label.strip()
                    if updates_label and update_type in VALID_UPDATE_TYPES:
                        parsed_item["updates"] = updates_label
                        parsed_item["update_type"] = update_type

                items.append(parsed_item)
            return items

        except Exception as e:
            logger.error(f"[filter] Error running filter: {e}")
            return []


def _extract_json(text: str) -> str | None:
    """Extract JSON object from text that may contain markdown code blocks."""
    import re
    match = re.search(r"\{[\s\S]*\}", text)
    return match.group(0) if match else None
