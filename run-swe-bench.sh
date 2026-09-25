#!/bin/bash
set -e

# Run pi-bench tasks inside official SWE-bench evaluation containers.
# Each task runs in its own container with the correct Python version and dependencies.
#
# Usage:
#   ./run-swe-bench.sh tasks/verified-mini/ --provider ds4 --judge-model google/gemini-3.1-pro-preview --platform strix-halo
#   ./run-swe-bench.sh tasks/verified-mini/django__django-12209.json --provider openrouter --model deepseek/deepseek-v4-flash
#
# The script:
#   1. Iterates over task files in the given directory (or runs a single task file)
#   2. For each task, launches the corresponding SWE-bench container
#   3. Installs bun + pi-bench deps inside the container (cached via Docker volume)
#   4. Mounts your ~/.pi/agent extensions/skills/prompts/settings.json read-only,
#      plus a staged copy of agents/ (see scripts/stage-agents.ts)
#      (see the RESOURCE_MOUNTS block below) -- auth.json/sessions/models-store.json
#      are NOT mounted, so model/judge credentials still come from .env
#   5. Commits a benchmark-baseline in /testbed before the agent runs, so the
#      agent's diff excludes pre-existing image noise (setup.py/tox.ini/etc.)
#   6. Runs the benchmark: agent works in /testbed, then FAIL_TO_PASS tests decide
#      the score (ground truth) -- the LLM judge only explains why
#   7. Results are written back to the host via the bind-mounted pi-bench directory
#   8. Removes that task's image afterward (the full set is 100GB+ on disk) --
#      pass --keep-images to keep them cached instead, for faster reruns

TARGET="${1:?Usage: ./run-swe-bench.sh <task-file-or-dir> [extra-args...]}"
shift

PASS_COUNT=1
KEEP_IMAGES=0
SEALED=1
EXTRA_ARGS=""
while [[ $# -gt 0 ]]; do
  case $1 in
    --pass)
      PASS_COUNT="$2"
      shift 2
      ;;
    --keep-images)
      KEEP_IMAGES=1
      shift
      ;;
    --unsealed)
      # Legacy mode: --network host + the whole repo bind-mounted read-write.
      # The agent can reach PyPI/GitHub and read tasks/*.json (which contain
      # the gold patch). Only for debugging the harness -- results from an
      # unsealed run are not comparable to sealed ones.
      SEALED=0
      shift
      ;;
    *)
      EXTRA_ARGS="$EXTRA_ARGS $1"
      shift
      ;;
  esac
done
REGISTRY="ghcr.io/epoch-research/swe-bench.eval.x86_64"
PI_BENCH_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Create persistent bun cache volume (shared across all container runs)
docker volume create pi-bench-bun-cache 2>/dev/null || true

# Mount only the specific ~/.pi/agent resources pi-coding-agent's resource
# loader discovers (extensions, skills, prompts, settings, context file, and
# already npm-installed extension packages), each read-only. Deliberately
# NOT the whole ~/.pi/agent directory: auth.json, sessions/, and
# models-store.json stay purely container-local -- the credential store
# needs to create a short-lived auth.json.lock directory even for reads that
# ultimately fall through to env vars, and a read-only mount of the whole
# tree breaks that with EROFS. Mounting npm/ read-only (rather than leaving
# it unmounted) matters too: settings.json can declare npm: extension
# sources (e.g. "npm:pi-lens"), and createAgentSession() tries to
# `npm install` any that aren't already present -- these containers don't
# have npm on PATH, so without this mount that install crashes the run.
AGENT_DIR="$HOME/.pi/agent"
RESOURCE_MOUNTS=""
for name in extensions skills prompts settings.json AGENTS.md npm; do
  if [ -e "$AGENT_DIR/$name" ]; then
    RESOURCE_MOUNTS="$RESOURCE_MOUNTS -v $AGENT_DIR/$name:/root/.pi/agent/$name:ro"
  fi
done

# Subagent definitions are mounted as a staged copy, not as-is: `model:`
# overrides dropped (children inherit the benchmarked model -- the sealed
# gateway forwards nothing else) and --exclude-tools applied to their `tools:`
# lists (the parent's exclusions don't reach child processes). Per-run dir so
# concurrent runs don't clobber each other. See src/subagent-support.ts.
STAGED_AGENTS_DIR=""
if [ -d "$AGENT_DIR/agents" ]; then
  STAGED_AGENTS_DIR="$PI_BENCH_DIR/.pi-bench-stage/agents-$$"
  trap 'rm -rf "$STAGED_AGENTS_DIR"' EXIT
  EXCLUDED_TOOLS=$(bun run src/index.ts --print-excluded-tools $EXTRA_ARGS 2>/dev/null || true)
  bun run scripts/stage-agents.ts "$AGENT_DIR/agents" "$STAGED_AGENTS_DIR" "$EXCLUDED_TOOLS"
  RESOURCE_MOUNTS="$RESOURCE_MOUNTS -v $STAGED_AGENTS_DIR:/root/.pi/agent/agents:ro"
fi

# ~/.pi/agent/extensions is commonly a symlink into a separate config repo
# (e.g. ~/pi-config). A bind mount doesn't rewrite symlink targets, so mount
# the real target at its identical absolute path too, or the symlink dangles
# inside the container.
EXTENSIONS_MOUNT=""
if [ -L "$AGENT_DIR/extensions" ]; then
  REAL_EXT_DIR="$(cd -P "$AGENT_DIR/extensions" 2>/dev/null && pwd)"
  if [ -n "$REAL_EXT_DIR" ] && [ "$REAL_EXT_DIR" != "$AGENT_DIR/extensions" ]; then
    EXTENSIONS_MOUNT="-v $REAL_EXT_DIR:$REAL_EXT_DIR:ro"
  fi
fi

# Collect env file args
ENV_ARGS=""
if [ -f "$PI_BENCH_DIR/.env" ]; then
  ENV_ARGS="--env-file $PI_BENCH_DIR/.env"
fi

# Collect task files
TASK_FILES=()
if [ -d "$TARGET" ]; then
  for f in "$TARGET"/*.json; do
    [ -f "$f" ] && TASK_FILES+=("$f")
  done
else
  TASK_FILES+=("$TARGET")
fi

if [ ${#TASK_FILES[@]} -eq 0 ]; then
  echo "[ERROR] No task JSON files found in $TARGET"
  exit 1
fi

TOTAL=${#TASK_FILES[@]}
COUNT=0
PASSED=0
FAILED=0

# Determine results directory on the host to check for cached results
RESULTS_DIR=$(bun run src/index.ts --print-output-dir "$TARGET" $EXTRA_ARGS 2>/dev/null || true)

echo "========================================================"
echo "[INFO] SWE-bench Runner — $TOTAL tasks queued"
if [ -n "$RESULTS_DIR" ]; then
  echo "[INFO] Results directory: $RESULTS_DIR"
fi
if [ "$SEALED" = "1" ]; then
  echo "[INFO] Sealed mode: no internet for the agent, task answers not mounted (pass --unsealed to disable)"
else
  echo "[WARN] UNSEALED mode: the agent can reach PyPI/GitHub and read tasks/*.json -- results are not trustworthy"
fi
echo "========================================================"

# ---------------------------------------------------------------------------
# Sealed mode.
#
# Why: agents with open network access were observed downloading the real
# upstream fix (`pip download sphinx==8.0.2 --no-binary :all:`, curl on
# raw.githubusercontent.com/<repo>/<later tag>/..., api.github.com issue/PR
# search) -- see src/egress.ts. And with the whole repo bind-mounted, every
# task's gold patch (tasks/*.json `expectedDiff`, swe-bench-verified-mini.json
# `patch`) was one `cat` away.
#
# How:
#   1. The task container joins an `--internal` docker network: no route out.
#   2. The only way out is the pi-bench-egress container (scripts/egress-proxy.ts):
#      - a forward proxy that allows just a LOCAL model server
#        (host.docker.internal:<port>, from --print-egress-allowlist), 403 for
#        everything else (pip/git/curl/python, any process or tool);
#      - a key-holding LLM gateway (src/gateway.ts) for REMOTE model APIs: the
#        container calls it with no key; it only forwards the benchmarked model,
#        rejects web-search features, and adds the real key. The agent
#        container gets NO .env and no API key at all.
#      Every decision is logged by that container (the agent can't touch it).
#   3. Only the harness code is mounted (read-only), plus the toolchain volume
#      (read-only). The task JSON is staged with expectedDiff stripped and
#      deleted by the harness before the agent starts.
#   4. The agent container's own results file is UNTRUSTED (the agent is root
#      there). Grading happens in a FRESH container from the task image with
#      `--network none` (src/grade.ts): only the agent's diff is applied, then
#      the hidden tests run. The judge runs on this host, and
#      scripts/finalize-sealed-result.ts writes the authoritative result.
#   5. Toolchain (bun, rg, fd, node_modules) is prepared ONCE up front with
#      network access, into the shared bun-cache volume.
# ---------------------------------------------------------------------------
SEALED_NETWORK="pi-bench-sealed"
EGRESS_CONTAINER="pi-bench-egress"
EGRESS_PROXY_URL="http://${EGRESS_CONTAINER}:3128"
STAGE_ROOT="$PI_BENCH_DIR/.pi-bench-stage"

if [ "$SEALED" = "1" ]; then
  if [ -z "$RESULTS_DIR" ]; then
    echo "[ERROR] Sealed mode needs the results directory up front, but 'src/index.ts --print-output-dir' failed."
    echo "        (For local providers the inference server must be reachable from this host.)"
    exit 1
  fi

  mkdir -p "$STAGE_ROOT"
  EGRESS_ALLOW="${PI_BENCH_EGRESS_ALLOW:-$(bun run src/index.ts --print-egress-allowlist $EXTRA_ARGS 2>/dev/null || true)}"
  # Holds the REAL API key: 0600, mounted read-only into the gateway container
  # only, deleted on exit.
  GATEWAY_CONFIG_FILE="$STAGE_ROOT/.gateway-config.json"
  if ! GATEWAY_SPEC=$(bun run src/index.ts --write-gateway-config "$GATEWAY_CONFIG_FILE" $EXTRA_ARGS 2>/dev/null); then
    echo "[ERROR] Could not configure the sealed LLM gateway (src/index.ts --write-gateway-config)."
    exit 1
  fi
  if [ -z "$EGRESS_ALLOW" ] && [ -z "$GATEWAY_SPEC" ]; then
    echo "[ERROR] Could not determine how the sealed container reaches the agent model."
    echo "        Set PI_BENCH_EGRESS_ALLOW=host:port[,host:port...] explicitly."
    exit 1
  fi
  # Fallback in case a client ignores NO_PROXY and sends the gateway request
  # to the forward proxy instead: let the proxy hand it to the gateway.
  if [ -n "$GATEWAY_SPEC" ]; then
    EGRESS_ALLOW="${EGRESS_ALLOW:+$EGRESS_ALLOW,}${EGRESS_CONTAINER}:8787"
  fi
  echo "[INFO] Egress allowlist: ${EGRESS_ALLOW:-(none)}"
  echo "[INFO] LLM gateway: ${GATEWAY_SPEC:-(none)}"

  docker network inspect "$SEALED_NETWORK" >/dev/null 2>&1 || docker network create --internal "$SEALED_NETWORK" >/dev/null

  docker rm -f "$EGRESS_CONTAINER" >/dev/null 2>&1 || true
  docker run -d --name "$EGRESS_CONTAINER" \
    --add-host host.docker.internal:host-gateway \
    -e EGRESS_ALLOW="$EGRESS_ALLOW" \
    -e GATEWAY_CONFIG=/gateway-config.json \
    -v "$GATEWAY_CONFIG_FILE:/gateway-config.json:ro" \
    -v "$PI_BENCH_DIR/src:/proxy/src:ro" \
    -v "$PI_BENCH_DIR/scripts:/proxy/scripts:ro" \
    -w /proxy \
    oven/bun:latest bun run scripts/egress-proxy.ts >/dev/null
  docker network connect "$SEALED_NETWORK" "$EGRESS_CONTAINER"
  trap 'docker rm -f "$EGRESS_CONTAINER" >/dev/null 2>&1 || true; rm -f "$GATEWAY_CONFIG_FILE"; [ -n "$STAGED_AGENTS_DIR" ] && rm -rf "$STAGED_AGENTS_DIR"' EXIT

  # One-time toolchain prep, WITH network, inside the first task's image so
  # the binaries match its arch/libc. Idempotent: skips whatever the
  # bun-cache volume already has.
  FIRST_TASK_ID=$(python3 -c "import json; print(json.load(open('${TASK_FILES[0]}'))['id'])")
  echo "[INFO] Preparing sealed toolchain (bun, rg, fd, node_modules) in ${REGISTRY}.${FIRST_TASK_ID} ..."
  docker run --rm \
    -v "$PI_BENCH_DIR:/pi-bench:z" \
    -v "pi-bench-bun-cache:/root/.bun" \
    "${REGISTRY}.${FIRST_TASK_ID}:latest" \
    bash -c '
      set -e
      export PATH=/root/.bun/bin:$PATH
      ARCH=$(uname -m)
      if [ ! -f /root/.bun/bin/bun ]; then
        for i in 1 2 3; do apt-get update -qq && break; rm -rf /var/lib/apt/lists/*; sleep 2; done
        apt-get install -y -qq unzip >/dev/null 2>&1
        curl -fsSL https://bun.sh/install | bash >/dev/null 2>&1
      fi
      mkdir -p /root/.bun/bin
      if [ ! -x /root/.bun/bin/rg ]; then
        curl -fsSL "https://github.com/BurntSushi/ripgrep/releases/download/14.1.1/ripgrep-14.1.1-${ARCH}-unknown-linux-musl.tar.gz" \
          | tar -xz -C /tmp && cp /tmp/ripgrep-14.1.1-${ARCH}-unknown-linux-musl/rg /root/.bun/bin/rg
      fi
      if [ ! -x /root/.bun/bin/fd ]; then
        curl -fsSL "https://github.com/sharkdp/fd/releases/download/v10.2.0/fd-v10.2.0-${ARCH}-unknown-linux-musl.tar.gz" \
          | tar -xz -C /tmp && cp /tmp/fd-v10.2.0-${ARCH}-unknown-linux-musl/fd /root/.bun/bin/fd
      fi
      cd /pi-bench && (bun install --frozen-lockfile 2>/dev/null || bun install 2>/dev/null)
      echo "[SETUP] toolchain ready: $(bun --version), $(rg --version | head -1), $(fd --version)"
    '
fi

for task_file in "${TASK_FILES[@]}"; do
  COUNT=$((COUNT + 1))
  TASK_ID=$(python3 -c "import json; print(json.load(open('$task_file'))['id'])")

  # Skip if result already exists (check on host to avoid docker startup overhead)
  if [ -n "$RESULTS_DIR" ] && [ -f "$RESULTS_DIR/results-${TASK_ID}.json" ]; then
    echo ""
    echo "========================================================"
    echo "[$COUNT/$TOTAL] Task: $TASK_ID"
    echo "[INFO] Skipping $TASK_ID, result already exists."
    echo "========================================================"
    PASSED=$((PASSED + 1))
    continue
  fi

  IMAGE="${REGISTRY}.${TASK_ID}:latest"

  echo ""
  echo "========================================================"
  echo "[$COUNT/$TOTAL] Task: $TASK_ID"
  echo "         Image: $IMAGE"
  echo "========================================================"

  REL_TASK_FILE=$(python3 -c "import os; print(os.path.relpath('$(realpath "$task_file")', '$(realpath "$PI_BENCH_DIR")'))")

  for ATTEMPT in $(seq 1 $PASS_COUNT); do
    if [ $PASS_COUNT -gt 1 ]; then
      echo "[INFO] Starting attempt $ATTEMPT of $PASS_COUNT for $TASK_ID"
    fi

    # Run container and tee output to a temp file so we can extract the results dir
    if [ "$SEALED" = "1" ]; then
      # Per-task staging dir: the ONLY rw mount of the agent container.
      # task.json is the task WITHOUT expectedDiff (the judge runs on the host)
      # and is deleted by the harness (--consume-task) before the agent starts.
      STAGE="$STAGE_ROOT/${TASK_ID}-attempt${ATTEMPT}"
      rm -rf "$STAGE" && mkdir -p "$STAGE/agent/out" "$STAGE/grade"
      python3 -c "
import json, sys
t = json.load(open(sys.argv[1]))
t.pop('expectedDiff', None)
json.dump(t, open(sys.argv[2], 'w'))
" "$task_file" "$STAGE/agent/task.json"
      CODE_MOUNTS="-v $PI_BENCH_DIR/src:/pi-bench/src:ro -v $PI_BENCH_DIR/node_modules:/pi-bench/node_modules:ro"
      for f in package.json bun.lock tsconfig.json models.json; do
        [ -f "$PI_BENCH_DIR/$f" ] && CODE_MOUNTS="$CODE_MOUNTS -v $PI_BENCH_DIR/$f:/pi-bench/$f:ro"
      done
      TASK_START=$(date -u +%Y-%m-%dT%H:%M:%SZ)

      # No $ENV_ARGS: the agent container gets no API keys. Remote models go
      # through the gateway (PI_BENCH_GATEWAY), local ones through the proxy.
      LOGFILE=$(mktemp /tmp/pi-bench-log.XXXXXX)
      docker run --init -it --rm --network "$SEALED_NETWORK" \
        -e PI_BENCH_SEALED=1 \
        -e PI_BENCH_LOCAL_HOST=host.docker.internal \
        -e PI_BENCH_GATEWAY="$GATEWAY_SPEC" \
        -e PI_OFFLINE=1 \
        -e HTTP_PROXY="$EGRESS_PROXY_URL" -e HTTPS_PROXY="$EGRESS_PROXY_URL" \
        -e http_proxy="$EGRESS_PROXY_URL" -e https_proxy="$EGRESS_PROXY_URL" \
        -e NO_PROXY="localhost,127.0.0.1,$EGRESS_CONTAINER" -e no_proxy="localhost,127.0.0.1,$EGRESS_CONTAINER" \
        $CODE_MOUNTS \
        -v "$STAGE/agent:/pi-bench-io:z" \
        -v "pi-bench-bun-cache:/root/.bun:ro" \
        $RESOURCE_MOUNTS \
        $EXTENSIONS_MOUNT \
        -w /pi-bench \
        "$IMAGE" \
        bash -c "
          set -e
          export PATH=/root/.bun/bin:\$PATH
          for bin in bun rg fd; do
            command -v \$bin >/dev/null || { echo \"[ERROR] \$bin missing from the bun-cache volume -- sealed toolchain prep failed\"; exit 1; }
          done
          source /opt/miniconda3/etc/profile.d/conda.sh
          conda activate testbed
          bun run src/index.ts /pi-bench-io/task.json --consume-task --defer-grading --output-dir /pi-bench-io/out $EXTRA_ARGS
        " 2>&1 | tee "$LOGFILE"
      EXIT_CODE=${PIPESTATUS[0]}

      if [ $EXIT_CODE -ne 2 ]; then
        # Everything under $STAGE/agent was writable by the agent: take ONLY
        # the diff from its results file into the grader's input.
        AGENT_RESULT="$STAGE/agent/out/results-${TASK_ID}.json"
        python3 -c "
import json, sys
task = json.load(open(sys.argv[1]))
diff = ''
try:
    d = json.load(open(sys.argv[2])).get('diff')
    diff = d if isinstance(d, str) else ''
except Exception:
    pass
json.dump({'task': {k: task.get(k) for k in ('id', 'repo', 'failToPass', 'testPatch')}, 'diff': diff}, open(sys.argv[3], 'w'))
" "$task_file" "$AGENT_RESULT" "$STAGE/grade/grade-input.json"

        # Fresh container from the pristine task image, no network, nothing
        # from the agent container except that diff.
        echo "[INFO] Grading $TASK_ID in a fresh container..."
        docker run --init --rm --network none \
          -v "$PI_BENCH_DIR/src:/pi-bench/src:ro" \
          -v "$STAGE/grade:/grade:z" \
          -v "pi-bench-bun-cache:/root/.bun:ro" \
          -w /pi-bench \
          "$IMAGE" \
          bash -c "
            export PATH=/root/.bun/bin:\$PATH
            source /opt/miniconda3/etc/profile.d/conda.sh
            conda activate testbed
            bun run src/grade.ts /grade/grade-input.json /grade/grade.json
          " 2>&1 | grep --line-buffered -E '^\[(GRADE|INFO|WARN|ERROR)\]' || true

        docker logs --since "$TASK_START" "$EGRESS_CONTAINER" > "$STAGE/egress.jsonl" 2>/dev/null || true
        mkdir -p "$RESULTS_DIR"
        bun run scripts/finalize-sealed-result.ts \
          --task "$task_file" \
          --grade "$STAGE/grade/grade.json" \
          --agent-result "$AGENT_RESULT" \
          --egress-log "$STAGE/egress.jsonl" \
          --out "$RESULTS_DIR/results-${TASK_ID}.json" \
          $EXTRA_ARGS
        for f in "$STAGE"/agent/out/transcript-*.json "$STAGE"/agent/out/run-meta.json; do
          [ -f "$f" ] && mv "$f" "$RESULTS_DIR/"
        done
      fi
      rm -rf "$STAGE"
    else
      LOGFILE=$(mktemp /tmp/pi-bench-log.XXXXXX)
      docker run --init -it --rm --network host $ENV_ARGS \
        -v "$PI_BENCH_DIR:/pi-bench:z" \
        -v "pi-bench-bun-cache:/root/.bun" \
        $RESOURCE_MOUNTS \
        $EXTENSIONS_MOUNT \
        "$IMAGE" \
        bash -c "
          set -e

          # Install unzip + ripgrep + bun (cached after first run via volume).
          # apt-get update is retried a few times: under QEMU emulation (amd64
          # image on an arm64 host) it can download a truncated package index,
          # which then fails GPG verification -- almost always transient.
          if [ ! -f /root/.bun/bin/bun ]; then
            echo '[SETUP] Installing bun...'
            for i in 1 2 3; do apt-get update -qq && break; rm -rf /var/lib/apt/lists/*; sleep 2; done
            apt-get install -y -qq unzip ripgrep >/dev/null 2>&1
            curl -fsSL https://bun.sh/install | bash >/dev/null 2>&1
            echo '[SETUP] bun installed.'
          fi
          export PATH=/root/.bun/bin:\$PATH

          # Ensure unzip + ripgrep are available (bun cache might exist from a previous run but these might not be in this container)
          if ! which unzip >/dev/null 2>&1 || ! which rg >/dev/null 2>&1; then
            for i in 1 2 3; do apt-get update -qq && break; rm -rf /var/lib/apt/lists/*; sleep 2; done
            apt-get install -y -qq unzip ripgrep >/dev/null 2>&1
          fi

          # Install pi-bench dependencies (fast if node_modules exists from bind mount)
          cd /pi-bench && bun install --frozen-lockfile 2>/dev/null || bun install 2>/dev/null

          # Activate the SWE-bench testbed conda environment so 'python' resolves
          # to the correct version (e.g. Python 3.6 for Django, 3.8+ for Sphinx)
          source /opt/miniconda3/etc/profile.d/conda.sh
          conda activate testbed

          # Run the benchmark
          bun run src/index.ts $REL_TASK_FILE $EXTRA_ARGS
        " 2>&1 | tee "$LOGFILE"

      EXIT_CODE=${PIPESTATUS[0]}
    fi

    # Capture the results directory from container output (first occurrence only)
    if [ -z "$RESULTS_DIR" ]; then
      RESULTS_DIR=$(grep -m1 'Saving results to directory:' "$LOGFILE" | sed 's/.*Saving results to directory: //' | tr -d '\r' || true)
    fi
    rm -f "$LOGFILE"

    if [ $EXIT_CODE -eq 2 ]; then
      echo "[FATAL] Inference backend is unreachable or crashed. Aborting entire benchmark run."
      exit 2
    fi

    # Rename the outputs for this attempt
    if [ -n "$RESULTS_DIR" ]; then
      mv "$RESULTS_DIR/results-${TASK_ID}.json" "$RESULTS_DIR/results-${TASK_ID}-attempt${ATTEMPT}.json" 2>/dev/null || true
      mv "$RESULTS_DIR/transcript-${TASK_ID}.json" "$RESULTS_DIR/transcript-${TASK_ID}-attempt${ATTEMPT}.json" 2>/dev/null || true

      # Check if this attempt succeeded
      JUDGE_SCORE=$(python3 -c "import json, sys; r=json.load(open(sys.argv[1], 'r')); print(r.get('judgeScore', 0))" "$RESULTS_DIR/results-${TASK_ID}-attempt${ATTEMPT}.json" 2>/dev/null || echo "0")
      if [ "$JUDGE_SCORE" = "1" ]; then
        break
      fi
    fi
  done

  # Combine attempts and determine pass/fail
  python3 -c "
import json, sys, os, shutil
results_dir = sys.argv[1]
task_id = sys.argv[2]
pass_count = int(sys.argv[3])

attempts = []
best_attempt = None
succeeded_at = None

for a in range(1, pass_count + 1):
    res_path = os.path.join(results_dir, f'results-{task_id}-attempt{a}.json')
    if os.path.exists(res_path):
        with open(res_path, 'r') as f:
            data = json.load(f)
            attempts.append(data)
            best_attempt = a
            if data.get('judgeScore') == 1:
                succeeded_at = a
                break

if attempts:
    final_data = attempts[-1].copy() # use the last run as base
    final_data['attempts'] = attempts
    final_data['succeededAtAttempt'] = succeeded_at
    
    with open(os.path.join(results_dir, f'results-{task_id}.json'), 'w') as f:
        json.dump(final_data, f, indent=2)
        
    # Copy the best transcript to standard name for legacy support
    best_trans = os.path.join(results_dir, f'transcript-{task_id}-attempt{best_attempt}.json')
    final_trans = os.path.join(results_dir, f'transcript-{task_id}.json')
    if os.path.exists(best_trans):
        shutil.copy2(best_trans, final_trans)
" "$RESULTS_DIR" "$TASK_ID" "$PASS_COUNT"

  # Count passes/fails based on the final combined file. A harness error
  # (malformed FAIL_TO_PASS data -- no test could be run) is neither a pass
  # nor a model failure, so it's excluded from both counters here too.
  FINAL_SCORE=$(python3 -c "import json, sys; r=json.load(open(sys.argv[1], 'r')); print(r.get('judgeScore', 0))" "$RESULTS_DIR/results-${TASK_ID}.json" 2>/dev/null || echo "0")
  IS_HARNESS_ERROR=$(python3 -c "import json, sys; r=json.load(open(sys.argv[1], 'r')); print('1' if r.get('excludeFromPassRate') else '0')" "$RESULTS_DIR/results-${TASK_ID}.json" 2>/dev/null || echo "0")
  if [ "$IS_HARNESS_ERROR" = "1" ]; then
    echo "[WARN] Task $TASK_ID excluded: harness-error (malformed FAIL_TO_PASS)"
  elif [ "$FINAL_SCORE" = "1" ]; then
    PASSED=$((PASSED + 1))
  else
    FAILED=$((FAILED + 1))
    echo "[WARN] Task $TASK_ID failed after $ATTEMPT attempts"
  fi

  # Free disk space: the full task set's images add up to 100GB+, more than
  # most machines have to spare, so remove this task's image now that we're
  # done with it. Pass --keep-images to skip this and keep images cached for
  # faster reruns, if you have the disk space for it.
  if [ "$KEEP_IMAGES" != "1" ]; then
    docker rmi "$IMAGE" >/dev/null 2>&1 || true
  fi
done

echo ""
echo "========================================================"
echo "[INFO] SWE-bench Runner Complete!"
echo "[INFO] Tasks: $TOTAL | Succeeded: $PASSED | Failed: $FAILED"
echo "========================================================"

# Generate aggregate summary.json from all individual result files.
# Each container writes its own summary.json with only 1 task, overwriting the previous.
# This step reads all results-*.json and builds the real aggregate.
if [ -n "$RESULTS_DIR" ] && [ -d "$RESULTS_DIR" ]; then
  echo "[INFO] Generating aggregate summary from $RESULTS_DIR ..."
  python3 -c "
import json, glob, os, sys

results_dir = sys.argv[1]
result_files = sorted(glob.glob(os.path.join(results_dir, 'results-*.json')))

if not result_files:
    print('[WARN] No result files found, skipping summary generation.')
    sys.exit(0)

results = []
passed = 0
harness_errors = 0
total_duration = 0

for f in result_files:
    with open(f) as fh:
        r = json.load(fh)
        results.append(r)
        if r.get('excludeFromPassRate'):
            harness_errors += 1
        elif r.get('judgeScore') == 1:
            passed += 1
        total_duration += r.get('durationMs', 0)

# Harness-error tasks (malformed FAIL_TO_PASS data -- no test could be run)
# are excluded from the pass-rate denominator, not counted as fails.
scorable = len(results) - harness_errors
summary = {
    'totalTasks': len(results),
    'harnessErrorTasks': harness_errors,
    'passedTasks': passed,
    'passRate': passed / scorable if scorable else 0,
    'totalDurationMs': total_duration,
    'averageDurationMs': total_duration / len(results) if results else 0,
    'results': results
}

summary_path = os.path.join(results_dir, 'summary.json')
with open(summary_path, 'w') as fh:
    json.dump(summary, fh, indent=2)

print(f'[INFO] Aggregate summary: {passed}/{scorable} passed ({summary[\"passRate\"]*100:.1f}%)' + (f' [{harness_errors} excluded: harness-error]' if harness_errors else ''))
print(f'[INFO] Summary saved to {summary_path}')
" "$RESULTS_DIR"
else
  echo "[WARN] Could not determine results directory for aggregate summary."
fi
