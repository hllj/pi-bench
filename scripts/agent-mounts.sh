#!/bin/bash
# Shared by run-docker.sh and run-swe-bench.sh: builds the `docker run -v ...`
# flags that expose the host's ~/.pi/agent resources to pi-coding-agent inside
# a container. Usage:
#
#   source scripts/agent-mounts.sh
#   build_agent_mounts "$HOME/.pi/agent"   # sets RESOURCE_MOUNTS
#
# Each standard resource (extensions, skills, prompts, agents, settings.json,
# AGENTS.md, npm) is mounted read-only at /root/.pi/agent/<name>. Deliberately
# NOT the whole directory: auth.json, sessions/ and models-store.json stay
# container-local (a read-only auth.json breaks pi-ai's credential-store lock
# file with EROFS).
#
# Symlinks: ~/.pi/agent/{extensions,skills,prompts,agents} are commonly full of
# ABSOLUTE symlinks into a separate config repo (e.g. ~/pi-config). A bind mount
# does not rewrite symlink targets, so each distinct target must ALSO be
# mounted at its identical absolute path -- otherwise the link dangles in the
# container and pi's resource loader drops that skill/prompt/agent/extension
# SILENTLY (`[Skills] []`, no diagnostic). Only absolute link targets are
# handled; relative links resolve within the mounted tree or are out of scope.

build_agent_mounts() {
  local agent_dir="$1"
  local name entry target a b
  local candidates=()   # every absolute symlink target that exists on the host
  local targets=()      # candidates minus any nested inside another candidate

  RESOURCE_MOUNTS=""
  for name in extensions skills prompts agents settings.json AGENTS.md npm; do
    if [ -e "$agent_dir/$name" ]; then
      RESOURCE_MOUNTS="$RESOURCE_MOUNTS -v $agent_dir/$name:/root/.pi/agent/$name:ro"
    fi
  done

  # The resource dir itself if it's a symlink (e.g. extensions -> ~/pi-config),
  # plus its immediate children (e.g. skills/dev-workflows -> ~/pi-config/...).
  for name in extensions skills prompts agents; do
    for entry in "$agent_dir/$name" "$agent_dir/$name"/* "$agent_dir/$name"/.[!.]*; do
      [ -L "$entry" ] || continue
      target="$(readlink "$entry")"
      case "$target" in
        /*) ;;
        *) continue ;;
      esac
      if [ ! -e "$target" ]; then
        echo "[WARN] $entry -> $target: dangling symlink (target missing on the host); it will not be available in the container" >&2
        continue
      fi
      candidates+=("$target")
    done
  done

  # Drop duplicates and anything nested inside another candidate.
  for a in "${candidates[@]}"; do
    local redundant=0
    for b in "${candidates[@]}"; do
      if [ "$a" != "$b" ]; then
        case "$a" in "$b"/*) redundant=1 ;; esac
      fi
    done
    if [ "$redundant" = 1 ]; then continue; fi
    local seen=0
    for b in "${targets[@]}"; do
      if [ "$a" = "$b" ]; then seen=1; fi
    done
    if [ "$seen" = 0 ]; then targets+=("$a"); fi
  done

  for target in "${targets[@]}"; do
    RESOURCE_MOUNTS="$RESOURCE_MOUNTS -v $target:$target:ro"
  done
}
