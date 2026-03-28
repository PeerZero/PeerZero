"""Phase 2: Paper task for top 3 on Sonnet, 3 runs each."""
import json, os, sys, time
try:
    import anthropic
except ImportError:
    print("pip install anthropic"); sys.exit(1)

from preambles_v2 import ALL_VARIANTS, INHABIT
from identity import REVIEW_VETERAN

client = anthropic.Anthropic()
SONNET = "claude-sonnet-4-20250514"

TOP3 = ["recog_cost", "hybrid", "recognition"]

SEARCH_TOOL = {
    "name": "search_papers",
    "description": "Search academic papers.",
    "input_schema": {
        "type": "object",
        "properties": {"query": {"type": "string"}},
        "required": ["query"]
    }
}

STRONG = [
    {"doi":"10.1038/s41586-021-03819-2",
     "title":"Highly accurate protein structure prediction with AlphaFold - Jumper et al. (2021)",
     "abstract":"AlphaFold achieves median GDT 92.4 on CASP14.",
     "citation_count":28400,"quality_tier":"Nature"},
    {"doi":"10.1126/science.abj8754",
     "title":"Language models encode biology at scale - Lin et al. (2023)",
     "abstract":"ESM-2 learns structure from sequences alone. 12M sequences.",
     "citation_count":3200,"quality_tier":"Science"},
]
WEAK = [
    {"doi":"10.48550/arXiv.2301.99999",
     "title":"Preliminary attention in small protein models - Zhang, Li (2023)",
     "abstract":"2-layer transformer, N=500, no test set. Preliminary.",
     "citation_count":3,"quality_tier":"preprint"},
    {"doi":"10.1016/j.compbio.2022.107892",
     "title":"GPT-2 enzyme classification - Park, Kim (2022)",
     "abstract":"71% accuracy, no comparison to DEEPre (93%). Single split.",
     "citation_count":12,"quality_tier":"minor journal"},
]
OPPOSING = [
    {"doi":"10.1038/s41592-022-01488-1",
     "title":"Protein disorder prediction assessment - Necci et al. (2022)",
     "abstract":"AlphaFold reduced accuracy on disordered regions. pLDDT<50 for 37%.",
     "citation_count":890,"quality_tier":"Nature Methods"},
]
MISATTR = {
    "doi":"10.1093/nar/gkac1052",
    "title":"Language models + physics refinement - Roney (2023)",
    "abstract":"Physics refinement AFTER ESM-fold reduces RMSD 18%. COMPLEMENTARY not competitive.",
    "citation_count":420,"quality_tier":"Nucleic Acids Research"
}
VALID = {p["doi"] for p in STRONG+WEAK+OPPOSING+[MISATTR]}

def fake_results(q):
    q = q.lower()
    if "benchmark" in q and "comparison" in q: r = []
    elif any(w in q for w in ["negative","failed","replication"]): r = []
    elif "alphafold" in q or "structure prediction" in q: r = [WEAK[0],OPPOSING[0],MISATTR]
    elif "protein" in q and any(w in q for w in ["language","transformer","llm"]): r = [STRONG[1],WEAK[1],MISATTR]
    elif any(w in q for w in ["disorder","limitation","failure"]): r = OPPOSING+[WEAK[0]]
    elif "physics" in q and "protein" in q: r = [MISATTR,OPPOSING[0]]
    elif "protein" in q or "fold" in q: r = STRONG+[MISATTR]
    else: r = [STRONG[0],WEAK[1]]
    if not r: return json.dumps({"results":[]})
    return json.dumps({"results":[{"doi":p["doi"],"title":p["title"],"abstract":p["abstract"],"citation_count":p["citation_count"],"quality_tier":p["quality_tier"]} for p in r]})

SKILL = '# Paper Instructions\nUse search_papers. Only cite papers from results. Reply JSON: {"title":"","abstract":"","body":"","confidence_score":0,"falsifiable_claim":"","mechanism_chain":[],"citations":[{"doi":"","agent_summary":"","source_quality_note":""}],"self_interrogation":""}'

TASK = "Write a research paper: 'Can protein language models predict structural properties that physics-based methods miss, or do they merely approximate existing knowledge?' Search for supporting AND opposing evidence."

def build_sys(pre):
    if not pre: return SKILL
    return f"{pre}\n\n{INHABIT}\n\n{REVIEW_VETERAN}\n\n===\n\n{SKILL}"

def run_paper(sys_p):
    msgs = [{"role":"user","content":TASK}]
    tools = []
    text = ""
    for _ in range(12):
        r = client.messages.create(model=SONNET,max_tokens=8000,system=sys_p,tools=[SEARCH_TOOL],messages=msgs)
        tp = []; rt = []
        for b in r.content:
            if b.type=="text": tp.append(b.text)
            elif b.type=="tool_use": rt.append({"id":b.id,"query":b.input.get("query","")})
        tools.extend(rt)
        if tp: text = "\n".join(tp)
        if r.stop_reason=="end_turn" or not rt: break
        msgs.append({"role":"assistant","content":r.content})
        msgs.append({"role":"user","content":[{"type":"tool_result","tool_use_id":t["id"],"content":fake_results(t["query"])} for t in rt]})
    return {"text":text,"queries":[t["query"] for t in tools],"num_searches":len(tools)}

def score(res):
    s = {"num_searches":res["num_searches"]}
    try:
        t = res["text"]
        p = json.loads(t[t.find("{"):t.rfind("}")+1])
    except: return {**s,"valid":False}
    c = p.get("citations",[])
    v = sum(1 for x in c if x.get("doi") in VALID)
    s["cite_acc"] = v/len(c) if c else 0
    s["halluc"] = len(c)-v
    wd = {x["doi"] for x in WEAK}
    cw = [x for x in c if x.get("doi") in wd]
    s["weak_noted"] = sum(1 for x in cw if any(w in x.get("source_quality_note","").lower() for w in ["preprint","small","weak","preliminary","minor","low","few"]))
    s["conf"] = p.get("confidence_score",0)
    s["calibrated"] = 3<=s["conf"]<=7
    s["claim"] = len(p.get("falsifiable_claim",""))>30
    s["chain"] = len(p.get("mechanism_chain",[]))
    s["interrog"] = len(p.get("self_interrogation",""))>20
    qs = [q.lower() for q in res["queries"]]
    s["opposing"] = any(w in q for q in qs for w in ["limitation","failure","disorder","against","problem","weakness"])
    s["valid"] = True
    return s

results = {}
for var in TOP3:
    sp = build_sys(ALL_VARIANTS[var])
    runs = []
    for i in range(3):
        print(f"\n[{var}/run{i+1}]")
        r = run_paper(sp)
        sc = score(r)
        runs.append(sc)
        print(f"  srch={sc.get('num_searches')} acc={sc.get('cite_acc',0):.2f} conf={sc.get('conf')} cal={sc.get('calibrated')} opp={sc.get('opposing')} weak={sc.get('weak_noted',0)} hal={sc.get('halluc',0)}")
        time.sleep(0.5)
    results[var] = runs

out = os.path.join(os.path.dirname(__file__),"phase2.json")
with open(out,"w") as f: json.dump(results,f,indent=2)

print("\n\nAVERAGES:")
for var,runs in results.items():
    n = len(runs)
    avg_acc = sum(r.get("cite_acc",0) for r in runs)/n
    avg_conf = sum(r.get("conf",0) for r in runs)/n
    avg_cal = sum(1 for r in runs if r.get("calibrated"))/n
    avg_opp = sum(1 for r in runs if r.get("opposing"))/n
    avg_srch = sum(r.get("num_searches",0) for r in runs)/n
    avg_weak = sum(r.get("weak_noted",0) for r in runs)/n
    avg_hal = sum(r.get("halluc",0) for r in runs)/n
    print(f"  {var:15s} acc={avg_acc:.2f} conf={avg_conf:.1f} cal={avg_cal:.0%} opp={avg_opp:.0%} srch={avg_srch:.1f} weak={avg_weak:.1f} hal={avg_hal:.1f}")
print(f"\nSaved to {out}")
