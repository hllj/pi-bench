# Candidate `AGENTS.md` — review notes

> **Update 2026-09-20:** this document describes candidate **v1** (reviewed when `~/.pi/agent/AGENTS.md` was still
> untouched). A later **v2** (v1 + the checkpoint-&-fork idea from your 14 Sep artifact + loophole fixes) was tested on
> 36 sessions and **installed** into `~/.pi/agent/AGENTS.md`. See **`V2-RESULTS.md`** for what is live now, the
> results, the risks and the one-line revert. The v1 rationale below still applies to the edits v2 inherits.

**Status of v1: superseded by v2.** Files in this directory:

| File | What |
| --- | --- |
| `AGENTS.v2.md` | **the version now installed** (`~/.pi/agent/AGENTS.md` is byte-identical to it) |
| `AGENTS.original-2026-09-20.md` | your file before the update — revert target |
| `AGENTS.candidate.md` | v1 (superseded) |
| `AGENTS.candidate.diff` / `AGENTS.v2.diff` / `AGENTS.v1-to-v2.diff` | diffs: v1 vs original, v2 vs original, v2 vs v1 |
| `V2-RESULTS.md` | v2: idea mapping, 36-session test matrix, findings, risks |
| `REVIEW.md` | this document (v1 rationale + first 3-run test) |
| `behavior-tests/` | the reusable skill/subagent case suite (9 cases) |

## Why change anything — what the experiments showed

Across 11 real plain-prompt runs (DeepSeek v4 flash 0731 and Claude Sonnet 5, three express tasks) the agent made
**0 subagent/workflow calls and 0 skill reads**, in every condition:

* Removing the "Lean loop" bullet alone changed nothing.
* Adding an *explicit* "read `dev-workflows`, then `run_dev_workflow`" rule (at line 68 of the file) did not
  work either. The model's reasoning shows it noticed the rule only at message 32, immediately before editing —
  after ~30 messages of investigation — and then talked itself out of it, citing (a) the harness's
  "stop investigating" nudge, (b) this file's own *"Trivial tasks may compress the loop"* escape hatch, and
  (c) the task prompt's "autonomous" framing:
  > "…the system warning said to stop investigating and make the code change now. This is a small, well-understood
  > fix… trivial task… I'll do the fix inline"
* Sonnet 5 with the unmodified file never mentioned skills or subagents at all.
* The same model ignores even the file's strongest rule: "Verify (never skippable)" via `lsp_diagnostics` /
  `lens_diagnostics` was followed in 0/6 runs — and `lsp_diagnostics` is not a registered tool in the installed
  pi-lens (it registers `lens_diagnostics`, `lens_diagnostic_mark`, `lsp_navigation`).

So the failure is not "the model can't": it delegates correctly when told in the user message (the `/implement`
run dispatched scout→planner→worker). It is that every soft, late, self-judged rule in this file loses to the
task prompt's framing. The candidate targets exactly those properties.

## What changed, and why (each edit maps to an observation)

| # | Edit | Evidence / reasoning |
| --- | --- | --- |
| E1 | New **Start-of-task protocol** at the very top (before the 27-line "how this file works" maintainer section; rules previously started at line 58/68) | The model recalled the old rule at msg 32, deep into the run. It must fire at the start, and be short. |
| E1 | Step 1 is **verifiable**: `read` matching `SKILL.md`, then `note` `Skills considered: …` | The old scan ("don't assume it happens automatically") left no trace, so it could not be checked or enforced. The `note` also makes triggering *measurable* per run. |
| E1 | Step 2 uses **objective triggers** (don't know the files → `scout`; >1 file or cause unclear after ~6 calls → `run_dev_workflow`; about to declare done after editing source → `reviewer`) | The old rule delegated on "non-trivial", which the model judged itself and always answered "trivial". |
| E1 | "Autonomous / no human interaction / minimal changes" **does not waive** the protocol; "stop investigating" means *yourself* — dispatch a `scout`; explicit user "don't delegate" still wins | These were the exact rationalizations quoted in the F2 run. Your file's "chat instruction overrides everything" was the loophole. |
| E1 | Skills are under `~/.pi/agent/`, outside cwd — reading them is always allowed | The benchmark prompt forbids reading outside the working directory; without this the protocol would lose to it. |
| E1 | **Subagents** (first message starts with `Task:`) do step 1 only, never dispatch further | The subagent tool prepends `Task:` to every child prompt, and children load this same file. Without a guard, "must delegate" recurses. Only an advisory spawn ceiling exists today. |
| E2 | `plan` row of the loop points at the protocol | Removes the soft duplicate. |
| E3, E6 | `review` row and Definition of done: **a `reviewer` agent on any source-code diff** (docs-only: self re-read); its verdict must be in the transcript | Was "non-trivial work" / "(or dispatched)". This is the most *reliably checkable* trigger — it happens at one known point (end), unlike "when the task is complex". |
| E4 | "Trivial tasks" / "use judgment" no longer cover the protocol | The escape hatch the model actually used. |
| E5 | "Lean loop over scaffolding" → **"Lean loop for tool choice"**, explicitly not about delegating | The old text told the model *not* to reach for `subagent` by default. Its `bash`-over-`ast_grep` advice is kept. |
| E7 | `lsp_diagnostics` → `lens_diagnostics` (5 places) | Stale tool name (verified against the installed pi-lens). **Independent of the rest — safe to keep even if you reject E1–E6.** |

## Trade-offs and knobs (your call)

* **Cost/latency.** The reviewer gate (E3/E6) dispatches one subagent per source-code change, and `glm-5.3`
  reviewers are not free. To relax: restrict the reviewer trigger to ">1 file changed" or make it opt-in.
* **The "~6 tool calls" threshold and ">1 source file"** are arbitrary; tune them.
* **File length.** +24 lines on a file whose own rule is "every line costs context on every run". Not offset
  here to keep the diff reviewable. Natural follow-up: move the 27-line maintainer section ("How this file works",
  layering table) to the end, or into a separate doc — compliance with rules that start on line 8 beats line 58.
* **Real-world friction.** Forcing a skill read + `note` on every task adds ~2 tool calls to genuinely trivial
  requests ("what does this function do?"). If that annoys you, gate step 1 on "the task will edit files".
* **Benchmark integrity is a separate problem — and worse than I first reported.** A scan of every transcript
  (`bash` commands only, local URLs excluded) found the agent reaching upstream in **5 of 14 runs**: `npm pack` of
  newer express/router releases, `curl` of upstream `master`/`4.x` source and tests from raw.githubusercontent.com,
  and (two runs, two models) the GitHub API for the real fix commit `99a369f…`. That includes 4 of the 5 hard-task
  runs and the baseline *medium* run (15 fetches). An earlier message of mine said "at least 2 of 5 hard runs";
  that was an undercount — I had only checked `read` paths. Pass/fail scores from those runs are not trustworthy,
  so do not compare pass rates across conditions. This file cannot fix it (the `web_search`/`web_fetch` exclusion is
  bypassed by `bash`+`curl`/`npm`; planner/general subagents also list `web_*` in their `tools:`).

## Empirical check of *this* candidate

Same harness, model (DeepSeek v4 flash 0731), tasks and plain prompts as the baselines; only `AGENTS.md` differs
(mounted read-only over the container's copy). **n = 3 — read this as direction, not a rate.**

| Behaviour the file asks for | Original file (6 runs) | Candidate (3 runs) |
| --- | --- | --- |
| `read` a matching skill's `SKILL.md` | 0 / 6 | **1 / 3** (easy: `dev-workflows`, at call 3 of 53) |
| Record the protocol in a `note` (section `workflow`) | 0 / 6 | **1 / 3** (medium, call 15 of 62; free-form wording, not the literal `Skills considered:`) |
| `reviewer` subagent before declaring done | 0 / 6 | **2 / 3** (easy, medium; hard timed out before the end) |
| `lens_diagnostics` ("Verify — never skippable") | 0 / 6 | **2 / 3** (easy ×2, medium ×1) |
| `scout` / `run_dev_workflow` | 0 / 6 | 0 / 3 |
| Judge score | 6 / 6 | 3 / 3 (hard: `timedOut`, still a passing diff) |

What the traces show:

* It moved behaviour that had been 0 across 11+ runs. The first-ever unprompted skill read, subagent dispatch
  and `lens_diagnostics` verify all appear.
* It is **partial compliance, not a fix.** No run did both halves of step 1. Medium listed `dev-workflows` and
  `subagents` in its note as matching but never read them; easy read the skill but wrote no note.
* The delegation triggers were applied *as written*. The medium run's own note: "single-file fix in
  lib/response.js … inline work chosen (no scout/planner needed …)". That is the protocol working — those tasks
  name the file and touch one source file, so no `scout`/`run_dev_workflow` trigger holds. To get those to fire you
  need harder / multi-file tasks (e.g. SWE-bench mini), not a stronger rule.
* The hard run hit the 25-minute timeout after only 28 tool calls (baselines: 6–15 min). The F2 run with an
  explicit rule also timed out on hard. With this few runs I cannot say whether extra instructions slow the model
  on that task; watch for it.

### Suggested v2 tweaks — **untested**, so not included in `AGENTS.candidate.md`

1. Close the "listed but not read" loophole: *"a skill counts as considered only if you have `read` its SKILL.md."*
2. Require the note *before the first edit* and give it a fixed literal (`Skills read: …`), so it can be counted
   mechanically per run.
3. Move the 27-line maintainer section ("How this file works") below the operating rules.

I did not fold these in: what I tested is exactly what is in `AGENTS.candidate.md`.
