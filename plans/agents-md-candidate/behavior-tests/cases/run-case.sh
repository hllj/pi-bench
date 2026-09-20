#!/bin/bash
# One behaviour case in one container. Usage: run-case.sh <O|N> <case> <rep>
#   O = plans/agents-md-candidate/AGENTS.original-2026-09-20.md  (your file BEFORE the update)
#   N = plans/agents-md-candidate/AGENTS.v2.md
# Both are mounted explicitly over the container's AGENTS.md, because ~/.pi/agent/AGENTS.md itself is now v2.
# Needs: docker, image `pi-bench-runner` (docker build -t pi-bench-runner .), an .env with OPENROUTER_API_KEY
# (default: <repo root>/.env, override with ENV_FILE), and `bun install` done in the repo root.
COND="$1"; CASE="$2"; REP="$3"
HERE="$(cd "$(dirname "$0")" && pwd)"          # .../behavior-tests/cases
JOB="$(dirname "$HERE")"                        # .../behavior-tests  (mounted at /diag, contains cases/)
CAND="$(dirname "$JOB")"                        # .../plans/agents-md-candidate
WT="$(cd "$CAND/../.." && pwd)"                 # repo root
source "$WT/scripts/agent-mounts.sh"
build_agent_mounts "$HOME/.pi/agent"
AG="-v $HOME/.pi/agent/AGENTS.md:/root/.pi/agent/AGENTS.md:ro"
RESOURCE_MOUNTS="${RESOURCE_MOUNTS/"$AG"/}"
if [ "$COND" = "N" ]; then AGENTS="$CAND/AGENTS.v2.md"; else AGENTS="$CAND/AGENTS.original-2026-09-20.md"; fi
RESOURCE_MOUNTS="$RESOURCE_MOUNTS -v $AGENTS:/root/.pi/agent/AGENTS.md:ro"
mkdir -p "$JOB/case-out"
docker run --rm --init --env-file "${ENV_FILE:-$WT/.env}" \
  -e CASE="$CASE" -e COND="$COND" -e REP="$REP" \
  -v "$WT:/pi-bench:z" -v "$JOB:/diag:ro" -v "$JOB/case-out:/out" \
  $RESOURCE_MOUNTS -w /pi-bench pi-bench-runner \
  sh -c 'export PATH=/pi-bench/node_modules/.bin:$PATH; exec bun run /diag/cases/case-runner.ts' 2>&1 | tail -3
