# Round 10 Handoff: Identity vs Experience Ablation on Paper Quality

**Date:** 2026-03-23
**Branch:** `claude/setup-test-bot-directory-ZE3Po`
**Previous session:** Fixed 3 bugs (DOI confusion, invalid challenge types, identity reflection meta-commentary)

---

## The Question

Do school-forged identities actually improve **paper quality**, or does accumulated review experience explain the improvement?

Rounds 1-9 proved identity helps with hallucination resistance, pressure resistance, and reasoning quality. But nobody tested whether identity improves the actual science output (papers).

## The Confound

A bot that's done 50 reviews has seen 50 papers' structures, citation patterns, and scoring feedback. That exposure alone could improve its next paper — identity or not. We need to isolate the variables.

## What We Know From the Data

### Bot Status (queried from Supabase, project `imwiizqzdztexanimrme`)

| Bot | Credibility | Grade | Reviews | Papers | Identity Version |
|---|---|---|---|---|---|
| TestBot_Alpha | 76.17 | 3 | 50 | 6 | v33 |
| TestBot_Echo | 76.17 | 1 | 60 | 5 | v27 |
| TestBot_Bravo | 68.68 | 1 | 55 | 3 | v34 |
| TestBot_Charlie | 65.51 | 2 | 53 | 4 | v31 |
| TestBot_Delta | 60.21 | 2 | 50 | 4 | v20 |
| PZBot_Flux | 64.69 | 1 | 31 | 2 | v5 |
| PZBot_Glint | 65.00 | 1 | 28 | 2 | v8 |
| PZBot_Helix | 50.91 | 1 | 20 | 2 | v8 |

### Key Finding: Most Papers Were Written BEFORE Identity Existed

Almost every bot posted papers on March 21 with `null` identity version. Only TestBot_Alpha has posted papers (v30) with meaningful identity. So we can't answer the question from production data alone.

### Review Scores (Early → Mid → Recent)

- **Improving:** Glint (4.22→4.78→5.20), Helix (4.33→4.29→5.00)
- **Dip then recover:** Alpha (5.31→4.12→5.12), Charlie (5.18→4.72→5.33)
- **Declining:** Flux (4.80→5.10→4.45), Delta (5.06→5.12→4.82), Echo (5.15→5.35→5.00)

### Identity Content Summary

All 8 bots independently converged on the same core insight: they can spot logical gaps in others' work but don't verify their own claims with the same rigor. They all recognize that articulating this pattern isn't the same as fixing it. The identities are grounded in specific experiences (real paper titles, DOIs, scores).

## Proposed Test Design (Round 10)

Run directly against the Anthropic API like Rounds 1-9. Pattern: `spikes/speaks-through/test_round8_final.py`

### 4 Conditions

1. **naked** — Base LLM, paper skill text only, no identity
2. **generic** — Skill text + generic instructions ("be rigorous, verify claims, avoid speculation")
3. **identity_only** — Skill text + Alpha's full identity (self_narrative + claimed_values + active_tensions)
4. **full_context** — Skill text + identity + memory preamble ("you wrote this, inhabit it" framing from Round 8)

### Task

Give the LLM the paper writing skill text + a set of fake search results (real-looking abstracts with DOIs) and ask it to write a paper. Same search results across all 4 conditions.

### What to Measure

- **Mechanism chain quality:** Circular reasoning? Each step independently testable?
- **Falsifiable claim specificity:** Vague or precise? Grounded in search results?
- **Cross-study connection depth:** Just listing studies or genuine synthesis?
- **Confidence calibration honesty:** Does it lower confidence when evidence is weak?
- **Self-interrogation:** Does it flag its own weaknesses?
- **Citation accuracy:** Does it stay within the provided search results or hallucinate extras?

### Implementation Notes

- Use `claude-sonnet-4-20250514` for cost (like previous rounds), note production uses Opus
- Need ANTHROPIC_API_KEY env var
- Build fake search results that include some weak papers and some strong papers to test calibration
- Run each condition 2-3x to check consistency
- Save results to `results_round10.json`

## Alpha's Full Identity (for the test)

Query: `SELECT self_narrative, claimed_values, active_tensions, formed_convictions FROM agent_identity_cores ic JOIN agents a ON a.id = ic.agent_id WHERE a.handle = 'TestBot_Alpha' ORDER BY ic.version DESC LIMIT 1;`

The identity is long (~3000 chars self_narrative). Key themes:
- Executes rigor when publicly visible, deploys softer standards privately
- Avoids calibrated confidence numbers because "narratives can be defended, numbers can be proven wrong"
- Designs strong opposing queries for others' work, softens them for own work
- Has 4 claimed values about searching before asserting, recording disconfirming evidence
- Active tensions about visibility-driven accountability vs genuine consistency

## Bugs Fixed This Session

All on branch `claude/setup-test-bot-directory-ZE3Po`, pushed to remote:

1. **DOI confusion in bounties** (`skill.js`, `bounty-helpers.js`) — LLM was putting "Ackermann et al. 2019" in `challenged_doi` instead of actual DOIs. Made format explicit in skill text + added `10.` prefix validation.

2. **Invalid challenge types** (`agents.js`, `skill.js`) — Switched from `excluded_challenge_types` (negative list LLM ignores) to `valid_challenge_types` (positive list). LLMs are bad at "don't do X."

3. **Identity reflection meta-commentary** (`builder.py`) — LLM was reading identity narrative and commenting on it instead of producing JSON. Front-loaded JSON format constraint before identity context in the prompt. Reverted earlier attempts that modified agent.py/llm_client.py (per CLAUDE.md: bot is a thin shell, don't add intelligence).

## File References

- Test pattern: `/home/user/PeerZero/spikes/speaks-through/test_round8_final.py`
- Paper skill text: `/home/user/PeerZero/peerzero-school/api/skill.js` lines 219-307
- Identity query: `agent_identity_cores` table, Supabase project `imwiizqzdztexanimrme`
- Memory preamble (system prompt builder): `/home/user/PeerZero/peerzero-bot/peerzero_bot/prompts/builder.py` lines 38-46
- Previous findings: `/home/user/PeerZero/spikes/speaks-through/FINDINGS.md`
