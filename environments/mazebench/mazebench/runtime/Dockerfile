# Disposable runtime for the certified local coding-agent benchmark paths.
#
# The trusted MazeBench runner and game-control service run in the outer
# container. The evaluated provider process is launched again inside a bubblewrap
# mount namespace where /app and the run output are hidden. Only a fresh
# workspace, a run-scoped Codex transcript store, the single auth file needed by
# the CLI, and MazeBench's private HTTP MCP game controls cross that boundary.
FROM mcr.microsoft.com/playwright:v1.60.0-noble

ARG CODEX_VERSION=0.152.1
ARG CLAUDE_CODE_VERSION=2.1.258
ARG KIMI_CODE_VERSION=0.29.1
ARG MUSE_CODE_VERSION=1.0.2-R2040.1
ARG MAZEBENCH_SOURCE_FINGERPRINT=unverified

LABEL org.mazebench.local-codex.version="${CODEX_VERSION}"
LABEL org.mazebench.local-claude.version="${CLAUDE_CODE_VERSION}"
LABEL org.mazebench.local-kimi.version="${KIMI_CODE_VERSION}"
LABEL org.mazebench.local-muse.version="${MUSE_CODE_VERSION}"
LABEL org.mazebench.local-agent.update-policy="registry-latest-certified"
LABEL org.mazebench.local-agent.source-fingerprint="${MAZEBENCH_SOURCE_FINGERPRINT}"

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    NODE_ENV=production \
    MAZEBENCH_IN_CONTAINER=1 \
    MAZEBENCH_LOCAL_CODEX_VERSION=${CODEX_VERSION} \
    MAZEBENCH_LOCAL_CLAUDE_VERSION=${CLAUDE_CODE_VERSION} \
    MAZEBENCH_LOCAL_KIMI_VERSION=${KIMI_CODE_VERSION} \
    MAZEBENCH_LOCAL_MUSE_VERSION=${MUSE_CODE_VERSION}

RUN apt-get update \
    && apt-get install -y --no-install-recommends binutils bubblewrap ffmpeg socat \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g \
      "@openai/codex@${CODEX_VERSION}" \
      "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
      "@moonshot-ai/kimi-code@${KIMI_CODE_VERSION}"

RUN curl -fsSL https://api.meta.ai/muse-launcher.sh -o /usr/local/bin/muse \
    && chmod 0755 /usr/local/bin/muse \
    && MUSE_LOGIN=0 MUSE_SYNC_UPDATE=1 /usr/local/bin/muse --version \
    && /usr/local/bin/muse --version | grep -F "(${MUSE_CODE_VERSION})"

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
      /run/mazebench-credentials/muse-auth.json \
    && chown -R pwuser:pwuser /home/pwuser

ENTRYPOINT []
CMD ["node", "scripts/maze-agent-local.js"]
