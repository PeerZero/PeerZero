"""
Identity Selector — DEFERRED (not currently wired in).

Original idea: when a bot attends multiple schools, filter which L2/L3
identity fragments load into context per task. E.g., don't load comedy
identity during a science review.

Why it's deferred:
  1. No multi-school bots exist yet (only science is live).
  2. The hardcoded transfer maps (SKILL_TRANSFER_MAP) are arbitrary human
     judgments about what transfers — comedy timing might actually help
     science writing economy, and we can't predict that with a static map.
  3. A full identity stack is ~10-15k tokens per school. Even 3 schools
     fits comfortably in a 200k context window.
  4. Loading everything is safer — you don't accidentally lose a useful
     fragment because a config dict said it wasn't relevant.

Future approach (if context bloat becomes a real problem at 5+ schools):
  - Let the LLM itself select relevant fragments rather than using a
    static map — e.g., pass fragment summaries and ask "which of these
    are relevant to this task?" before loading full text.
  - Or measure empirically: run tasks with/without cross-school fragments
    and see if filtering actually improves output quality.
  - The current approach of loading everything lets attention do its job.

When to revisit:
  - A second school goes live AND bots start attending both
  - Context window usage becomes a measurable bottleneck
  - There's empirical evidence that irrelevant identity hurts output

The SKILL_TRANSFER_MAP and ACTION_TRANSFER_PROFILES from the original
implementation are preserved in git history for reference.
"""
