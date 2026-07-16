import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { parseSignup, type Signup } from "./validate";
import { registerAuthRoutes, type AuthDeps } from "./auth";
import { registerBillingRoutes, type BillingDeps } from "./billing";
import { registerAgentRoutes, type AgentDeps } from "./agent";

export interface AppDeps {
  appKey: string;
  upsert: (s: Signup) => Promise<void>;
  allow: (key: string) => boolean;
  /** Best-effort side sync (e.g. Kit). Failures are logged, never surfaced. */
  notify?: (s: Signup) => Promise<void>;
  /** When present, mounts the /auth/* + /me account routes. */
  auth?: AuthDeps;
  /** When present, mounts the /entitlements billing route. */
  billing?: BillingDeps;
  /** When present, mounts the /agent/* routes (token mint + entitlement). */
  agent?: AgentDeps;
}

// Origins allowed to call /signups from a browser. The marketing site (rigel.run)
// posts the "early access" waitlist form here; the desktop app calls it from Node
// (no Origin header, unaffected by CORS).
const ALLOWED_ORIGINS = ["https://rigel.run", "https://www.rigel.run"];

export function createApp({ appKey, upsert, allow, notify, auth, billing, agent }: AppDeps): Hono {
  const app = new Hono();

  app.get("/health", (c) => c.json({ ok: true }));

  app.use("*", logger());

  // Browser CORS for the waitlist form. Reflects an allowed Origin (and handles
  // the OPTIONS preflight, which the custom x-rigel-key header forces).
  app.use(
    "/signups",
    cors({
      origin: (origin) => (ALLOWED_ORIGINS.includes(origin) ? origin : null),
      allowMethods: ["POST", "OPTIONS"],
      allowHeaders: ["Content-Type", "x-rigel-key"],
      maxAge: 86_400,
    }),
  );

  app.post("/signups", async (c) => {
    if (c.req.header("x-rigel-key") !== appKey) return c.json({ error: "unauthorized" }, 401);
    const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
    if (!allow(ip)) return c.json({ error: "rate limited" }, 429);
    let body: unknown;
    try { body = await c.req.json(); } catch { return c.json({ error: "invalid json" }, 400); }
    const parsed = parseSignup(body);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    await upsert(parsed.value);
    if (notify) {
      // Best-effort: a Kit failure must not fail the signup (Postgres is source of truth).
      try { await notify(parsed.value); } catch (e) { console.error("kit sync failed", e); }
    }
    return c.json({ ok: true });
  });

  if (auth) registerAuthRoutes(app, auth);
  if (billing) registerBillingRoutes(app, billing);
  if (agent) registerAgentRoutes(app, agent);

  app.onError((err, c) => {
    console.error(`[signups] unhandled error on ${c.req.method} ${c.req.path}:`, err);
    return c.json({ error: "internal error" }, 500);
  });

  return app;
}
