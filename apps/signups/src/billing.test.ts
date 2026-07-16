import { test, expect, vi } from "vitest";
import { Hono } from "hono";
import { registerBillingRoutes } from "./billing";
import type { EntitlementPayload } from "./entitlements";

function appWith(overrides = {}) {
  const app = new Hono();
  const db = { accountByToken: vi.fn(async () => ({ id: "acc-1", email: "a@b.co", name: null })), touchToken: vi.fn(async () => {}) };
  const resolve = vi.fn(async (): Promise<EntitlementPayload> => ({ plan: "pro", audits: ["security"], cloudConnect: false, agentAutonomy: false, fetchedAt: "t" }));
  registerBillingRoutes(app, { db: db as never, resolve, stripe: {} as never, priceId: "price_1", publishableKey: "pk_test_abc", endpoint: "https://api.rigel.run", ...overrides });
  return { app, db, resolve };
}

test("GET /entitlements returns the resolved payload for a valid token", async () => {
  const { app, resolve } = appWith();
  const res = await app.request("/entitlements", { headers: { authorization: "Bearer tok" } });
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ plan: "pro", audits: ["security"] });
  expect(resolve).toHaveBeenCalledWith("acc-1", { fresh: false });
});

test("GET /entitlements?fresh=1 bypasses the cache", async () => {
  const { app, resolve } = appWith();
  const res = await app.request("/entitlements?fresh=1", { headers: { authorization: "Bearer tok" } });
  expect(res.status).toBe(200);
  expect(resolve).toHaveBeenCalledWith("acc-1", { fresh: true });
});

test("GET /entitlements without fresh does not force a bypass", async () => {
  const { app, resolve } = appWith();
  const res = await app.request("/entitlements", { headers: { authorization: "Bearer tok" } });
  expect(res.status).toBe(200);
  expect(resolve).toHaveBeenCalledWith("acc-1", { fresh: false });
});

test("GET /entitlements 401 without a valid token", async () => {
  const { app } = appWith({ db: { accountByToken: vi.fn(async () => null), touchToken: vi.fn() } });
  const res = await app.request("/entitlements", { headers: { authorization: "Bearer bad" } });
  expect(res.status).toBe(401);
});

test("POST /billing/checkout creates a customer if none, persists it, returns the client secret + publishable key", async () => {
  const db = { accountByToken: vi.fn(async () => ({ id: "acc-1" })), touchToken: vi.fn(),
    orgBilling: vi.fn(async () => ({ stripeCustomerId: null, role: "owner" })),
    orgSeatCount: vi.fn(async () => 1), setOrgStripeCustomer: vi.fn(async () => {}),
    accountEmail: vi.fn(async () => "a@b.co") };
  const stripe = { ensureCustomer: vi.fn(async () => ({ customerId: "cus_new", created: true })),
    createCheckoutSession: vi.fn(async () => "cs_test_123") };
  const app = new Hono(); registerBillingRoutes(app, { db, resolve: vi.fn(), stripe, priceId: "price_1", endpoint: "https://api.rigel.run", publishableKey: "pk_test_abc" } as never);
  const res = await app.request("/billing/checkout", { method: "POST", headers: { authorization: "Bearer t", "content-type": "application/json" }, body: JSON.stringify({ orgId: "o1" }) });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ clientSecret: "cs_test_123", publishableKey: "pk_test_abc" });
  expect(db.setOrgStripeCustomer).toHaveBeenCalledWith("o1", "cus_new");
  expect(stripe.createCheckoutSession).toHaveBeenCalledWith({ customerId: "cus_new", quantity: 1, priceId: "price_1" });
});

test("POST /billing/checkout 403 when caller is a plain member", async () => {
  const db = { accountByToken: vi.fn(async () => ({ id: "acc-1" })), touchToken: vi.fn(),
    orgBilling: vi.fn(async () => ({ stripeCustomerId: null, role: "member" })) };
  const app = new Hono(); registerBillingRoutes(app, { db, resolve: vi.fn(), stripe: {}, priceId: "p", endpoint: "e" } as never);
  const res = await app.request("/billing/checkout", { method: "POST", headers: { authorization: "Bearer t", "content-type": "application/json" }, body: JSON.stringify({ orgId: "o1" }) });
  expect(res.status).toBe(403);
});

test("POST /billing/checkout 400 on a missing/invalid orgId (before touching the db)", async () => {
  const orgBilling = vi.fn();
  const db = { accountByToken: vi.fn(async () => ({ id: "acc-1" })), touchToken: vi.fn(), orgBilling };
  const app = new Hono(); registerBillingRoutes(app, { db, resolve: vi.fn(), stripe: {}, priceId: "p", endpoint: "e" } as never);
  for (const body of ["", "{}", JSON.stringify({ orgId: 123 })]) {
    const res = await app.request("/billing/checkout", { method: "POST", headers: { authorization: "Bearer t", "content-type": "application/json" }, body });
    expect(res.status).toBe(400);
  }
  expect(orgBilling).not.toHaveBeenCalled();
});
