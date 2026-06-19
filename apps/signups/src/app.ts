import { Hono } from "hono";
import { parseSignup, type Signup } from "./validate";

export interface AppDeps {
  appKey: string;
  upsert: (s: Signup) => Promise<void>;
  allow: (key: string) => boolean;
}

export function createApp({ appKey, upsert, allow }: AppDeps): Hono {
  const app = new Hono();

  app.get("/health", (c) => c.json({ ok: true }));

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
