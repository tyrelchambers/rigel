# Rigel Signup Capture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture a name + email from desktop users on first run (required, network-resilient) as the first step of the onboarding wizard, and store it in a `signups` table in a new `rigel` DB via a new `apps/signups` API at `api.rigel.run`.

**Architecture:** A new standalone monorepo app `apps/signups` (Node + Hono + pg) exposes `POST /signups` → upsert by `installId`. The Electron main process owns a persistent install identity + delivery-with-retry; the renderer's onboarding wizard becomes multi-step with a required, desktop-only "About you" step that calls the main process over IPC.

**Tech Stack:** Hono + `@hono/node-server`, `pg`, `pg-mem` (tests), vitest, tsx/esbuild, Electron IPC, React (SPA), CloudNativePG, traefik + cert-manager.

**Spec:** `docs/superpowers/specs/2026-06-19-rigel-signup-capture-design.md`

---

## File Structure

**New app `apps/signups/` (the separate API project):**
- `package.json`, `tsconfig.json` — standalone app, no workspace deps
- `src/validate.ts` — payload type + `parseSignup()` (pure)
- `src/rateLimit.ts` — per-IP fixed-window limiter (pure)
- `src/db.ts` — `ensureSchema()` + `upsertSignup()` (the SQL)
- `src/app.ts` — `createApp(deps)` Hono app (routes, no I/O of its own)
- `src/index.ts` — env wiring + `serve()`
- `src/*.test.ts` — vitest unit tests
- `Dockerfile` — two-stage, esbuild bundle on `node:26-slim`
- `k8s/{deployment,service,ingress}.yaml` — mirrors `apps/marketing/k8s/`
- `.github/workflows/signups-build.yml` — build → GHCR → deploy (repo pattern)

**Desktop client (`apps/desktop/`):**
- `src/installStore.ts` — persistent `installId`/`captured`/`pending` in `userData`
- `src/signup.ts` — `submitSignup()` + `deliver()` (POST with retry)
- `src/main.ts` (modify) — instantiate store, IPC handlers, background retry on boot
- `src/preload.ts` (modify) — rename bridge `rigel`→`rigel`, add `needsSignup`/`submitSignup`
- `package.json` (modify) — add vitest + `test` script
- `src/*.test.ts` — vitest unit tests

**Renderer (`apps/web/`):**
- `src/shell/onboarding/Stepper.tsx` — step indicator (new)
- `src/shell/onboarding/AboutYouStep.tsx` — required name+email step (new)
- `src/shell/OnboardingWizard.tsx` (modify) — multi-step container
- `src/App.tsx` (modify) — trigger + lock logic
- `src/lib/desktop.ts` — typed `window.rigel` accessor (new)

---

# Phase 1 — `apps/signups` API (the separate app)

## Task 1: Scaffold the `apps/signups` app

**Files:**
- Create: `apps/signups/package.json`
- Create: `apps/signups/tsconfig.json`

- [ ] **Step 1: Create `apps/signups/package.json`**

```json
{
  "name": "signups",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "start": "node --import tsx src/index.ts",
    "build": "esbuild src/index.ts --bundle --platform=node --format=esm --external:pg-native --outfile=dist/signups.mjs",
    "typecheck": "tsc --noEmit",
    "test": "vitest run --passWithNoTests"
  },
  "dependencies": {
    "hono": "latest",
    "@hono/node-server": "latest",
    "pg": "latest"
  },
  "devDependencies": {
    "@types/node": "latest",
    "@types/pg": "latest",
    "pg-mem": "latest",
    "vitest": "latest",
    "tsx": "latest",
    "esbuild": "latest",
    "typescript": "latest"
  }
}
```

- [ ] **Step 2: Create `apps/signups/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "types": ["node"],
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Install (the workspace globs `apps/*`, so it's picked up)**

Run: `pnpm install` (from repo root)
Expected: adds `signups` workspace project; no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/signups/package.json apps/signups/tsconfig.json pnpm-lock.yaml
git commit -m "feat(signups): scaffold the apps/signups API project"
```

## Task 2: Payload validation (`parseSignup`)

**Files:**
- Create: `apps/signups/src/validate.ts`
- Test: `apps/signups/src/validate.test.ts`

- [ ] **Step 1: Write the failing test** — `apps/signups/src/validate.test.ts`

```ts
import { test, expect } from "vitest";
import { parseSignup } from "./validate";

const valid = {
  installId: "11111111-1111-4111-8111-111111111111",
  name: "Jane Doe",
  email: "jane@acme.com",
  appVersion: "0.1.0",
  platform: "darwin",
};

test("accepts a valid payload and trims", () => {
  const r = parseSignup({ ...valid, name: "  Jane Doe  " });
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.value.name).toBe("Jane Doe");
});

test("rejects non-object", () => {
  expect(parseSignup(null).ok).toBe(false);
  expect(parseSignup("x").ok).toBe(false);
});

test("rejects bad installId", () => {
  expect(parseSignup({ ...valid, installId: "not-a-uuid" }).ok).toBe(false);
});

test("rejects empty name and over-long name", () => {
  expect(parseSignup({ ...valid, name: "" }).ok).toBe(false);
  expect(parseSignup({ ...valid, name: "a".repeat(201) }).ok).toBe(false);
});

test("rejects malformed email", () => {
  expect(parseSignup({ ...valid, email: "nope" }).ok).toBe(false);
});

test("truncates appVersion/platform to 50 chars and tolerates missing", () => {
  const r = parseSignup({ ...valid, appVersion: "v".repeat(80), platform: undefined });
  expect(r.ok).toBe(true);
  if (r.ok) {
    expect(r.value.appVersion.length).toBe(50);
    expect(r.value.platform).toBe("");
  }
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter signups exec vitest run src/validate.test.ts`
Expected: FAIL ("Cannot find module './validate'").

- [ ] **Step 3: Implement `apps/signups/src/validate.ts`**

```ts
export interface Signup {
  installId: string;
  name: string;
  email: string;
  appVersion: string;
  platform: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type Result = { ok: true; value: Signup } | { ok: false; error: string };

export function parseSignup(body: unknown): Result {
  if (typeof body !== "object" || body === null) return { ok: false, error: "body must be an object" };
  const b = body as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const installId = str(b.installId);
  const name = str(b.name);
  const email = str(b.email);
  const appVersion = str(b.appVersion).slice(0, 50);
  const platform = str(b.platform).slice(0, 50);
  if (!UUID.test(installId)) return { ok: false, error: "invalid installId" };
  if (name.length < 1 || name.length > 200) return { ok: false, error: "invalid name" };
  if (email.length < 3 || email.length > 320 || !EMAIL.test(email)) return { ok: false, error: "invalid email" };
  return { ok: true, value: { installId, name, email, appVersion, platform } };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter signups exec vitest run src/validate.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/signups/src/validate.ts apps/signups/src/validate.test.ts
git commit -m "feat(signups): payload validation"
```

## Task 3: Per-IP rate limiter

**Files:**
- Create: `apps/signups/src/rateLimit.ts`
- Test: `apps/signups/src/rateLimit.test.ts`

- [ ] **Step 1: Write the failing test** — `apps/signups/src/rateLimit.test.ts`

```ts
import { test, expect } from "vitest";
import { createRateLimiter } from "./rateLimit";

test("allows up to the limit, then blocks, then resets after the window", () => {
  let t = 1000;
  const allow = createRateLimiter(2, 60_000, () => t);
  expect(allow("ip")).toBe(true);
  expect(allow("ip")).toBe(true);
  expect(allow("ip")).toBe(false); // 3rd in window
  t += 60_000;
  expect(allow("ip")).toBe(true); // window reset
});

test("tracks keys independently", () => {
  const allow = createRateLimiter(1, 60_000, () => 0);
  expect(allow("a")).toBe(true);
  expect(allow("b")).toBe(true);
  expect(allow("a")).toBe(false);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter signups exec vitest run src/rateLimit.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `apps/signups/src/rateLimit.ts`**

```ts
/** Fixed-window per-key limiter. `now` is injectable for tests. */
export function createRateLimiter(limit: number, windowMs: number, now: () => number = Date.now) {
  const hits = new Map<string, { count: number; reset: number }>();
  return function allow(key: string): boolean {
    const t = now();
    const e = hits.get(key);
    if (!e || t >= e.reset) {
      hits.set(key, { count: 1, reset: t + windowMs });
      return true;
    }
    if (e.count >= limit) return false;
    e.count++;
    return true;
  };
}
```

- [ ] **Step 4: Run to verify it passes** — `pnpm --filter signups exec vitest run src/rateLimit.test.ts` → PASS (2).

- [ ] **Step 5: Commit**

```bash
git add apps/signups/src/rateLimit.ts apps/signups/src/rateLimit.test.ts
git commit -m "feat(signups): per-IP rate limiter"
```

## Task 4: Database layer (schema + upsert)

**Files:**
- Create: `apps/signups/src/db.ts`
- Test: `apps/signups/src/db.test.ts`

- [ ] **Step 1: Write the failing test** — `apps/signups/src/db.test.ts` (uses `pg-mem`, an in-memory postgres)

```ts
import { test, expect, beforeEach } from "vitest";
import { newDb } from "pg-mem";
import { ensureSchema, upsertSignup } from "./db";
import type { Pool } from "pg";

function makePool(): Pool {
  const { Pool } = newDb().adapters.createPg();
  return new Pool() as unknown as Pool;
}

const s = {
  installId: "11111111-1111-4111-8111-111111111111",
  name: "Jane",
  email: "jane@acme.com",
  appVersion: "0.1.0",
  platform: "darwin",
};

let pool: Pool;
beforeEach(async () => {
  pool = makePool();
  await ensureSchema(pool);
});

test("ensureSchema is idempotent", async () => {
  await ensureSchema(pool); // second call must not throw
  const r = await pool.query("SELECT count(*)::int AS n FROM signups");
  expect(r.rows[0].n).toBe(0);
});

test("insert then upsert by installId keeps one row and updates fields", async () => {
  await upsertSignup(pool, s);
  await upsertSignup(pool, { ...s, name: "Jane Updated", email: "jane2@acme.com" });
  const r = await pool.query("SELECT name, email, first_seen, last_seen FROM signups");
  expect(r.rows.length).toBe(1);
  expect(r.rows[0].name).toBe("Jane Updated");
  expect(r.rows[0].email).toBe("jane2@acme.com");
});
```

- [ ] **Step 2: Run to verify it fails** — `pnpm --filter signups exec vitest run src/db.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement `apps/signups/src/db.ts`**

```ts
import type { Pool } from "pg";
import type { Signup } from "./validate";

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS signups (
  install_id  uuid PRIMARY KEY,
  email       text NOT NULL,
  name        text NOT NULL,
  app_version text,
  platform    text,
  first_seen  timestamptz NOT NULL DEFAULT now(),
  last_seen   timestamptz NOT NULL DEFAULT now()
);`;

export async function ensureSchema(pool: Pool): Promise<void> {
  await pool.query(SCHEMA);
}

export async function upsertSignup(pool: Pool, s: Signup): Promise<void> {
  await pool.query(
    `INSERT INTO signups (install_id, email, name, app_version, platform)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (install_id) DO UPDATE SET
       email       = EXCLUDED.email,
       name        = EXCLUDED.name,
       app_version = EXCLUDED.app_version,
       platform    = EXCLUDED.platform,
       last_seen   = now();`,
    [s.installId, s.email, s.name, s.appVersion, s.platform],
  );
}
```

- [ ] **Step 4: Run to verify it passes** — `pnpm --filter signups exec vitest run src/db.test.ts` → PASS (2).

  If `pg-mem` rejects `timestamptz DEFAULT now()` or `ON CONFLICT`, switch the test to assert via `upsertSignup` twice + a `SELECT count(*)` only (drop the timestamp assertions) — the production SQL stays as written (it targets real postgres).

- [ ] **Step 5: Commit**

```bash
git add apps/signups/src/db.ts apps/signups/src/db.test.ts
git commit -m "feat(signups): schema + upsert-by-installId"
```

## Task 5: HTTP app (routes)

**Files:**
- Create: `apps/signups/src/app.ts`
- Test: `apps/signups/src/app.test.ts`

- [ ] **Step 1: Write the failing test** — `apps/signups/src/app.test.ts`

```ts
import { test, expect } from "vitest";
import { createApp } from "./app";
import type { Signup } from "./validate";

const valid = {
  installId: "11111111-1111-4111-8111-111111111111",
  name: "Jane",
  email: "jane@acme.com",
  appVersion: "0.1.0",
  platform: "darwin",
};

function make(over: Partial<Parameters<typeof createApp>[0]> = {}) {
  const calls: Signup[] = [];
  const app = createApp({ appKey: "secret", upsert: async (s) => { calls.push(s); }, allow: () => true, ...over });
  return { app, calls };
}

const post = (app: ReturnType<typeof createApp>, body: unknown, key = "secret") =>
  app.request("/signups", {
    method: "POST",
    headers: { "content-type": "application/json", "x-rigel-key": key },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

test("health is 200", async () => {
  const { app } = make();
  expect((await app.request("/health")).status).toBe(200);
});

test("valid signup → 200 and upsert called", async () => {
  const { app, calls } = make();
  const res = await post(app, valid);
  expect(res.status).toBe(200);
  expect(calls).toEqual([valid]);
});

test("wrong app key → 401, no upsert", async () => {
  const { app, calls } = make();
  expect((await post(app, valid, "wrong")).status).toBe(401);
  expect(calls.length).toBe(0);
});

test("invalid body → 400", async () => {
  const { app } = make();
  expect((await post(app, { ...valid, email: "nope" })).status).toBe(400);
});

test("malformed JSON → 400", async () => {
  const { app } = make();
  expect((await post(app, "{not json")).status).toBe(400);
});

test("rate-limited → 429", async () => {
  const { app } = make({ allow: () => false });
  expect((await post(app, valid)).status).toBe(429);
});
```

- [ ] **Step 2: Run to verify it fails** — `pnpm --filter signups exec vitest run src/app.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement `apps/signups/src/app.ts`**

```ts
import { Hono } from "hono";
import { parseSignup, type Signup } from "./validate";

export interface AppDeps {
  appKey: string;
  upsert: (s: Signup) => Promise<void>;
  allow: (key: string) => boolean;
}

export function createApp({ appKey, upsert, allow }: AppDeps): Hono {
  const app = new Hono();

  app.get("/health", (c) => c.json({ ok: true }));

  app.post("/signups", async (c) => {
    if (c.req.header("x-rigel-key") !== appKey) return c.json({ error: "unauthorized" }, 401);
    const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
    if (!allow(ip)) return c.json({ error: "rate limited" }, 429);
    let body: unknown;
    try { body = await c.req.json(); } catch { return c.json({ error: "invalid json" }, 400); }
    const parsed = parseSignup(body);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    await upsert(parsed.value);
    return c.json({ ok: true });
  });

  return app;
}
```

- [ ] **Step 4: Run to verify it passes** — `pnpm --filter signups exec vitest run src/app.test.ts` → PASS (6).

- [ ] **Step 5: Commit**

```bash
git add apps/signups/src/app.ts apps/signups/src/app.test.ts
git commit -m "feat(signups): HTTP routes (POST /signups, /health)"
```

## Task 6: Server entry + Dockerfile

**Files:**
- Create: `apps/signups/src/index.ts`
- Create: `apps/signups/Dockerfile`

- [ ] **Step 1: Implement `apps/signups/src/index.ts`**

```ts
import { serve } from "@hono/node-server";
import pg from "pg";
import { createApp } from "./app";
import { ensureSchema, upsertSignup } from "./db";
import { createRateLimiter } from "./rateLimit";

const PORT = Number(process.env.PORT ?? 8080);
const APP_KEY = process.env.APP_KEY ?? "";
const DATABASE_URL = process.env.DATABASE_URL ?? "";
if (!APP_KEY) { console.error("APP_KEY is required"); process.exit(1); }
if (!DATABASE_URL) { console.error("DATABASE_URL is required"); process.exit(1); }

const pool = new pg.Pool({ connectionString: DATABASE_URL });
await ensureSchema(pool);

const allow = createRateLimiter(30, 60_000); // 30 req/min per IP
const app = createApp({ appKey: APP_KEY, upsert: (s) => upsertSignup(pool, s), allow });

serve({ fetch: app.fetch, port: PORT, hostname: "0.0.0.0" }, (info) =>
  console.log(`signups api on :${info.port}`),
);
```

- [ ] **Step 2: Verify it boots locally against pg-mem-free DB**

Run (needs a throwaway postgres or skip): `APP_KEY=x DATABASE_URL=postgres://… pnpm --filter signups dev` then `curl -s localhost:8080/health` → `{"ok":true}`. If no local postgres handy, skip — covered by app.test.ts + the deploy smoke (Task 10).

- [ ] **Step 3: Verify the bundle builds** — `pnpm --filter signups build` → produces `apps/signups/dist/signups.mjs`, no error.

- [ ] **Step 4: Create `apps/signups/Dockerfile`** (two-stage; runtime runs the esbuild bundle — no node_modules needed since `pg` is pure JS)

```dockerfile
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
```

- [ ] **Step 5: Verify the image builds** — `docker build -t rigel-signups:test -f apps/signups/Dockerfile .` → succeeds.

- [ ] **Step 6: Commit**

```bash
git add apps/signups/src/index.ts apps/signups/Dockerfile
git commit -m "feat(signups): server entry + Dockerfile"
```

## Task 7: CI workflow

**Files:**
- Create: `.github/workflows/signups-build.yml`

- [ ] **Step 1: Create the workflow** (mirror `.github/workflows/marketing-build.yml`: build+push to GHCR, then the standard deploy job)

```yaml
name: Build Rigel signups image

on:
  push:
    branches: [master]
    paths: ["apps/signups/**", ".github/workflows/signups-build.yml"]
  workflow_dispatch:

jobs:
  build:
    runs-on: ubuntu-latest
    permissions: { contents: read, packages: write }
    steps:
      - uses: actions/checkout@v5
      - uses: docker/login-action@v3
        with: { registry: ghcr.io, username: ${{ github.actor }}, password: ${{ secrets.GITHUB_TOKEN }} }
      - uses: docker/build-push-action@v6
        with:
          context: .
          file: apps/signups/Dockerfile
          push: true
          tags: ghcr.io/tyrelchambers/rigel-signups:latest

  deploy:
    runs-on: ubuntu-latest
    needs: build
    permissions: { contents: read }
    steps:
      - uses: actions/checkout@v5
      - name: Load kubeconfig from 1Password
        uses: 1password/load-secrets-action@v3
        with: { export-env: true }
        env:
          OP_SERVICE_ACCOUNT_TOKEN: ${{ secrets.OP_SERVICE_ACCOUNT_TOKEN }}
          KUBECONFIG_B64: op://App Secrets/Kubeconfig/notesPlain
      - name: Connect to Tailscale
        uses: tailscale/github-action@v3
        with:
          oauth-client-id: ${{ secrets.TS_OAUTH_CLIENT_ID }}
          oauth-secret: ${{ secrets.TS_OAUTH_SECRET }}
          tags: tag:ci
      - name: Set up kubeconfig
        run: |
          mkdir -p ~/.kube
          echo "$KUBECONFIG_B64" | base64 -d > ~/.kube/config
          chmod 600 ~/.kube/config
      - name: Apply manifests and roll out
        run: |
          kubectl apply -f apps/signups/k8s/deployment.yaml -f apps/signups/k8s/service.yaml
          kubectl rollout restart deployment/rigel-signups -n default
```

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/signups-build.yml
git commit -m "ci(signups): build image + deploy"
```

---

# Phase 2 — Database + k8s infra

> These tasks run against the live cluster (context `default`). They are infra, not unit-tested; each has an explicit verification command.

## Task 8: Create the `rigel` DB + role in the existing CNPG cluster

**Files:** Create `apps/signups/k8s/db-secret.example.yaml` (a template; the real Secret is applied by hand, not committed).

- [ ] **Step 1: Find the CNPG cluster**

Run: `kubectl get clusters.postgresql.cnpg.io -A`
Note the cluster `NAME` + `NAMESPACE` (likely `default`) and its read-write service `<cluster>-rw`.

- [ ] **Step 2: Create the `rigel` database + a least-privilege role**

Run (substitute `<cluster>` + a generated password `<PW>`):
```bash
kubectl exec -it -n default <cluster>-1 -- psql -U postgres -c "CREATE DATABASE rigel;"
kubectl exec -it -n default <cluster>-1 -- psql -U postgres -d rigel -c "CREATE ROLE rigel_app LOGIN PASSWORD '<PW>'; GRANT ALL ON SCHEMA public TO rigel_app;"
```
(The service's `ensureSchema()` creates the `signups` table on first start; `rigel_app` owns the public schema so the `CREATE TABLE IF NOT EXISTS` succeeds.)

- [ ] **Step 3: Create the runtime Secret (DATABASE_URL + APP_KEY)**

Generate an app key: `openssl rand -hex 24`. Then:
```bash
kubectl create secret generic rigel-signups -n default \
  --from-literal=DATABASE_URL="postgres://rigel_app:<PW>@<cluster>-rw.default.svc:5432/rigel" \
  --from-literal=APP_KEY="<app-key>"
```
Record the `<app-key>` — the desktop client (Task 13) needs the same value.

- [ ] **Step 4: Create `apps/signups/k8s/db-secret.example.yaml`** (committed template, no real secrets)

```yaml
# Template only — create the real Secret with `kubectl create secret` (Task 8 Step 3).
apiVersion: v1
kind: Secret
metadata: { name: rigel-signups, namespace: default }
stringData:
  DATABASE_URL: postgres://rigel_app:CHANGEME@<cnpg-cluster>-rw.default.svc:5432/rigel
  APP_KEY: CHANGEME
```

- [ ] **Step 5: Verify** — `kubectl get secret rigel-signups -n default` exists.

- [ ] **Step 6: Commit** — `git add apps/signups/k8s/db-secret.example.yaml && git commit -m "infra(signups): rigel DB + secret template"`

## Task 9: k8s manifests for the service

**Files:** Create `apps/signups/k8s/{deployment,service,ingress}.yaml` (mirror `apps/marketing/k8s/`).

- [ ] **Step 1: `apps/signups/k8s/deployment.yaml`**

```yaml
apiVersion: apps/v1
kind: Deployment
metadata: { name: rigel-signups, namespace: default }
spec:
  replicas: 1
  selector: { matchLabels: { app: rigel-signups } }
  template:
    metadata: { labels: { app: rigel-signups } }
    spec:
      containers:
        - name: signups
          image: ghcr.io/tyrelchambers/rigel-signups:latest
          ports: [{ containerPort: 8080 }]
          envFrom: [{ secretRef: { name: rigel-signups } }]
          readinessProbe: { httpGet: { path: /health, port: 8080 }, initialDelaySeconds: 3 }
          livenessProbe: { httpGet: { path: /health, port: 8080 }, initialDelaySeconds: 10 }
```

- [ ] **Step 2: `apps/signups/k8s/service.yaml`**

```yaml
apiVersion: v1
kind: Service
metadata: { name: rigel-signups, namespace: default }
spec:
  selector: { app: rigel-signups }
  ports: [{ port: 80, targetPort: 8080 }]
```

- [ ] **Step 3: `apps/signups/k8s/ingress.yaml`** (copy annotations/class from `apps/marketing/k8s/ingress.yaml` — traefik + cert-manager `letsencrypt-prod`)

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: rigel-signups
  namespace: default
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-prod
spec:
  ingressClassName: traefik
  tls: [{ hosts: [api.rigel.run], secretName: rigel-signups-tls }]
  rules:
    - host: api.rigel.run
      http:
        paths:
          - path: /
            pathType: Prefix
            backend: { service: { name: rigel-signups, port: { number: 80 } } }
```
(Match the exact `ingressClassName`/annotations used in `apps/marketing/k8s/ingress.yaml`.)

- [ ] **Step 4: Commit** — `git add apps/signups/k8s/{deployment,service,ingress}.yaml && git commit -m "infra(signups): k8s deployment/service/ingress"`

## Task 10: DNS + deploy + smoke

- [ ] **Step 1: DNS (manual, maintainer)** — add an `A` record `api.rigel.run → 159.203.36.138`.
- [ ] **Step 2: Build/push the image** — push to `master` (triggers CI) or `docker build` + `docker push ghcr.io/tyrelchambers/rigel-signups:latest`.
- [ ] **Step 3: Apply** — `kubectl apply -f apps/signups/k8s/deployment.yaml -f apps/signups/k8s/service.yaml -f apps/signups/k8s/ingress.yaml`.
- [ ] **Step 4: Verify TLS issued** — `kubectl get certificate rigel-signups-tls -n default` → `READY=True` (give cert-manager a minute).
- [ ] **Step 5: Smoke** — `curl -s https://api.rigel.run/health` → `{"ok":true}`; then a signed POST:
```bash
curl -s -X POST https://api.rigel.run/signups -H "x-rigel-key: <app-key>" -H "content-type: application/json" \
  -d '{"installId":"11111111-1111-4111-8111-111111111111","name":"Smoke","email":"smoke@test.com","appVersion":"0","platform":"test"}'
```
→ `{"ok":true}`; confirm the row: `kubectl exec -n default <cluster>-1 -- psql -U postgres -d rigel -c "SELECT email,name FROM signups;"`.

---

# Phase 3 — Desktop client (Electron main + preload)

## Task 11: Persistent install identity store

**Files:**
- Modify: `apps/desktop/package.json` (add vitest + `test` script)
- Create: `apps/desktop/src/installStore.ts`
- Test: `apps/desktop/src/installStore.test.ts`

- [ ] **Step 1: Add test tooling to `apps/desktop/package.json`** — add `"test": "vitest run --passWithNoTests"` to `scripts` and `"vitest": "latest"` to `devDependencies`; then `pnpm install`.

- [ ] **Step 2: Write the failing test** — `apps/desktop/src/installStore.test.ts`

```ts
import { test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InstallStore } from "./installStore";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "rigel-install-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

test("generates a stable installId persisted across instances", () => {
  const a = new InstallStore(dir);
  const id = a.installId;
  expect(id).toMatch(/^[0-9a-f-]{36}$/);
  expect(new InstallStore(dir).installId).toBe(id); // reloaded
});

test("starts uncaptured; setCapturedWithPending flips captured + stores pending; clearPending clears", () => {
  const s = new InstallStore(dir);
  expect(s.captured).toBe(false);
  const payload = { installId: s.installId, name: "J", email: "j@x.com", appVersion: "0", platform: "darwin" };
  s.setCapturedWithPending(payload);
  expect(s.captured).toBe(true);
  expect(new InstallStore(dir).pending).toEqual(payload); // persisted
  s.clearPending();
  expect(new InstallStore(dir).pending).toBeNull();
  expect(new InstallStore(dir).captured).toBe(true); // captured stays
});
```

- [ ] **Step 3: Run to verify it fails** — `pnpm --filter desktop test` → FAIL (module not found).

- [ ] **Step 4: Implement `apps/desktop/src/installStore.ts`**

```ts
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface SignupPayload {
  installId: string;
  name: string;
  email: string;
  appVersion: string;
  platform: string;
}
interface State { installId: string; captured: boolean; pending: SignupPayload | null }

export class InstallStore {
  private file: string;
  private state: State;
  constructor(userDataDir: string) {
    this.file = join(userDataDir, "rigel-install.json");
    this.state = this.load();
    if (!this.state.installId) { this.state.installId = randomUUID(); this.save(); }
  }
  private load(): State {
    try {
      const s = JSON.parse(readFileSync(this.file, "utf8"));
      return { installId: s.installId ?? "", captured: !!s.captured, pending: s.pending ?? null };
    } catch { return { installId: "", captured: false, pending: null }; }
  }
  private save() { writeFileSync(this.file, JSON.stringify(this.state), { mode: 0o600 }); }
  get installId() { return this.state.installId; }
  get captured() { return this.state.captured; }
  get pending() { return this.state.pending; }
  setCapturedWithPending(p: SignupPayload) { this.state.captured = true; this.state.pending = p; this.save(); }
  clearPending() { this.state.pending = null; this.save(); }
}
```

- [ ] **Step 5: Run to verify it passes** — `pnpm --filter desktop test` → PASS (2).

- [ ] **Step 6: Commit** — `git add apps/desktop/package.json apps/desktop/src/installStore.ts apps/desktop/src/installStore.test.ts pnpm-lock.yaml && git commit -m "feat(desktop): persistent install-identity store"`

## Task 12: Signup delivery + retry

**Files:**
- Create: `apps/desktop/src/signup.ts`
- Test: `apps/desktop/src/signup.test.ts`

- [ ] **Step 1: Write the failing test** — `apps/desktop/src/signup.test.ts`

```ts
import { test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InstallStore } from "./installStore";
import { submitSignup, deliver } from "./signup";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "rigel-signup-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const okFetch = async () => ({ ok: true }) as Response;
const failFetch = async () => { throw new Error("offline"); };

test("submit captures + delivers; pending cleared on 2xx", async () => {
  const s = new InstallStore(dir);
  let posted = 0;
  const fetchFn = (async (_u: string, init: RequestInit) => { posted++; return { ok: true } as Response; }) as typeof fetch;
  const r = await submitSignup(s, fetchFn, "https://api", "key", "Jane", "j@x.com", "0.1.0", "darwin");
  expect(r.ok).toBe(true);
  expect(s.captured).toBe(true);
  expect(posted).toBe(1);
  expect(s.pending).toBeNull();
});

test("submit still captures when delivery fails; pending kept for retry", async () => {
  const s = new InstallStore(dir);
  const r = await submitSignup(s, failFetch as unknown as typeof fetch, "https://api", "key", "Jane", "j@x.com", "0.1.0", "darwin");
  expect(r.ok).toBe(true);     // user is NOT blocked
  expect(s.captured).toBe(true);
  expect(s.pending).not.toBeNull();
});

test("deliver clears pending on success and is a no-op with no pending", async () => {
  const s = new InstallStore(dir);
  expect(await deliver(s, okFetch as unknown as typeof fetch, "https://api", "key")).toBe(true); // no pending
  s.setCapturedWithPending({ installId: s.installId, name: "J", email: "j@x.com", appVersion: "0", platform: "d" });
  expect(await deliver(s, okFetch as unknown as typeof fetch, "https://api", "key")).toBe(true);
  expect(s.pending).toBeNull();
});
```

- [ ] **Step 2: Run to verify it fails** — `pnpm --filter desktop test src/signup.test.ts` → FAIL.

- [ ] **Step 3: Implement `apps/desktop/src/signup.ts`**

```ts
import type { InstallStore, SignupPayload } from "./installStore";

/** POST the pending payload; clear it on a 2xx. Returns true if delivered (or nothing pending). */
export async function deliver(store: InstallStore, fetchFn: typeof fetch, endpoint: string, appKey: string): Promise<boolean> {
  const p = store.pending;
  if (!p) return true;
  try {
    const res = await fetchFn(`${endpoint}/signups`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-rigel-key": appKey },
      body: JSON.stringify(p),
    });
    if (res.ok) { store.clearPending(); return true; }
    return false;
  } catch { return false; }
}

/** Gate satisfied the instant the user submits: capture locally, then best-effort deliver. */
export async function submitSignup(
  store: InstallStore, fetchFn: typeof fetch, endpoint: string, appKey: string,
  name: string, email: string, appVersion: string, platform: string,
): Promise<{ ok: true }> {
  const payload: SignupPayload = { installId: store.installId, name, email, appVersion, platform };
  store.setCapturedWithPending(payload);
  await deliver(store, fetchFn, endpoint, appKey);
  return { ok: true };
}
```

- [ ] **Step 4: Run to verify it passes** — `pnpm --filter desktop test` → PASS (all).

- [ ] **Step 5: Commit** — `git add apps/desktop/src/signup.ts apps/desktop/src/signup.test.ts && git commit -m "feat(desktop): signup delivery with background retry"`

## Task 13: Wire the bridge (preload) + IPC handlers (main)

**Files:**
- Modify: `apps/desktop/src/preload.ts`
- Modify: `apps/desktop/src/main.ts`

- [ ] **Step 1: Rewrite `apps/desktop/src/preload.ts`** (rename bridge `rigel`→`rigel`, add the two methods; renderer references none of the old name, verified)

```ts
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("rigel", {
  desktop: true,
  electronVersion: process.versions.electron,
  /** True on first run until the user has submitted name+email. */
  needsSignup: (): Promise<boolean> => ipcRenderer.invoke("rigel:needs-signup"),
  /** Record + deliver the signup. Resolves once captured locally (delivery retries in the background). */
  submitSignup: (data: { name: string; email: string }): Promise<{ ok: true }> =>
    ipcRenderer.invoke("rigel:submit-signup", data),
});
```

- [ ] **Step 2: Wire main (`apps/desktop/src/main.ts`)** — near the top imports add:

```ts
import { ipcMain } from "electron";
import { InstallStore } from "./installStore";
import { submitSignup, deliver } from "./signup";

const SIGNUP_ENDPOINT = "https://api.rigel.run";
const SIGNUP_APP_KEY = "<app-key from Task 8 Step 3>"; // baked-in; obfuscation, not a secret
```

Then inside `app.whenReady().then(...)` (before/around `boot()`), add:

```ts
const installStore = new InstallStore(app.getPath("userData"));
// Background retry of any undelivered signup (offline on a previous run).
void deliver(installStore, fetch, SIGNUP_ENDPOINT, SIGNUP_APP_KEY);

ipcMain.handle("rigel:needs-signup", () => !installStore.captured);
ipcMain.handle("rigel:submit-signup", (_e, data: { name: string; email: string }) =>
  submitSignup(installStore, fetch, SIGNUP_ENDPOINT, SIGNUP_APP_KEY, data.name, data.email, app.getVersion(), process.platform),
);
```

- [ ] **Step 3: Typecheck + build** — `pnpm --filter desktop typecheck` clean; `pnpm --filter desktop build` ok.

- [ ] **Step 4: Commit** — `git add apps/desktop/src/preload.ts apps/desktop/src/main.ts && git commit -m "feat(desktop): rigel bridge + signup IPC + boot retry"`

---

# Phase 4 — Renderer onboarding wizard (multi-step + required first step)

## Task 14: Typed desktop accessor + Stepper

**Files:**
- Create: `apps/web/src/lib/desktop.ts`
- Create: `apps/web/src/shell/onboarding/Stepper.tsx`

- [ ] **Step 1: `apps/web/src/lib/desktop.ts`** (typed window.rigel; undefined on web self-host)

```ts
export interface RigelBridge {
  desktop: true;
  electronVersion: string;
  needsSignup(): Promise<boolean>;
  submitSignup(data: { name: string; email: string }): Promise<{ ok: true }>;
}
export const rigel: RigelBridge | undefined = (window as unknown as { rigel?: RigelBridge }).rigel;
export const isDesktop = !!rigel;
```

- [ ] **Step 2: `apps/web/src/shell/onboarding/Stepper.tsx`** (the visible step indicator)

```tsx
export function Stepper({ labels, current }: { labels: string[]; current: number }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
      {labels.map((label, i) => (
        <div key={label} style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span
            aria-current={i === current ? "step" : undefined}
            style={{
              width: 8, height: 8, borderRadius: 8,
              background: i <= current ? "var(--accent-primary)" : "var(--border)",
            }}
          />
          {i < labels.length - 1 && <span style={{ width: 14, height: 1, background: "var(--border)" }} />}
        </div>
      ))}
      <span style={{ marginLeft: 8, fontSize: 11.5, color: "var(--fg-secondary)" }}>
        Step {current + 1} of {labels.length} · {labels[current]}
      </span>
    </div>
  );
}
```

- [ ] **Step 3: Commit** — `git add apps/web/src/lib/desktop.ts apps/web/src/shell/onboarding/Stepper.tsx && git commit -m "feat(web): desktop bridge accessor + onboarding stepper"`

## Task 15: The required "About you" step

**Files:**
- Create: `apps/web/src/shell/onboarding/AboutYouStep.tsx`
- Test: `apps/web/src/shell/onboarding/AboutYouStep.test.tsx`

- [ ] **Step 1: Write the failing test** — `apps/web/src/shell/onboarding/AboutYouStep.test.tsx` (jsdom + Testing Library, already used by apps/web)

```tsx
import { test, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { AboutYouStep } from "./AboutYouStep";

test("Continue is disabled until name + valid email, then submits and advances", async () => {
  const submit = vi.fn().mockResolvedValue({ ok: true });
  const onDone = vi.fn();
  render(<AboutYouStep submitSignup={submit} onDone={onDone} />);

  const cont = screen.getByRole("button", { name: /continue/i });
  expect(cont).toBeDisabled();

  fireEvent.change(screen.getByLabelText(/name/i), { target: { value: "Jane" } });
  fireEvent.change(screen.getByLabelText(/email/i), { target: { value: "bad" } });
  expect(cont).toBeDisabled(); // invalid email

  fireEvent.change(screen.getByLabelText(/email/i), { target: { value: "jane@acme.com" } });
  expect(cont).toBeEnabled();

  fireEvent.click(cont);
  await waitFor(() => expect(submit).toHaveBeenCalledWith({ name: "Jane", email: "jane@acme.com" }));
  await waitFor(() => expect(onDone).toHaveBeenCalled());
});
```

- [ ] **Step 2: Run to verify it fails** — `pnpm --filter web test src/shell/onboarding/AboutYouStep.test.tsx` → FAIL.

- [ ] **Step 3: Implement `apps/web/src/shell/onboarding/AboutYouStep.tsx`**

```tsx
import { useState } from "react";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function AboutYouStep({
  submitSignup,
  onDone,
}: {
  submitSignup: (d: { name: string; email: string }) => Promise<{ ok: true }>;
  onDone: () => void;
}) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const valid = name.trim().length > 0 && EMAIL.test(email.trim());

  async function submit() {
    if (!valid || busy) return;
    setBusy(true);
    try {
      await submitSignup({ name: name.trim(), email: email.trim() });
      onDone();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <span style={{ fontSize: 12.5, color: "var(--fg-secondary)", lineHeight: 1.5 }}>
        Tell us who you are to get started — so we know who's using Rigel.
      </span>
      <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12.5 }}>
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Jane Doe" />
      </label>
      <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12.5 }}>
        Email
        <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="jane@acme.com" type="email" />
      </label>
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <button type="button" disabled={!valid || busy} onClick={submit}>
          {busy ? "Saving…" : "Continue →"}
        </button>
      </div>
    </div>
  );
}
```
(Match the existing wizard's button/input styling — reuse the `primaryBtn`/input styles from `OnboardingWizard.tsx`.)

- [ ] **Step 4: Run to verify it passes** — `pnpm --filter web test src/shell/onboarding/AboutYouStep.test.tsx` → PASS.

- [ ] **Step 5: Commit** — `git add apps/web/src/shell/onboarding/AboutYouStep.tsx apps/web/src/shell/onboarding/AboutYouStep.test.tsx && git commit -m "feat(web): required About-you onboarding step"`

## Task 16: Make OnboardingWizard multi-step + wire the trigger/lock

**Files:**
- Modify: `apps/web/src/shell/OnboardingWizard.tsx`
- Modify: `apps/web/src/App.tsx`

- [ ] **Step 1: Refactor `OnboardingWizard` into steps.** Convert the four existing cards (`TokenCard`, `AssistantCard`, `MetricsCard`, Signal `ToolCard`) into entries of a `steps` array; render `<Stepper>` + the current step + Back/Skip/Next (Next on the last step says "Done"). Prepend the required About-you step when `aboutYou` is provided. Signature:

```tsx
import { Stepper } from "./onboarding/Stepper";
import { AboutYouStep } from "./onboarding/AboutYouStep";
import { rigel } from "@/lib/desktop";

export function OnboardingWizard({ onClose, requireAboutYou }: { onClose: () => void; requireAboutYou: boolean }) {
  const optionalSteps = [
    { label: "AI copilot", node: <TokenCard /> },
    { label: "Assistant", node: <AssistantCard /> },
    { label: "Metrics", node: <MetricsCard /> },
    { label: "Notifications", node: <SignalCard onClose={onClose} /> },
  ];
  const [aboutDone, setAboutDone] = useState(!requireAboutYou);
  const steps = requireAboutYou && !aboutDone
    ? [{ label: "About you", node: (
        <AboutYouStep submitSignup={(d) => rigel!.submitSignup(d)} onDone={() => { setAboutDone(true); setI(1); }} />
      ) }, ...optionalSteps]
    : optionalSteps;
  const [i, setI] = useState(0);
  const locked = requireAboutYou && !aboutDone; // step 0 cannot be skipped/dismissed
  // ...render: backdrop click + close button are no-ops while `locked`;
  //    <Stepper labels={steps.map(s=>s.label)} current={i} />; steps[i].node;
  //    footer: Back (i>0 && !locked), Skip/Next (hidden on the About-you step), Done on last.
}
```
Key behaviors: while `locked`, the overlay's backdrop-dismiss and the close button do nothing, and there is no Skip on the About-you step (only the step's own "Continue →" advances it). After About-you completes (`onDone`), `locked` becomes false and the rest behave as the normal optional wizard.

- [ ] **Step 2: Wire the trigger in `apps/web/src/App.tsx`.** Replace the current `showOnboarding` effect (around line 80–96) so it also accounts for the desktop required-signup, and pass `requireAboutYou`:

```tsx
import { rigel } from "@/lib/desktop";
// ...
const [showOnboarding, setShowOnboarding] = useState(false);
const [requireAboutYou, setRequireAboutYou] = useState(false);

useEffect(() => {
  let cancelled = false;
  (async () => {
    const needs = rigel ? await rigel.needsSignup() : false;
    if (cancelled) return;
    if (needs) { setRequireAboutYou(true); setShowOnboarding(true); return; }
    // existing optional-onboarding condition:
    if (authed && chatConfig && !chatConfig.configured && !localStorage.getItem("rigel_onboarded")) {
      setShowOnboarding(true);
    }
  })();
  return () => { cancelled = true; };
}, [authed, chatConfig]);

function closeOnboarding() {
  if (requireAboutYou) return; // guarded; the wizard itself only calls onClose once About-you is done
  setShowOnboarding(false);
  localStorage.setItem("rigel_onboarded", "1");
}
// render:
{showOnboarding && <OnboardingWizard onClose={closeOnboarding} requireAboutYou={requireAboutYou} />}
```
(When About-you completes, the wizard sets its internal `aboutDone`; once the user finishes/closes the optional steps, `onClose` runs and — since by then `requireAboutYou` should no longer block — set `requireAboutYou` to false on About-you completion via a callback, or simpler: have the wizard call a passed `onAboutYouDone` that does `setRequireAboutYou(false)`. Thread that prop through.)

- [ ] **Step 3: Typecheck + run web tests** — `pnpm --filter web typecheck` clean; `pnpm --filter web test` green.

- [ ] **Step 4: Commit** — `git add apps/web/src/shell/OnboardingWizard.tsx apps/web/src/App.tsx && git commit -m "feat(web): multi-step onboarding with required desktop signup step"`

---

# Phase 5 — End-to-end verification

- [ ] **Step 1: Web self-host unaffected** — run `pnpm --filter web dev`; the About-you step never appears (no `window.rigel`); onboarding behaves as before (dismissible).
- [ ] **Step 2: Desktop first run** — `pnpm --filter desktop dev` on a clean profile (delete `~/Library/Application Support/Rigel/rigel-install.json` first): the wizard opens **locked** on About-you; you cannot dismiss or skip; entering name+email + Continue advances into the optional steps; finishing closes it.
- [ ] **Step 3: Data landed** — confirm a row in postgres: `kubectl exec -n default <cluster>-1 -- psql -U postgres -d rigel -c "SELECT name,email,app_version,platform FROM signups ORDER BY first_seen DESC LIMIT 5;"`.
- [ ] **Step 4: Resilience** — quit, delete the install file, re-launch with networking off (or a bogus `SIGNUP_ENDPOINT`): you can still complete About-you and use the app; re-enable networking, relaunch → the queued `pending` delivers (row appears) with no prompt.
- [ ] **Step 5: Second launch** — relaunch normally → no About-you prompt (`captured` is set).
- [ ] **Step 6: Full suite** — `pnpm -r test` and `pnpm -r typecheck` green.
