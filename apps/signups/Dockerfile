# ---- build ----
FROM node:26-slim AS build
RUN npm install -g pnpm@11.4.0
WORKDIR /app
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml .npmrc ./
COPY apps/signups/package.json ./apps/signups/
RUN pnpm install --frozen-lockfile --filter signups
COPY apps/signups ./apps/signups
RUN pnpm --filter signups build

# ---- runtime ----
FROM node:26-slim
WORKDIR /app
COPY --from=build /app/apps/signups/dist/signups.mjs ./signups.mjs
ENV PORT=8080
EXPOSE 8080
CMD ["node", "signups.mjs"]
