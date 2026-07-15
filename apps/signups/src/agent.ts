import { randomBytes, randomUUID } from "node:crypto";
import type { Context, Hono } from "hono";
import { sha, bearer } from "./authToken";
import { authed } from "./billing";
import { createRateLimiter } from "./rateLimit";
import type { OrgEntitlement } from "./entitlements";

export interface AgentDeps {
  db: {
    accountByToken(hash: string): Promise<{ id: string } | null>;
    touchToken(hash: string): Promise<void>;
    orgBilling(orgId: string, accountId: string): Promise<{ stripeCustomerId: string | null; role: string } | null>;
    createAgentToken(input: { orgId: string; installId: string; tokenHash: string }): Promise<void>;
    agentTokenByHash(hash: string): Promise<{ orgId: string; installId: string; revoked: boolean } | null>;
  };
  resolveOrg: (orgId: string) => Promise<OrgEntitlement>;
}

export function registerAgentRoutes(app: Hono, deps: AgentDeps): void {
  // Per-replica, approximate — cluster-wide precision would need a shared store.
  const allow = createRateLimiter(10, 3_600_000);

  app.post("/agent/token", async (c) => {
    const acc = await authed(c, deps.db);
    if (!acc) return c.json({ error: "unauthorized" }, 401);
    const body = (await c.req.json().catch(() => null)) as { orgId?: unknown } | null;
    const orgId = typeof body?.orgId === "string" && body.orgId ? body.orgId : null;
    if (!orgId) return c.json({ error: "orgId required" }, 400);
    if (!(await deps.db.orgBilling(orgId, acc.id))) return c.json({ error: "not a member" }, 403);
    const token = "rig_agent_" + randomBytes(32).toString("base64url");
    const installId = randomUUID();
    await deps.db.createAgentToken({ orgId, installId, tokenHash: sha(token) });
    return c.json({ token, installId });
  });

  app.get("/agent/entitlement", async (c: Context) => {
    const token = bearer(c);
    if (!token) return c.json({ error: "unauthorized" }, 401);
    const hash = sha(token);
    if (!allow(hash)) return c.json({ error: "rate limited" }, 429);
    const row = await deps.db.agentTokenByHash(hash);
    if (!row || row.revoked) return c.json({ error: "unauthorized" }, 401);
    return c.json(await deps.resolveOrg(row.orgId));
  });
}
