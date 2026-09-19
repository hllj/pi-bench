# DeepSeek V4 Flash (0731) on SWE-bench Verified-mini: v1 vs v2 vs v2.1

*This analysis was conducted by Claude Sonnet 5 on 2026-09-19. Every number below is reproducible with `scripts/analyze-runs.py` (command at the end).*

## Objective

The same model (`deepseek/deepseek-v4-flash-0731` via OpenRouter) was run on the same 50 SWE-bench Verified-mini tasks (25 django + 25 sphinx) three times, with the pi-bench harness changing in between. This report answers:

1. How much did the score move, and how much of that is real?
2. Which harness changes caused the movement, and which are noise?
3. What is still wrong, in the harness or in the data, that the next iteration should fix?

## TL;DR

| | v1 | v2 | v2.1 |
|---|---|---|---|
| Scored pass rate | **35/50 = 70.0%** | **44/50 = 88.0%** | **45/48 = 93.8%** (2 tasks excluded as `harness-error`) |
| Same 48 tasks (excl. 12209, 8265 everywhere) | 35/48 = 72.9% | 44/48 = 91.7% | 45/48 = 93.8% |
| First-try pass rate (no verification retry), 48 tasks | 72.9% | 77.1% | 85.4% |
| Wall-clock, total agent time | 652 min | 533 min | 425 min |
| Tasks that ran > 20 min | 8 | 6 | 1 |
| Agent cost (harness-recorded) | $2.35 | $2.20 | $1.99 |

1. **v1 → v2 (+18 pp) is real but is mostly a change in what is being measured.** 11 tasks flipped FAIL→PASS and 2 flipped PASS→FAIL (exact McNemar p = 0.022). Seven of v2's 44 passes were *rescued by the new one-shot verification retry*, which feeds the agent the real FAIL_TO_PASS failure output. First-try passes (no retry) only moved 70% → 74% of the 50 tasks. **v2/v2.1 scores are "agent + one round of acceptance-test feedback" and are not comparable to v1, or to any leaderboard number, without saying so.**
2. **v2 → v2.1 (+5.8 pp) is mostly a denominator effect, not a capability gain.** The pass count went 44 → 45; the rest is two structurally unwinnable tasks (corrupt `FAIL_TO_PASS` data) being excluded. Flips: 2 FAIL→PASS, 1 PASS→FAIL (McNemar p = 1.0). Treat 44 vs 45 as noise.
3. **v2.1's real gains are efficiency and robustness:** total wall-clock −20% vs v2 and −35% vs v1, runaway tasks (>20 min) 8 → 6 → 1, zero git-archaeology nudges, zero empty diffs. The git-history scrub and the 50% budget nudge are the likely contributors: the v2 transcripts show the agent running `git show v8.1.3:…` on a 4.1-era checkout, and v2.1 has only one reachable commit (`benchmark-baseline`). Single-run variance (below) means the size of each contribution is not separable.
4. **The scrub closed only one of two ways to see the answer. Container network access is open, and it is used in every run.** Agents successfully `pip download` later Django/Sphinx releases (which contain the fixes) or pull GitHub raw files in **at least 10 / 10 / 9 of 50 tasks** (v1 / v2 / v2.1; a lower bound, see §6.1). Concrete case: in v2, django-11815 downloaded the Django 3.2.25 wheel, printed its `EnumSerializer`, and submitted the same fix. `web_search`/`web_fetch` are excluded, but `bash` + `pip`/`curl`/`urllib` bypasses that. This inflates the absolute pass rate of all three runs by an unmeasured amount (§6.1).
5. **Two harness bugs cost real points and are still open**, and one dataset entry is probably defective:
   - `revertAgentTestModifications` cannot remove agent-created files that `getDiff()` already staged, so the official test patch falls back to `git apply --3way` and writes merge-conflict markers into fixtures (sphinx-11510, fails in v2 and v2.1 even though the judge rates the code fix exact). I reproduced this in a scratch repo, and confirmed the proposed fix.
   - The archaeology-nudge path aborts the session when its budget is exhausted and then `break`s, ending the run with no edits (sphinx-10323 and sphinx-9229 in v2, both empty diffs). v2.1 avoids it only because the scrub removed the trigger.
   - sphinx-9229 fails identically in all three runs (`No module named 'target'`) while the judge rates the v2.1 diff as matching the reference. The stored test patch has no `testroot` marker. Likely a third bad dataset entry (needs verification against canonical SWE-bench).
6. **`summary.json` is wrong in v2 and v2.1.** It lists each task twice, so `totalTasks`, `passedTasks`, `totalDurationMs` are doubled (v2.1 says `totalTasks: 100`). The pass *rate* survives, the counts do not. `durationMs` also silently excludes the verification-retry phase. (Detail and fixes in §6.6 and §7.)

## Runs compared

| Tag | Directory (under `benchmark_results/macos-openrouter/`) | Ran (UTC) | Harness state |
|---|---|---|---|
| v1 | `deepseek_deepseek-v4-flash-0731_results` | 2026-08-29 → 08-30 | Original harness. Predates ground-truth-first scoring and baseline-diff hygiene (`13d1975`, 2026-08-30); its `summary.json` was retroactively rescored. Agent pinned to `fp4` quantization. No retry, no nudges, no `run-meta` details. No evident 30-min cap (one task ran 125 min). |
| v2 | `deepseek_deepseek-v4-flash-0731-0913_results` | 2026-09-14 | Approximately main as of 2026-09-13 (no commit stamp is stored; the state is inferred from the result fields present and the dates). Adds the 09-10 work (one-shot verification retry `8545a4b`, archaeology nudge `894f492`, hardened judge `cf07b51`, "verify against the full test file" prompt `d1a7371`) and the 09-13 environment fixes (Node 22 `59a8dcb`, ripgrep + apt retry `77dee9d`, extension-tool activation `70b0815`, `question` tools excluded `b9081a5`, fp4 pin removed `13b655d`). 30 min budget. |
| v2.1 | `deepseek_deepseek-v4-flash-0731-0916_results` | 2026-09-16 → 09-17 | v2 + the P0 correctness commit `07465e3` and `fd2b23f`: corrupt-`FAIL_TO_PASS` validation and `harness-error` scoring, `execFile` test invocation with scaled timeout, config-file edit guard, **git history scrub (orphan baseline, all other refs/tags deleted)**, 50%-of-budget time nudge. |

Constants: same model id, same 50 tasks, container-test-first scoring, judge `openrouter/google/gemini-3.1-pro-preview` in v2/v2.1 (v1 did not record its judge; it does not affect pass/fail because the container test is the scoring authority). All three runs are single attempts (`attempts` has length 1 everywhere; the `-attempt1` files are byte-identical duplicates).

Not held constant, and not separable from the data: the fp4 quantization pin was removed between v1 and v2, so v2/v2.1 may have been served by a different endpoint mix (the fraction of prompt tokens billed as uncached input fell from ~10% to ~3%, consistent with a different provider/caching path, but the artifacts do not record the serving provider). See recommendation R8.

## 1. Headline results

Wilson 95% intervals on the scored pass rate: v1 [56.2%, 80.9%], v2 [76.2%, 94.4%], v2.1 [83.2%, 97.9%]. With n ≈ 50 and a single run per version, only the v1 → v2 step is statistically distinguishable.

| Paired comparison | FAIL→PASS | PASS→FAIL | Exact McNemar p |
|---|---|---|---|
| v1 → v2 | 11 | 2 | 0.022 |
| v2 → v2.1 | 2 | 1 | 1.000 |

Transition table (status in v1 / v2 / v2.1): `PASS/PASS/PASS` 32 tasks; `FAIL/PASS/PASS` 11; `FAIL/FAIL/EXCL` 2; `FAIL/FAIL/FAIL` 1 (sphinx-9229); the remaining 4 are one each of `FAIL/FAIL/PASS` (11885), `PASS/FAIL/PASS` (10323), `PASS/FAIL/FAIL` (11510), `PASS/PASS/FAIL` (7985).

Per-repo: django 18/25 → 23/25 → 24/24 scored; sphinx 17/25 → 21/25 → 21/24 scored.

## 2. Where the v1 → v2 gain came from

The verification retry (`buildVerificationRetryPrompt`) runs only when the first real test run fails, so `verificationRetries = 1` plus a final PASS is direct evidence of a rescue.

| | v1 | v2 | v2.1 |
|---|---|---|---|
| Tasks that needed the retry | n/a | 9 | 7 |
| Rescued (retry → final PASS) | n/a | **7** | **4** |
| First-try passes / 50 | 35 (70%) | 37 (74%) | 41 (82%) |

- v2 rescues: django-11790, 11815, 11848, 12273, 12774; sphinx-7590, 8638. v2.1 rescues: django-11790, 11848, 12325; sphinx-10673.
- Without the retry, v2 would have scored 37/50 = 74%, only +4 pp over v1. The other ~14 pp is the feedback loop, not a better first attempt.
- Churn shows the noise floor. Three of v2's seven rescues (11790, 11815, 8638) were first-try passes in v1. Between v2 and v2.1, **10 of 50 tasks changed first-try status** (3 lost: 12325, 10673, 7985; 7 gained: 11815, 11885, 12273, 12774, 10323, 7590, 8638) for a net change of only +4, with the same model and largely the same prompt. Net differences of a few tasks between single runs are not evidence of improvement.
- Task-specific fixes that are unambiguous:
  - **sphinx-9320:** 45 min / 0 source edits in v1 (chased the upstream fix commit and `v4.1.0…v8.1.3` tags) → 4 min in v2 and v2.1. In v2 the agent ran no git-history commands at all this time, so this one is variance; in v2.1 it could not have chased them (scrubbed).
  - **sphinx-8035:** 125 min in v1 → 17 min → 10 min.
  - **django-11848:** the v1 "judge vs frozen test" trap (agent used a `utcnow()`-relative window, frozen test expects 1971) is solved in both later runs, each time via the retry.
- **Config pollution disappeared with baseline hygiene, not with the config guard.** In v1 every one of the 25 sphinx diffs contained `tox.ini` (20 also `setup.py`). In v2 and v2.1 it is 0 of 50, even though `config-guard.ts` only landed in v2.1. This is consistent with `13d1975` (baseline diff hygiene, 2026-08-30, which landed around the time of the v1 run); the artifacts carry no commit stamp to confirm it. `improvement-plan.md` had attributed dead-venture dependency-pin edits (9320, 8548) partly to this noise.

## 3. What v2.1 changed (v2 → v2.1)

| Signal | v2 | v2.1 | Reading |
|---|---|---|---|
| Archaeology nudges (tasks / total) | 14 / 22 | 0 / 0 | Scrub removed the trigger. |
| Git-history bash commands | 102 in 28 tasks | 35 in 28 tasks | Agents still look (`git log --oneline -5`), and now see one `benchmark-baseline` commit. |
| Empty diffs | 2 (10323, 9229) | 0 | See §6.2 (nudge-abort bug). |
| Sessions whose last turn is `error`/`aborted` | 9 (5 timeouts + 4 archaeology-budget exhaustions) | 1 (timeout, 7985) | All `The operation was aborted`. |
| `timedOut` | 5 | 1 | |
| Tasks with wall-clock ≥ 28 min | 6 | 1 | v2 retries ran on the same 30-min timer and were squeezed. |
| Time-budget nudge fired | n/a | 9 tasks | 8 of 9 then finished within about 3 min (15.6–18.1 min); 6 of those 8 pass, 1 is the excluded 12209, 1 fails (9229). The 9th (sphinx-7985) timed out at 30 min. No control group, so consistent with the nudge working, not proof. |
| Harness-error exclusions | 0 (both scored as fails) | 2 (12209, 8265) | Correct. But the agent still ran 17.7 and 4.2 min on them (§6.5). |

Time and cost:

| | v1 | v2 | v2.1 |
|---|---|---|---|
| Wall-clock total / mean / median (min) | 652 / 13.0 / 8.2 | 533 / 10.7 / 8.1 | 425 / 8.5 / 7.4 |
| Mean time, passes vs fails (min) | 11.8 / 16.0 | 10.4 / 12.5 | 7.6 / 20.1 |
| Cost (all agent messages) / per solved task | $2.35 / $0.067 | $2.20 / $0.050 | $1.99 / $0.044 |
| Output tokens | 1.31 M | 1.45 M | 1.42 M |
| Tool calls (mean per task) | 60 | 60 | 61 |

Wall-clock is the transcript span (first to last message), not `durationMs`, because `durationMs` excludes the retry phase (§6.6). Cost is the harness-recorded per-message cost of the agent model only (no judge). One v2.1 transcript (sphinx-9461) was context-compacted, so its span and counts are lower bounds. No other transcript in any run was.

Tool mix (all runs are overwhelmingly `bash`):

| | v1 | v2 | v2.1 |
|---|---|---|---|
| `bash` : `run_test` calls | 2095 : 66 (32:1) | 1911 : 94 (20:1) | 1892 : 105 (18:1) |
| Tasks that used `run_test` at all | 15 / 50 | 23 / 50 | 27 / 50 |
| `grep` + `find` tool calls | 0 | 104 | 114 |

The `grep`/`find` tools first appear in v2, which coincides with ripgrep being installed in the containers (`77dee9d`). The agent still prefers ad-hoc `bash` over the dedicated test tool by about 18 to 1 (open item 8 of `plans/2026-09-12-harness-improvements-round-2.md`; the numbers above were derived by hand from transcripts).

Loops: `loopRecoveries` is 1 (v2) and 0 (v2.1). No tool-call looping, in line with `debug/analysis_report.md`'s finding that the fp4 OpenRouter configuration does not loop.

## 4. Every task that was not PASS in all three runs

| Task | v1 / v2 / v2.1 | What the evidence shows |
|---|---|---|
| django-12209 | F / F / EXCL | Corrupt `FAIL_TO_PASS` (a docstring). Unwinnable in v1 and v2. Correctly excluded in v2.1. |
| sphinx-8265 | F / F / EXCL | Truncated pytest node id. Same. |
| sphinx-9229 | F / F / F | Fails with `No module named 'target'` in all three runs. The v2.1 judge rates the diff "virtually identical" to the reference. The stored `testPatch` adds `test_class_alias_having_doccomment(app)` with no `@pytest.mark.sphinx(…, testroot='ext-autodoc')` marker, so it runs against the default `root` testroot. **Probable dataset/harness defect, unverified.** |
| sphinx-11510 | P / F / F | Harness bug (§6.3). Judge: code "exactly matches the known correct solution". |
| sphinx-7985 | P / P / F | The judge reads the v2.1 diff as introducing a bug: `path = unquote(link.path)` shadows the `path` module, so `path.isfile(path.join(...))` would raise. The container run itself produced no test result (it stalled in `test_defaults` until the command failed), consistent with the ~300 s network stall the agent described, and the session hit the 30 min timeout. So the cause is not cleanly separable between a real bug and a network-dependent test. |
| django-11885 | F / F(T) / P | Too-broad queryset merging breaks `test_large_delete` batching. v2 timed out at 28 min. v2.1 passed at 17 min after the budget nudge. |
| sphinx-10323 | P / F / P | v2 failure is the nudge-abort bug (§6.2), not model skill. |
| django-11848 | F / P / P | Fixed via the retry in both later runs. |
| django-12273, 12774 | F / P / P | v2 rescued by retry. v2.1 first-try passes. |
| django-12325 | F / P / P | v2 first-try pass. v2.1 rescued by retry. |
| sphinx-7590, 10673 | F / P / P | 7590 rescued by retry in v2. 10673 rescued in v2.1. |
| django-12308, sphinx-8056 | F / P / P | No nudge and no retry in v2 or v2.1. Passes first try in both later runs; no harness event explains the flip, so most likely sampling variance. |
| sphinx-10435 | F / P / P | v1 lost to a byte-different-but-equivalent output vs the frozen test. Passes in v2 (one archaeology nudge) and v2.1 (nothing). In v2.1 it read upstream `v5.0.0`/`v5.0.1`/`v5.3.0` source, tests and CHANGES from `raw.githubusercontent.com` (§6.1). |
| sphinx-8548, 9320 | F / P / P | v1 lost to git archaeology and env noise. Solved in v2 and v2.1. |

The 32 `PASS/PASS/PASS` tasks are the stable core.

**Judge as a harness-bug detector.** In v2.1 the only two scored tasks where the LLM judge and the container test disagree (11510 and 9229, both judge = 1, exit = 1) are exactly the two tasks with suspected harness/data defects. In v2 the disagreements were 11510, 8265 (corrupt data) and sphinx-8035 (judge 0, container pass: a plain judge error). A "judge says correct but test says fail" alarm is a cheap way to triage future runs. Judge robustness itself is fine: `judgeAttempts = 1` and `judgeParseFailed = false` for all 100 v2/v2.1 results.

## 5. Sensitivity of the v2.1 headline

Measured: 45/48 = 93.8% (90.0% if the two exclusions counted as fails). If 11510 is counted as the harness false-fail it appears to be, 46/48 = 95.8%. If 9229 is also a dataset defect, 47/48 = 97.9%. These are upper bounds to be confirmed by rerunning after fixes, not claims.

## 6. Harness and data defects found

### 6.1 Open network egress lets the agent fetch the upstream fix (all three runs)

The v2.1 git scrub removes future commits and tags from the container's history. It does not stop the agent from downloading them. The containers have working internet access: `pip download`, `curl`, and `urllib` succeed against PyPI, `raw.githubusercontent.com`, and `api.github.com`. `excludeTools` removes `web_search` and `web_fetch`, but `bash` bypasses that.

| | v1 | v2 | v2.1 |
|---|---|---|---|
| Tasks with a **confirmed successful** upstream fetch (saved download or JSON hit in the tool result). **Lower bound** | ≥ 10 / 50 | ≥ 10 / 50 | ≥ 9 / 50 |
| Pass rate among those tasks / among the rest | 9/10 / 26/40 | 9/10 / 35/40 | 7/9 / 38/41 |
| `pip download` commands issued | 18 | 25 | 35 |

- The agent's intent is to get a later release to diff against. Typical commands: `pip download django==3.2.25 --no-deps`, `pip download sphinx==5.0.0 --no-deps --no-binary :all:`, `curl -o django.tar.gz https://files.pythonhosted.org/…`, `urlopen('https://raw.githubusercontent.com/sphinx-doc/sphinx/v5.0.1/sphinx/writers/latex.py')`, `api.github.com/search/issues?q=repo:…`. A failed attempt is also common (for example, `django==4.2` is not installable on the container's old Python, so it retries with `3.2.25`).
- **Concrete case (verified):** v2 `django__django-11815` (msg 45) downloaded `Django-3.2.25-py3-none-any.whl`, extracted `EnumSerializer` from it, and printed the upstream implementation (`'%s.%s[%r]' % (module, enum_class.__qualname__, self.value.name)`). Its submitted diff is the same change (`'%s.%s[%r]' % (module, enum_class.__name__, self.value.name)`).
- The counts are lower bounds: the classifier recognises saved downloads and JSON API hits, not plain-text bodies. For example, v2.1 `sphinx-10435` read upstream `v5.0.1` `latex.py`, `tests/test_build_latex.py` and `CHANGES` through `urllib` (11 successful `raw.githubusercontent.com` reads) and is not in the 9.
- The scrub did not reduce fetching (≥10 → ≥10 → ≥9 tasks; `pip download` commands went *up*). The same tasks recur across runs (sphinx-7748, 9230, 9461, django-12325, …), so this is a standing behaviour, not a consequence of v2.1.
- The pass rates above are descriptive only (and computed over the lower-bound set). Agents may fetch when a task is hard, which confounds any causal reading, and I did not audit each of the ~29 counted fetch cases for how much of the downloaded code was reused.
- **What this means:** absolute pass rates in all three runs are inflated by an unknown amount, and the git scrub's purpose ("the agent can no longer see the answer") is only half-achieved. The relative v1 → v2 → v2.1 comparison is less affected because the fetch rate is about constant.

### 6.2 Archaeology-nudge budget exhaustion aborts the run (v2, latent in v2.1)

In `runPromptWithLoopDetection` the archaeology detector calls `session.abort()`. When `archaeologyNudgesUsed >= maxArchaeologyNudges` the handler logs "letting normal flow continue" and `break`s. But the session was just aborted, so nothing continues: the run ends with whatever diff exists.

Evidence: sphinx-10323 and sphinx-9229 in v2 both received two `SYSTEM WARNING … git history` user messages, went back to git-history commands (`git show v8.1.3:…`, `git log --all --grep=…`), and ended with a final assistant turn of `stopReason: error / "The operation was aborted."`, zero output tokens, and an empty diff. Two more tasks (django-12209, sphinx-8265, both unwinnable anyway) ended the same way. 10323 passed in v1 and v2.1. v2.1 does not hit this only because the scrub eliminated the trigger. The other abort-based branches (loop guard, config guard, budget nudge) re-prompt rather than `break`, but are worth auditing for the same end state.

### 6.3 Staged agent-created test fixtures collide with the official test patch (11510)

`getDiff()` runs `git add .`, which stages any new files the agent wrote under `tests/`. `revertAgentTestModifications` then runs `git checkout HEAD -- tests/` and `git clean -fd tests/`. Neither removes a file that is in the index but not in HEAD. `git apply swe_test.patch` fails ("already exists"), the code falls back to `git apply --3way`, and the result is an add/add conflict with `<<<<<<< ours` markers written into `tests/roots/test-directive-include/conf.py`. pytest then dies with `SyntaxError` at fixture setup.

Reproduced end to end in a scratch repo (status `AA tests/conf.py`, conflict markers in the file). The same scratch repo confirmed that unstaging first makes the official patch apply cleanly. Suggested change (harness code was not modified by this report). Keep it per-directory, since the existing code comments warn that a multi-pathspec `git checkout` aborts if any pathspec does not match:

```ts
for (const testDir of ['tests/', 'test/', 'testing/']) {
  try {
    await execAsync(`git reset -q HEAD -- ${testDir}`, { cwd: tmpDir });   // new: unstage agent-added files
    await execAsync(`git checkout -- ${testDir}`, { cwd: tmpDir });
  } catch { /* directory doesn't exist in this repo */ }
}
await execAsync(`git clean -fd tests/ test/ testing/ 2>/dev/null || true`, { cwd: tmpDir });
```

This is likely to hit any task where the agent writes a fixture the upstream test patch also adds.

### 6.4 Likely third corrupt dataset entry: sphinx-9229

See §4. The existing import validator (`src/task-validation.ts`) checks id shape only. It cannot catch a test patch that is syntactically fine but semantically unrunnable.

### 6.5 `harness-error` tasks still burn the agent budget

django-12209 ran 17.7 min (with a time-budget nudge) and sphinx-8265 4.2 min in v2.1 before being excluded from scoring. The exclusion is known before the agent starts (`dataQuality: "corrupt-failToPass"`).

### 6.6 Reporting bugs

- **`summary.json` double-counts.** `run-swe-bench.sh` aggregates with `glob('results-*.json')`, which also matches `results-<task>-attempt1.json`, so each task is counted twice. v2.1's summary says `totalTasks: 100, harnessErrorTasks: 4, passedTasks: 90` for 50 tasks. The rate (0.9375) is right only because both numerator and denominator double. `totalDurationMs` and `averageDurationMs` are doubled or skewed too. The dashboard generator (`scripts/generate-report.ts`) skips `-attempt` files and is not affected.
- **`durationMs` excludes the retry phase.** `const duration = Date.now() - start` runs before the verification retry, so 16 retried tasks (9 in v2, 7 in v2.1) show a shorter duration than their transcripts (v2 total 474 min recorded vs 533 min by transcript span). The retry also shares the original 30-min timer, so a retried task can `timedOut` at, e.g., 18 min recorded duration (v2 django-12273).
- **The pre-retry test result is not stored.** "First-try pass" above is inferred from `verificationRetries` and the final score. It would be exact if the first `testExitCode` were saved.

## 7. Recommendations

Ordered by expected value per unit of work.

| # | Change | Why / expected effect |
|---|---|---|
| R1 | **Close container network egress** (allowlist only the LLM API host, e.g. via a proxy or an internal Docker network), and add an egress self-test to the run script. Re-run the ~10 tasks that fetched upstream code to measure the inflation. | The git scrub is only half-effective while `pip download django==3.2.25` works (§6.1). Every absolute number in this report is affected until fixed. |
| R2 | Unstage before checkout in `revertAgentTestModifications` (§6.3). Add a regression test using the scratch-repo sequence. | Recovers 11510 (about +2 pp) and prevents the whole class. |
| R3 | On archaeology-budget exhaustion, send a plain "stop investigating; implement now" prompt instead of `break` after abort. Add a test that a budget-exhausted nudge still leaves the agent a turn. | Removes a silent run-terminating path (cost 10323 in v2). |
| R4 | Report **first-try** and **with-retry** pass rates as separate columns; store `preRetryTestExitCode` per task; label v2+ scores as "with acceptance feedback". | v2/v2.1 are not comparable to v1 or to other benchmarks otherwise. This is the largest single methodological issue. |
| R5 | Add a **gold-patch dry run** to the importer/CI: apply the reference `patch` in the container, run `FAIL_TO_PASS`, require exit 0. | Would have caught 12209, 8265 and, if it is a defect, 9229 automatically. Replaces shape-only validation. |
| R6 | Skip the agent run when `dataQuality` is corrupt. | Saves ~22 min and cost per run, removes noise (§6.5). |
| R7 | Fix the summary aggregation to exclude `-attempt` files (one glob change) and record wall-clock including the retry phase. | Correct `totalTasks`/`passedTasks`/durations (§6.6). |
| R8 | Record the serving provider and quantization per request (OpenRouter returns it), and decide deliberately between pinning and not pinning. | The fp4 pin was removed between v1 and v2, so endpoint changes are confounded with harness changes. |
| R9 | Repeat each version ≥3 times, or at least re-run the ~18 unstable tasks. | 10 of 50 tasks changed first-try status between v2 and v2.1 (§2). Differences of 1-3 tasks (all of v2 → v2.1) cannot be claimed. |
| R10 | Give the verification retry its own time allowance (or nudge on total budget). | v2 had 6 tasks at ≥28 min because the retry shared the timer. |
| R11 | Add per-tool call counts to the result JSON (round-2 plan Task 8). | Makes the `bash:run_test` trend (32:1 → 18:1) a first-class metric instead of a transcript re-parse. |

## Limitations

- One run per version, n = 50, no seeds: sampling noise is the same size as most v2 → v2.1 differences.
- v2 bundles two groups of changes (09-10 agent-behaviour work and 09-13 environment/provider fixes), and v1 has no commit stamp, so v1 → v2 cannot be decomposed beyond the retry evidence in §2.
- "Rescued by the retry" is exact (the retry only runs after a failing test run). "Attributable to variance" is an inference from the absence of any relevant harness event in that task's metadata, not a measured cause.
- Cost is the harness-recorded estimate for the agent model only, and provider routing changed between v1 and v2.
- One further result directory exists, `deepseek_deepseek-v4-flash-0913_results`, for a different model id (`deepseek/deepseek-v4-flash`, not `-0731`). It is out of scope here.
- Network-fetch detection (§6.1) is based on the tool results of `bash` commands. It confirms a download or response arrived; it does not measure how much of it the agent reused, and it cannot see fetches made through other tools.
- The Node/pi-agent versions inside the containers are not recorded in the result files.

## Reproduce

```bash
python3 scripts/analyze-runs.py --base benchmark_results/macos-openrouter \
  v1=deepseek_deepseek-v4-flash-0731_results \
  v2=deepseek_deepseek-v4-flash-0731-0913_results \
  v2.1=deepseek_deepseek-v4-flash-0731-0916_results
```

The script de-duplicates `summary.json` by task, computes wall-clock from transcript timestamps, and prints the per-run metrics, paired transitions, McNemar p-values, and the per-task table (flags: `T` timed out, `V` verification retry, `A<n>` archaeology nudges, `B` time-budget nudge).
