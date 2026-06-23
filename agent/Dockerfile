# syntax=docker/dockerfile:1

# Alpine (musl) base on purpose: the glibc build of Claude Code's bundled Bun
# segfaults during JSC garbage collection on Linux kernel 6.17 ("embedder
# failed to suspend thread"). The musl Bun build that claude-code installs on
# Alpine is unaffected — verified on the cluster's 6.17 nodes.

# ── build stage: compile TypeScript → dist ───────────────────────────────────
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build

# ── runtime stage ────────────────────────────────────────────────────────────
FROM node:22-alpine

# Runtime libs: ca-certificates (HTTPS to Anthropic + dl.k8s.io), and
# libstdc++/libgcc which the musl Bun binary links against.
RUN apk add --no-cache ca-certificates libstdc++ libgcc bash curl \
 && case "$(uname -m)" in x86_64) KARCH=amd64;; aarch64) KARCH=arm64;; *) KARCH=amd64;; esac \
 && KVER="$(curl -fsSL https://dl.k8s.io/release/stable.txt)" \
 && curl -fsSL -o /usr/local/bin/kubectl "https://dl.k8s.io/release/${KVER}/bin/linux/${KARCH}/kubectl" \
 && chmod +x /usr/local/bin/kubectl \
 && apk del curl

# Claude Code CLI — on Alpine this pulls the musl Bun build. The agent shells
# `claude -p` against the subscription via CLAUDE_CODE_OAUTH_TOKEN. Never --bare.
RUN npm install -g @anthropic-ai/claude-code

# Codex CLI — musl static binary from GitHub releases (arch-aware). The agent's
# codex bridge shells `codex exec --json` authenticated via CODEX_API_KEY.
RUN apk add --no-cache --virtual .codex-dl curl tar \
 && case "$(uname -m)" in \
      x86_64)  CODEX_ARCH=x86_64-unknown-linux-musl ;; \
      aarch64) CODEX_ARCH=aarch64-unknown-linux-musl ;; \
      *)       CODEX_ARCH=x86_64-unknown-linux-musl ;; \
    esac \
 && curl -fsSL -o /tmp/codex.tar.gz "https://github.com/openai/codex/releases/latest/download/codex-${CODEX_ARCH}.tar.gz" \
 && tar -xzf /tmp/codex.tar.gz -C /usr/local/bin \
 && rm -f /tmp/codex.tar.gz \
 && chmod +x /usr/local/bin/codex \
 && apk del .codex-dl

# Gemini CLI — npm global (Node is already in the image). The gemini bridge shells
# `gemini -o stream-json --approval-mode yolo` authenticated via GEMINI_API_KEY.
RUN npm install -g @google/gemini-cli

# OpenCode CLI — Bun-built single binary from GitHub releases (arch-aware). The
# opencode bridge shells `opencode run --format json` authenticated via
# OPENCODE_AUTH_CONTENT / OPENCODE_API_KEY.
RUN apk add --no-cache --virtual .oc-dl curl unzip \
 && case "$(uname -m)" in \
      x86_64)  OC_ARCH=linux-x64 ;; \
      aarch64) OC_ARCH=linux-arm64 ;; \
      *)       OC_ARCH=linux-x64 ;; \
    esac \
 && curl -fsSL -o /tmp/opencode.zip "https://github.com/sst/opencode/releases/latest/download/opencode-${OC_ARCH}.zip" \
 && unzip -o /tmp/opencode.zip -d /usr/local/bin \
 && rm -f /tmp/opencode.zip \
 && chmod +x /usr/local/bin/opencode \
 && apk del .oc-dl

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist

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
