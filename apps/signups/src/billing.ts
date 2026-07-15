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
