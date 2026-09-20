#!/usr/bin/env python3
"""For every subagent/run_workflow/run_dev_workflow call in every case run: did it actually succeed?"""
import glob, json, re

import os
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "case-out") + "/"
for path in sorted(glob.glob(OUT + "*.json")):
    d = json.load(open(path))
    msgs = d["messages"]
    res = {m.get("toolCallId"): m for m in msgs if isinstance(m, dict) and m.get("role") == "toolResult"}
    for m in msgs:
        if not (isinstance(m, dict) and isinstance(m.get("content"), list)):
            continue
        for p in m["content"]:
            if isinstance(p, dict) and p.get("type") == "toolCall" and p["name"] in ("subagent", "run_workflow", "run_dev_workflow"):
                r = res.get(p.get("id"))
                txt = json.dumps(r.get("content")) if r else ""
                bad = bool(re.search(r"\b402\b|credit|insufficient|error|failed|exit code [1-9]|ENOENT|not found", txt, re.I))
                agent = (p.get("arguments") or {}).get("agent") or (p.get("arguments") or {}).get("type")
                print(f"{d['cond']}/{d['case']}/r{d['rep']:<2} {p['name']:9s} agent={str(agent):9s} isError={r.get('isError') if r else None} suspicious={bad}  -> {txt[:230]}")
