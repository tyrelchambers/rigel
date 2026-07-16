import { test, expect, vi } from "vitest";
import { Hono } from "hono";
import { registerAgentRoutes } from "./agent";
import { sha } from "./authToken";
import type { OrgEntitlement } from "./entitlements";

function appWith(overrides: Record<string, unknown> = {}) {
  const db = {
    accountByToken: vi.fn(async () => ({ id: "acc-1" })),
    touchToken: vi.fn(async () => {}),
    orgBilling: vi.fn(async () => ({ stripeCustomerId: null, role: "owner" })),
    createAgentToken: vi.fn(async () => {}),
    agentTokenByHash: vi.fn(async () => ({ orgId: "orgA", installId: "inst-1", revoked: false })),
  };
  const resolveOrg = vi.fn(async (orgId: string): Promise<OrgEntitlement> => ({
    agentEntitled: orgId === "orgA",
    plan: orgId === "orgA" ? "pro" : "free",
    fetchedAt: "T",
  }));
  const app = new Hono();
  registerAgentRoutes(app, { db: db as never, resolveOrg, ...overrides } as never);
  return { app, db, resolveOrg };
}

test("POST /agent/token mints a token for an org member and stores its hash", async () => {
  const { app, db } = appWith();
  const res = await app.request("/agent/token", {
    method: "POST",
    headers: { authorization: "Bearer t", "content-type": "application/json" },
    body: JSON.stringify({ orgId: "orgA" }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { token: string; installId: string };
  expect(body.token).toMatch(/^rig_agent_/);
  expect(body.installId).toBeTruthy();
  expect(db.orgBilling).toHaveBeenCalledWith("orgA", "acc-1");
  expect(db.createAgentToken).toHaveBeenCalledWith({ orgId: "orgA", installId: body.installId, tokenHash: sha(body.token) });
});

test("POST /agent/token 403 for a non-member", async () => {
  const { app } = appWith({
    db: { accountByToken: vi.fn(async () => ({ id: "acc-1" })), touchToken: vi.fn(), orgBilling: vi.fn(async () => null), createAgentToken: vi.fn() },
  });
  const res = await app.request("/agent/token", {
    method: "POST",
    headers: { authorization: "Bearer t", "content-type": "application/json" },
    body: JSON.stringify({ orgId: "orgA" }),
  });
  expect(res.status).toBe(403);
});

test("POST /agent/token 401 without a bearer token", async () => {
  const { app } = appWith();
  const res = await app.request("/agent/token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ orgId: "orgA" }),
  });
  expect(res.status).toBe(401);
});

test("POST /agent/token 400 when orgId is missing", async () => {
  const { app } = appWith();
  const res = await app.request("/agent/token", {
    method: "POST",
    headers: { authorization: "Bearer t", "content-type": "application/json" },
    body: "{}",
  });
  expect(res.status).toBe(400);
});

test("GET /agent/entitlement returns the token's org entitlement (entitled)", async () => {
  const { app, resolveOrg } = appWith();
  const res = await app.request("/agent/entitlement", { headers: { authorization: "Bearer agenttok" } });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ agentEntitled: true, plan: "pro", fetchedAt: "T" });
  expect(resolveOrg).toHaveBeenCalledWith("orgA");
});

test("GET /agent/entitlement free org → not entitled", async () => {
  const { app } = appWith({
    db: {
      agentTokenByHash: vi.fn(async () => ({ orgId: "orgFree", installId: "i", revoked: false })),
    },
  });
  const res = await app.request("/agent/entitlement", { headers: { authorization: "Bearer agenttok" } });
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ agentEntitled: false, plan: "free" });
});

test("LOCK-IN: orgId query param is ignored; token's org wins", async () => {
  const { app, resolveOrg } = appWith();
  const res = await app.request("/agent/entitlement?orgId=orgB", { headers: { authorization: "Bearer agenttok" } });
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ agentEntitled: true, plan: "pro" });
  expect(resolveOrg).toHaveBeenCalledWith("orgA");
  expect(resolveOrg).not.toHaveBeenCalledWith("orgB");
});

test("GET /agent/entitlement 401 for an unknown token hash", async () => {
  const { app } = appWith({ db: { agentTokenByHash: vi.fn(async () => null) } });
  const res = await app.request("/agent/entitlement", { headers: { authorization: "Bearer nope" } });
  expect(res.status).toBe(401);
});

test("GET /agent/entitlement 401 for a revoked token", async () => {
  const { app } = appWith({ db: { agentTokenByHash: vi.fn(async () => ({ orgId: "orgA", installId: "i", revoked: true })) } });
  const res = await app.request("/agent/entitlement", { headers: { authorization: "Bearer revoked" } });
  expect(res.status).toBe(401);
});

test("GET /agent/entitlement 401 without a bearer token", async () => {
  const { app } = appWith();
  const res = await app.request("/agent/entitlement");
  expect(res.status).toBe(401);
});

test("GET /agent/entitlement rate limits a token past the hourly cap", async () => {
  const { app } = appWith();
  let last = 200;
  for (let i = 0; i < 11; i++) {
    const res = await app.request("/agent/entitlement", { headers: { authorization: "Bearer agenttok" } });
    last = res.status;
  }
  expect(last).toBe(429);
});
