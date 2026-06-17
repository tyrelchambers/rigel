# Helmsman marketing — static Astro site, built with pnpm and served by nginx.
# Build context is the repo ROOT (the pnpm workspace), like the web image:
#   docker build -f apps/marketing/Dockerfile -t helmsman-marketing .

# ---- Stage 1: build the static site ----
FROM node:22-slim AS build
RUN corepack enable
WORKDIR /app

# Workspace manifests first for better layer caching. pnpm needs every
# workspace member's package.json present to resolve the frozen lockfile.
COPY pnpm-workspace.yaml package.json .npmrc pnpm-lock.yaml ./
COPY packages/catalog/package.json ./packages/catalog/
COPY packages/k8s/package.json ./packages/k8s/
COPY apps/server/package.json ./apps/server/
COPY apps/web/package.json ./apps/web/
COPY apps/marketing/package.json ./apps/marketing/

# Install only the marketing app's dependency subset.
RUN pnpm install --frozen-lockfile --filter @helmsman/marketing...

# Build the static output to apps/marketing/dist.
COPY apps/marketing ./apps/marketing
RUN pnpm --filter @helmsman/marketing build

# ---- Stage 2: serve with nginx ----
FROM nginx:1.27-alpine
COPY apps/marketing/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/marketing/dist /usr/share/nginx/html
EXPOSE 80
