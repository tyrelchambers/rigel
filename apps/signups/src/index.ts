import { serve } from "@hono/node-server";
import pg from "pg";
import { createApp } from "./app";
import { ensureSchema, upsertSignup } from "./db";
import { createRateLimiter } from "./rateLimit";

const PORT = Number(process.env.PORT ?? 8080);
const APP_KEY = process.env.APP_KEY ?? "";
const DATABASE_URL = process.env.DATABASE_URL ?? "";
if (!APP_KEY) { console.error("APP_KEY is required"); process.exit(1); }
if (!DATABASE_URL) { console.error("DATABASE_URL is required"); process.exit(1); }

const pool = new pg.Pool({ connectionString: DATABASE_URL });
await ensureSchema(pool);

const allow = createRateLimiter(30, 60_000); // 30 req/min per IP
const app = createApp({ appKey: APP_KEY, upsert: (s) => upsertSignup(pool, s), allow });

serve({ fetch: app.fetch, port: PORT, hostname: "0.0.0.0" }, (info) =>
  console.log(`signups api on :${info.port}`),
);
