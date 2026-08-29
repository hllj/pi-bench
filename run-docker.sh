#!/bin/bash
set -e

# Build the docker image
echo "[INFO] Building pi-bench docker image..."
docker build -t pi-bench-runner .

# Mount only the specific ~/.pi/agent resources pi-coding-agent's resource
# loader discovers (extensions, skills, prompts, settings, context file),
# each read-only. Deliberately NOT the whole ~/.pi/agent directory: auth.json,
# sessions/, and models-store.json stay purely container-local -- the
# credential store needs to create a short-lived auth.json.lock directory
# even for reads that ultimately fall through to env vars, and a read-only
# mount of the whole tree breaks that with EROFS.
AGENT_DIR="$HOME/.pi/agent"
RESOURCE_MOUNTS=""
for name in extensions skills prompts agents settings.json AGENTS.md; do
    if [ -e "$AGENT_DIR/$name" ]; then
        RESOURCE_MOUNTS="$RESOURCE_MOUNTS -v $AGENT_DIR/$name:/root/.pi/agent/$name:ro"
    fi
done

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
    $EXTENSIONS_MOUNT \
    -w /pi-bench \
    pi-bench-runner \
    bun run src/index.ts "$@"
