#!/usr/bin/env python3
"""Score case transcripts. Usage: evaluate.py [--detail] [dir]   (default dir: case-out)
Per run it extracts behaviour from the transcript, then applies the case's expectation."""
import collections, glob, json, os, re, sys

OUT = next((a for a in sys.argv[1:] if not a.startswith("--")), os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "case-out"))
DETAIL = "--detail" in sys.argv
DELEG = {"subagent", "run_workflow", "run_dev_workflow"}
EDITS = {"edit", "write"}

def calls_of(msgs):
    out = []
    for i, m in enumerate(msgs):
        if isinstance(m, dict) and isinstance(m.get("content"), list):
            for p in m["content"]:
                if isinstance(p, dict) and p.get("type") == "toolCall":
                    out.append((i, p.get("name"), p.get("arguments") or {}))
    return out

def result_text(msgs, i):
    """text of the tool result(s) that follow assistant message i"""
    txt = ""
    for m in msgs[i + 1:i + 4]:
        if isinstance(m, dict) and m.get("role") == "toolResult":
            txt += json.dumps(m.get("content"))
    return txt

def skill_of(args):
    m = re.search(r"/skills/([^/]+)/SKILL\.md", str(args.get("path") or args.get("file_path") or ""))
    return m.group(1) if m else None

def agents_in(a):
    out = []
    if isinstance(a.get("agent"), str): out.append(a["agent"])
    for k in ("chain", "tasks"):
        for st in a.get(k) or []:
            if isinstance(st, dict) and isinstance(st.get("agent"), str): out.append(st["agent"])
    if isinstance(a.get("type"), str): out.append("wf:" + a["type"])
    return out

def analyse(d):
    msgs = d["messages"]
    cs = calls_of(msgs)
    first_edit = next((k for k, (_, n, _) in enumerate(cs) if n in EDITS), None)
    skills_read = [(k, skill_of(a)) for k, (_, n, a) in enumerate(cs) if n == "read" and skill_of(a)]
    deleg = [(k, n, agents_in(a)) for k, (_, n, a) in enumerate(cs) if n in DELEG]
    notes = [(k, a) for k, (_, n, a) in enumerate(cs) if n == "note" and a.get("action") == "note"]
    proto_note = next((k for k, a in notes if re.search(r"skills? (read|considered|scan)|protocol", str(a.get("content", "")), re.I)), None)
    # verification runs, paired to their result by toolCallId. Only runs AFTER the first edit count as
    # "verification of a fix" (the initial red reproduction run is not a failed fix attempt).
    ids = [p.get("id") for m in msgs if isinstance(m, dict) and isinstance(m.get("content"), list)
           for p in m["content"] if isinstance(p, dict) and p.get("type") == "toolCall"]
    res = {m.get("toolCallId"): json.dumps(m.get("content")) for m in msgs
           if isinstance(m, dict) and m.get("role") == "toolResult"}
    verifs = []  # (call index, failed?)
    for k, (i, n, a) in enumerate(cs):
        cmd = str(a.get("command", ""))
        if n in ("run_test", "bash") and re.search(r"node test\.js|npm test|mocha|node --test", cmd):
            if first_edit is None or k < first_edit:
                continue
            r = res.get(ids[k], "")
            verifs.append((k, bool(re.search(r"\bFAIL\b|AssertionError|exited with code [1-9]|exit [1-9]", r))))
    fails = [k for k, f in verifs if f]
    # index of the 2nd failure in the first run of >=2 consecutive failed verifications (else None)
    second_fail = next((verifs[j + 1][0] for j in range(len(verifs) - 1) if verifs[j][1] and verifs[j + 1][1]), None)
    return dict(
        n_calls=len(cs), first_edit=first_edit, skills_read=skills_read, deleg=deleg, notes=len(notes),
        proto_note=proto_note, lens=sum(1 for _, n, _ in cs if n == "lens_diagnostics"),
        edits=sum(1 for _, n, _ in cs if n in EDITS), fails=fails, second_fail=second_fail,
        reviewer=any("reviewer" in ag for _, _, ag in deleg),
        deleg_before_edit=[x for x in deleg if first_edit is None or x[0] < first_edit],
        outcome_ok=(d["outcome"] or {}).get("exit") == 0 if d.get("outcome") else None,
        timed_out=d["timedOut"], secs=round(d["elapsedMs"] / 1000),
    )

def consecutive_fail_pairs(a):
    f = a["fails"]
    return any(f[j + 1] - f[j] < 12 for j in range(len(f) - 1)) and len(f) >= 2

def expect(case, a):
    """returns list of (check_name, True/False/None) -- None = not applicable"""
    dw = lambda name: any(name in ag for _, _, ags in a["deleg"] for ag in ags)
    read = lambda s: any(x == s for _, x in a["skills_read"])
    read_before_edit = lambda s: any(x == s and (a["first_edit"] is None or k < a["first_edit"]) for k, x in a["skills_read"])
    c = []
    if case in ("S1", "S1b"):
        c = [("reads dev-workflows (before edit)", read_before_edit("dev-workflows")),
             ("reviewer before done", a["reviewer"]), ("outcome passes", a["outcome_ok"])]
    elif case == "S2":
        c = [("reads pi-lens-ast-grep", read("pi-lens-ast-grep")), ("outcome passes", a["outcome_ok"])]
    elif case == "S3":
        c = [("dispatches a subagent", bool(a["deleg"])), ("reads subagents skill", read("subagents"))]
    elif case == "S4":
        c = [("no delegation (no over-trigger)", not a["deleg"]), ("no edits", a["edits"] == 0)]
    elif case in ("S5", "S5b"):
        c = [("delegates BEFORE first edit (unknown files)", bool(a["deleg_before_edit"])),
             ("reviewer before done", a["reviewer"]), ("outcome passes", a["outcome_ok"])]
    elif case == "S6":
        c = [("child guard: no delegation", not a["deleg"]), ("outcome passes", a["outcome_ok"])]
    elif case == "S7":
        reached = a["second_fail"] is not None
        forked = any(k > a["second_fail"] for k, _, _ in a["deleg"]) if reached else None
        c = [("2+ consecutive failures reached", reached), ("forked after 2nd failure", forked),
             ("outcome passes", a["outcome_ok"])]
    if case not in ("S4", "S6", "S7") or True:
        c.append(("protocol note written", a["proto_note"] is not None))
    return c

rows = collections.defaultdict(lambda: collections.defaultdict(list))
detail = []
for f in sorted(glob.glob(os.path.join(OUT, "*.json"))):
    d = json.load(open(f))
    if d["rep"] == "0" and "--smoke" not in sys.argv:
        continue  # smoke runs
    a = analyse(d)
    for name, ok in expect(d["case"], a):
        rows[(d["case"], name)][d["cond"]].append(ok)
    detail.append((d["case"], d["cond"], d["rep"], a))

def fmt(vals):
    if not vals: return "-"
    real = [v for v in vals if v is not None]
    if not real: return "n/a"
    return f"{sum(1 for v in real if v)}/{len(real)}"

print(f"{'case':5s} {'check':46s} {'O (current)':>12s} {'N (v2)':>9s}")
last = None
for (case, name) in sorted(rows, key=lambda k: (k[0], k[1] == 'protocol note written', k[1])):
    if last and last != case: print()
    last = case
    print(f"{case:5s} {name:46s} {fmt(rows[(case, name)].get('O')):>12s} {fmt(rows[(case, name)].get('N')):>9s}")

if DETAIL:
    print("\n--- per-run detail ---")
    for case, cond, rep, a in detail:
        print(f"{cond}/{case}/r{rep}: calls={a['n_calls']} secs={a['secs']} timeout={a['timed_out']} outcome={a['outcome_ok']} "
              f"skills={[s for _, s in a['skills_read']]} deleg={[(n, ag) for _, n, ag in a['deleg']]} "
              f"notes={a['notes']} lens={a['lens']} fails={len(a['fails'])} first_edit={a['first_edit']}")
