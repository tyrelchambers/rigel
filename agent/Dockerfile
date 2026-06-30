# syntax=docker/dockerfile:1

# Alpine (musl) base on purpose: the glibc build of Claude Code's bundled Bun
# segfaults during JSC garbage collection on Linux kernel 6.17 ("embedder
# failed to suspend thread"). The musl Bun build that claude-code installs on
# Alpine is unaffected — verified on the cluster's 6.17 nodes.

# ── build stage: esbuild bundle → dist ───────────────────────────────────────
# Build context is the repo ROOT (see agent-build.yml / release-images.yml): the
# agent is a standalone npm project but consumes @rigel/k8s BY SOURCE via the
# tsconfig "paths" alias (../packages/k8s/src), so both must be laid out as
# siblings for the esbuild bundle (npm run build → build.mjs) to inline it.
FROM node:22-alpine AS build
WORKDIR /app
COPY agent/package.json agent/package-lock.json agent/tsconfig.json agent/build.mjs ./agent/
COPY agent/src ./agent/src
COPY packages/k8s/src ./packages/k8s/src
WORKDIR /app/agent
RUN npm ci
# Bundles dist/index.js + dist/fixRunner.js + dist/guardedKubectl.js, each a
# self-contained ESM file with @rigel/k8s inlined (Node builtins external).
RUN npm run build

# ── runtime stage ────────────────────────────────────────────────────────────
FROM node:22-alpine

# Runtime libs: ca-certificates (HTTPS to Anthropic + dl.k8s.io), git (the
# fix-runner Job clones/pushes via @rigel/k8s repoFix), and libstdc++/libgcc
# which the musl Bun binary links against.
RUN apk add --no-cache ca-certificates libstdc++ libgcc bash git curl \
 && case "$(uname -m)" in x86_64) KARCH=amd64;; aarch64) KARCH=arm64;; *) KARCH=amd64;; esac \
 && KVER="$(curl -fsSL https://dl.k8s.io/release/stable.txt)" \
 && curl -fsSL -o /usr/local/bin/kubectl "https://dl.k8s.io/release/${KVER}/bin/linux/${KARCH}/kubectl" \
 && chmod +x /usr/local/bin/kubectl \
 && apk del curl

# Claude Code CLI — on Alpine this pulls the musl Bun build. The agent shells
# `claude -p` against the subscription via CLAUDE_CODE_OAUTH_TOKEN. Never --bare.
RUN npm install -g @anthropic-ai/claude-code

# Codex CLI — musl static binary from GitHub releases (arch-aware). We use the
# release tarball, NOT npm: @openai/codex's npm optional deps are glibc-only (no
# musl), so they won't run on Alpine. The tarball contains a single binary named
# after the arch (codex-<arch>), which we rename to `codex`. The agent's codex
# bridge shells `codex exec --json` (CODEX_API_KEY or a CODEX_AUTH_CONTENT
# subscription auth.json).
RUN apk add --no-cache --virtual .codex-dl curl tar \
 && case "$(uname -m)" in \
      x86_64)  CODEX_ARCH=x86_64-unknown-linux-musl ;; \
      aarch64) CODEX_ARCH=aarch64-unknown-linux-musl ;; \
      *)       CODEX_ARCH=x86_64-unknown-linux-musl ;; \
    esac \
 && curl -fsSL -o /tmp/codex.tar.gz "https://github.com/openai/codex/releases/latest/download/codex-${CODEX_ARCH}.tar.gz" \
 && tar -xzf /tmp/codex.tar.gz -C /tmp \
 && mv "/tmp/codex-${CODEX_ARCH}" /usr/local/bin/codex \
 && chmod +x /usr/local/bin/codex \
 && rm -f /tmp/codex.tar.gz \
 && apk del .codex-dl

# Gemini CLI — npm global (Node is already in the image). The gemini bridge shells
# `gemini -o stream-json --approval-mode yolo` authenticated via GEMINI_API_KEY.
RUN npm install -g @google/gemini-cli

# OpenCode CLI — npm global. opencode-ai ships musl optional deps
# (opencode-linux-x64-musl / opencode-linux-arm64-musl), so npm resolves the
# right binary on Alpine (no manual download needed, unlike Codex). The opencode
# bridge shells `opencode run --format json` authenticated via
# OPENCODE_AUTH_CONTENT / OPENCODE_API_KEY.
RUN npm install -g opencode-ai

WORKDIR /app
# package.json carries "type":"module" so the bundled dist/*.js run as ESM. The
# agent has NO runtime deps (esbuild inlined @rigel/k8s; the model CLIs are global
# above), so there is nothing to `npm ci` here.
COPY agent/package.json ./package.json
COPY --from=build /app/agent/dist ./dist

# Run as the unprivileged built-in `node` user (UID 1000), in an empty working
# dir so `claude -p` doesn't pick up stray repo context.
RUN mkdir -p /workspace && chown node:node /workspace
ENV NODE_ENV=production
# The guarded-kubectl shim (agent/src/guardedKubectl.ts → dist/guardedKubectl.js)
# is exec'd by the non-Claude bridges. In the production image there is no tsx, so
# point the shim's runner at the compiled .js (mirrors RIGEL_GUARD_CMD in the chat).
ENV RIGEL_AGENT_GUARD_CMD="node /app/dist/guardedKubectl.js"
USER node
WORKDIR /workspace
CMD ["node", "/app/dist/index.js"]
