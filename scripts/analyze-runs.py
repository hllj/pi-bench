#!/usr/bin/env python3
"""Compare several pi-bench SWE-bench result directories for the same model.

Reproduces every number in debug/analysis_report_deepseek-v4-flash-v1-v2-v2.1.md.
Standard library only.

    python3 scripts/analyze-runs.py --base benchmark_results/macos-openrouter \
        v1=deepseek_deepseek-v4-flash-0731_results \
        v2=deepseek_deepseek-v4-flash-0731-0913_results \
        v2.1=deepseek_deepseek-v4-flash-0731-0916_results

Notes on the data this handles:
  * v2 and v2.1 `summary.json` list every task twice (raw attempt + wrapper),
    so totalTasks/passedTasks/totalDurationMs are doubled. Results are
    de-duplicated by task id here.
  * `durationMs` is captured BEFORE the verification-retry phase, so it
    under-reports wall-clock for retried tasks. Wall-clock below is the
    transcript span (first to last message timestamp) instead.
"""
import argparse
import collections
import json
import math
import re
import statistics as st
from math import comb
from pathlib import Path

CONFIG_FILES = {"setup.py", "tox.ini", "pyproject.toml", "setup.cfg", "requirements.txt"}
# A bash command that tries to obtain upstream django/sphinx code, and tool-result
# text proving something actually arrived (a saved download or a non-empty API hit).
FETCH_CMD = re.compile(r"pip download|pip install[^\n]*(django|sphinx)|files\.pythonhosted|raw\.githubusercontent\.com/(django|sphinx-doc)|api\.github\.com|git (fetch|clone|ls-remote)|curl[^\n]*github", re.I)
FETCH_OK = re.compile(r"Successfully downloaded|Saved [^\n]*(whl|tar\.gz)|saved \d+|-rw-[^\n]*(tar\.gz|whl|\.py)\b|\"total_count\": *[1-9]|\"items\": *\[\s*\{|^\s*\d{3}\s+\{", re.I | re.M)
GIT_HISTORY = re.compile(r"\bgit\s+(log|show|tag|reflog|describe|branch|rev-list|blame)\b")
FUTURE_REFS = re.compile(r"\bv\d+\.\d+(\.\d+)?\b|--all\b|git tag|git branch -a|for-each-ref")


def status(r):
    if r.get("scoreSource") == "harness-error" or r.get("excludeFromPassRate"):
        return "EXCL"
    return "PASS" if r["judgeScore"] == 1 else "FAIL"


def load_run(run_dir):
    summary = json.loads((run_dir / "summary.json").read_text())
    tasks = {}
    for r in summary["results"]:
        tasks[r["task"]] = dict(r)  # de-dupe (identical duplicates in v2/v2.1)
    for tid, m in tasks.items():
        m["files"] = re.findall(r"^diff --git a/(\S+)", m.get("diff") or "", re.M)
        transcript = json.loads((run_dir / f"transcript-{tid}.json").read_text())
        calls, usage, bash = collections.Counter(), collections.Counter(), []
        cost = 0.0
        pending, fetched = {}, False
        for msg in transcript:
            if msg["role"] == "toolResult" and msg["toolCallId"] in pending:
                text = " ".join(x.get("text", "") for x in msg["content"])
                fetched = fetched or bool(FETCH_OK.search(text))
                del pending[msg["toolCallId"]]
            if msg["role"] != "assistant":
                continue
            u = msg.get("usage") or {}
            for k in ("input", "output", "cacheRead", "reasoning"):
                usage[k] += u.get(k, 0) or 0
            cost += (u.get("cost") or {}).get("total", 0) or 0
            for b in msg["content"]:
                if b.get("type") == "toolCall":
                    calls[b["name"]] += 1
                    if b["name"] == "bash":
                        cmd = (b.get("arguments") or {}).get("command", "")
                        bash.append(cmd)
                        if FETCH_CMD.search(cmd):
                            pending[b["id"]] = cmd
        last = [x for x in transcript if x["role"] == "assistant"][-1]
        m.update(
            calls=calls, usage=usage, cost=cost, bash=bash, fetched=fetched,
            span_min=(transcript[-1]["timestamp"] - transcript[0]["timestamp"]) / 60000,
            last_stop=last.get("stopReason"),
            compacted=any(x["role"] == "compactionSummary" for x in transcript),
            peak_ctx=max((x["usage"]["input"] + x["usage"]["cacheRead"] for x in transcript if x["role"] == "assistant"), default=0),
        )
    return summary, tasks


def wilson(k, n, z=1.96):
    p, d = k / n, 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return c - h, c + h


def mcnemar(a, b):
    """Exact two-sided McNemar on tasks scored in both runs."""
    x = y = 0
    for t in a:
        sa, sb = status(a[t]), status(b[t])
        if "EXCL" in (sa, sb):
            continue
        x += sa == "FAIL" and sb == "PASS"
        y += sa == "PASS" and sb == "FAIL"
    n = x + y
    return x, y, min(1.0, 2 * sum(comb(n, i) for i in range(min(x, y) + 1)) / 2**n) if n else 1.0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="benchmark_results/macos-openrouter")
    ap.add_argument("runs", nargs="+", help="tag=dirname")
    args = ap.parse_args()
    runs = {}
    for spec in args.runs:
        tag, name = spec.split("=", 1)
        runs[tag] = load_run(Path(args.base) / name)

    for tag, (summary, o) in runs.items():
        c = collections.Counter(status(r) for r in o.values())
        k, n = c["PASS"], c["PASS"] + c["FAIL"]
        lo, hi = wilson(k, n)
        print(f"\n===== {tag}")
        print(f"summary.json claims totalTasks={summary['totalTasks']} passedTasks={summary['passedTasks']} passRate={summary['passRate']}")
        print(f"de-duplicated: {len(o)} tasks {dict(c)}; scored pass {k}/{n} = {k/n:.1%} (95% Wilson {lo:.1%}-{hi:.1%}); over all {len(o)}: {k/len(o):.1%}")
        for repo in ("django", "sphinx"):
            print(f"  {repo}: {dict(collections.Counter(status(r) for t, r in o.items() if t.startswith(repo)))}")
        span = [r["span_min"] for r in o.values()]
        rec = [r["durationMs"] / 60000 for r in o.values()]
        print(f"wall-clock (transcript span) total {sum(span):.0f}m mean {st.mean(span):.1f} median {st.median(span):.1f} max {max(span):.1f}; recorded durationMs total {sum(rec):.0f}m; tasks >20m: {sum(x > 20 for x in span)}")
        print(f"  mean span: pass {st.mean(r['span_min'] for r in o.values() if status(r) == 'PASS'):.1f}m fail {st.mean(r['span_min'] for r in o.values() if status(r) == 'FAIL'):.1f}m")
        cost = sum(r["cost"] for r in o.values())
        usage = collections.Counter()
        tc = collections.Counter()
        for r in o.values():
            usage.update(r["usage"])
            tc.update(r["calls"])
        print(f"cost ${cost:.2f} (${cost/k:.3f}/solved); output tokens {usage['output']/1e6:.2f}M; uncached input {usage['input']/1e6:.1f}M; cacheRead {usage['cacheRead']/1e6:.0f}M")
        print(f"tool calls {sum(tc.values())}: bash {tc['bash']} read {tc['read']} edit {tc['edit']} run_test {tc['run_test']} grep+find {tc['grep'] + tc['find']} -> bash:run_test {tc['bash']/tc['run_test']:.0f}:1; tasks using run_test {sum(1 for r in o.values() if r['calls'].get('run_test'))}")
        git = [c for r in o.values() for c in r["bash"] if GIT_HISTORY.search(c)]
        refs = [c for r in o.values() for c in r["bash"] if "git" in c and FUTURE_REFS.search(c)]
        print(f"git-history bash cmds {len(git)} in {sum(1 for r in o.values() if any(GIT_HISTORY.search(c) for c in r['bash']))} tasks; tag/--all/branch-a cmds {len(refs)}")
        fetch = [t for t, r in o.items() if r["fetched"]]
        rest = [t for t in o if t not in fetch]
        npass = lambda ts: sum(status(o[t]) == "PASS" for t in ts)
        print(f"upstream fetch (confirmed by tool result): {len(fetch)} tasks, pass {npass(fetch)}/{len(fetch)} vs rest {npass(rest)}/{len(rest)}; `pip download` cmds {sum('pip download' in c for r in o.values() for c in r['bash'])}: {sorted(t.split('__')[-1] for t in fetch)}")
        print(f"tasks whose diff touches config files: {sum(1 for r in o.values() if any(f in CONFIG_FILES for f in r['files']))}; empty diffs: {[t for t, r in o.items() if not r['files']]}")
        print(f"last assistant stopReason: {dict(collections.Counter(r['last_stop'] for r in o.values()))}; compacted transcripts: {sum(r['compacted'] for r in o.values())}; median peak prompt {st.median(r['peak_ctx'] for r in o.values()):.0f}")
        for key in ("timedOut", "loopRecoveries", "verificationRetries", "archaeologyNudges", "timeBudgetNudged"):
            if key in next(iter(o.values())):
                print(f"  {key}: tasks with value>0 = {sum(1 for r in o.values() if r.get(key))}, sum = {sum(int(r.get(key) or 0) for r in o.values())}")
        if "judgeModelScore" in next(iter(o.values())):
            dis = [(t, r["judgeModelScore"], r["sweTestExitCode"]) for t, r in o.items() if status(r) != "EXCL" and r["judgeModelScore"] != (1 if r["sweTestExitCode"] == 0 else 0)]
            print(f"  judge vs container-test disagreements (scored tasks): {dis}")
            retried = [t for t, r in o.items() if r["verificationRetries"]]
            rescued = [t for t in retried if status(o[t]) == "PASS"]
            first = [t for t, r in o.items() if not r["verificationRetries"] and status(r) == "PASS"]
            print(f"  verification retry: retried {len(retried)}, rescued {len(rescued)} {rescued}; first-try passes {len(first)}/{len(o)} = {len(first)/len(o):.0%}")

    tags = list(runs)
    print("\n===== paired transitions (status per run, in order)", tags)
    trans = collections.Counter(tuple(status(runs[t][1][tid]) for t in tags) for tid in runs[tags[0]][1])
    for k, v in sorted(trans.items()):
        print(" ", k, v)
    for a, b in zip(tags, tags[1:]):
        x, y, p = mcnemar(runs[a][1], runs[b][1])
        print(f"  {a}->{b}: FAIL->PASS {x}, PASS->FAIL {y}, exact McNemar p={p:.3f}")
    print("\n===== per task")
    print(f"{'task':28} | " + " | ".join(f"{t:22}" for t in tags))
    for tid in sorted(runs[tags[0]][1]):
        cells = []
        for t in tags:
            r = runs[t][1][tid]
            flags = ("T" if r.get("timedOut") else "") + ("V" if r.get("verificationRetries") else "") + (f"A{r['archaeologyNudges']}" if r.get("archaeologyNudges") else "") + ("B" if r.get("timeBudgetNudged") else "")
            cells.append(f"{status(r):4} {r['span_min']:5.1f}m {sum(r['calls'].values()):3}c {flags}")
        print(f"{tid:28} | " + " | ".join(f"{c:22}" for c in cells))


if __name__ == "__main__":
    main()
