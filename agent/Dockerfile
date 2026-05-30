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

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist

# Run as the unprivileged built-in `node` user (UID 1000), in an empty working
# dir so `claude -p` doesn't pick up stray repo context.
RUN mkdir -p /workspace && chown node:node /workspace
ENV NODE_ENV=production
USER node
WORKDIR /workspace
CMD ["node", "/app/dist/index.js"]
