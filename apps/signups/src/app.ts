import { Hono } from "hono";
import { cors } from "hono/cors";
import { parseSignup, type Signup } from "./validate";

export interface AppDeps {
  appKey: string;
  upsert: (s: Signup) => Promise<void>;
  allow: (key: string) => boolean;
}

// Origins allowed to call /signups from a browser. The marketing site (rigel.run)
// posts the "early access" waitlist form here; the desktop app calls it from Node
// (no Origin header, unaffected by CORS).
const ALLOWED_ORIGINS = ["https://rigel.run", "https://www.rigel.run"];

export function createApp({ appKey, upsert, allow }: AppDeps): Hono {
  const app = new Hono();

  app.get("/health", (c) => c.json({ ok: true }));

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
    return c.json({ ok: true });
  });

  return app;
}
