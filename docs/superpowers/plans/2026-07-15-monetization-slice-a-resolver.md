# Monetization Slice A — Billing schema + entitlements resolver Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the `stripe_customer_id` column + a `GET /entitlements` route to `apps/signups` that resolves the union of a signed-in account's active Stripe entitlements across its orgs. Returns free-for-everyone until a subscription exists. No client behavior change.

**Architecture:** `apps/signups` (Hono + node-postgres) gains a `billing.ts` route module + a `stripeAdapter.ts` (thin wrapper over the `stripe` SDK's Entitlements API) + `billingDb` methods on the existing `authDb`. The resolver reads Stripe live (no mirror table) with a ~60s in-process cache. Policy lives entirely in Stripe; the app only ever receives a resolved feature payload.

**Tech Stack:** TypeScript, Hono, node-postgres (`pg`), `stripe` SDK, Vitest (pg pool stubbed via the `recorder()` pattern in `authDb.test.ts`).

**Spec:** `docs/superpowers/specs/2026-07-15-monetization-foundation-design.md`.

---

## File Structure

- **Create** `apps/signups/src/stripeAdapter.ts` — `StripeAdapter` interface + `createStripeAdapter(secretKey)`; the only file that imports `stripe`. Methods used by Slice A: `activeFeatureKeys(customerId)`. (Slice B adds checkout/portal here.)
- **Create** `apps/signups/src/entitlements.ts` — pure `resolvePayload(featureKeys: Set<string>): EntitlementPayload` mapper + the `resolveEntitlements(accountId, deps)` orchestrator with the 60s cache. No `stripe`/`pg` imports (deps injected) so it unit-tests without network/DB.
- **Create** `apps/signups/src/billing.ts` — `registerBillingRoutes(app, deps)` registering `GET /entitlements`.
- **Modify** `apps/signups/src/authDb.ts` — add the `stripe_customer_id` ALTER to `AUTH_SCHEMA`; add `billableOrgs(accountId)` to the `AuthDb` interface + `createAuthDb`.
- **Modify** `apps/signups/src/app.ts` — add optional `billing?` to `AppDeps`, wire `registerBillingRoutes`.
- **Modify** `apps/signups/src/index.ts` — read `STRIPE_SECRET_KEY`, build the adapter + billing deps, pass to `createApp`.
- **Modify** `apps/signups/k8s/db-secret.example.yaml` — document `STRIPE_SECRET_KEY`.
- **Test** `apps/signups/src/entitlements.test.ts`, `apps/signups/src/billing.test.ts`, additions to `apps/signups/src/authDb.test.ts`.
- **Doc** `docs/stripe-setup.md` — the manual Stripe dashboard setup (Product + Features).

**Shared types (defined here, reused in B/C):**
```ts
// entitlements.ts
export type FeatureKey = "reliability" | "security" | "performance" | "cloudConnect" | "agentAutonomy";
export interface EntitlementPayload {
  plan: "free" | "pro";
  audits: ("reliability" | "security" | "performance")[];
  cloudConnect: boolean;
  agentAutonomy: boolean;
  fetchedAt: string; // ISO
}
```

---

## Task 1: Add the `stripe` dependency + env wiring

**Files:**
- Modify: `apps/signups/package.json`
- Modify: `apps/signups/src/index.ts:10-24`
- Modify: `apps/signups/k8s/db-secret.example.yaml`

- [ ] **Step 1: Add the dependency.** In `apps/signups/package.json`, add `"stripe": "latest"` to `dependencies` (alongside `hono`, `pg`). Run `pnpm install --filter @rigel/signups`.

- [ ] **Step 2: Read the secret in `index.ts`.** After the existing env reads (`index.ts:10-16`), add:
```ts
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY ?? "";
```
Below the required fail-fast block (`:17-18`) add a soft-warn matching the `KIT_API_KEY` idiom (`:19-20`):
```ts
if (!STRIPE_SECRET_KEY) console.warn("[signups] STRIPE_SECRET_KEY unset — /entitlements returns free for everyone");
```

- [ ] **Step 3: Document the secret.** In `apps/signups/k8s/db-secret.example.yaml`, under `stringData:`, add:
```yaml
  STRIPE_SECRET_KEY: "sk_live_..."   # Stripe restricted key; entitlements + billing
```

- [ ] **Step 4: Commit.**
```bash
git add apps/signups/package.json apps/signups/src/index.ts apps/signups/k8s/db-secret.example.yaml pnpm-lock.yaml
git commit -m "chore(signups): add stripe dependency + STRIPE_SECRET_KEY env"
```

---

## Task 2: Schema migration + `billableOrgs` DB method

The `organizations` table shipped without `stripe_customer_id`. `AUTH_SCHEMA` is one multi-statement string applied via a single `pool.query` (`authDb.ts:94-96`); idempotent ALTERs are inlined after their table (existing example: `authDb.ts:55`). Add the column + a partial unique index there.

**Files:**
- Modify: `apps/signups/src/authDb.ts` (AUTH_SCHEMA `:67-83`; interface `:18-32`; factory `:98-219`)
- Test: `apps/signups/src/authDb.test.ts`

- [ ] **Step 1: Add the migration to `AUTH_SCHEMA`.** Immediately after the `organizations` `CREATE TABLE` (ends `authDb.ts:74`), insert:
```sql
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS stripe_customer_id text;
CREATE UNIQUE INDEX IF NOT EXISTS organizations_stripe_customer_idx
  ON organizations (stripe_customer_id) WHERE stripe_customer_id IS NOT NULL;
```

- [ ] **Step 2: Write the failing test for `billableOrgs`.** In `authDb.test.ts`, using the existing `recorder()` helper:
```ts
test("billableOrgs returns each membership org id + its stripe customer", async () => {
  const { pool, calls, push } = recorder();
  push({ org_id: "org-1", stripe_customer_id: "cus_1" });
  push({ org_id: "org-2", stripe_customer_id: null });
  const db = createAuthDb(pool);
  const rows = await db.billableOrgs("acc-1");
  expect(calls[0].params).toEqual(["acc-1"]);
  expect(calls[0].sql.toUpperCase()).toContain("JOIN ORGANIZATIONS");
  expect(rows).toEqual([
    { orgId: "org-1", stripeCustomerId: "cus_1" },
    { orgId: "org-2", stripeCustomerId: null },
  ]);
});
```

- [ ] **Step 2b: Run it → FAIL** (`billableOrgs` not a function).
Run: `pnpm --filter @rigel/signups test authDb`

- [ ] **Step 3: Add to the `AuthDb` interface** (`authDb.ts:18-32`):
```ts
billableOrgs(accountId: string): Promise<{ orgId: string; stripeCustomerId: string | null }[]>;
```
- [ ] **Step 4: Implement in `createAuthDb`** (add alongside `getOrgsForAccount`, `:113-122`):
```ts
async billableOrgs(accountId) {
  const r = await pool.query(
    `SELECT o.id AS org_id, o.stripe_customer_id
       FROM memberships m JOIN organizations o ON o.id = m.org_id
      WHERE m.account_id = $1`,
    [accountId],
  );
  return r.rows.map((x: { org_id: string; stripe_customer_id: string | null }) => ({
    orgId: x.org_id,
    stripeCustomerId: x.stripe_customer_id,
  }));
},
```
- [ ] **Step 5: Run → PASS.** `pnpm --filter @rigel/signups test authDb`

- [ ] **Step 6: Commit.**
```bash
git add apps/signups/src/authDb.ts apps/signups/src/authDb.test.ts
git commit -m "feat(signups): stripe_customer_id column + billableOrgs query"
```

---

## Task 3: Stripe adapter (`activeFeatureKeys`)

**Files:**
- Create: `apps/signups/src/stripeAdapter.ts`
- Test: `apps/signups/src/stripeAdapter.test.ts`

The adapter is the ONLY file importing `stripe`. Slice A needs one method: list the active entitlement feature keys ("lookup keys") for a customer via Stripe's Entitlements API (`stripe.entitlements.activeEntitlements.list({ customer })`), each entitlement carrying `lookup_key`.

- [ ] **Step 1: Write the failing test** (inject a fake stripe client so no network):
```ts
import { test, expect, vi } from "vitest";
import { makeStripeAdapter } from "./stripeAdapter";

test("activeFeatureKeys returns the entitlements' lookup keys", async () => {
  const list = vi.fn(async () => ({ data: [{ lookup_key: "reliability" }, { lookup_key: "cloudConnect" }] }));
  const adapter = makeStripeAdapter({ entitlements: { activeEntitlements: { list } } } as never);
  const keys = await adapter.activeFeatureKeys("cus_1");
  expect(list).toHaveBeenCalledWith({ customer: "cus_1", limit: 100 });
  expect([...keys]).toEqual(["reliability", "cloudConnect"]);
});
```

- [ ] **Step 2: Run → FAIL.** `pnpm --filter @rigel/signups test stripeAdapter`

- [ ] **Step 3: Implement.**
```ts
import Stripe from "stripe";

export interface StripeAdapter {
  activeFeatureKeys(customerId: string): Promise<Set<string>>;
}

// Injectable core for tests (takes a stripe-shaped client).
export function makeStripeAdapter(stripe: Pick<Stripe, "entitlements">): StripeAdapter {
  return {
    async activeFeatureKeys(customerId) {
      const res = await stripe.entitlements.activeEntitlements.list({ customer: customerId, limit: 100 });
      return new Set(res.data.map((e) => e.lookup_key).filter((k): k is string => !!k));
    },
  };
}

// Production factory (real SDK).
export function createStripeAdapter(secretKey: string): StripeAdapter {
  return makeStripeAdapter(new Stripe(secretKey));
}
```

- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit.**
```bash
git add apps/signups/src/stripeAdapter.ts apps/signups/src/stripeAdapter.test.ts
git commit -m "feat(signups): stripe adapter — activeFeatureKeys via Entitlements API"
```

---

## Task 4: Entitlement resolver (pure mapper + orchestrator + cache)

**Files:**
- Create: `apps/signups/src/entitlements.ts`
- Test: `apps/signups/src/entitlements.test.ts`

- [ ] **Step 1: Write the failing tests.**
```ts
import { test, expect, vi } from "vitest";
import { resolvePayload, makeResolver } from "./entitlements";

test("resolvePayload: no features → free", () => {
  const p = resolvePayload(new Set(), "2026-07-15T00:00:00.000Z");
  expect(p).toMatchObject({ plan: "free", audits: [], cloudConnect: false, agentAutonomy: false });
});

test("resolvePayload: unions features into the shaped payload", () => {
  const p = resolvePayload(new Set(["reliability", "security", "cloudConnect"]), "2026-07-15T00:00:00.000Z");
  expect(p.plan).toBe("pro");
  expect(p.audits.sort()).toEqual(["reliability", "security"]);
  expect(p.cloudConnect).toBe(true);
  expect(p.agentAutonomy).toBe(false);
});

test("resolveEntitlements unions across billable orgs, skipping orgs with no customer", async () => {
  const billableOrgs = vi.fn(async () => [
    { orgId: "o1", stripeCustomerId: "cus_1" },
    { orgId: "o2", stripeCustomerId: null },
    { orgId: "o3", stripeCustomerId: "cus_3" },
  ]);
  const activeFeatureKeys = vi.fn(async (c: string) =>
    c === "cus_1" ? new Set(["reliability"]) : new Set(["cloudConnect"]));
  const resolve = makeResolver({ db: { billableOrgs }, stripe: { activeFeatureKeys }, now: () => "2026-07-15T00:00:00.000Z" });
  const p = await resolve("acc-1");
  expect(activeFeatureKeys).toHaveBeenCalledTimes(2); // skipped cus-less org
  expect(p.audits).toEqual(["reliability"]);
  expect(p.cloudConnect).toBe(true);
});

test("resolveEntitlements caches per account for ~60s", async () => {
  const billableOrgs = vi.fn(async () => [{ orgId: "o1", stripeCustomerId: "cus_1" }]);
  const activeFeatureKeys = vi.fn(async () => new Set(["security"]));
  let t = 1_000_000;
  const resolve = makeResolver({ db: { billableOrgs }, stripe: { activeFeatureKeys }, now: () => new Date(t).toISOString(), monoNow: () => t });
  await resolve("acc-1");
  await resolve("acc-1"); // within window
  expect(billableOrgs).toHaveBeenCalledTimes(1);
  t += 61_000;
  await resolve("acc-1"); // window expired
  expect(billableOrgs).toHaveBeenCalledTimes(2);
});
```

- [ ] **Step 2: Run → FAIL.** `pnpm --filter @rigel/signups test entitlements`

- [ ] **Step 3: Implement.**
```ts
export type FeatureKey = "reliability" | "security" | "performance" | "cloudConnect" | "agentAutonomy";
const AUDIT_KEYS = ["reliability", "security", "performance"] as const;

export interface EntitlementPayload {
  plan: "free" | "pro";
  audits: ("reliability" | "security" | "performance")[];
  cloudConnect: boolean;
  agentAutonomy: boolean;
  fetchedAt: string;
}

export function resolvePayload(keys: Set<string>, fetchedAt: string): EntitlementPayload {
  const audits = AUDIT_KEYS.filter((k) => keys.has(k));
  const cloudConnect = keys.has("cloudConnect");
  const agentAutonomy = keys.has("agentAutonomy");
  const anyPaid = audits.length > 0 || cloudConnect || agentAutonomy;
  return { plan: anyPaid ? "pro" : "free", audits, cloudConnect, agentAutonomy, fetchedAt };
}

export interface ResolverDeps {
  db: { billableOrgs(accountId: string): Promise<{ orgId: string; stripeCustomerId: string | null }[]> };
  stripe: { activeFeatureKeys(customerId: string): Promise<Set<string>> };
  now: () => string;
  monoNow?: () => number; // for cache; defaults to Date.now
}

const CACHE_MS = 60_000;

export function makeResolver(deps: ResolverDeps): (accountId: string) => Promise<EntitlementPayload> {
  const mono = deps.monoNow ?? (() => Date.now());
  const cache = new Map<string, { at: number; payload: EntitlementPayload }>();
  return async (accountId) => {
    const hit = cache.get(accountId);
    if (hit && mono() - hit.at < CACHE_MS) return hit.payload;
    const orgs = await deps.db.billableOrgs(accountId);
    const keys = new Set<string>();
    for (const o of orgs) {
      if (!o.stripeCustomerId) continue;
      for (const k of await deps.stripe.activeFeatureKeys(o.stripeCustomerId)) keys.add(k);
    }
    const payload = resolvePayload(keys, deps.now());
    cache.set(accountId, { at: mono(), payload });
    return payload;
  };
}
```

- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit.**
```bash
git add apps/signups/src/entitlements.ts apps/signups/src/entitlements.test.ts
git commit -m "feat(signups): entitlement resolver — union across orgs + 60s cache"
```

---

## Task 5: `GET /entitlements` route

**Files:**
- Create: `apps/signups/src/billing.ts`
- Test: `apps/signups/src/billing.test.ts`

Bearer auth is a per-route inline check (no middleware) — mirror `/me` (`auth.ts:91-105`): `bearer(c)` → `accountByToken(sha(token))` → 401.

- [ ] **Step 1: Write the failing test** (inject a fake `resolve` + `authDb`):
```ts
import { test, expect, vi } from "vitest";
import { Hono } from "hono";
import { registerBillingRoutes } from "./billing";

function appWith(overrides = {}) {
  const app = new Hono();
  const db = { accountByToken: vi.fn(async () => ({ id: "acc-1", email: "a@b.co", name: null })), touchToken: vi.fn(async () => {}) };
  const resolve = vi.fn(async () => ({ plan: "pro", audits: ["security"], cloudConnect: false, agentAutonomy: false, fetchedAt: "t" }));
  registerBillingRoutes(app, { db: db as never, resolve, ...overrides });
  return { app, db, resolve };
}

test("GET /entitlements returns the resolved payload for a valid token", async () => {
  const { app, resolve } = appWith();
  const res = await app.request("/entitlements", { headers: { authorization: "Bearer tok" } });
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ plan: "pro", audits: ["security"] });
  expect(resolve).toHaveBeenCalledWith("acc-1");
});

test("GET /entitlements 401 without a valid token", async () => {
  const { app } = appWith({ db: { accountByToken: vi.fn(async () => null), touchToken: vi.fn() } });
  const res = await app.request("/entitlements", { headers: { authorization: "Bearer bad" } });
  expect(res.status).toBe(401);
});
```

- [ ] **Step 2: Run → FAIL.** `pnpm --filter @rigel/signups test billing`

- [ ] **Step 3: Implement `billing.ts`.** Reuse the `bearer`/`sha` idiom from `auth.ts` (import them if exported, else replicate the 3-line helpers — check `auth.ts:14,26-30` and export them from a shared `authToken.ts` if not already; if replicating, keep identical: `sha = (t) => createHash("sha256").update(t).digest("hex")`).
```ts
import type { Hono } from "hono";
import { createHash } from "node:crypto";
import type { EntitlementPayload } from "./entitlements";

const sha = (t: string) => createHash("sha256").update(t).digest("hex");
const bearer = (c: { req: { header(n: string): string | undefined } }) => {
  const h = c.req.header("authorization") ?? "";
  return h.startsWith("Bearer ") ? h.slice(7) : null;
};

export interface BillingDeps {
  db: { accountByToken(hash: string): Promise<{ id: string } | null>; touchToken(hash: string): Promise<void> };
  resolve: (accountId: string) => Promise<EntitlementPayload>;
}

export function registerBillingRoutes(app: Hono, deps: BillingDeps): void {
  app.get("/entitlements", async (c) => {
    const token = bearer(c);
    if (!token) return c.json({ error: "unauthorized" }, 401);
    const account = await deps.db.accountByToken(sha(token));
    if (!account) return c.json({ error: "unauthorized" }, 401);
    await deps.db.touchToken(sha(token));
    return c.json(await deps.resolve(account.id));
  });
}
```

- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit.**
```bash
git add apps/signups/src/billing.ts apps/signups/src/billing.test.ts
git commit -m "feat(signups): GET /entitlements route"
```

---

## Task 6: Wire into the app + composition root

**Files:**
- Modify: `apps/signups/src/app.ts:6-14,54`
- Modify: `apps/signups/src/index.ts:22-39`

- [ ] **Step 1: Extend `AppDeps` + wire the route** (`app.ts`). Add to `AppDeps` (`:6-14`): `billing?: import("./billing").BillingDeps;`. After the `if (auth) registerAuthRoutes(app, auth)` line (`:54`) add:
```ts
if (billing) registerBillingRoutes(app, billing);
```
(import `registerBillingRoutes` at top; destructure `billing` from the deps arg).

- [ ] **Step 2: Build the deps in `index.ts`.** After the pool + `ensureAuthSchema(pool)` (`:22-24`) and before `createApp`:
```ts
import { createStripeAdapter, makeStripeAdapter } from "./stripeAdapter";
import { makeResolver } from "./entitlements";
// ...
const stripeAdapter = STRIPE_SECRET_KEY
  ? createStripeAdapter(STRIPE_SECRET_KEY)
  : makeStripeAdapter({ entitlements: { activeEntitlements: { list: async () => ({ data: [] }) } } } as never); // unset key → everyone free
const resolve = makeResolver({ db: authDb, stripe: stripeAdapter, now: () => new Date().toISOString() });
```
Then add to the `createApp({...})` call (`:33-39`): `billing: { db: authDb, resolve },`.
(`authDb` is the object created for the auth routes — reuse it; do not create a second.)

- [ ] **Step 3: Verify end-to-end.** `pnpm --filter @rigel/signups build && pnpm --filter @rigel/signups test`
Expected: all green.

- [ ] **Step 4: Commit.**
```bash
git add apps/signups/src/app.ts apps/signups/src/index.ts
git commit -m "feat(signups): wire /entitlements into the app + composition root"
```

---

## Task 7: Stripe dashboard setup doc (manual, prerequisite for real data)

**Files:**
- Create: `docs/stripe-setup.md`

This is a business/dashboard task, not code — but the exact **lookup keys must match** `entitlements.ts` (`reliability`, `security`, `performance`, `cloudConnect`, `agentAutonomy`) or resolution silently returns free.

- [ ] **Step 1: Write `docs/stripe-setup.md`** documenting:
  1. Create one **Product**: "Rigel Pro". Add a **recurring, per-seat (licensed) Price** (monthly). The dollar amount is your choice; it's never in code.
  2. Create five **Features** (Product catalog → Features) with **lookup keys exactly**: `reliability`, `security`, `performance`, `cloudConnect`, `agentAutonomy`.
  3. **Attach all five Features to the "Rigel Pro" Product.** Any active subscription then grants all five (Stripe Entitlements ignore quantity — seats are billing-only).
  4. Create a **restricted API key** with write on Checkout/Billing/Customers and read on Entitlements; put it in the `rigel-signups` Secret as `STRIPE_SECRET_KEY`.
  5. Note: to make a feature free later, detach it from the Product; to add a new paid feature, create its Feature + add a field in `entitlements.ts` `resolvePayload`.

- [ ] **Step 2: Commit.**
```bash
git add -f docs/stripe-setup.md
git commit -m "docs: Stripe product + feature setup for entitlements"
```

---

## Verification
- `pnpm --filter @rigel/signups test` green (authDb, stripeAdapter, entitlements, billing).
- `pnpm --filter @rigel/signups build` clean.
- With `STRIPE_SECRET_KEY` unset, `GET /entitlements` returns `{ plan: "free", ... }` for any valid token (the stub adapter). With it set and no subscription, same. This is the intended "free for everyone until a subscription exists" state — no client change ships in this slice.

## Self-review notes (author)
- Resolver reads Stripe live (no mirror table), 60s cache — matches the spec's "no subscription-mirror table."
- `stripe_customer_id` added via `ALTER ... IF NOT EXISTS` (not `CREATE TABLE`) — the documented trap.
- The `billing.ts` route reuses the exact `/me` bearer-auth idiom (no middleware exists to hook).
- `authDb` is reused for both auth and billing deps (one pool, one object) — no duplicate DB layer.
