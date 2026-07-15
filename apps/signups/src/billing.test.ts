import { test, expect, vi } from "vitest";
import { Hono } from "hono";
import { registerBillingRoutes } from "./billing";
import type { EntitlementPayload } from "./entitlements";

function appWith(overrides = {}) {
  const app = new Hono();
  const db = { accountByToken: vi.fn(async () => ({ id: "acc-1", email: "a@b.co", name: null })), touchToken: vi.fn(async () => {}) };
  const resolve = vi.fn(async (): Promise<EntitlementPayload> => ({ plan: "pro", audits: ["security"], cloudConnect: false, agentAutonomy: false, fetchedAt: "t" }));
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
