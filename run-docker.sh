#!/bin/bash
set -e

# Build the docker image
echo "[INFO] Building pi-bench docker image..."
docker build -t pi-bench-runner .

# Ensure ~/.pi/agent exists on the host so it can be bind-mounted (read-only)
# into the container, giving pi-coding-agent access to the user's global
# extensions, skills, prompts, and settings.json.
mkdir -p ~/.pi/agent

# ~/.pi/agent/extensions is commonly a symlink into a separate config repo
# (e.g. ~/pi-config). A bind mount doesn't rewrite symlink targets, so mount
# the real target at its identical absolute path too, or the symlink dangles
# inside the container.
EXTENSIONS_MOUNT=""
if [ -L "$HOME/.pi/agent/extensions" ]; then
    REAL_EXT_DIR="$(cd -P "$HOME/.pi/agent/extensions" 2>/dev/null && pwd)"
    if [ -n "$REAL_EXT_DIR" ] && [ "$REAL_EXT_DIR" != "$HOME/.pi/agent/extensions" ]; then
        EXTENSIONS_MOUNT="-v $REAL_EXT_DIR:$REAL_EXT_DIR:ro"
    fi
fi

# Run the benchmark
# -v $(pwd):/pi-bench:z mounts the pi-bench directory
# -v ~/.pi/agent:/root/.pi/agent:ro mounts the user's pi-coding-agent config (read-only)
# -w /pi-bench sets the working directory to pi-bench
echo "[INFO] Running pi-bench inside docker..."
ENV_ARGS=""
if [ -f .env ]; then
    ENV_ARGS="--env-file .env"
fi

docker run --init --rm -it --network host $ENV_ARGS \
    -v "$(pwd):/pi-bench:z" \
    -v "$HOME/.pi/agent:/root/.pi/agent:ro" \
    $EXTENSIONS_MOUNT \
    -w /pi-bench \
    pi-bench-runner \
    bun run src/index.ts "$@"
