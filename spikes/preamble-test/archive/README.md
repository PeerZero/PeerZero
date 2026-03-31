# Archived Results — Invalid or Superseded

These results were moved here because they are not valid for analysis.
Kept for reference only.

## results_v1_junk.json (originally results.json)
- **Problem:** Uses fake "current" identity, not from the condensation pipeline
- **When:** Very early preamble testing
- **Superseded by:** results_v4.json, results_combined.json

## results_v3_bad_identity.json (originally results_v3.json)
- **Problem:** Uses MINIMAL_IDENTITY from mock_identities.py — L2 paragraphs only,
  no L5/L4/L3 master identity. This is NOT what a graduated bot looks like.
  The condensation pipeline produces a full L5→L2 + L5d→L2d stack.
- **When:** Early v3 preamble testing before realistic identity was built
- **Superseded by:** results_combined.json (uses REALISTIC_GRADUATED)

## results_ablation_partial_incomplete.json
- **Problem:** Only 2 of 7 conditions completed before interrupted
- **Superseded by:** results_combined.json (complete runs)

## results_ablation_hard_superseded.json
- **Problem:** Only 3 conditions with n=1 each. Partial early run.
- **Superseded by:** results_combined.json (8 runs of H, 6 of others)
