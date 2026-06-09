# Helmsman Web — single self-hostable container.
# Stage 1 (node) builds the React UI with pnpm; stage 2 (bun) runs the API/WS
# server, which also serves the built UI. The server shells out to kubectl (and
# claude, for chat) against a mounted kubeconfig.

# ---- Stage 1: build the web UI ----
FROM node:22-slim AS build
RUN corepack enable
WORKDIR /app

# Install workspace deps first (better layer caching).
COPY pnpm-workspace.yaml package.json .npmrc pnpm-lock.yaml ./
COPY packages ./packages
COPY apps/web/package.json ./apps/web/
COPY apps/server/package.json ./apps/server/
RUN pnpm install --frozen-lockfile

# Build the web UI.
COPY apps/web ./apps/web
COPY apps/server ./apps/server
RUN pnpm --filter web build

# ---- Stage 2: runtime (bun) ----
FROM oven/bun:1
USER root

# kubectl + helm + claude (claude is best-effort; chat needs it, panels don't).
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates bash git \
 && rm -rf /var/lib/apt/lists/* \
 && ARCH="$(dpkg --print-architecture)" \
 && curl -fsSLo /usr/local/bin/kubectl "https://dl.k8s.io/release/$(curl -fsSL https://dl.k8s.io/release/stable.txt)/bin/linux/${ARCH}/kubectl" \
 && chmod +x /usr/local/bin/kubectl \
 && curl -fsSL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash \
 && (curl -fsSL https://claude.ai/install.sh | bash || echo "claude CLI install skipped (chat will be unavailable)")
ENV PATH="/root/.local/bin:${PATH}"

WORKDIR /app
# Bring over the installed workspace (incl. node_modules symlinks) + built UI.
COPY --from=build /app /app

ENV PORT=8787 \
    WEB_DIST=/app/apps/web/dist \
    NODE_ENV=production
EXPOSE 8787

CMD ["bun", "apps/server/src/index.ts"]
