#!/bin/bash
set -e

# Build the docker image
echo "[INFO] Building pi-bench docker image..."
docker build -t pi-bench-runner .

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
# Builds RESOURCE_MOUNTS: each ~/.pi/agent resource read-only, plus every
# symlink target (skills/prompts/agents/extensions are usually absolute
# symlinks into a separate config repo) at its identical host path so the
# links resolve in the container. See scripts/agent-mounts.sh for the why.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/scripts/agent-mounts.sh"
build_agent_mounts "$HOME/.pi/agent"

# Run the benchmark
# -v $(pwd):/pi-bench:z mounts the pi-bench directory
# -w /pi-bench sets the working directory to pi-bench
echo "[INFO] Running pi-bench inside docker..."
ENV_ARGS=""
if [ -f .env ]; then
    ENV_ARGS="--env-file .env"
fi

docker run --init --rm -it --network host $ENV_ARGS \
    -v "$(pwd):/pi-bench:z" \
    $RESOURCE_MOUNTS \
    -w /pi-bench \
    pi-bench-runner \
    bun run src/index.ts "$@"
