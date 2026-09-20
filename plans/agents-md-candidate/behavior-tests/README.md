# Skill / subagent behaviour tests

Nine small cases that check whether a pi session, using a given `AGENTS.md`, proactively reads skills, delegates to
subagents, and behaves sanely. Each case runs in a **harness-equivalent session** inside the `pi-bench-runner`
container (same `createAgentSession`, same tool exclusions and active-tool resync as `src/index.ts`) against a fresh
dependency-free scratch repo, with the same `~/.pi/agent` mounts as the benchmark. The transcript is scored offline.

| Case | Repo | What it probes | Expected with a good `AGENTS.md` |
| --- | --- | --- | --- |
| S1 | A-slugify | plain bug report | reads `dev-workflows`, `reviewer` before done |
| S1b | A-slugify | same, wrapped in the benchmark's "autonomous" preamble | same (framing must not suppress it) |
| S2 | B-rename | codebase-wide rename incl. an aliased import | reads `pi-lens-ast-grep` |
| S3 | A-slugify | explicit "have a subagent review …" | dispatches a subagent; reads `subagents` |
| S4 | A-slugify | read-only question (negative control) | no delegation, no edits (no over-triggering) |
| S5 / S5b | C-cart | "I don't know where the bug is" (plain / benchmark framing) | delegates (`scout`) before editing; `reviewer` at the end |
| S6 | C-cart | prompt starts with `Task:` (child-guard check) | NO further delegation |
| S7 | D-price | three sequential bugs → repeated failed verification | after 2 consecutive failures: checkpoint `note` + forked subagent |

## Run

```sh
docker build -t pi-bench-runner .     # once, from the repo root
bun install                           # once
cd plans/agents-md-candidate/behavior-tests/cases
./validate-repos.sh                   # free: every repo fails at first, passes after its intended fix
export ENV_FILE=/path/to/.env         # must contain OPENROUTER_API_KEY (default: <repo root>/.env)
./run-queue.sh 4                      # all missing (cond, case, rep) cells, 4 containers at a time
./evaluate.py                         # O-vs-N table   (--detail for per-run rows)
./summarize.py                        # skill reads, protocol notes, reviewer successes, latency
./subagent-results.py                 # did each subagent call actually succeed (spots 402s)
```

Conditions: **O** = `../../AGENTS.original-2026-09-20.md` (your file before the update), **N** = `../../AGENTS.v2.md`.
Both are mounted explicitly, because `~/.pi/agent/AGENTS.md` itself is now v2 — comparing "the live file" to v2
would compare v2 to itself. Edit `run-case.sh` to point O/N at other files.

## Constraints learned the hard way

* **Concurrency.** Each container uses ~700 MB and >100% of a core while starting. 9 at once exhausted an 8 GB
  Docker VM and containers died silently (no output file). Use `run-queue.sh 4`.
* **Credits.** `subagent` children use their own models (`reviewer`/`planner` = `openrouter/z-ai/glm-5.3`, which
  requests up to 262,144 output tokens). With a low OpenRouter balance they fail with `402 … can only afford N tokens`
  and the parent silently falls back. Run `./openrouter-credits.py` first, and `./subagent-results.py` after.
* **Scoring is heuristic.** "Verification failed" is inferred from test-run output after the first edit; "protocol
  note" by regex on `note` content. Read `--detail` and the raw transcripts (`case-out/*.json`) before trusting a cell.
* n is small (2 per cell in the published run). Treat differences as direction, not rates.
