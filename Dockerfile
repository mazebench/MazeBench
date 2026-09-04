# Disposable runtime for the certified local coding-agent benchmark paths.
#
# The trusted MazeBench runner and game-control service run in the outer
# container. The evaluated provider process is launched again inside a bubblewrap
# mount namespace where /app and the run output are hidden. Only a fresh
# workspace, a run-scoped Codex transcript store, the single auth file needed by
# the CLI, and MazeBench's private HTTP MCP game controls cross that boundary.
FROM mcr.microsoft.com/playwright:v1.60.0-noble

ARG CODEX_VERSION=0.146.0
ARG CLAUDE_CODE_VERSION=2.1.220
ARG KIMI_CODE_VERSION=0.29.1
ARG GROK_BUILD_VERSION=1.0.13

LABEL org.mazebench.local-codex.version="${CODEX_VERSION}"
LABEL org.mazebench.local-claude.version="${CLAUDE_CODE_VERSION}"
LABEL org.mazebench.local-kimi.version="${KIMI_CODE_VERSION}"
LABEL org.mazebench.local-grok.version="${GROK_BUILD_VERSION}"

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    NODE_ENV=production \
    MAZEBENCH_IN_CONTAINER=1 \
    MAZEBENCH_LOCAL_CODEX_VERSION=${CODEX_VERSION} \
    MAZEBENCH_LOCAL_CLAUDE_VERSION=${CLAUDE_CODE_VERSION} \
    MAZEBENCH_LOCAL_KIMI_VERSION=${KIMI_CODE_VERSION} \
    MAZEBENCH_LOCAL_GROK_VERSION=${GROK_BUILD_VERSION}

RUN apt-get update \
    && apt-get install -y --no-install-recommends bubblewrap ffmpeg socat \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g \
      "@openai/codex@${CODEX_VERSION}" \
      "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
      "@moonshot-ai/kimi-code@${KIMI_CODE_VERSION}" \
      "@xai-official/grok@${GROK_BUILD_VERSION}" \
    && grok --version

# The official npm trampoline expands the native binary into the invoking
# user's GROK_HOME on first use. Bake that verified payload into PATH so the
# unprivileged, read-only benchmark namespace never needs a first-run write.
RUN install -m 0755 "/root/.grok/bin/grok-${GROK_BUILD_VERSION}" /usr/local/bin/grok \
    && /usr/local/bin/grok --version

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --include=dev

COPY . .

RUN mkdir -p \
      /home/pwuser \
      /run/mazebench-credentials \
      /run/mazebench-output \
      /run/mazebench-workspace \
    && touch \
      /run/mazebench-credentials/codex-auth.json \
      /run/mazebench-credentials/claude-credentials.json \
      /run/mazebench-credentials/kimi-config.toml \
      /run/mazebench-credentials/grok-auth.json \
    && chown -R pwuser:pwuser /home/pwuser

ENTRYPOINT []
CMD ["node", "scripts/maze-agent-local.js"]
