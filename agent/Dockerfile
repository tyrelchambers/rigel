# syntax=docker/dockerfile:1

# ── build stage: compile TypeScript → dist ───────────────────────────────────
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build

# ── runtime stage ────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim

# kubectl (matches the cluster's stable release; arch-aware for amd64/arm64 homelabs)
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && ARCH="$(dpkg --print-architecture)" \
 && KVER="$(curl -fsSL https://dl.k8s.io/release/stable.txt)" \
 && curl -fsSL -o /usr/local/bin/kubectl "https://dl.k8s.io/release/${KVER}/bin/linux/${ARCH}/kubectl" \
 && chmod +x /usr/local/bin/kubectl \
 && apt-get purge -y curl && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*

# Claude Code CLI — the agent shells `claude -p` against the subscription via
# CLAUDE_CODE_OAUTH_TOKEN (injected from a Secret). Never uses --bare.
RUN npm install -g @anthropic-ai/claude-code

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist

# Run as the unprivileged built-in `node` user, in an empty working dir so
# `claude -p` doesn't pick up stray repo context.
RUN mkdir -p /workspace && chown node:node /workspace
ENV NODE_ENV=production
USER node
WORKDIR /workspace
CMD ["node", "/app/dist/index.js"]
