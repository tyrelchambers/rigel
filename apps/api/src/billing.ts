import type { Context, Hono } from "hono";
import type { EntitlementPayload } from "./entitlements";
import type { StripeAdapter } from "./stripeAdapter";
import { sha, bearer } from "./authToken";

export interface BillingDeps {
  db: {
    accountByToken(hash: string): Promise<{ id: string } | null>;
    touchToken(hash: string): Promise<void>;
    orgBilling(orgId: string, accountId: string): Promise<{ stripeCustomerId: string | null; role: string } | null>;
    orgSeatCount(orgId: string): Promise<number>;
    setOrgStripeCustomer(orgId: string, customerId: string): Promise<void>;
    accountEmail(accountId: string): Promise<string>;
  };
  resolve: (accountId: string, opts?: { fresh?: boolean }) => Promise<EntitlementPayload>;
  stripe: StripeAdapter;
  priceId: string;
  publishableKey: string;
  endpoint: string; // e.g. https://api.rigel.run — for portal return urls
}

/** Bearer-token account auth shared by the billing + agent routes:
 *  bearer → sha → accountByToken → touchToken. Returns the account or null. */
export async function authed(
  c: Context,
  db: { accountByToken(hash: string): Promise<{ id: string } | null>; touchToken(hash: string): Promise<void> },
): Promise<{ id: string } | null> {
  const token = bearer(c);
  if (!token) return null;
  const acc = await db.accountByToken(sha(token));
  if (!acc) return null;
  await db.touchToken(sha(token));
  return acc;
}

export function registerBillingRoutes(app: Hono, deps: BillingDeps): void {
  /** Parse + validate a non-empty string `orgId` from the JSON body. */
  async function orgIdFromBody(c: Context): Promise<string | null> {
    const body = (await c.req.json().catch(() => null)) as { orgId?: unknown } | null;
    return typeof body?.orgId === "string" && body.orgId ? body.orgId : null;
  }

  app.get("/entitlements", async (c) => {
    const acc = await authed(c, deps.db);
    if (!acc) return c.json({ error: "unauthorized" }, 401);
    const fresh = c.req.query("fresh") === "1" || c.req.query("fresh") === "true";
    return c.json(await deps.resolve(acc.id, { fresh }));
  });

  app.post("/billing/checkout", async (c) => {
    const acc = await authed(c, deps.db);
    if (!acc) return c.json({ error: "unauthorized" }, 401);
    const orgId = await orgIdFromBody(c);
    if (!orgId) return c.json({ error: "orgId required" }, 400);
    const b = await deps.db.orgBilling(orgId, acc.id);
    if (!b) return c.json({ error: "not a member" }, 403);
    if (b.role !== "owner" && b.role !== "admin") return c.json({ error: "owner or admin required" }, 403);
    const email = await deps.db.accountEmail(acc.id);
    const { customerId, created } = await deps.stripe.ensureCustomer({ existing: b.stripeCustomerId, email, orgId });
    if (created) await deps.db.setOrgStripeCustomer(orgId, customerId);
    const quantity = await deps.db.orgSeatCount(orgId);
    const clientSecret = await deps.stripe.createCheckoutSession({ customerId, priceId: deps.priceId, quantity });
    return c.json({ clientSecret, publishableKey: deps.publishableKey });
  });

  app.post("/billing/portal", async (c) => {
    const acc = await authed(c, deps.db);
    if (!acc) return c.json({ error: "unauthorized" }, 401);
    const orgId = await orgIdFromBody(c);
    if (!orgId) return c.json({ error: "orgId required" }, 400);
    const b = await deps.db.orgBilling(orgId, acc.id);
    if (!b) return c.json({ error: "not a member" }, 403);
    if (b.role !== "owner" && b.role !== "admin") return c.json({ error: "owner or admin required" }, 403);
    if (!b.stripeCustomerId) return c.json({ error: "no subscription yet" }, 409);
    const url = await deps.stripe.createPortalSession({ customerId: b.stripeCustomerId, returnUrl: `${deps.endpoint}/billing/complete` });
    return c.json({ url });
  });

  const page = (msg: string) => `<!doctype html><meta charset=utf8><body style="font:16px system-ui;background:#0c0d0f;color:#fff;display:grid;place-items:center;height:100vh;margin:0">${msg} — you can close this window.</body>`;
  app.get("/billing/complete", (c) => c.html(page("Done")));
  app.get("/billing/cancelled", (c) => c.html(page("Cancelled")));
}
