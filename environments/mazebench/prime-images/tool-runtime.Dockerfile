FROM python:3.13-slim

ARG CODEX_VERSION=0.144.5
ARG UV_VERSION=0.12.2
ARG VERIFIERS_REVISION=b3b8f51ed470e3c46c12bb858ad18d257dc50c5e

ENV PATH="/root/.local/bin:${PATH}"
ENV UV_LINK_MODE=copy

RUN apt-get update -qq \
    && apt-get install -y -qq --no-install-recommends ca-certificates curl git \
    && rm -rf /var/lib/apt/lists/* \
    && python -m pip install --no-cache-dir "uv==${UV_VERSION}"

WORKDIR /opt/mazebench-build
COPY pyproject.toml README.md ./
COPY mazebench ./mazebench
COPY mazebench_codex ./mazebench_codex
COPY mazebench_prime_agent ./mazebench_prime_agent
COPY mazebench_tools ./mazebench_tools

RUN uv venv /tmp/vf-venv \
    && uv pip install --python /tmp/vf-venv /opt/mazebench-build \
    && uv pip install --python /tmp/vf-venv hatchling \
    && /tmp/vf-venv/bin/python -c \
      "import importlib.metadata as m; assert m.version('nodejs-wheel') == '24.16.0'; assert m.version('verifiers')" \
    && test -x /tmp/vf-venv/bin/node \
    && rm -rf /opt/mazebench-build /root/.cache/uv

RUN mkdir -p /tmp/mazebench-python-codex/bin /opt/mazebench-image \
    && case "$(uname -m)" in aarch64|arm64) arch=aarch64 ;; *) arch=x86_64 ;; esac \
    && triple="${arch}-unknown-linux-musl" \
    && curl -fsSL "https://github.com/openai/codex/releases/download/rust-v${CODEX_VERSION}/codex-${triple}.tar.gz" \
      | tar -xz -C /tmp/mazebench-python-codex/bin \
    && mv "/tmp/mazebench-python-codex/bin/codex-${triple}" /tmp/mazebench-python-codex/bin/codex \
    && chmod 0755 /tmp/mazebench-python-codex/bin/codex \
    && /tmp/mazebench-python-codex/bin/codex --version \
    && printf '%s\n' \
      "codex_version=${CODEX_VERSION}" \
      "verifiers_revision=${VERIFIERS_REVISION}" \
      "nodejs_wheel_version=24.16.0" \
      > /opt/mazebench-image/tool-runtime

LABEL ai.mazebench.image-purpose="isolated-tool-runtime"
LABEL ai.mazebench.codex-version="${CODEX_VERSION}"
LABEL ai.mazebench.verifiers-revision="${VERIFIERS_REVISION}"
