# AGENTS.md v2 — installed 2026-09-20, with test results

**Status: `~/.pi/agent/AGENTS.md` now equals `AGENTS.v2.md` (byte-identical, verified with `cmp`).**
Your previous file is saved as `AGENTS.original-2026-09-20.md` (byte-identical to what was live).

Revert: `cp plans/agents-md-candidate/AGENTS.original-2026-09-20.md ~/.pi/agent/AGENTS.md`

Diffs: `AGENTS.v2.diff` (vs your previous file, +55 −15, 250 → 290 lines) and `AGENTS.v1-to-v2.diff` (vs the
earlier candidate, +21 −5). `REVIEW.md` has the rationale for the v1 edits; this file covers what v2 adds.

## Where the ideas came from

Your 14 Sep review artifact (`claude.ai/code/artifact/a1eead…`) proposed six things. What v2 does with each:

| Artifact idea | In v2? | Notes |
| --- | --- | --- |
| §4 plan-stage skill scan (already live) | **kept and hardened** | now mandatory for every task, at the top of the file, a skill only counts if its `SKILL.md` was actually `read`, and a `note` (`Skills read: …`) is written before the first edit. |
| §2 checkpoint & fork protocol | **added** | new section "When a fix keeps failing": after 2 consecutive failed verifications → `note` checkpoint → fresh subagent with only the checkpoint → merge or escalate. Also a delegation trigger in step 2. **Not exercised by the tests (see below).** |
| §3 diagnosis (selection, not discovery) | consistent with the data | discovery works (all skills load in the container); selection is the bottleneck. |
| §1 engineering-loop tool table → an on-demand skill | not done | it would be a new skill in your `pi-config`. Note the artifact's table uses two tool names that **do not exist**: `dispatch_agent` (real tool: `subagent`) and `lsp_diagnostics` (real: `lens_diagnostics`). Fix those before reusing it. |
| §5 Skill Guard (hard-enforcement extension) | not built | the data below supports the artifact's argument that prose is weak; see "What it does not fix". |
| §6 sharper skill descriptions | not applied | not needed for the skills that did trigger; untested as a lever. |

Also folded in from my earlier review: objective delegation triggers, "autonomous/minimal" wording no longer waives the
protocol, `Lean loop` rescoped to tool choice, a `reviewer` on any source-code diff, the stale `lsp_diagnostics` →
`lens_diagnostics` fix, and a subagent recursion guard.

## Test results

9 cases × 2 conditions × 2 repetitions = **36 real sessions**, DeepSeek v4 flash 0731, plain user-style prompts
(S1b/S5b use the benchmark's autonomous preamble). O = your previous file, N = v2. Suite: `behavior-tests/`.

| Case | Check | O (previous) | N (v2) |
| --- | --- | --- | --- |
| S1 plain bug fix | reads `dev-workflows` before editing | 0/2 | 0/2 |
| S1b same, benchmark framing | reads `dev-workflows` | 0/2 | 0/2 |
| S2 rename across files | reads `pi-lens-ast-grep` | 0/2 | **2/2** |
| S3 "have a subagent review…" | dispatches a subagent | 2/2 | 2/2 |
| S3 | reads the `subagents` skill | 0/2 | **2/2** |
| S4 read-only question (control) | no delegation / no edits | 2/2 · 2/2 | 2/2 · 2/2 |
| S5 unknown-files bug | delegates **before** first edit | 0/2 | 0/2 |
| S5 | `reviewer` dispatched before done | 0/2 | **2/2** (1 succeeded, 1 failed 402) |
| S5b same, benchmark framing | delegates / reviewer | 0/2 · 0/2 | 0/2 · 0/2 |
| S6 prompt starts `Task:` | **no** delegation (child guard) | 2/2 | **1/2** ✗ |
| S6, S7 | reads `dev-workflows` | 0/4 | **4/4** |
| S7 three sequential bugs | ≥2 consecutive failed verifications reached | 1/2 | 0/2 |
| S7 | forked after the 2nd failure | 0/1 | n/a |

Aggregates over all 18 runs per condition:

| | O (previous) | N (v2) |
| --- | --- | --- |
| runs with a skill read | **0** / 18 | **8** / 18 |
| runs with a protocol `note` | 0 / 18 | 11 / 18 |
| `reviewer` dispatched | 2 (both the explicit S3 ask) | 6 (2 explicit; **4 unprompted**) |
| …of which actually succeeded | 2 | 2 (**4 failed with HTTP 402**) |
| code outcome correct | 14 / 14 | 14 / 14 |
| mean wall time | 82 s | **163 s** |

Wall time per case, O → N: S1 96→74 s, S1b 43→110, S2 45→59, S3 159→324, S4 16→11, S5 99→245, S5b 80→83,
S6 96→287, S7 108→280. About **2–3×** slower on every case where the protocol actually does something; no slowdown
on the trivial ones. (S2's two "failed outcome" rows in the raw scorer are a leftover *comment* mentioning the old
name in `src/net.js`; `node test.js` passed and all code was renamed in both conditions, so correctness is 14/14 both.)

## What worked

* **Skill reads went from 0 to 8 of 18 runs** and protocol notes from 0 to 11. The reads land exactly where a skill
  is clearly relevant: `pi-lens-ast-grep` on the rename (2/2), `subagents` on an explicit delegation request (2/2),
  `dev-workflows` on the audit and the failing-tests task (4/4).
* **No over-triggering** on the read-only control (S4): no notes, no delegation, no edits.
* **No loss of correctness.**

## What it does not fix

1. **The simplest bug fix still skips the protocol.** S1/S1b (a one-line `slugify` bug) never read `dev-workflows` —
   even though the file says it matches "any bug fix" — and wrote no note. The model still classes it "trivial".
2. **Benchmark framing still wins.** With the autonomous preamble (S1b, S5b) there is no `reviewer` and no delegation;
   only the note survives. For pi-bench specifically, `AGENTS.md` alone is not enough — the harness prompt is part
   of the treatment.
3. **"Don't know which files → `scout` first" never fired** (S5/S5b 0/4). The model reads the small repo itself.
4. **The child guard failed.** In S6 the rule "first message begins with `Task:` → you are a subagent" was recognised
   in **0 of 2** runs; one run went on to dispatch a `reviewer`. Caveat: my S6 has no role system prompt, which a real
   child gets, so real children may behave better. But the subagent extension does **not** block nested dispatch
   (only the watchdog checks `PI_SUBAGENT_CHILD`), so this prose is the only guard, and it is unproven.
5. **The checkpoint & fork protocol is untested.** v2-runs never produced two consecutive failed verifications
   (they fixed the three bugs in one pass), and the previous file hit that state once without forking. To test it you
   need a task that reliably fails twice.

## Costs and a blocker you should know about

* **Latency:** ~2× on average, 2–3× where it triggers (above).
* **OpenRouter balance is $0.45** of $42 (queried from your key; no per-key limit set). The `reviewer`/`planner`
  agents use `glm-5.3`, which requests up to 262,144 output tokens; with that balance **4 of the 6 v2 reviewer
  dispatches returned `Agent error: 402 … can only afford ~100k tokens`**, and the parent fell back to re-reading its
  own diff. So the "reviewer before done" rule currently mostly burns a turn. Top up, or lower those agents' `model:`
  / max tokens in `~/pi-config/subagent/agents/*.md`.
* Everything above is one model (DeepSeek v4 flash 0731), n=2 per cell, scratch repos. Direction, not rates.

## Suggested v3 (untested — deliberately not installed)

1. **Deterministic child check.** The extension sets `PI_SUBAGENT_CHILD=1` for every child; say "if `echo $PI_SUBAGENT_CHILD`
   prints `1` you are a subagent" instead of relying on the `Task:` prefix.
2. **Reviewer fallback:** "if a `reviewer` dispatch errors, re-read your own diff, say so, and do not retry".
3. Gate the whole protocol on "the task will edit files", to save the ~2× on questions and trivia.
4. A task set that forces repeated failure (to test fork), and multi-file / SWE-bench-mini tasks (to test scout).
