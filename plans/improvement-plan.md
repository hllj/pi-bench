# pi-bench + pi-coding-agent improvement plan
*Source: review of `benchmark_results/macos-openrouter/deepseek_deepseek-v4-flash-0731_results` (50 tasks, SWE-bench Verified-mini subset, `deepseek/deepseek-v4-flash-0731` fp4 via OpenRouter, ~Aug 29–30 2025).*

---

## 1. Headline numbers

| Metric | Value |
|---|---|
| Tasks | 50 (25 django, 25 sphinx) |
| Pass | 35 (70%) — django 18/25 (72%), sphinx 17/25 (68%) |
| Fail | 15 (11 model-caused, 2 harness/data-corruption false fails, 2 judge-vs-frozen-test mismatches) |
| Avg duration, passed | 11.9 min |
| Avg duration, failed | 16.1 min (longest fail: 45 min `sphinx-9320`) |
| Outlier | `sphinx-8035` passed at **125 min** |
| Tool-loop recoveries | 0 (fp4/OpenRouter; cf. the ds4-hip quants study in `debug/analysis_report.md`) |

Every failed result carries `judgeScore=0`, decided by the SWE-bench container test (ground-truth-first). `judgeScoreOriginal=1` on three of them (11848, 12209, 10435) — i.e. the judge believed the fix was correct; the container test disagreed. Two of those three are harness/data failures, not model failures.

---

## 2. Fail-case inventory (15)

### A. Harness / data-corruption false-fails (2) — fix first, they deflate the real score

| Task | Symptom | Root cause |
|---|---|---|
| `django__django-12209` | `runtests.py --verbosity 2` with **empty module list** → full Django suite → killed at the 300 s `exec` timeout → exit 1. Judge judged the fix **correct** (orig=1). | Task JSON `failToPass` is corrupt: `["partial(func, *args, **keywords) - new function with partial application"]` — a **test docstring**, not a test id. `buildSweTestCommand` regex extracts no module → `modules.join(" ")` is empty. |
| `sphinx-doc__sphinx-8265` | pytest `ERROR: not found: ...test_unparse[(1,` → exit 4. Test never ran. | Task JSON `failToPass` is a **truncated** parametrized node id: `"tests/test_pycode_ast.py::test_unparse[(1,"` (cut at the comma). Node id doesn't exist. |

Both stem from the verified-mini **import** step (`scripts/import-swe-mini.ts` / `download-swe-mini.sh`), not the runner. Params like `test_unparse[(1, 'a')]` are being clipped and a docstring found its way into `failToPass`.

**Scroll fix:** validate/normalize `failToPass` at import (pytest ids must contain `::` and balanced parens; django ids must match `^test_\w+ \([\w.]+\)$`), regenerate the dataset, and add a **run-time guard**: a malformed/unparseable failToPass (empty module list / nonexistent node) must abort scoring with `scoreSource: "harness-error"` and exclude the task from pass-rate, never run the whole suite.

### C. Judge-vs-frozen-test mismatches (2) — scoring philosophy judgment, model was arguably “right”

| # | What happened |
|---|---|
| `django__django-11848` | Agent implemented RFC 7231 year mapping with a **time-dependent window** (`utcnow()` ± 50 y) and added a *dynamic* test (passes on any date). The repo's frozen `test_parsing_rfc850` (hardcoded 1971) then fails in 2025: agent's impl gives 2071. Judge **incorrectly certified algebraic equivalence** with the reference. This is the classic time-dependent-logic trap; the ground-truth test was right, the judge was wrong. |
| `sphinx-doc__sphinx-10435` | Agent produced semantically-equivalent output but **byte-different** (whitespace strip vs the reference's `%`-comment trick); the frozen test asserts the exact reference bytes → fails. Agent also rewrote the test to its own output (harness reverts that — good). Judge judged fix correct (or `1`). |

Conclusion for the judge: on pass/fail disagreements, prefer the container test (already the rule), but the rationale must cite the **failing assertion**, and `--judge`-model should be stronger than the agent model when the budget allows (the model grading its own output was warned about and used anyway).

### D. Genuine model failures (11) — where the agent quality lever lives

**Too-broad / doesn't respect MINIMAL change / regresses neighbors (4):**
- `django-11885` — over-aggressive queryset-combination breaks `test_large_delete(_related)` query-count expectations AND ignores SQL-placeholder limits.
- `django-12273` — `_save_parents` change breaks multi-table inheritance with `UNIQUE constraint failed`.
- `django-12774` — removes the uniqueness check entirely instead of narrowing to `UniqueConstraint`-covered fields; `in_bulk` on non-unique fields no longer raises.
- `sphinx-8056` — ignores `napoleon_use_param`; always splits field lists.

**Incomplete / near-miss (3):**
- `django-12308` — JSON display handles list/dict but **misses str** (`'a'` vs `"a"`); one edge case from correct.
- `django-12325` — keeps the stale `ImproperlyConfigured` path; doesn't restrict to `parent_link=True` fields.
- `sphinx-9229` — partial: `get_doc` returns `[]` instead of `[comment]` + ran the wrong test root (`root` vs `ext-autodoc`).

**Wrong-approach (1):**
- `sphinx-10673` — rewrites toctree entries at parse time, breaking the authored toctree AST contract (`test_toctree_index` fails).

**Hard domain miss (1):**
- `sphinx-7590` — C++ user-defined literals: appended the suffix instead of the required `ASTUserDefinedLiteral` + ID-mangling; also touched `setup.py`/`tox.ini` + test.

**Off-task / scope drift (2):**
- `sphinx-9320` — **45 min, zero source-code edits** (diff = setup.py + tox.ini only). Transcript shows it discovering the **actual upstream fix commit in the container's git history** (`81049ded "Make quickstart exit without reprompting"`), chasing tags `v4.1.0…v8.1.3`, and eventually editing dependency pins in confusion.
- `sphinx-8548` — partial autodoc change + **dependency-pin edits in setup.py** (dead venture), diff noise in CHANGES.

---

## 3. Cross-cutting findings (harness / setup / model)

1. **Git history penetration is a real harness hole.** SWE-bench images ship the *full* repo history — including future commits and tags (base Sphinx 4.1 with a history containing the fix commit and tags to v8.x). The agent that decides to archaeology-reads `git log`, finds the "answer" as a future commit **invented after the baseline**, then gets stuck porting it backward across version drift (9320, 8548). The existing prompt line "Don't waste time on git archaeology" demonstrably doesn't hold. Fix: scrub history (grafted/`--deep` baseline, drop refs/tags past the base), or add a targeted tool-level interceptor on `git log/show/merge`.

2. **setup.py/tox.ini pollution is endemic in Sphinx**: 8/15 fails touch `setup.py` and/or `tox.ini` (10435, 10673, 7590, 8056, 8265, 8548, 9229, 9320). The image ships these already dirty (dev-state differs from git), so the agent misreads env noise as "dependency version" (the dead-venture). The harness *already* commits a clean `benchmark-baseline` and re-prompts when the diff is **100% config-only**, but:
    - the re-prompt only runs *at the very end* (time budget already spent — 9320 with 45 m),
    - it **doesn't backfix** when the diff mixes config + source (7/8 pollution cases),
    - it can't stop the behavior (terminal diff shows it happened).
3. **Test-run surface / timeout issues:**
   - Django path runs an empty `runtests.py` = full suite → 300 s fixed `exec` timeout, `exit 1` (12209). No F2P isolation.
   - Sphinx `pytest <node-id>` isn't safe for parameterized ids (commas/parens/quotes).
   - A hard 300 s cap per test call regardless of F2P count; full-suite runs get the same cap.
   - No explicit failToPass validation before running.
4. **Judge over-credits** on 3 results (`judgeScoreOriginal=1` on 11848, 12209, 10435): includes one time-dependency trap where the judge's own algebra was wrong. Ground-truth-first ordering is correct; the judge only explains. Cost to use a much stronger `--judge-model` is trivial per task.
5. **Extensions do run inside the containers** (mounted read-only, per commit `f9e5d` etc.) and were **used actively**: `todo`/`note` in nearly every (transcripts, `lsp_diagnostics`, `run_test`, `capture`). Raw `bash` still dominates (45–100 calls/fail) over `run_test` (1–9) — the model defaults to `bash` + pipes despite the capture-once guidance. `lsp_diagnostics` output in-container degraded ("auxiliary coverage INCOMPLETE — ast-grep/11 did not answer", no node binary), so its "confirmed clean" verdict is weaker than on-host and adds a roundtrip.
6. **No timeouts/loop stats recorded**: `results-*.json`/`summary.json` for this run carry no `timedOut`/`loopRecoveries`/`agentModel`/`judgeModel`/`timeoutMin` (the README says they should) — reproducibility gap.

---

## 4. Improvement plan (by priority)

### P0 — Harness correctness (pi-bench; unblocks ~2–3 points, no model work)

1. **Fix the verified-mini import** (`scripts/import-swe-mini.ts`): normalize `failToPass` per-repo (django `test (mod.Class)` / sphinx `path::node[param]`), reject truncated ids, refuse docstring-shaped entries; re-import; regenerate `tasks/verified-mini/`.
2. **Run-time guard in `buildSweTestCommand` + scoring**: if module list or node list ends up empty/invalid → abort test, mark `scoreSource: "harness-error"`, exclude from pass-rate with a loud warning (do not silently run the full suite).
3. **Safe test invocation**: sphinx: write node ids to a file and use `pytest --collect-only`-validated ids, or shell-quote via `execFile`-style arg array rather than string interpolation. django: only run extracted modules; add per-module `--verbosity` isolation; raise/scale the 300 s cap by (expected F2P count × e.g. 120 s) and add `-x` early fail when F2P fails.
4. **Config-file early-warning**: intercept `edit`/`write` on `{setup.py, setup.cfg, tox.ini, pyproject.toml, requirements.txt, *.cfg}` inside SWE containers and re-prompt *immediately* ("environment artifact; revert it; fix source code only"); extend the end-of-run check so it also warns when config files appear *alongside* source edits.
5. **Git history containment** (bigger win for sphinx): after checkout, scrub ahead-of-baseline history (`git checkout --orphan` + prune refs/tags beyond base, or `git replace` graft of the past), so `git log` can't present the future fix; if scrubbing is too invasive, add a `git log|git show|git merge-base` interceptor that injects "history may show the fix; port it against the BASELINE tree, not tags" once.
6. **Time budget awareness**: mid-run elapsed-check (e.g. at 50% penalty "You have X min left; implement the source fix now and verify only the F2P test"), and a hard per-task cap that reports `timedOut` and discards config-only diffs.

### P1 — pi-coding-agent config/setup (helps the model use its budget better)

7. **Strengthen the SWE-bench system prompt with the two biggest empiric hazards**:
   - "The repo's git history may contain the future fix; **do not port fixes from later commits/tags**; implement against baseline."
   - "setup.py/tox.ini ship pre-modified in this container; **never edit dependency pins** to 'fix' tests."
   - "When a test in the frozen suite fails on a 2-digit-year/date-sensitive check, **type the literal**, don't compute from the current date."
8. **Default `thinkingLevel`: keep `high`** (no degeneracy observed, open-router fp4 clean) but expose a bench profile that sets `minimal`+`timeout` for cost/time tradeoffs; measure both before changing the default.
9. **Tool set for the container**: keep `--exclude-tools web_search,web_fetch` (already the default); consider excluding `note`/`todo` noise or making notes optional in benchmark (they're useful for the model but each call is a round-trip); keep `lsp_diagnostics` but expect degraded auxiliary scanners.
10. **Judge**: default to a **stronger separate judge** when available (e.g. in local loop `gemini-3.1-pro` as used in `debug/analysis_report.md`); and strengthen the judge prompt with "if the container test failed, cite the *failing assertion* and whether the diff could have caused it".

### P2 — Extensions (evidence-based conclusions + tuning)

11. **bash-first habit**: `bash` outweighs `run_test` ~10:1; the model needs the *same* one-shot-test UX. Bonus that doubles as a harness feature: give `run_test` **(a)** per-test `timeout` wrapping (it already), **(b)** a `--node-id` shortcut that validates existence & times out — and market it in the in-container prompt ("prefer `run_test`, not raw `bash`, for pytest/django test runs").
12. **pi-lens in containers**: silence auxiliary-scanner "INCOMPLETE" noise when the scanner binaries missing (detect no node/opengrep/ast-grep) — currently a plausible mis-signal; convert to a one-line "scanner unavailable offline" note.
13. **Extend the bench harness's extensions gate**: `--exclude-tools` should accept `all-non-essential` preset (keep `todo run_test edit write bash read note`? experiment; measure round-trips vs score like we did for web_search?).
14. Add a **look at the harness's own 2 stuck tasks as extension telemetry**: record `loopRecoveries`, `timedOut`, per-tool call counts into `run-meta.json`/`summary.json` so future runs can measure the effect of each config change (fits the repo convention; currently missing).

---

## 5. What the data says about DeepSeek V4 Flash (fp4/OpenRouter)

- **Architecture-strength**: 70% on a hard filtered subset, zero tool-looping, produces tests + `todo`/`note`-driven progress on complex multi-file Python fixes (11815, 1199, 12050, 12304 passed).
- **Cracks**: (1) time-dependent logic vs frozen tests (11848), (2) byte-level output-matching against a gold diff (10435), (3) broad/over-minimal-change porosity on Django specifics/constraints (11885, 12774, 12273), (4) a hard algorithmic hole in C++ domain parsing (7590), (5) gravity toward git-history "future fix" exploration on sphinx (9320, 8548) — a harness hole (histoy) plus instructions-robustness issue.
- The **django vs sphinx delta (72 vs 68) is small** but the failure *shape* differs: django fails are correctness of constraint/edge semantics; sphinx fails are (a) byte-exact frozen tests and (b) env-файл- distraction.
- **Immediate upside without any model change**: fixing the two data bugs (+2), the two judge/byte-diff cases (+1 genuine?), config/no-history guardrails (protects ~1-2), budget nudges (helps 3 slow failures). A conservative 3-4% point lift to ~74-76% is realistic from harness alone; the rest is model skill (minimal diffs, C++).

---

### Files examined
- `benchmark_results/macos/openrouter/deepseek*_results/summary.json` + 50 `results-*.json` + selected `transcript-*.json` (9320, 7590, 85-48)
- `src/index.ts` (prompt, loops, config-only guard, `buildSweTestCommand`, judge, rescoring)
- `run-swe-bench.sh` (`~/.pi/agent` mounts, baseline commit, retries)
- `tasks/verified-mini/django__django-12209.json`, `sphinx-doc__sphinx-8265.json` (corrupt `failToPass`)
- `~/.pi/agent/settings.json`, `models.json`, `AGENTS.md` layering, `debug/analysis_report.md` (prior Q2/Q4 vs FP4 loop analysis)