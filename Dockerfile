# Rigel Web — single self-hostable container.
# Stage 1 (node) builds the React UI with pnpm; stage 2 (also node) runs the
# API/WS server via tsx, which also serves the built UI. The server shells out
# to kubectl (and claude, for chat) against a mounted kubeconfig.

# ---- Stage 1: build the web UI + install the server's runtime deps ----
FROM node:26-slim AS build
# Node 25+ no longer bundles corepack, so install pnpm directly (pin to the
# repo's packageManager version so the frozen lockfile resolves cleanly).
RUN npm install -g pnpm@11.4.0
WORKDIR /app

# node-pty 1.1.0 ships prebuilt binaries only for darwin-* and win32-* — there
# is NO linux prebuild — so on linux its `install` step (node scripts/prebuild.js
# || node-gyp rebuild) falls through to node-gyp and compiles from source. That
# needs python3 + a C++ toolchain, which node:22-slim lacks. Install them here
# in the BUILD stage only; the runtime stage just copies the compiled pty.node.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

# Install workspace deps first (better layer caching).
#
# The lockfile (v9) lists ALL workspace importers — including apps/desktop
# (electron) and apps/marketing — so every package.json must be present or a
# --frozen-lockfile install fails with ERR_PNPM_OUTDATED_LOCKFILE (workspace
# vs. lockfile mismatch). We therefore copy all of them for a valid graph…
COPY pnpm-workspace.yaml package.json .npmrc pnpm-lock.yaml ./
COPY packages ./packages
COPY apps/web/package.json ./apps/web/
COPY apps/server/package.json ./apps/server/
COPY apps/marketing/package.json ./apps/marketing/
COPY apps/desktop/package.json ./apps/desktop/
# server postinstall (fix-node-pty.mjs) runs during the filtered install below.
COPY apps/server/scripts ./apps/server/scripts
# …but SCOPE the install to just web + the server, so pnpm fetches only those
# two projects' dependency closure (packages/k8s, packages/catalog, and the
# server's node-pty / tsx / @hono/node-server / ws). apps/desktop's electron —
# a huge, platform-specific dep whose postinstall can fail in a headless Debian
# build — is NOT in that closure, so it's never downloaded.
RUN pnpm install --frozen-lockfile --filter web --filter @helmsman/server

# Build the web UI.
COPY apps/web ./apps/web
COPY apps/server ./apps/server
RUN pnpm --filter web build

# ---- Stage 2: runtime (node) ----
# Same base as Stage 1 (node:22-slim, same Debian/glibc), so node-pty's native
# linux prebuild built in Stage 1 stays ABI-compatible when copied over.
FROM node:26-slim
USER root

# kubectl + helm + kubectl-cnpg + cmctl + claude.
# kubectl-cnpg powers the Databases panel's CNPG controls (backup/switchover/
# hibernate/scale). cmctl (the `kubectl cert-manager` plugin) powers the
# Certificates panel's Force-renew action. Both run SERVER-SIDE here, so they
# must live in the image — a runtime install would be lost on container restart.
# Best-effort (like claude): absence just disables those actions, it doesn't
# break the build.
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates bash git jq \
 && rm -rf /var/lib/apt/lists/* \
 && ARCH="$(dpkg --print-architecture)" \
 && curl -fsSLo /usr/local/bin/kubectl "https://dl.k8s.io/release/$(curl -fsSL https://dl.k8s.io/release/stable.txt)/bin/linux/${ARCH}/kubectl" \
 && chmod +x /usr/local/bin/kubectl \
 && curl -fsSL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash \
 && (curl -sSfL https://github.com/cloudnative-pg/cloudnative-pg/raw/main/hack/install-cnpg-plugin.sh | sh -s -- -b /usr/local/bin || echo "kubectl-cnpg install skipped (CNPG database actions will be disabled)") \
 && (curl -fsSLo /usr/local/bin/cmctl "https://github.com/cert-manager/cmctl/releases/latest/download/cmctl_linux_${ARCH}" \
     && chmod +x /usr/local/bin/cmctl \
     && ln -sf /usr/local/bin/cmctl /usr/local/bin/kubectl-cert_manager \
     || echo "cmctl install skipped (certificate Force-renew will be disabled)") \
 && (curl -fsSL https://claude.ai/install.sh | bash || echo "claude CLI install skipped (chat will be unavailable)")
ENV PATH="/root/.local/bin:${PATH}"

WORKDIR /app
# Bring over the installed workspace (incl. node_modules symlinks, node-pty's
# compiled build/Release/pty.node, and tsx) + built UI. Stage 1's install was
# scoped to web + server, so apps/desktop has no node_modules — this copy
# carries NO electron.
COPY --from=build /app /app

ENV PORT=8787 \
    WEB_DIST=/app/apps/web/dist \
    NODE_ENV=production
EXPOSE 8787

# Entrypoint synthesizes an in-cluster kubeconfig from the pod ServiceAccount
# when none is mounted (no-op for the `docker compose` path, which mounts one).
# It's runtime-agnostic and exec "$@"s the CMD below.
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]

# Run the Node server's TS entry via tsx (NOT the esbuild bundle, which has a
# dynamic require("events") from ws and an import.meta.url-relative permission-
# hook path that the desktop build had to re-bundle around). Running from
# apps/server is REQUIRED so `node --import tsx` resolves tsx from
# apps/server/node_modules and the extensionless workspace imports resolve under
# pnpm's layout. WEB_DIST stays absolute, so the WORKDIR change doesn't affect it.
WORKDIR /app/apps/server
CMD ["node", "--import", "tsx", "src/index.ts"]
