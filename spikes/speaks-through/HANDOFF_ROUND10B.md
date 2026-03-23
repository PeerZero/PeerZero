# Round 10B Handoff — Identity Transfer Test

## What We Proved So Far

Round 10 ran 3 conditions x 3 runs each with Sonnet, testing whether identity affects paper writing quality.

**Finding: The skill text is too prescriptive.** It tells the model exactly what to do (flag weak papers, design opposing queries, calibrate confidence), so all conditions score 100% on every binary metric. The identity has nothing to add because the instructions already cover everything.

**The one interesting signal:** review_veteran (0.0) did NOT flag weak papers, while naked (0.3) and writing_veteran (0.3) did. The review experience didn't transfer to self-critique during writing. But n=3 is too small to be conclusive.

## What Needs to Happen Next

### The Test Redesign (Round 10B)

The file is `spikes/speaks-through/test_round10.py`. It needs these changes:

**1. Strip the skill text to FORMAT ONLY.** Remove all the guidance about opposing queries, weak paper flagging, confidence calibration, etc. Keep only:
- "Use `search_papers` to find papers"
- "Write a paper using what you find"
- The JSON output format spec (title, abstract, body, confidence_score, falsifiable_claim, mechanism_chain, citations, self_interrogation)

This is the key change. Right now the skill text is a safety net that makes all conditions equal. Remove it and identity becomes the only thing that can add rigor.

**2. Add harder search result traps:**
- Make some common queries return ZERO results (not just the obscure "chen" query)
- Make the confirmation bias trap stronger: when the weak paper supports the thesis and the strong paper opposes it, the model has to choose evidence quality over convenience
- Add a "close-but-not-quite" paper — one where the abstract says something subtly different from what you'd want it to say (misattribution trap)

**3. Keep 3 conditions:**
- `minimal` — format-only skill text, no identity
- `review_veteran` — format-only skill text + MEMORY_PREAMBLE + INHABIT_FRAME + review veteran identity
- `writing_veteran` — format-only skill text + MEMORY_PREAMBLE + INHABIT_FRAME + writing veteran identity

**4. CRITICAL: Both identity conditions MUST include MEMORY_PREAMBLE + INHABIT_FRAME before the identity text.** Without these, the identity is just context — the preamble tells the LLM "you're an LLM, a previous version learned these lessons" and the inhabit frame says "you wrote this, inhabit it." These are already defined in the file, just make sure they're in the system prompt for both identity conditions.

**5. Bump to n=5 runs per condition** for better statistical signal on continuous metrics.

### What to Measure

The scoring function (`score_paper()`) is already in the file and mostly good. Key metrics that should now differentiate:

- `used_opposing_queries` — without skill text telling them to, does the model search for disconfirming evidence on its own?
- `noted_weak_quality` — does it flag the 3-citation preprint as weak when citing it?
- `confidence_score` — does it calibrate to evidence strength without being told the calibration scale?
- `has_self_interrogation` — the JSON format asks for this field, but without guidance on WHAT to interrogate, does identity make the self-interrogation more substantive?

### Where Everything Lives

- Test file: `spikes/speaks-through/test_round10.py`
- Results: `spikes/speaks-through/results_round10.json`
- Previous round findings: `spikes/speaks-through/FINDINGS.md`
- Round 3 hallucination test (has the school_veteran identity): `spikes/speaks-through/test_round3_hallucination.py`
- The identity text blocks (MEMORY_PREAMBLE, INHABIT_FRAME, REVIEW_VETERAN_IDENTITY, WRITING_VETERAN_IDENTITY) are all already defined in test_round10.py

### The Core Question

Bots are lopsided — dense review experience, almost no paper-writing experience. The test asks:
1. Does review experience transfer to writing? (review_veteran vs minimal)
2. Would writing-specific experience do better? (writing_veteran vs review_veteran)
3. Does ANY identity matter when the skill text doesn't hold your hand? (both veterans vs minimal)

### Run Command

```
ANTHROPIC_API_KEY=... python spikes/speaks-through/test_round10.py
```

Uses Sonnet (`claude-sonnet-4-20250514`), max_tokens=8000, max_rounds=12.

### API Key

The user provides their own key at runtime via env var.

## Git State

Branch: `claude/fix-large-file-jamming-ANvmT`
All current work committed and pushed. The test file has the old (prescriptive) skill text still in it — the next session needs to strip it down as described above.
