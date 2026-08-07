FROM python:3.11-slim

ARG CODEX_VERSION=0.144.5

RUN apt-get update -qq \
    && apt-get install -y -qq --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /tmp/vf-codex/bin \
    && case "$(uname -m)" in aarch64|arm64) arch=aarch64 ;; *) arch=x86_64 ;; esac \
    && triple="${arch}-unknown-linux-musl" \
    && curl -fsSL "https://github.com/openai/codex/releases/download/rust-v${CODEX_VERSION}/codex-${triple}.tar.gz" \
      | tar -xz -C /tmp/vf-codex/bin \
    && mv "/tmp/vf-codex/bin/codex-${triple}" /tmp/vf-codex/bin/codex \
    && chmod 0755 /tmp/vf-codex/bin/codex \
    && /tmp/vf-codex/bin/codex --version

LABEL ai.mazebench.image-purpose="isolated-codex-agent"
LABEL ai.mazebench.codex-version="${CODEX_VERSION}"
