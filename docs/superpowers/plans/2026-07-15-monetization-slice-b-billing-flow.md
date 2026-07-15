# Monetization Slice B — Billing flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a signed-in user subscribe and manage billing without leaving the app: backend `POST /billing/checkout` + `POST /billing/portal`, a desktop billing `BrowserWindow` that loads Stripe's hosted page and closes on the success redirect, and a billing section in the Account modal. Gates stay allow-all this slice — paying just shows "Pro" and unlocks nothing yet (that's Slice C).

**Architecture:** Extends Slice A's `stripeAdapter.ts` with customer/checkout/portal methods and `authDb` with seat-count/customer helpers. Desktop gains a `billingClient.ts` (factory mirroring `accountClient.ts`), `rigel:billing:*` IPC, and a managed billing window. The window detects Stripe's `success_url`/`cancel_url` (fixed `api.rigel.run/billing/{complete,cancelled}` pages) by navigation and refetches entitlements on success.

**Tech Stack:** TypeScript, Hono, `stripe` SDK, Electron (`BrowserWindow`, `ipcMain`), React 19, Vitest.

**Depends on:** Slice A (`stripeAdapter.ts`, `EntitlementPayload`, `billableOrgs`, `GET /entitlements`).
**Spec:** `docs/superpowers/specs/2026-07-15-monetization-foundation-design.md`.

---

## File Structure

- **Modify** `apps/signups/src/stripeAdapter.ts` — add `ensureCustomer`, `createCheckoutSession`, `createPortalSession`.
- **Modify** `apps/signups/src/authDb.ts` — add `orgSeatCount`, `orgBilling` (customer id + caller's role), `setOrgStripeCustomer`.
- **Modify** `apps/signups/src/billing.ts` — add `POST /billing/checkout`, `POST /billing/portal`, and the two static `/billing/complete|cancelled` HTML pages the window detects.
- **Modify** `apps/signups/src/index.ts` — read `STRIPE_PRICE_ID`, pass checkout deps.
- **Create** `apps/desktop/src/billingClient.ts` — `createBillingClient({ store, fetchFn, endpoint })`.
- **Modify** `apps/desktop/src/main.ts` — billing IPC + `openBillingWindow(url)`.
- **Modify** `apps/desktop/src/preload.ts` + `apps/web/src/lib/desktop.ts` — `billing` bridge section.
- **Modify** `apps/web/src/shell/useAccount.ts` — surface `entitlement` + billing actions.
- **Modify** `apps/web/src/shell/AccountModal.tsx` — a Plan/Billing section.
- **Tests** alongside each.

---

## Task 1: Stripe adapter — customer + checkout + portal

**Files:**
- Modify: `apps/signups/src/stripeAdapter.ts`
- Test: `apps/signups/src/stripeAdapter.test.ts`

- [ ] **Step 1: Extend the `StripeAdapter` interface** (Slice A defined it) with:
```ts
ensureCustomer(input: { existing: string | null; email: string; orgId: string }): Promise<{ customerId: string; created: boolean }>;
createCheckoutSession(input: { customerId: string; priceId: string; quantity: number; successUrl: string; cancelUrl: string }): Promise<string>;
createPortalSession(input: { customerId: string; returnUrl: string }): Promise<string>;
```

- [ ] **Step 2: Write failing tests** (fake stripe client):
```ts
test("ensureCustomer reuses an existing id and does not create", async () => {
  const create = vi.fn();
  const adapter = makeStripeAdapter({ customers: { create }, entitlements: { activeEntitlements: { list: async () => ({ data: [] }) } } } as never);
  const r = await adapter.ensureCustomer({ existing: "cus_1", email: "a@b.co", orgId: "o1" });
  expect(r).toEqual({ customerId: "cus_1", created: false });
  expect(create).not.toHaveBeenCalled();
});

test("ensureCustomer creates when none, tagging org metadata", async () => {
  const create = vi.fn(async () => ({ id: "cus_new" }));
  const adapter = makeStripeAdapter({ customers: { create }, entitlements: { activeEntitlements: { list: async () => ({ data: [] }) } } } as never);
  const r = await adapter.ensureCustomer({ existing: null, email: "a@b.co", orgId: "o1" });
  expect(create).toHaveBeenCalledWith({ email: "a@b.co", metadata: { orgId: "o1" } });
  expect(r).toEqual({ customerId: "cus_new", created: true });
});

test("createCheckoutSession passes per-seat line item + urls, returns url", async () => {
  const create = vi.fn(async () => ({ url: "https://checkout.stripe/s1" }));
  const adapter = makeStripeAdapter({ checkout: { sessions: { create } }, entitlements: { activeEntitlements: { list: async () => ({ data: [] }) } } } as never);
  const url = await adapter.createCheckoutSession({ customerId: "cus_1", priceId: "price_1", quantity: 3, successUrl: "https://s/ok", cancelUrl: "https://s/no" });
  expect(create).toHaveBeenCalledWith(expect.objectContaining({
    mode: "subscription", customer: "cus_1",
    line_items: [{ price: "price_1", quantity: 3 }],
    success_url: "https://s/ok", cancel_url: "https://s/no",
  }));
  expect(url).toBe("https://checkout.stripe/s1");
});

test("createPortalSession returns the portal url", async () => {
  const create = vi.fn(async () => ({ url: "https://portal/1" }));
  const adapter = makeStripeAdapter({ billingPortal: { sessions: { create } }, entitlements: { activeEntitlements: { list: async () => ({ data: [] }) } } } as never);
  expect(await adapter.createPortalSession({ customerId: "cus_1", returnUrl: "https://s/back" })).toBe("https://portal/1");
});
```

- [ ] **Step 3: Run → FAIL**, then **implement** in `makeStripeAdapter`:
```ts
async ensureCustomer({ existing, email, orgId }) {
  if (existing) return { customerId: existing, created: false };
  const c = await stripe.customers.create({ email, metadata: { orgId } });
  return { customerId: c.id, created: true };
},
async createCheckoutSession({ customerId, priceId, quantity, successUrl, cancelUrl }) {
  const s = await stripe.checkout.sessions.create({
    mode: "subscription", customer: customerId,
    line_items: [{ price: priceId, quantity }],
    success_url: successUrl, cancel_url: cancelUrl,
  });
  if (!s.url) throw new Error("stripe returned no checkout url");
  return s.url;
},
async createPortalSession({ customerId, returnUrl }) {
  const s = await stripe.billingPortal.sessions.create({ customer: customerId, return_url: returnUrl });
  return s.url;
},
```
Widen the `makeStripeAdapter` param type to `Pick<Stripe, "entitlements" | "customers" | "checkout" | "billingPortal">`.

- [ ] **Step 4: Run → PASS. Commit.**
```bash
git commit -am "feat(signups): stripe adapter — customer/checkout/portal"
```

---

## Task 2: `authDb` billing helpers

**Files:** Modify `apps/signups/src/authDb.ts`; Test `apps/signups/src/authDb.test.ts`.

- [ ] **Step 1: Failing tests** (recorder pattern):
```ts
test("orgBilling returns customer id + caller role (null when not a member)", async () => {
  const { pool, push } = recorder();
  push({ stripe_customer_id: "cus_1", role: "owner" });
  const db = createAuthDb(pool);
  expect(await db.orgBilling("o1", "acc-1")).toEqual({ stripeCustomerId: "cus_1", role: "owner" });
});
test("orgSeatCount counts memberships", async () => {
  const { pool, push } = recorder();
  push({ n: "3" });
  const db = createAuthDb(pool);
  expect(await db.orgSeatCount("o1")).toBe(3);
});
test("setOrgStripeCustomer writes the id", async () => {
  const { pool, calls } = recorder();
  const db = createAuthDb(pool);
  await db.setOrgStripeCustomer("o1", "cus_9");
  expect(calls[0].sql.toUpperCase()).toContain("UPDATE ORGANIZATIONS");
  expect(calls[0].params).toEqual(["cus_9", "o1"]);
});
```
- [ ] **Step 2: Run → FAIL. Implement** (interface + factory):
```ts
// interface
orgBilling(orgId: string, accountId: string): Promise<{ stripeCustomerId: string | null; role: string } | null>;
orgSeatCount(orgId: string): Promise<number>;
setOrgStripeCustomer(orgId: string, customerId: string): Promise<void>;
// factory
async orgBilling(orgId, accountId) {
  const r = await pool.query(
    `SELECT o.stripe_customer_id, m.role
       FROM organizations o JOIN memberships m ON m.org_id = o.id
      WHERE o.id = $1 AND m.account_id = $2`, [orgId, accountId]);
  if (r.rows.length === 0) return null;
  return { stripeCustomerId: r.rows[0].stripe_customer_id, role: r.rows[0].role };
},
async orgSeatCount(orgId) {
  const r = await pool.query(`SELECT count(*)::int AS n FROM memberships WHERE org_id = $1`, [orgId]);
  return Number(r.rows[0].n);
},
async setOrgStripeCustomer(orgId, customerId) {
  await pool.query(`UPDATE organizations SET stripe_customer_id = $1 WHERE id = $2`, [customerId, orgId]);
},
```
- [ ] **Step 3: Run → PASS. Commit.** `git commit -am "feat(signups): authDb billing helpers (orgBilling/seatCount/setCustomer)"`

---

## Task 3: `/billing/checkout` + `/billing/portal` + redirect pages

**Files:** Modify `apps/signups/src/billing.ts`; `apps/signups/src/index.ts`; Test `apps/signups/src/billing.test.ts`.

Authorization: only an **owner/admin** of the org may start checkout/portal. Lazily create the Stripe customer + persist its id on first checkout.

- [ ] **Step 1: Failing tests:**
```ts
test("POST /billing/checkout creates a customer if none, persists it, returns the url", async () => {
  const db = { accountByToken: vi.fn(async () => ({ id: "acc-1" })), touchToken: vi.fn(),
    orgBilling: vi.fn(async () => ({ stripeCustomerId: null, role: "owner" })),
    orgSeatCount: vi.fn(async () => 1), setOrgStripeCustomer: vi.fn(async () => {}),
    accountEmail: vi.fn(async () => "a@b.co") };
  const stripe = { ensureCustomer: vi.fn(async () => ({ customerId: "cus_new", created: true })),
    createCheckoutSession: vi.fn(async () => "https://checkout/x") };
  const app = new Hono(); registerBillingRoutes(app, { db, resolve: vi.fn(), stripe, priceId: "price_1", endpoint: "https://api.rigel.run" } as never);
  const res = await app.request("/billing/checkout", { method: "POST", headers: { authorization: "Bearer t", "content-type": "application/json" }, body: JSON.stringify({ orgId: "o1" }) });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ url: "https://checkout/x" });
  expect(db.setOrgStripeCustomer).toHaveBeenCalledWith("o1", "cus_new");
  expect(stripe.createCheckoutSession).toHaveBeenCalledWith(expect.objectContaining({ customerId: "cus_new", quantity: 1, priceId: "price_1" }));
});
test("POST /billing/checkout 403 when caller is a plain member", async () => {
  const db = { accountByToken: vi.fn(async () => ({ id: "acc-1" })), touchToken: vi.fn(),
    orgBilling: vi.fn(async () => ({ stripeCustomerId: null, role: "member" })) };
  const app = new Hono(); registerBillingRoutes(app, { db, resolve: vi.fn(), stripe: {}, priceId: "p", endpoint: "e" } as never);
  const res = await app.request("/billing/checkout", { method: "POST", headers: { authorization: "Bearer t", "content-type": "application/json" }, body: JSON.stringify({ orgId: "o1" }) });
  expect(res.status).toBe(403);
});
```
(Add an `accountEmail(accountId)` helper to `authDb` — `SELECT email FROM accounts WHERE id=$1` — in a tiny sub-step with its own recorder test.)

- [ ] **Step 2: Run → FAIL. Extend `BillingDeps` + `registerBillingRoutes`:**
```ts
export interface BillingDeps {
  db: { /* Slice A */ accountByToken; touchToken;
        orgBilling(orgId, accountId): Promise<{ stripeCustomerId: string|null; role: string }|null>;
        orgSeatCount(orgId): Promise<number>; setOrgStripeCustomer(orgId, id): Promise<void>; accountEmail(id): Promise<string> };
  resolve: (accountId: string) => Promise<EntitlementPayload>;
  stripe: import("./stripeAdapter").StripeAdapter;
  priceId: string;
  endpoint: string; // e.g. https://api.rigel.run — for success/cancel/return urls
}

// inside registerBillingRoutes, add:
async function authed(c): Promise<{ id: string } | null> {
  const token = bearer(c); if (!token) return null;
  const acc = await deps.db.accountByToken(sha(token)); if (!acc) return null;
  await deps.db.touchToken(sha(token)); return acc;
}

app.post("/billing/checkout", async (c) => {
  const acc = await authed(c); if (!acc) return c.json({ error: "unauthorized" }, 401);
  const { orgId } = await c.req.json<{ orgId: string }>();
  const b = await deps.db.orgBilling(orgId, acc.id);
  if (!b) return c.json({ error: "not a member" }, 403);
  if (b.role !== "owner" && b.role !== "admin") return c.json({ error: "owner or admin required" }, 403);
  const email = await deps.db.accountEmail(acc.id);
  const { customerId, created } = await deps.stripe.ensureCustomer({ existing: b.stripeCustomerId, email, orgId });
  if (created) await deps.db.setOrgStripeCustomer(orgId, customerId);
  const quantity = await deps.db.orgSeatCount(orgId);
  const url = await deps.stripe.createCheckoutSession({
    customerId, priceId: deps.priceId, quantity,
    successUrl: `${deps.endpoint}/billing/complete`,
    cancelUrl: `${deps.endpoint}/billing/cancelled`,
  });
  return c.json({ url });
});

app.post("/billing/portal", async (c) => {
  const acc = await authed(c); if (!acc) return c.json({ error: "unauthorized" }, 401);
  const { orgId } = await c.req.json<{ orgId: string }>();
  const b = await deps.db.orgBilling(orgId, acc.id);
  if (!b) return c.json({ error: "not a member" }, 403);
  if (b.role !== "owner" && b.role !== "admin") return c.json({ error: "owner or admin required" }, 403);
  if (!b.stripeCustomerId) return c.json({ error: "no subscription yet" }, 409);
  const url = await deps.stripe.createPortalSession({ customerId: b.stripeCustomerId, returnUrl: `${deps.endpoint}/billing/complete` });
  return c.json({ url });
});

// Static pages the desktop billing window detects by path (no auth):
const page = (msg: string) => `<!doctype html><meta charset=utf8><body style="font:16px system-ui;background:#0c0d0f;color:#fff;display:grid;place-items:center;height:100vh;margin:0">${msg} — you can close this window.</body>`;
app.get("/billing/complete", (c) => c.html(page("Done")));
app.get("/billing/cancelled", (c) => c.html(page("Cancelled")));
```

- [ ] **Step 3: Run → PASS.** Add `STRIPE_PRICE_ID` to `index.ts` (env read + soft-warn) and pass `stripe: stripeAdapter, priceId: STRIPE_PRICE_ID, endpoint: "https://api.rigel.run"` into the `billing` deps (and `accountEmail` is on `authDb`). Document `STRIPE_PRICE_ID` in `db-secret.example.yaml`.

- [ ] **Step 4: Commit.** `git commit -am "feat(signups): /billing/checkout + /billing/portal + redirect pages"`

---

## Task 4: Desktop billing client

**Files:** Create `apps/desktop/src/billingClient.ts`; Test `apps/desktop/src/billingClient.test.ts`.

Mirror `accountClient.ts` (factory + injected `fetchFn`, `Authorization: Bearer ${store.getToken()}`).

- [ ] **Step 1: Failing test** (memStore like `accountClient.test.ts`):
```ts
test("checkout posts orgId with the bearer token and returns the url", async () => {
  const fetchFn = vi.fn(async () => ({ ok: true, json: async () => ({ url: "https://checkout/x" }) }));
  const client = createBillingClient({ store: { getToken: () => "tok" } as never, fetchFn: fetchFn as never, endpoint: "https://api.rigel.run" });
  expect(await client.checkout("o1")).toBe("https://checkout/x");
  expect(fetchFn).toHaveBeenCalledWith("https://api.rigel.run/billing/checkout", expect.objectContaining({
    method: "POST", headers: expect.objectContaining({ authorization: "Bearer tok" }),
  }));
});
test("entitlements returns the resolved payload", async () => {
  const fetchFn = vi.fn(async () => ({ ok: true, json: async () => ({ plan: "pro", audits: [], cloudConnect: true, agentAutonomy: false, fetchedAt: "t" }) }));
  const client = createBillingClient({ store: { getToken: () => "tok" } as never, fetchFn: fetchFn as never, endpoint: "https://api.rigel.run" });
  expect((await client.entitlements())?.cloudConnect).toBe(true);
});
```
- [ ] **Step 2: Run → FAIL. Implement:**
```ts
import type { EntitlementPayload } from "@rigel/signups/entitlements"; // or duplicate the type locally if cross-pkg import is awkward

export interface BillingStore { getToken(): string | null; }
export function createBillingClient({ store, fetchFn, endpoint }: { store: BillingStore; fetchFn: typeof fetch; endpoint: string }) {
  const auth = () => ({ authorization: `Bearer ${store.getToken() ?? ""}`, "content-type": "application/json" });
  const postUrl = async (path: string, orgId: string): Promise<string | null> => {
    const res = await fetchFn(`${endpoint}${path}`, { method: "POST", headers: auth(), body: JSON.stringify({ orgId }) });
    if (!res.ok) return null;
    return (await res.json()).url ?? null;
  };
  return {
    checkout: (orgId: string) => postUrl("/billing/checkout", orgId),
    portal: (orgId: string) => postUrl("/billing/portal", orgId),
    async entitlements(): Promise<EntitlementPayload | null> {
      const res = await fetchFn(`${endpoint}/entitlements`, { headers: auth() });
      return res.ok ? ((await res.json()) as EntitlementPayload) : null;
    },
  };
}
export type BillingClient = ReturnType<typeof createBillingClient>;
```
(If the cross-package type import is awkward, define `EntitlementPayload` in `apps/desktop/src/billingClient.ts` and re-export; Slice C's provider will consume the same shape.)
- [ ] **Step 3: Run → PASS. Commit.** `git commit -am "feat(desktop): billing client (checkout/portal/entitlements)"`

---

## Task 5: Billing IPC + in-app billing window

**Files:** Modify `apps/desktop/src/main.ts` (client wiring `:436-476`; IPC block `:478-510`; window idiom `:382-417`).

- [ ] **Step 1: Wire the client** next to `accountClient` (`main.ts:437`):
```ts
const billingClient = createBillingClient({ store: accountStore, fetchFn: fetch, endpoint: SIGNUP_ENDPOINT });
```
- [ ] **Step 2: Add `openBillingWindow`** (module-level `let billingWindow: BrowserWindow | null = null;` near `mainWindow`). It loads the Stripe URL and detects the fixed success/cancel pages by URL, then closes + tells the renderer to refresh:
```ts
function openBillingWindow(url: string): void {
  if (billingWindow) { billingWindow.focus(); billingWindow.loadURL(url); return; }
  billingWindow = new BrowserWindow({
    width: 480, height: 720, parent: mainWindow ?? undefined, modal: false,
    title: "Rigel billing", autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  const onNav = (u: string) => {
    if (u.startsWith(`${SIGNUP_ENDPOINT}/billing/complete`) || u.startsWith(`${SIGNUP_ENDPOINT}/billing/cancelled`)) {
      billingWindow?.close();
      mainWindow?.webContents.send("rigel:billing:changed"); // Slice C provider refetches on this
    }
  };
  billingWindow.webContents.on("will-redirect", (_e, u) => onNav(u));
  billingWindow.webContents.on("did-navigate", (_e, u) => onNav(u));
  billingWindow.on("closed", () => { billingWindow = null; });
  void billingWindow.loadURL(url);
}
```
- [ ] **Step 3: Register IPC** in the `boot()` handler block (`main.ts:494` area, next to app-update):
```ts
ipcMain.handle("rigel:billing:checkout", async (_e, orgId: string) => {
  const url = await billingClient.checkout(orgId);
  if (url) openBillingWindow(url);
  return { ok: !!url };
});
ipcMain.handle("rigel:billing:portal", async (_e, orgId: string) => {
  const url = await billingClient.portal(orgId);
  if (url) openBillingWindow(url);
  return { ok: !!url };
});
ipcMain.handle("rigel:billing:entitlements", () => billingClient.entitlements());
```
- [ ] **Step 4: Verify** `pnpm --filter desktop typecheck`. Commit. `git commit -am "feat(desktop): billing IPC + in-app Stripe window"`

---

## Task 6: Preload + web bridge types

**Files:** Modify `apps/desktop/src/preload.ts` (bridge `:7-48`); `apps/web/src/lib/desktop.ts` (`RigelBridge` `:22-46`).

- [ ] **Step 1: Preload** — add a `billing` section mirroring `account`/`appUpdate`:
```ts
billing: {
  checkout: (orgId: string) => ipcRenderer.invoke("rigel:billing:checkout", orgId),
  portal: (orgId: string) => ipcRenderer.invoke("rigel:billing:portal", orgId),
  entitlements: () => ipcRenderer.invoke("rigel:billing:entitlements"),
  onChanged: (cb: () => void) => { const l = () => cb(); ipcRenderer.on("rigel:billing:changed", l); return () => ipcRenderer.removeListener("rigel:billing:changed", l); },
},
```
- [ ] **Step 2: Web type** — add to `RigelBridge` (optional, desktop-only) + export `EntitlementPayload`:
```ts
export interface EntitlementPayload { plan: "free" | "pro"; audits: ("reliability"|"security"|"performance")[]; cloudConnect: boolean; agentAutonomy: boolean; fetchedAt: string; }
// in RigelBridge:
billing?: {
  checkout(orgId: string): Promise<{ ok: boolean }>;
  portal(orgId: string): Promise<{ ok: boolean }>;
  entitlements(): Promise<EntitlementPayload | null>;
  onChanged(cb: () => void): () => void;
};
```
- [ ] **Step 3:** `pnpm --filter desktop typecheck && pnpm --filter web typecheck`. Commit. `git commit -am "feat: billing bridge (preload + web types)"`

---

## Task 7: Account modal — Plan / Billing section

**Files:** Modify `apps/web/src/shell/useAccount.ts` (`:6-15`, `:22-28`); `apps/web/src/shell/AccountModal.tsx` (signed-in body `:73-112`); Test `apps/web/src/shell/AccountModal.test.tsx`.

- [ ] **Step 1: Extend `useAccount`.** Add `entitlement: EntitlementPayload | null` to `UseAccountResult`; in `refresh` (after `rigel.account.status()`), `setEntitlement(await rigel?.billing?.entitlements() ?? null)`. Subscribe to `rigel.billing?.onChanged(() => void refresh())` in a second effect (mirror `account.onChanged`, `:32-35`). Expose `upgrade(orgId)` → `rigel?.billing?.checkout(orgId)` and `manageBilling(orgId)` → `rigel?.billing?.portal(orgId)`.

- [ ] **Step 2: Failing test** for the modal section:
```ts
// with useAccount mocked to return status "signed-in", a personal org {id:"o1",role:"owner"}, entitlement {plan:"free"}
it("free plan shows Upgrade, calls upgrade(personalOrgId) on click", () => { /* render, getByRole button /upgrade/i, click, expect upgrade mock called with "o1" */ });
it("pro plan shows Manage billing", () => { /* entitlement.plan="pro" → getByText(/pro/i) + /manage billing/i */ });
```
- [ ] **Step 3: Implement the section** in the signed-in body (after the ORGANIZATIONS card `:99`, before sign-out `:101`), mirroring the `OrgRow` card structure (label `text-3xs font-mono tracking-wide text-[var(--fg-tertiary)]` + bordered card):
```tsx
<div className="rounded-lg border border-[var(--border-subtle)] bg-white/[0.02] p-3">
  <span className="text-3xs font-mono tracking-wide text-[var(--fg-tertiary)]">PLAN</span>
  <div className="mt-2 flex items-center justify-between">
    <span className="text-sm text-[var(--fg-primary)]">{account.entitlement?.plan === "pro" ? "Rigel Pro" : "Free"}</span>
    {account.entitlement?.plan === "pro"
      ? <Button size="sm" variant="outline" onClick={() => account.manageBilling(personalOrgId)}>Manage billing</Button>
      : <Button size="sm" onClick={() => account.upgrade(personalOrgId)}>Upgrade</Button>}
  </div>
</div>
```
`personalOrgId` = `account.orgs.find(o => o.kind === "personal")?.id`. (Team orgs: a later slice adds a per-team Upgrade in the org row; personal is enough here.)
- [ ] **Step 4:** `pnpm --filter web test AccountModal` green. Commit. `git commit -am "feat(web): Plan/Billing section in the account modal"`

---

## Verification
- `pnpm --filter @rigel/signups test` + `pnpm --filter desktop test` + `pnpm --filter web test` green; all three typecheck.
- Manual (packaged or `pnpm --filter desktop dev` with a live `STRIPE_SECRET_KEY`/`STRIPE_PRICE_ID`): Account modal shows **Free** + **Upgrade** → opens the in-app Stripe window → complete Checkout → window closes → `plan` flips to **Rigel Pro**; **Manage billing** opens the Portal. Gates still allow-all (nothing new unlocks — that's Slice C).

## Self-review notes (author)
- Window detects the fixed `${endpoint}/billing/{complete,cancelled}` pages (served by the backend) — no custom scheme, no localhost server.
- Checkout is owner/admin-gated; customer created lazily + persisted (`setOrgStripeCustomer`) on first checkout — matches "created lazily at first checkout."
- `quantity = orgSeatCount` (1 for personal). Team quantity-sync on member changes is HELM-92, not here.
- Bridge follows the `account`/`appUpdate` optional-desktop-only convention so the web build tolerates its absence.
