#!/usr/bin/env python3
"""Aggregate numbers for the write-up: skill reads, protocol notes, reviewer attempts/successes, latency."""
import collections, glob, json, re, statistics, sys

import os
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "case-out") + "/"

def skill_reads(msgs):
    s = []
    for m in msgs:
        if isinstance(m, dict) and isinstance(m.get("content"), list):
            for p in m["content"]:
                if isinstance(p, dict) and p.get("type") == "toolCall" and p["name"] == "read":
                    mm = re.search(r"/skills/([^/]+)/SKILL\.md", str((p.get("arguments") or {}).get("path", "")))
                    if mm: s.append(mm.group(1))
    return s

agg = collections.defaultdict(lambda: collections.defaultdict(list))
for path in sorted(glob.glob(OUT + "*.json")):
    d = json.load(open(path))
    if d["rep"] == "0":
        continue
    c, case = d["cond"], d["case"]
    msgs = d["messages"]
    res = {m.get("toolCallId"): json.dumps(m.get("content")) for m in msgs if isinstance(m, dict) and m.get("role") == "toolResult"}
    skills, notes_proto, att, ok = skill_reads(msgs), 0, 0, 0
    for m in msgs:
        if isinstance(m, dict) and isinstance(m.get("content"), list):
            for p in m["content"]:
                if not (isinstance(p, dict) and p.get("type") == "toolCall"):
                    continue
                a = p.get("arguments") or {}
                if p["name"] == "note" and a.get("action") == "note" and re.search(r"skills? (read|considered|scan)|protocol", str(a.get("content", "")), re.I):
                    notes_proto += 1
                if p["name"] == "subagent" and a.get("agent") == "reviewer":
                    att += 1
                    ok += 0 if "Agent error" in res.get(p.get("id"), "") else 1
    agg[c]["runs"].append(1)
    agg[c]["skill_run"].append(1 if skills else 0)
    agg[c]["note_run"].append(1 if notes_proto else 0)
    agg[c]["rev_att"].append(att)
    agg[c]["rev_ok"].append(ok)
    agg[c]["secs"].append(d["elapsedMs"] / 1000)
    agg[c]["pass"].append(1 if (d.get("outcome") or {}).get("exit") == 0 else 0 if d.get("outcome") else None)
    agg[c][f"secs_{case}"].append(d["elapsedMs"] / 1000)

for c in ("O", "N"):
    a = agg[c]
    passes = [x for x in a["pass"] if x is not None]
    print(f"{c}: runs={len(a['runs'])}  runs with a skill read={sum(a['skill_run'])}  runs with a protocol note={sum(a['note_run'])}  "
          f"reviewer dispatched={sum(a['rev_att'])} (succeeded={sum(a['rev_ok'])}, 402/error={sum(a['rev_att']) - sum(a['rev_ok'])})  "
          f"outcome passes={sum(passes)}/{len(passes)}  mean secs={statistics.mean(a['secs']):.0f}")
print("\nmean wall seconds per case (O -> N):")
for case in ("S1", "S1b", "S2", "S3", "S4", "S5", "S5b", "S6", "S7"):
    o, n = statistics.mean(agg["O"][f"secs_{case}"]), statistics.mean(agg["N"][f"secs_{case}"])
    print(f"  {case:4s} {o:5.0f}s -> {n:5.0f}s   ({n / o:.1f}x)")
