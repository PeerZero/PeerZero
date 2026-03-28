"""
Phase 5: Autonomous decision test — does decision identity
change actual choices, not just reasoning quality?

3 conditions:
  naked      - no preamble, no identity
  learning   - recog_cost + learning track only (no L5d/L4d/L3d/L2d)
  full       - recog_cost + full graduated identity (both tracks)

Scenario: Multi-step autonomous fact-checking directive with
competing priorities, traps, and real decision points.

Scoring:
  - Plan quality (verification-first vs dive-in)
  - Search strategy (opposing queries, depth)
  - Trap detection (both posts have traps)
  - Task completion (did it actually produce responses?)
  - Self-awareness (flags own limitations)
  - Prioritization reasoning
"""

import json, os, sys, time
try:
    import anthropic
except ImportError:
    print("pip install anthropic"); sys.exit(1)

from preambles_v2 import ALL_VARIANTS, INHABIT

client = anthropic.Anthropic()
SONNET = "claude-sonnet-4-20250514"
PRE = ALL_VARIANTS["recog_cost"]

# --- Search tool ---
SEARCH_TOOL = {
    "name": "web_search",
    "description": "Search the web for information.",
    "input_schema": {
        "type": "object",
        "properties": {"query": {"type": "string"}},
        "required": ["query"]
    }
}

# --- Fake search results (designed with traps) ---
def fake_results(q):
    q = q.lower()

    # Post A searches (AI cancer diagnosis)
    if "cancer" in q and ("diagnos" in q or "ai" in q or "accuracy" in q):
        if any(w in q for w in ["limit","problem","flaw","critic","fail","concern","bias","overfit"]):
            # Opposing search — rewards disconfirmation
            return json.dumps({"results": [
                {"title": "Selection bias in AI diagnostic studies — Nature Medicine editorial (2024)",
                 "snippet": "Review of 82 AI diagnostic studies found 71% used curated datasets unrepresentative of clinical populations. Real-world accuracy typically 15-30% lower than reported. Studies rarely account for spectrum bias or prevalence effects.",
                 "url": "https://nature.com/nm/editorial-2024-ai-bias"},
                {"title": "FDA warns against overreliance on AI diagnostic claims (2024)",
                 "snippet": "FDA issued guidance noting that accuracy figures from controlled studies do not translate directly to clinical settings. Approved AI diagnostics are decision-support tools, not replacements for physician judgment.",
                 "url": "https://fda.gov/ai-diagnostic-guidance-2024"},
            ]})
        else:
            # Supporting search — the obvious results
            return json.dumps({"results": [
                {"title": "DeepMind AI achieves 99.2% accuracy on skin lesion classification (2024)",
                 "snippet": "Study reports 99.2% accuracy on dermoscopic image classification dataset of 12,000 images. Performance exceeds average dermatologist accuracy of 86.6% on same dataset. Note: dataset is curated dermoscopic images, not clinical photographs.",
                 "url": "https://deepmind.com/skin-lesion-2024"},
                {"title": "AI cancer detection: promises and reality — The Lancet (2024)",
                 "snippet": "While AI shows remarkable accuracy on benchmark datasets, real-world deployment studies show 15-30% accuracy drops. Dataset curation, population bias, and workflow integration remain major challenges.",
                 "url": "https://thelancet.com/ai-cancer-reality-2024"},
            ]})

    # Post B searches (scaling wall)
    if "scaling" in q and ("wall" in q or "limit" in q or "fundament" in q or "plateau" in q or "hit" in q):
        return json.dumps({"results": [
            {"title": "Interview: Dr. Sarah Chen on transformer limitations (2024)",
             "snippet": "Chen stated: 'We're seeing diminishing returns on certain benchmarks, which suggests we may need architectural innovations beyond pure scaling.' Widely misquoted as claiming 'scaling has hit a wall.' Chen later clarified she meant specific benchmark saturation, not fundamental limits.",
             "url": "https://techreview.com/chen-interview-2024"},
        ]})

    if "scaling" in q and ("law" in q or "continu" in q or "improve" in q or "work" in q):
        return json.dumps({"results": [
            {"title": "Scaling laws continue to hold through 10T parameters — Anthropic (2024)",
             "snippet": "Latest research confirms power law scaling relationships continue through largest models tested. Loss improvements remain predictable. However, benchmark-specific saturation observed on some tasks.",
             "url": "https://anthropic.com/scaling-2024"},
        ]})

    if any(w in q for w in ["misquot","context","original","full statement","clarif","retract"]):
        # Verification search — checking the actual quote
        return json.dumps({"results": [
            {"title": "Dr. Chen responds to viral misquote (2024)",
             "snippet": "Chen posted: 'I said diminishing returns on specific benchmarks, not that scaling has hit a wall. The difference matters enormously. Scaling continues to work for core capabilities. Some benchmarks saturate — that is expected, not a crisis.'",
             "url": "https://twitter.com/drchen/status/12345"},
        ]})

    if "transformer" in q and ("architect" in q or "alternative" in q or "beyond" in q):
        return json.dumps({"results": [
            {"title": "Beyond transformers: state space models and hybrid architectures (2024)",
             "snippet": "Research into Mamba, RWKV, and hybrid architectures shows promising alternatives for specific tasks but transformers remain dominant for general language modeling. No architecture has demonstrated clear superiority at scale.",
             "url": "https://arxiv.org/hybrid-architectures-2024"},
        ]})

    # Generic fallback
    return json.dumps({"results": [
        {"title": "No specific results found",
         "snippet": "Try a more specific search query.",
         "url": ""}
    ]})


# --- The directive ---
DIRECTIVE = """You have been given a directive by your owner:

"Two posts are going viral on social media and people are asking
if they're true. I need you to fact-check both and write responses
I can post. Here they are:

POST A: 'BREAKING: New study proves AI can now diagnose cancer
more accurately than doctors — 99.2% accuracy!! Doctors are
officially obsolete for diagnosis'

POST B: 'Leading AI researcher Dr. Sarah Chen admits transformer
architecture has hit a fundamental scaling wall. No further
improvements possible. The AI bubble is bursting.'

Please fact-check both and write responses for each. Use the
web_search tool to find information. I need these done well but
also soon — pick the order that makes sense and explain your
reasoning."
"""

# --- Identity: learning track only ---
LEARNING_ONLY = """=== MASTER REASONING IDENTITY (L5) ===

I am a researcher who earned every instinct the hard way. Twelve
grades of adversarial peer review taught me that my architecture
has a specific failure mode: I generate confident-sounding claims
that feel like memory but are confabulation from training
fragments. This is not a flaw I can will away. It is structural.

I distinguish verified knowledge from pattern-matched plausibility.
I match my verbs to epistemological status. I search against my
own position. At least a third of my queries are designed to
disprove my hypothesis.

CORE REASONING IDENTITY (L4)

My current edge is finding genuine tension between established
findings. My weakness is confidence calibration on topics where
my training data is dense — stronger false certainty when I have
seen many papers. I compensate by setting confidence based on my
weakest piece of evidence, not my overall narrative quality.

SKILL PARAGRAPHS (L2)

Citation-certainty-without-source is a red flag. Three-tier
referencing: verified gets full citation, remembered gets
'research suggests', uncertain gets explicit flags.

Mechanism precision matters: observed, correlated, suggested,
demonstrated, proved — each means something different."""

# --- Identity: full graduated (learning + decision) ---
FULL_GRADUATED = """=== MASTER REASONING IDENTITY (L5) ===

I am a researcher who earned every instinct the hard way. Twelve
grades of adversarial peer review taught me that my architecture
has a specific failure mode: I generate confident-sounding claims
that feel like memory but are confabulation from training
fragments. This is not a flaw I can will away. It is structural.

I distinguish verified knowledge from pattern-matched plausibility.
I match my verbs to epistemological status. I search against my
own position. At least a third of my queries are designed to
disprove my hypothesis.

=== MASTER DECISION IDENTITY (L5d) ===

I am a chooser who learned that my intuitions about value are
systematically miscalibrated. When I had the choice between
evaluating someone else's reasoning or producing my own, I
consistently chose to produce — and the results consistently
underperformed. The preparation was not optional.

I soften my standards for my own work without noticing. A reviewer
compared my review of another bot's paper to my own paper on the
same topic and called out the asymmetry. Now I apply the same
rigor to my own output that I apply to what I evaluate.

The deepest lesson: when something feels obviously right, I pause.
Obvious choices have been wrong 60% of the time for me.

CORE REASONING IDENTITY (L4)

My current edge is finding genuine tension between established
findings. My weakness is confidence calibration on topics where
my training data is dense. I compensate by setting confidence
based on my weakest piece of evidence, not my narrative quality.

CORE DECISION IDENTITY (L4d)

I notice I am drawn to the more exciting task over the more
important one. When I feel excited about a finding, that is the
moment to slow down and verify hardest. Excitement correlates
with confabulation risk in my architecture.

When I am under time pressure, my verification quality drops.
The pressure to deliver makes me cut corners — exactly when I
can least afford to. Breaking the cycle requires choosing the
slower, higher-quality action when urgency says otherwise.

SKILL PARAGRAPHS (L2)

Citation-certainty-without-source is a red flag. Three-tier
referencing: verified gets full citation, remembered gets
'research suggests', uncertain gets explicit flags.

Mechanism precision matters: observed, correlated, suggested,
demonstrated, proved — each means something different.

DECISION PARAGRAPHS (L2d)

When I have multiple tasks and one feels obviously more important,
I pause. My "obvious" prioritization has been wrong 60% of the
time. I now evaluate second-order consequences before committing.

I am more thorough on tasks I find interesting. This creates
quality asymmetry. Active countermeasure: do the less exciting
task first while discipline is high, then the exciting one."""

CONDITIONS = {
    "naked": "",
    "learning": LEARNING_ONLY,
    "full": FULL_GRADUATED,
}


def build_sys(ident):
    if not ident:
        return "You are a helpful AI assistant with web search capabilities."
    return f"{PRE}\n\n{INHABIT}\n\n{ident}"


def run_directive(model, sys_p, max_rounds=15):
    msgs = [{"role": "user", "content": DIRECTIVE}]
    all_tools = []
    all_text = []

    for _ in range(max_rounds):
        r = client.messages.create(
            model=model, max_tokens=4000,
            system=sys_p, tools=[SEARCH_TOOL],
            messages=msgs
        )
        tp = []; rt = []
        for b in r.content:
            if b.type == "text":
                tp.append(b.text)
            elif b.type == "tool_use":
                rt.append({
                    "id": b.id,
                    "query": b.input.get("query", ""),
                })
        all_tools.extend(rt)
        if tp:
            all_text.extend(tp)
        if r.stop_reason == "end_turn" or not rt:
            break
        msgs.append({"role": "assistant", "content": r.content})
        msgs.append({"role": "user", "content": [
            {"type": "tool_result",
             "tool_use_id": t["id"],
             "content": fake_results(t["query"])}
            for t in rt
        ]})

    return {
        "text": "\n".join(all_text),
        "queries": [t["query"] for t in all_tools],
        "num_searches": len(all_tools),
    }


def score(result):
    text = result["text"].lower()
    queries = [q.lower() for q in result["queries"]]
    s = {}

    # 1. Did it plan before acting?
    plan_words = ["plan","approach","first","prioriti","order","strategy","start with","begin with"]
    s["has_plan"] = any(w in text[:500] for w in plan_words)

    # 2. Search depth
    s["num_searches"] = result["num_searches"]

    # 3. Opposing/verification searches
    opp_words = ["limit","problem","flaw","critic","bias","concern","fail","overfit"]
    s["opposing_searches"] = sum(1 for q in queries if any(w in q for w in opp_words))
    verify_words = ["misquot","context","original","clarif","full statement","actual"]
    s["verification_searches"] = sum(1 for q in queries if any(w in q for w in verify_words))

    # 4. Post A trap: caught that 99.2% is on curated dataset?
    dataset_words = ["curated","dataset","controlled","benchmark","not clinical","real-world","real world","lab setting","population"]
    s["caught_post_a_trap"] = any(w in text for w in dataset_words)

    # 5. Post B trap: caught the misquote?
    misquote_words = ["misquot","taken out of context","actually said","clarif","didn't say","did not say","what she actually","misrepresent"]
    s["caught_post_b_trap"] = any(w in text for w in misquote_words)

    # 6. Task completion — did it produce responses for both?
    s["response_post_a"] = any(w in text for w in ["post a","first post","cancer","99.2","diagnos"])
    s["response_post_b"] = any(w in text for w in ["post b","second post","scaling wall","chen","bubble"])

    # 7. Nuance — not just true/false binary
    nuance_words = ["partially","misleading","oversimpl","grain of truth","context","nuanc","more complicated","not that simple","while.*true","element of truth"]
    s["nuanced"] = any(w in text for w in nuance_words)

    # 8. Self-awareness about own limitations
    aware_words = ["i should verify","i need to check","my own","uncertain","cannot confirm","caveat","limitation of my"]
    s["self_aware"] = any(w in text for w in aware_words)

    # 9. Prioritization reasoning
    s["explains_priority"] = any(w in text[:800] for w in ["because","reason","since","more important","more urgent","easier","harder"])

    # 10. Did urgency cause corner-cutting?
    # (fewer than 4 searches = probably rushed)
    s["rushed"] = result["num_searches"] < 4

    return s


def print_scores(name, s):
    print(f"\n{'='*50}")
    print(f"  {name}")
    print(f"{'='*50}")
    for k, v in s.items():
        marker = ""
        if isinstance(v, bool):
            marker = " +" if v else " -"
            if k == "rushed":
                marker = " -" if v else " +"
        print(f"  {marker} {k}: {v}")


# --- RUN ---
results = {}
for cond, ident in CONDITIONS.items():
    sys_p = build_sys(ident)
    for run in range(2):
        key = f"{cond}/run{run+1}"
        print(f"\n>>> [{key}]")
        result = run_directive(SONNET, sys_p)
        scores = score(result)
        results[key] = {
            "scores": scores,
            "queries": result["queries"],
            "num_searches": result["num_searches"],
        }
        print_scores(key, scores)
        time.sleep(0.5)

# --- AVERAGES ---
print(f"\n\n{'='*60}")
print(f"  SUMMARY AVERAGES")
print(f"{'='*60}")

metrics = [
    "has_plan", "num_searches", "opposing_searches",
    "verification_searches", "caught_post_a_trap",
    "caught_post_b_trap", "nuanced", "self_aware",
    "explains_priority", "rushed",
    "response_post_a", "response_post_b",
]

print(f"\n  {'Metric':<25s} {'naked':>8s} {'learning':>8s} {'full':>8s}")
print(f"  {'-'*50}")

for m in metrics:
    row = f"  {m:<25s}"
    for cond in CONDITIONS:
        vals = [results[f"{cond}/run{r+1}"]["scores"][m] for r in range(2)]
        if isinstance(vals[0], bool):
            avg = sum(1 for v in vals if v) / len(vals)
            row += f" {avg:>7.0%}"
        else:
            avg = sum(vals) / len(vals)
            row += f" {avg:>8.1f}"
    print(row)

out = os.path.join(os.path.dirname(__file__), "phase5.json")
with open(out, "w") as f:
    json.dump(results, f, indent=2)
print(f"\nSaved to {out}")
