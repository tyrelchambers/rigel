# ---- build ----
FROM node:26-slim AS build
RUN npm install -g pnpm@11.4.0
WORKDIR /app
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml .npmrc ./
COPY apps/api/package.json ./apps/api/
RUN pnpm install --frozen-lockfile --filter api
COPY apps/api ./apps/api
RUN pnpm --filter api build

# ---- runtime ----
FROM node:26-slim
WORKDIR /app
COPY --from=build /app/apps/api/dist/signups.mjs ./signups.mjs
ENV PORT=8080
EXPOSE 8080
CMD ["node", "signups.mjs"]
