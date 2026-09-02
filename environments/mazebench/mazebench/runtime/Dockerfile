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
ARG ANTIGRAVITY_VERSION=1.1.24
ARG ANTIGRAVITY_URL=https://storage.googleapis.com/antigravity-public/antigravity-cli/1.1.24-6130423206641664/linux-arm/cli_linux_arm64.tar.gz
ARG ANTIGRAVITY_SHA512=316ca00d50389a08b162c66066b4e2db201e4ffb85acea05029e3c4532c69d5b8f7c741cf027325889f898ea8f747af8cd15c802e15fcf5d73b7137b6e2420a1
ARG MAZEBENCH_SOURCE_FINGERPRINT=unverified

LABEL org.mazebench.local-codex.version="${CODEX_VERSION}"
LABEL org.mazebench.local-claude.version="${CLAUDE_CODE_VERSION}"
LABEL org.mazebench.local-kimi.version="${KIMI_CODE_VERSION}"
LABEL org.mazebench.local-antigravity.version="${ANTIGRAVITY_VERSION}"
LABEL org.mazebench.local-agent.update-policy="registry-latest-certified"
LABEL org.mazebench.local-agent.source-fingerprint="${MAZEBENCH_SOURCE_FINGERPRINT}"

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    NODE_ENV=production \
    MAZEBENCH_IN_CONTAINER=1 \
    MAZEBENCH_LOCAL_CODEX_VERSION=${CODEX_VERSION} \
    MAZEBENCH_LOCAL_CLAUDE_VERSION=${CLAUDE_CODE_VERSION} \
    MAZEBENCH_LOCAL_KIMI_VERSION=${KIMI_CODE_VERSION} \
    MAZEBENCH_LOCAL_ANTIGRAVITY_VERSION=${ANTIGRAVITY_VERSION}

RUN apt-get update \
    && apt-get install -y --no-install-recommends binutils bubblewrap ffmpeg socat \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g \
      "@openai/codex@${CODEX_VERSION}" \
      "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
      "@moonshot-ai/kimi-code@${KIMI_CODE_VERSION}"

RUN curl -fsSL "${ANTIGRAVITY_URL}" -o /tmp/antigravity.tar.gz \
    && printf '%s  %s\n' "${ANTIGRAVITY_SHA512}" /tmp/antigravity.tar.gz | sha512sum -c - \
    && tar -xzf /tmp/antigravity.tar.gz -C /usr/local/bin antigravity \
    && mv /usr/local/bin/antigravity /usr/local/bin/agy \
    && chmod 0755 /usr/local/bin/agy \
    && test "$(agy --version)" = "${ANTIGRAVITY_VERSION}" \
    && rm -f /tmp/antigravity.tar.gz

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
      /run/mazebench-credentials/antigravity-auth.json \
    && chown -R pwuser:pwuser /home/pwuser

ENTRYPOINT []
CMD ["node", "scripts/maze-agent-local.js"]
