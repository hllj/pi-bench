FROM docker.io/oven/bun:latest

# Install necessary system dependencies for the agent and benchmarker to work
# Git is required for cloning repos and extracting diffs.
# Node.js via NodeSource (22.x), not Debian's own `nodejs` package: Debian
# trixie ships Node 20, which lacks `node:fs`'s `globSync` export (stable
# only in Node 21.7+/22+) that the bundled @earendil-works/pi-coding-agent
# CLI needs - without it, any subagent dispatch that falls through to
# invoking a real `pi` binary crashes at import time.
RUN apt-get update && apt-get install -y curl ca-certificates gnupg \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y \
    git \
    python3 \
    python3-pip \
    python-is-python3 \
    nodejs \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# Set up git config to avoid warnings when agent tries to commit/diff
RUN git config --global user.email "bench@pi.local" && \
    git config --global user.name "Pi Benchmarker"

WORKDIR /pi-bench

# Fast appended layer to prevent busting the heavy cache above
RUN apt-get update && apt-get install -y python3-setuptools && rm -rf /var/lib/apt/lists/*
