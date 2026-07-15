# Entitlement Lifecycle (live-check) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make the in-cluster agent a free observe-only feature whose premium capabilities (notifications, digests, autonomous remediation, autofix PRs) are gated by a live entitlement check the agent performs against `api.rigel.run` using an install-scoped, org-bound token.

**Architecture:** No lease, no crypto keypair. The agent holds an opaque scoped token (hashed in the DB like account tokens), calls `GET /agent/entitlement` every ~12–24h, caches the answer in its existing `assistant-state` ConfigMap with a 30-day grace window, and gates only the premium branches of `tick()`. Observe + incident recording always run. Downgrade requires an authenticated "free" answer; unreachable/error holds last-known-good. `orgId` is derived from the token server-side, never a request param.

**Tech Stack:** signups = Hono + node-postgres (vitest, pg-mem); agent = Node 22 + kubectl shell-out (vitest); desktop = Electron/TS; server = Node (vitest).

**Design doc:** `docs/superpowers/specs/2026-07-15-entitlement-lifecycle-design.md`

---

## Slice E1 — signups: mint the token + serve entitlement

**Files:**
- Modify: `apps/signups/src/authDb.ts` (schema + methods)
- Modify: `apps/signups/src/billing.ts` (routes) OR a new `apps/signups/src/agent.ts` registered in `index.ts` — prefer a new `agent.ts` module (own responsibility: agent-token mint + entitlement serve), keeps billing.ts focused.
- Modify: `apps/signups/src/index.ts` (wire the new routes + deps)
- Modify: `apps/signups/k8s/db-secret.example.yaml` — **no change needed** (no new signing secret; token is opaque + DB-stored). Confirm and note.
- Test: `apps/signups/src/agent.test.ts`

### Task E1.1: `agent_tokens` schema + authDb methods

**Files:** Modify `apps/signups/src/authDb.ts`; Test `apps/signups/src/authDb.test.ts` (if it exists; else assert via agent.test.ts).

- [ ] **Write failing test** (pg-mem, mirroring existing authDb tests): create an org + membership, call `createAgentToken({ orgId, installId, tokenHash })`, then `agentTokenByHash(tokenHash)` returns `{ orgId, installId, revoked: false }`; an unknown hash returns `null`; a revoked row returns `revoked: true`. Also `orgStripeCustomer(orgId)` returns the org's `stripe_customer_id` (or null).
- [ ] **Schema:** add a `CREATE TABLE IF NOT EXISTS agent_tokens ( id uuid primary key default gen_random_uuid(), token_hash text unique not null, org_id uuid not null references organizations(id) on delete cascade, install_id text not null, revoked boolean not null default false, created_at timestamptz not null default now() )` to the schema-init block alongside the other `CREATE TABLE`s in `authDb.ts`.
- [ ] **Methods on the `AuthDb` interface + impl:**
  - `createAgentToken(input: { orgId: string; installId: string; tokenHash: string }): Promise<void>`
  - `agentTokenByHash(hash: string): Promise<{ orgId: string; installId: string; revoked: boolean } | null>`
  - `orgStripeCustomer(orgId: string): Promise<string | null>` (SELECT stripe_customer_id FROM organizations WHERE id = $1) — needed because the existing `orgBilling` requires an accountId, which the agent-token path does not have.
- [ ] **Run:** `pnpm --filter signups test` — green.
- [ ] **Commit.**

### Task E1.2: per-org entitlement resolve (no accountId)

**Files:** Modify `apps/signups/src/entitlements.ts`; Test `apps/signups/src/entitlements.test.ts`.

The existing `makeResolver` unions across an account's orgs. The agent path needs a single-org resolve keyed by `orgId`.

- [ ] **Write failing test:** a `resolveOrgEntitlement(orgId, deps)` returns `{ agentEntitled: true, plan: "pro", fetchedAt }` when `orgStripeCustomer(orgId)` yields a customer whose `activeFeatureKeys` contains `"agentAutonomy"`; returns `agentEntitled: false, plan: "free"` when the org has no customer or the feature is absent.
- [ ] **Implement** `resolveOrgEntitlement(orgId, deps: { db: { orgStripeCustomer }, stripe: { activeFeatureKeys }, now })`. Reuse `resolvePayload`'s key logic — `agentEntitled = keys.has("agentAutonomy")`. Keep the 60s cache optional here (agent already caches for 12–24h; a short server cache is fine but not required — decide by DRY: if trivial, add a per-org cache mirroring `makeResolver`).
- [ ] **Run + Commit.**

### Task E1.3: `POST /agent/token` (authed by account)

**Files:** Create `apps/signups/src/agent.ts`; Test `apps/signups/src/agent.test.ts`. Model auth on `billing.ts`'s `authed(c)` (bearer → sha → `accountByToken`).

- [ ] **Write failing test** (Hono `app.request`, mocked db): `POST /agent/token` with `Bearer acctok` and body `{ orgId }` where the account is a member → 200 `{ token: string, installId: string }`, and `createAgentToken` was called with `sha(token)` + the returned `installId`. Non-member (`orgBilling` returns null) → 403. Missing bearer → 401.
- [ ] **Implement:** `registerAgentRoutes(app, deps)` with `POST /agent/token`:
  - authenticate the account (copy `authed` from billing, or export/share it).
  - `orgId` from body; verify membership with `deps.db.orgBilling(orgId, acc.id)` (null → 403).
  - generate token: `` `rig_agent_${randomBytes(32).toString("base64url")}` ``; `installId = randomUUID()`.
  - `await deps.db.createAgentToken({ orgId, installId, tokenHash: sha(token) })`.
  - return `{ token, installId }` (token shown once).
- [ ] **Run + Commit.**

### Task E1.4: `GET /agent/entitlement` (authed by the AGENT token, orgId from token)

**Files:** Modify `apps/signups/src/agent.ts`; Test `apps/signups/src/agent.test.ts`.

- [ ] **Write failing tests:**
  - `GET /agent/entitlement` with `Bearer rig_agent_...` whose hash maps to an entitled org → 200 `{ agentEntitled: true, plan, fetchedAt }`.
  - Same for a free org → `{ agentEntitled: false, plan: "free", fetchedAt }`.
  - Unknown token hash → 401. Revoked token → 401.
  - **Security lock-in test:** a query param `?orgId=<someone-elses-org>` is IGNORED — the response reflects the token's org, not the param. (Assert by wiring the token to org A while passing org B in the query and confirming org A's entitlement is returned.)
- [ ] **Implement** `GET /agent/entitlement`:
  - bearer → `sha` → `deps.db.agentTokenByHash(hash)`; null or `revoked` → 401.
  - `orgId = row.orgId` (NEVER `c.req.query("orgId")`).
  - `return c.json(await deps.resolveOrg(orgId))`.
- [ ] **Rate limit:** add a tiny in-memory limiter keyed by token hash (e.g. ≤ 10 requests/hour → else 429). Note in a comment it is per-replica/approximate — acceptable for abuse prevention at a 12–24h cadence. Test one over-limit call → 429.
- [ ] **Run + Commit.**

### Task E1.5: wire into `index.ts`

**Files:** Modify `apps/signups/src/index.ts`.

- [ ] Construct the agent-route deps (`db: authDb`, `orgBilling`, `resolveOrg: (orgId) => resolveOrgEntitlement(orgId, {...})`, `now`) and call `registerAgentRoutes(app, ...)` next to `registerBillingRoutes`.
- [ ] No new env/secret. Confirm boot still logs cleanly.
- [ ] **Run** `pnpm --filter signups test` + `pnpm --filter signups build` (or typecheck) — green. **Commit.**

---

## Slice E2 — agent: live-check + capability gating

**Files:**
- Create: `apps/../agent/src/entitlement.ts` (fetch + cache + grace resolve)
- Modify: `agent/src/config.ts` (read `RIGEL_AGENT_TOKEN`, `RIGEL_ENTITLEMENT_ENDPOINT`)
- Modify: `agent/src/index.ts` (`tick()` — compute `entitled`, gate premium branches)
- Modify: `agent/manifests/deployment.yaml` (inject the two env vars from the credentials Secret)
- Test: `agent/src/entitlement.test.ts`, extend `agent/src/index.test.ts`

Run agent tests: `cd agent && npx vitest run`.

### Task E2.1: config — read the token + endpoint

**Files:** Modify `agent/src/config.ts`; Test `agent/src/config.test.ts` (if present).

- [ ] Add to `Config`: `agentToken: string` (env `RIGEL_AGENT_TOKEN`, default `""`) and `entitlementEndpoint: string` (env `RIGEL_ENTITLEMENT_ENDPOINT`, default `"https://api.rigel.run"`), plus `entitlementCheckMs` (default `12 * 60 * 60 * 1000`) and `entitlementGraceMs` (default `30 * 24 * 60 * 60 * 1000`). Mirror the existing `str()`/number env helpers.
- [ ] **Commit.**

### Task E2.2: entitlement fetch + cache + grace resolve (pure-ish, injectable)

**Files:** Create `agent/src/entitlement.ts`; Test `agent/src/entitlement.test.ts`. Mock the `kubectl.js` seam like `runtimeConfig.test.ts` does; inject `fetch`.

Shape:
```ts
export interface Entitlement { agentEntitled: boolean; fetchedAt: string } // fetchedAt = ISO
// cached form persisted in assistant-state ConfigMap under key "entitlement"
```
- [ ] `readEntitlementCache(cfg)` — `kubectl get configmap assistant-state -o json`, parse `.data.entitlement` JSON; null on miss/garbage.
- [ ] `writeEntitlementCache(cfg, e)` — merge the `entitlement` key into `assistant-state` (read-modify-write, same pattern the agent already uses to write state).
- [ ] `fetchEntitlement(endpoint, token, fetchFn)` — `GET ${endpoint}/agent/entitlement` with `authorization: Bearer ${token}`. Returns `{ status: "ok", value }` on 2xx JSON; `{ status: "unauth" }` on 401/403; `{ status: "error" }` on network/5xx/malformed. (Distinguishing authenticated-free from unreachable is load-bearing — see below.)
- [ ] `resolveEntitlement({ cfg, now, cache, fetchResult })` — the decision function, PURE and unit-tested exhaustively:
  - If `fetchResult.status === "ok"` → return `fetchResult.value` (authoritative; caller persists it). This covers **authenticated-free (downgrade now)** and entitled.
  - If `fetchResult.status === "unauth"` → treat as **not entitled** (token bad/revoked → free). Persist free.
  - If `fetchResult.status === "error"` → **hold last-known-good** from `cache` **iff** cache is valid: `cache.fetchedAt` parses, is not in the future, and `now - cache.fetchedAt <= entitlementGraceMs`. Otherwise (no cache / implausible / beyond grace) → not entitled (fail-closed to free).
  - Plausibility guard applied to any cache read (future or older-than-grace ⇒ ignore).
- [ ] `shouldRefetch(cache, now, cfg)` — true when no cache or `now - cache.fetchedAt >= entitlementCheckMs`.
- [ ] **Tests (table-driven):** ok-entitled, ok-free (downgrade), unauth→free, error+fresh-cache→hold, error+stale-cache(>30d)→free, error+future-timestamp-cache→free, error+no-cache→free.
- [ ] **Run + Commit.**

### Task E2.3: integrate the gate into `tick()`

**Files:** Modify `agent/src/index.ts`; extend `agent/src/index.test.ts`.

- [ ] Near the top of `tick()` (after `readState`/`readRuntimeConfig`, before `detectAll` at ~:253): read the cached entitlement from the already-read `assistant-state` (avoid a second `kubectl get`), compute `const entitled = resolveEntitlement(...)` using the cache only (cheap, every tick). Separately, when `shouldRefetch(...)`, perform `fetchEntitlement` and `writeEntitlementCache` — but **do not block observe**: refetch can run once per tick guarded by the interval, failures fall to grace. (Simplest: refetch inline at the top since the loop is 30s and the interval is 12–24h, so it fires rarely; a failed fetch just holds cache.)
- [ ] **Gate the premium branches on `entitled`** (observe/`detectAll` + incident recording stay unconditional):
  - Autofix-PR branch (`isRepoFixAction`, ~:518) — wrap dispatch in `if (entitled)`.
  - Remediation execution (the `if (rc.enabled)` + `decideAutonomy` path, ~:299/:669) — additionally require `entitled`.
  - Notifications (the notify senders) — require `entitled`. Identify every outbound notify call and gate it. (Observe-only free tier must not send.)
  - Digests (`evaluateDigests`, ~:749) — require `entitled` (this path bypasses the kill-switch today, so it must be explicitly gated).
- [ ] When not entitled, optionally log once per transition ("observe-only: org not entitled") for the incident-history/upsell surface. Keep terse.
- [ ] **Tests:** drive a `tick()` with a mocked `assistant-state` cache = free and assert NO notify/digest/remediation/autofix side effects fire, but `detectAll` still runs; with cache = entitled, premium paths fire as before. Reuse the `index.test.ts` IO mocks.
- [ ] **Run `cd agent && npx vitest run` (all ~576+ green) + Commit.**

### Task E2.4: deployment env wiring

**Files:** Modify `agent/manifests/deployment.yaml`; and the Secret builder `packages/k8s/src/assistant.ts` (`credentialsSecretYAML`) so `RIGEL_AGENT_TOKEN` is written into the credentials Secret and injected.

- [ ] Add `RIGEL_AGENT_TOKEN` (`valueFrom.secretKeyRef` to the credentials Secret key) and `RIGEL_ENTITLEMENT_ENDPOINT` (plain env, default api.rigel.run) to the agent container env. No new RBAC (env injection, not a Secret API read).
- [ ] Update `credentialsSecretYAML` (packages/k8s) to include the agent token key when provided (mirror how the model token is written). Keep a count/shape test in packages/k8s green.
- [ ] **Commit.**

---

## Slice E3 — desktop/server: mint on install + scale-to-0 courtesy

**Files:**
- Modify: `apps/server/src/assistant.ts` — add `scaleAgentsToZero`, remove `revertAgentsToAdvisory`.
- Modify: `apps/server/src/index.ts` — `agent-downgrade` handler → `scaleAgentsToZero`.
- Modify: `apps/server/src/assistant.test.ts` — replace the `revertAgentsToAdvisory` describe-block with `scaleAgentsToZero`.
- Modify: `apps/desktop/src/main.ts` + install flow — mint the agent token during agent install/setup and thread it into the credentials Secret.
- Modify: `apps/desktop/src/billingClient.ts` — add `agentToken(orgId)` calling `POST /agent/token`.

### Task E3.1: `scaleAgentsToZero` replaces `revertAgentsToAdvisory`

- [ ] **Write failing test** (copy the existing `revertAgentsToAdvisory` describe block, `apps/server/src/assistant.test.ts:1035-1080`): `scaleAgentsToZero({ discover, run })` scales every installed context via `run(ctx, ["scale", "deployment/rigel-assistant", "--replicas=0", "-n", "default"])`, isolates a throwing context into `failures`, empty discover → zero calls.
- [ ] **Implement** `scaleAgentsToZero` in `assistant.ts` modeled 1:1 on `revertAgentsToAdvisory`, swapping the `patch` for `runKubectlStdin(ctx, ["scale", \`deployment/${DEPLOYMENT_NAME}\`, "--replicas=0", "-n", namespace], null)`. Delete `revertAgentsToAdvisory`.
- [ ] Update `apps/server/src/index.ts` `agent-downgrade` handler to call `scaleAgentsToZero()` and log `scaled`/`failures`.
- [ ] **Run `pnpm --filter @rigel/server test` + Commit.**

### Task E3.2: `billingClient.agentToken` + mint on install

- [ ] **billingClient:** add `agentToken(orgId): Promise<{ token: string; installId: string }>` → `POST ${endpoint}/agent/token` with the account bearer (`auth()`) and `{ orgId }` body. Unit-test with a fake `fetchFn`.
- [ ] **Install flow:** at the point the desktop installs/sets up the agent (the `/api/assistant` install action path), before building the credentials Secret, mint the token (`billingClient.agentToken(activeOrgId)`) and include it so `credentialsSecretYAML` writes `RIGEL_AGENT_TOKEN`. Thread `installId` if we want it persisted (optional v1). Guard: if minting fails (offline), install proceeds without a token → agent stays observe-only until a later setup writes one (fail-closed, acceptable).
- [ ] **Tests:** server-side, assert the install request carries the token into the Secret builder; desktop-side, assert `agentToken` posts correctly.
- [ ] **Run + Commit.**

---

## Slice E4 — "Resume" UI

**Files:**
- Modify: `apps/server/src/assistant.ts` + route — a `scaleAgentUp` action (replicas=1) for the active context.
- Modify: `apps/web/src/...` (agent/assistant panel) — show a "Resume" affordance when the Deployment is at 0 replicas AND the org is entitled.

### Task E4.1: server action to scale back to 1
- [ ] **Test + implement** a `scaleAgent(context, namespace, replicas)` (or reuse a general scale) invoked by a new `assistant` action `resume` → `kubectl scale deployment/rigel-assistant --replicas=1`. Route it through the existing `/api/assistant` action switch. Confirm it goes through the guarded-action path (ConfirmSheet) per app conventions.
- [ ] **Commit.**

### Task E4.2: web "Resume" affordance
- [ ] In the assistant/agent panel, when the agent Deployment `spec.replicas === 0` (read from the store/watch) and `canBeAutonomous()` is true, render a "Resume agent" button that fires the `resume` action via the confirm sheet. Follow the Pencil design system + existing gate components (ProGateCard/UpgradeBanner) for the not-entitled case (show upgrade CTA instead of Resume).
- [ ] **Typecheck + test + Commit.**

---

## Self-review checklist (run before final review)
- **Security:** `GET /agent/entitlement` derives orgId from the token ONLY; a param is ignored (locked by a test). ✔ required.
- **Grace correctness:** authenticated-free ⇒ downgrade; unreachable/5xx/malformed ⇒ hold last-known-good within 30d; implausible timestamp ignored. ✔ table-tested.
- **Observe always runs:** free tier still observes + records; only premium branches gated. ✔ tick test asserts detectAll runs while notify/digest/remediate/autofix don't.
- **No new agent RBAC / no Secret API read:** token via env, cache in `assistant-state` ConfigMap. ✔
- **No crypto/keypair anywhere.** ✔ (opaque token, hashed in DB.)
- **`revertAgentsToAdvisory` fully removed** (superseded); `detectAgentDowngrade` retained for scale-to-0. ✔
