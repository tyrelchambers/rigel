import { serve } from "@hono/node-server";
import pg from "pg";
import { createApp } from "./app";
import { ensureSchema, upsertSignup } from "./db";
import { createRateLimiter } from "./rateLimit";
import { createKitNotifier } from "./kit";
import { ensureAuthSchema, createAuthDb } from "./authDb";
import { createResendSender } from "./resend";

const PORT = Number(process.env.PORT ?? 8080);
const APP_KEY = process.env.APP_KEY ?? "";
const DATABASE_URL = process.env.DATABASE_URL ?? "";
const KIT_API_KEY = process.env.KIT_API_KEY ?? "";
const KIT_TAG_ID = process.env.KIT_TAG_ID ? Number(process.env.KIT_TAG_ID) : null;
const RESEND_API_KEY = process.env.RESEND_API_KEY ?? "";
const RESEND_FROM = process.env.RESEND_FROM ?? "Rigel <login@rigel.run>";
if (!APP_KEY) { console.error("APP_KEY is required"); process.exit(1); }
if (!DATABASE_URL) { console.error("DATABASE_URL is required"); process.exit(1); }
if (!KIT_API_KEY) console.warn("KIT_API_KEY not set — signups will not sync to Kit");
if (!RESEND_API_KEY) console.warn("RESEND_API_KEY not set — auth code emails will fail");

const pool = new pg.Pool({ connectionString: DATABASE_URL });
await ensureSchema(pool);
await ensureAuthSchema(pool);

const allow = createRateLimiter(30, 60_000); // 30 req/min per IP
const notify = createKitNotifier({ apiKey: KIT_API_KEY, tagId: KIT_TAG_ID });
const authDb = createAuthDb(pool);
const sendCode = createResendSender({ apiKey: RESEND_API_KEY, from: RESEND_FROM });
// Tighter, separate limiters (namespaced keys prevent collision with /signups).
const allowRequest = createRateLimiter(5, 10 * 60_000);  // 5 code requests / 10 min per key
const allowVerify = createRateLimiter(10, 10 * 60_000);  // 10 verify attempts / 10 min per key
const app = createApp({
  appKey: APP_KEY,
  upsert: (s) => upsertSignup(pool, s),
  allow,
  notify,
  auth: { db: authDb, sendCode, allowRequest, allowVerify },
});

serve({ fetch: app.fetch, port: PORT, hostname: "0.0.0.0" }, (info) =>
  console.log(`signups api on :${info.port}`),
);
