# Pi-Bench

A lightweight, customizable benchmark runner for `pi-coding-agent`, inspired by `opencode-bench`.

## Overview
`pi-bench` automates the process of testing an AI coding agent against real-world tasks. It does this by:
1. Cloning a target repository to a temporary workspace (or using a pre-configured SWE-bench container).
2. Checking out a specific baseline commit, then committing a clean `benchmark-baseline` snapshot so any pre-existing dirty files in the image (e.g. `setup.py`/`tox.ini`) aren't later attributed to the agent's diff.
3. Spinning up `pi-coding-agent` in the workspace with a predefined task prompt. For containerized runs, this includes your real `~/.pi/agent` extensions, skills, prompts, and settings — see [pi-coding-agent Configuration](#pi-coding-agent-configuration-extensions-skills-settings) below.
4. Letting the agent use its tools (`read`, `bash`, `edit`, `write`, plus whatever your extensions register) to complete the task.
5. Capturing the generated patch (`git diff` against the baseline commit).
6. **Running the test suite** — either from a `testCommand` (curated tasks) or SWE-bench `FAIL_TO_PASS` tests (inside the container).
7. **Scoring**: for SWE-bench container tasks, the `FAIL_TO_PASS` test result is the ground truth score — a secondary LLM **Judge** runs alongside it but only explains *why*, it can no longer flip a test-decided score. For tasks without a container test (curated `testCommand` tasks, or tasks with none), the judge decides the score directly.

## Setup

First, install the required dependencies (using `bun` or `npm`). This installs `@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent` (the actively maintained fork of the original `@mariozechner/*` packages):
```bash
bun install
```

Then give the agent (and judge) something to authenticate with. You need at least one of:

- **A local inference server** (`llama.cpp`, `ds4`, or `vllm`) — no auth needed, just configure the endpoint in [models.json](models.json) and pass `--provider`. See [Local Providers](#local-providers-llamacpp-ds4-and-vllm) below.
- **A cloud provider API key** (OpenRouter, Anthropic, Google, etc.) — for local execution (`bun run src/index.ts` and the `run-swe-bench.sh` / `run-docker.sh` wrappers), credentials resolve through `pi-coding-agent`'s own credential store, in this order:
  1. Stored credentials in `~/.pi/agent/auth.json` — the same file `pi auth login` writes to. If you already use `pi` (the coding agent CLI) with a provider configured, `pi-bench` picks it up automatically, no extra setup required.
  2. Provider environment variables (e.g. `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`).
  3. A `.env` file in the project root (only consumed by `run-docker.sh` / `run-swe-bench.sh`, which pass it into the container — it is **not** read by `bun run src/index.ts` directly).

Verify everything is wired up with a trivial task before running a full suite:
```bash
bun run src/index.ts tasks/example-task.json \
  --provider openrouter --model deepseek/deepseek-v4-flash \
  --judge-model openrouter/deepseek/deepseek-v4-flash \
  --timeout 4
```
A `[INFO] Score: 1` at the end means the agent, judge, and model auth are all working end-to-end.

## pi-coding-agent Configuration (extensions, skills, settings)

`bun run src/index.ts` (local execution) and the `run-docker.sh` / `run-swe-bench.sh` container runners all use `pi-coding-agent`'s standard config discovery, which defaults to `~/.pi/agent`. Concretely:

- **`run-docker.sh` and `run-swe-bench.sh` mount your real `~/.pi/agent/{extensions,skills,prompts,agents,settings.json,AGENTS.md,npm}` into the container, read-only.** If `~/.pi/agent/extensions` is a symlink into a separate config repo (a common setup), the scripts detect that and mount the real target too, so the symlink resolves correctly inside the container. This means your custom tools, skills, prompt templates, and `settings.json` (including `defaultThinkingLevel`, `defaultModel`, etc.) apply the same way in a container as they do on your host.
- **`auth.json`, `sessions/`, and `models-store.json` are deliberately *not* mounted.** Model/judge credentials for containerized runs come from `.env` → environment variables (see [API Keys](#api-keys) above), not from your host's stored credentials. This also avoids a real failure mode: `pi-ai`'s credential store creates a short-lived lock file on every auth read, even for a provider resolved via env var — mounting `auth.json` read-only breaks that with `EROFS`.
- **npm-installed extension packages** (declared via `settings.json`'s `packages`, e.g. `npm:pi-lens`) are picked up from your host's `~/.pi/agent/npm` if already installed there — the containers don't have `npm` on `PATH`, so an extension that isn't already installed on your host can't be installed fresh inside the container.
- To run without any of your personal config (a "clean" agent, closer to what a fresh SWE-bench evaluation container would have on its own), just don't mount `~/.pi/agent` — you'd need to fork the scripts or comment out the `RESOURCE_MOUNTS`/`EXTENSIONS_MOUNT` lines, there's no flag for this yet.

## Defining Tasks

Benchmark tasks are defined as simple JSON files. See `tasks/curated/easy.json` for a reference:
```json
{
  "id": "curated-easy",
  "repo": "chalk/chalk",
  "commit": "v5.3.0",
  "prompt": "There is a typo in the README.md file in the `chalk` repository. Please find the typo 'colos' and fix it to 'colors'.",
  "expectedDiff": "diff --git a/README.md b/README.md\n...",
  "testCommand": "npm install && npm test"
}
```

*Note: `solutionCommit`, `expectedDiff`, and `testCommand` are optional. If `testCommand` is provided, the runner will execute it in the workspace after the agent completes and pass the result to the judge as a strong signal — but for these non-SWE-bench tasks the **judge still decides the final score**, it isn't auto-passed on a `0` exit code. Ground-truth, test-decided scoring (see [How SWE-bench evaluation works](#how-swe-bench-evaluation-works)) is specific to SWE-bench container tasks with `FAIL_TO_PASS` tests.*

## Included Datasets

`pi-bench` supports multiple datasets to evaluate the agent's performance.

### SWE-bench Verified Mini (Recommended)
A highly curated subset of 50 verified tasks from the SWE-bench dataset. This is the recommended dataset for rapid, high-quality evaluation as it tests a broad set of capabilities without taking days to run.

To download and import this dataset directly from HuggingFace, simply run:
```bash
./scripts/download-swe-mini.sh
```
This will automatically generate the 50 task files inside the `tasks/verified-mini/` directory.



---

## Running Benchmarks

### SWE-bench Tasks (Recommended)

SWE-bench tasks run inside **official SWE-bench Docker containers** from `ghcr.io/epoch-research/swe-bench.eval.x86_64.*`. Each task gets its own container with:
- The correct Python version (e.g. Python 3.6 for Django 3.1, Python 3.8+ for Sphinx)
- All dependencies pre-installed
- The repository checked out at the right commit in `/testbed`

This eliminates the environment mismatch problems that plague host-side execution.

#### Pre-pull containers (optional)
Download all 49 container images upfront (~2.4 GB download, ~6 GB on disk due to heavy layer sharing):
```bash
./scripts/pull-swe-containers.sh
```

#### Provider Setup & Execution

You can configure and use both local and cloud-based models as the backend engine for the `pi-coding-agent`.

##### Local Providers (`llama.cpp`, `ds4`, and `vllm`)
Local providers are configured in [models.json](file:///home/kyuz0/Documents/Projects/pi-bench/models.json) in the project root. By default:
- `llama.cpp` expects a local server running at `http://localhost:8080/v1`
- `ds4` and `vllm` expect a local server running at `http://localhost:8000/v1`

When using a local provider, you do not need to specify a model name via `--model`. `pi-bench` will automatically query the local provider's `/v1/models` endpoint to retrieve the active model name and format the results directory accordingly. Whatever model your local server is currently running will be used.


**Example: Running with `llama.cpp`**
```bash
./run-swe-bench.sh tasks/verified-mini/ \
  --provider llama.cpp \
  --judge-model google/gemini-3.1-pro-preview \
  --platform strix-halo \
  --rocm-version 7.2.4 \
  --timeout 45
```


**Example: Running with `ds4`**
```bash
./run-swe-bench.sh tasks/verified-mini/ \
  --provider ds4 \
  --judge-model google/gemini-3.1-pro-preview \
  --platform strix-halo \
  --rocm-version 7.2.4 \
  --timeout 45
```

**Example: Running with `vllm` and specifying a model**
If your vLLM instance hosts multiple models or you want to explicitly select a configuration from `models.json`, use the `--model` flag:
```bash
./run-swe-bench.sh tasks/verified-mini/ \
  --provider vllm \
  --model RedHatAI/Qwen3.6-27B-FP8 \
  --judge-model google/gemini-3.1-pro-preview \
  --platform dual-r9700 \
  --rocm-version 7.2.4 \
  --timeout 45
```

##### Cloud Providers (`openrouter`)
For cloud providers like OpenRouter, the provider endpoint is queried. Because these platforms host many models, you **must** specify which model to run using the `--model` flag.

**Example: Running with OpenRouter**
```bash
./run-swe-bench.sh tasks/verified-mini/django__django-11790.json \
  --provider openrouter \
  --model deepseek/deepseek-v4-flash \
  --judge-model google/gemini-3.1-pro-preview \
  --platform openrouter \
  --timeout 30
```

#### How SWE-bench evaluation works
Before the agent starts, the runner commits a `benchmark-baseline` snapshot in `/testbed` (using an inline git identity, no global config needed), so any pre-existing dirty files in the container image are excluded from the agent's diff — only what the agent actually changed shows up.

After the agent finishes editing code, the runner:
1. **Applies the test patch** from the SWE-bench dataset (adds the regression tests)
2. **Runs the `FAIL_TO_PASS` tests** inside the container using the correct Python and test runner
3. **Score is ground truth** — if the tests pass, `judgeScore = 1`; if they fail, `judgeScore = 0`. The judge can no longer override this.
4. **The LLM Judge** receives both the diff and the test results and provides a human-readable rationale explaining *why* the fix worked or didn't. Its raw verdict is preserved separately as `judgeModelScore` (useful for measuring judge/test agreement over time), even when it's overridden by the test result. The judge call is retried up to 3 times on unparseable output before falling back to the test result.
5. If the judge and agent are configured to the same model, the run logs a `[WARN] Judge model is the SAME as the agent model` notice — worth knowing, though it no longer affects the score for container tasks since the test decides it.

This combines the objectivity of SWE-bench's test-based evaluation with the explainability of an LLM judge. Each result JSON also records `scoreSource` (`"container-test"` | `"judge"` | `"judge-parse-failed"`), `judgeParseFailed`, `judgeAttempts`, `judgeModel`, `timedOut`, `loopRecoveries` (how many times the agent got stuck in a tool-call loop and had to be redirected), `verificationRetries` (`1` if the fix failed the real `FAIL_TO_PASS` tests and the agent was given its one corrective pass with the actual failure output, otherwise `0`), and `archaeologyNudges` (how many times the agent was nudged out of a git-history exploration streak with no file edits, capped at 2 per task) for later analysis.

### Curated Tasks (Docker sandbox)

For non-SWE-bench tasks (curated, custom), use the Docker runner:
```bash
./run-docker.sh tasks/curated/ \
  --provider llama.cpp \
  --judge-model google/gemini-3.1-pro-preview \
  --platform strix-halo \
  --timeout 30
```

### Local Execution (Use with Caution)
Running the benchmark locally executes the agent on your host machine.
```bash
bun run src/index.ts tasks/curated/easy.json
```

---

## CLI Reference

### Provider & Model Flags

| Flag | Description | Default |
|---|---|---|
| `--provider <name>` | Inference provider: `llama.cpp`, `ds4`, `vllm`, or `openrouter` | `llama.cpp` |
| `--model <model-id>` | Model ID within the provider (e.g. `deepseek/deepseek-v4-flash`) | Auto-detected |
| `--judge-model <provider/id>` | Judge model (e.g. `google/gemini-3.1-pro-preview`) | Same as agent |
| `--port <port>` | Override the local server port | `8080` (llama.cpp), `8000` (ds4, vllm) |
| `--engine <name>` | Backward-compatible alias for `--provider` | — |

**Local providers** (`llama.cpp`, `ds4`, `vllm`) auto-detect the model name by querying the local server's `/v1/models` endpoint. No `--model` needed unless you want to force a specific configuration from `models.json` or target a specific model on a multi-model server.

**Cloud providers** (`openrouter`) require `--model` to specify which model to use, since the provider may host many models.

**Backward compatibility**: `--model openrouter/deepseek/deepseek-v4-flash` (without `--provider`) still works — the provider is parsed from the first path segment.

### Other Flags

| Flag | Description | Default |
|---|---|---|
| `--platform <id>` | Save results to `benchmark_results/<platform>/` | — |
| `--model-tag <tag>` | Append a suffix to the results directory (e.g. `mtp`) | — |
| `--rocm-version <ver>`| ROCm version running the backend | `7.2.4` |
| `--context <tokens>` | Override model context window size for this run | From `models.json` |
| `--timeout <minutes>` | Agent timeout per task | `30` |
| `--pass <N>` | Number of attempts to make per task (retries on failure) | `1` |
| `--exclude-tools <list\|none>` | Comma-separated tool names to disable, or `none` to allow everything | `web_search,web_fetch` |

`--exclude-tools` defaults to disabling `web_search` and `web_fetch` (if your `~/.pi/agent` extensions register them) so the agent can't look up the real upstream fix online instead of solving the task — pass `--exclude-tools none` to allow all tools, or your own comma-separated list to disable a different set.

### Examples

```bash
# Local llama.cpp (auto-detects model from server)
./run-swe-bench.sh tasks/verified-mini/ \
  --judge-model google/gemini-3.1-pro-preview \
  --platform strix-halo \
  --rocm-version 7.2.4 \
  --timeout 45

# Local ds4 server on custom port
./run-swe-bench.sh tasks/verified-mini/ \
  --provider ds4 --port 9000 \
  --judge-model google/gemini-3.1-pro-preview \
  --platform strix-halo \
  --rocm-version 7.2.4 \
  --timeout 45

# Local vllm specifying an exact model ID
./run-swe-bench.sh tasks/verified-mini/ \
  --provider vllm --model cyankiwi/MiniMax-M2.7-AWQ-4bit \
  --judge-model google/gemini-3.1-pro-preview \
  --platform strix-halo \
  --rocm-version 7.2.4 \
  --timeout 45

# OpenRouter cloud
./run-swe-bench.sh tasks/verified-mini/ \
  --provider openrouter --model deepseek/deepseek-v4-flash \
  --judge-model google/gemini-3.1-pro-preview \
  --platform openrouter \
  --timeout 30

# Single task, backward-compat style
./run-swe-bench.sh tasks/verified-mini/django__django-11790.json \
  --model openrouter/deepseek/deepseek-v4-flash \
  --judge-model google/gemini-3.1-pro-preview \
  --platform openrouter \
  --timeout 30

# Override context window for a run (e.g. limit to 90k tokens)
./run-swe-bench.sh tasks/verified-mini/ \
  --provider vllm --model cyankiwi/MiniMax-M2.7-AWQ-4bit \
  --judge-model google/gemini-3.1-pro-preview \
  --platform strix-halo \
  --context 90000 \
  --timeout 45

# Run with 2 attempts per task (pass@2)
./run-swe-bench.sh tasks/verified-mini/ \
  --provider llama.cpp \
  --judge-model google/gemini-3.1-pro-preview \
  --platform strix-halo \
  --pass 2 \
  --timeout 45
```

---

## Configuring Models

If you need to configure custom API endpoints or model parameters (like max tokens or context windows), edit the `models.json` file in the project root.

### API Keys
Create a `.env` file in the root `pi-bench/` directory with your API keys:
```
GEMINI_API_KEY=...
OPENROUTER_API_KEY=...
```
Both `run-docker.sh` and `run-swe-bench.sh` automatically pass this file into the container.

---

## Results & Multi-Platform Dashboard

When a single run completes, it outputs a JSON artifact to the current directory (e.g. `results-curated-easy.json`).

When running a **batch** (providing a directory like `tasks/verified-mini/`), `pi-bench` automatically generates a uniquely named directory for the results based on the model (e.g., `Qwen3_6-35B-A3B-UD-Q8_K_XL_gguf_results/`). Re-running the same command later skips any task whose `results-<id>.json` already exists — use `--model-tag` to force a fresh, separately-tracked run instead of skipping.

Each `results-<id>.json` records, alongside the standard `diff`/`testOutput` fields: `judgeScore` (final), `judgeModelScore` (raw judge verdict, preserved even when overridden), `scoreSource`, `judgeParseFailed`, `judgeAttempts`, `judgeModel`, `timedOut`, `loopRecoveries`, `verificationRetries` (one corrective pass against the real acceptance tests was used), and `archaeologyNudges` (git-history streaks the agent was nudged out of) — see [How SWE-bench evaluation works](#how-swe-bench-evaluation-works). `run-meta.json` for a batch also records `agentModel`, `judgeModel`, `timeoutMin`, and `excludeTools`. Note that `summary.json` (the per-run aggregate) is generated separately by `run-swe-bench.sh`'s own aggregation step and by `bun run scripts/generate-report.ts` for the dashboard — the dashboard reads the individual `results-*.json` files directly, not `summary.json`.

### Rescoring Older Results
Result directories produced before ground-truth-first scoring can hold a `judgeScore` that disagrees with the container test the run actually recorded. `bun run scripts/rescore-results.ts <results-dir>` recomputes `judgeScore` for each `results-*.json` in that directory from its own stored `sweTestExitCode` (marking rescored files with `scoreSource: "container-test-rescore"`), updates `summary.json` if present, and prints the old and new pass rates. It re-reads existing files only — nothing is re-run.

### Populating the Dashboard
`pi-bench` includes a dynamic HTML dashboard that can track results across multiple hardware platforms. To get your results onto the dashboard:

1. **Create your platform metadata**: If it's a new platform, create a folder for it inside `benchmark_results/` and add a `platform.json` describing your hardware:
   ```bash
   mkdir -p benchmark_results/r9700
   ```
   *benchmark_results/r9700/platform.json*:
   ```json
   {
     "id": "r9700",
     "name": "Radeon 9700",
     "gpu": "Radeon 9700 16GB",
     "ram": "32GB DDR5"
   }
   ```
2. **Run your benchmark with the `--platform` flag**:
   ```bash
   ./run-swe-bench.sh tasks/verified-mini/ \
     --judge-model google/gemini-3.1-pro-preview \
     --platform r9700
   ```
   *This automatically routes the results folder (e.g. `Qwen3_6..._results`) right into `benchmark_results/r9700/`.*
   
3. **Generate the report**:
   This script parses all new results in `benchmark_results/` and compiles them into a single `docs/data.json` file. The frontend dashboard (`app.js`) requires this JSON file to display data.
   ```bash
   bun run scripts/generate-report.ts
   ```

4. **Serve the dashboard**:
   The dashboard is a static website. Serve the `docs/` folder, open your browser (e.g., `http://localhost:8082`), and the Vue frontend (`app.js`) will automatically load the updated `data.json`.
   ```bash
   python3 -m http.server 8082 -d docs/
   ```
