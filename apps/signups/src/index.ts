import { serve } from "@hono/node-server";
import pg from "pg";
import { createApp } from "./app";
import { ensureSchema, upsertSignup } from "./db";
import { createRateLimiter } from "./rateLimit";
import { createKitNotifier } from "./kit";
import { ensureAuthSchema, createAuthDb } from "./authDb";
import { createResendSender } from "./resend";
import { createStripeAdapter, makeStripeAdapter } from "./stripeAdapter";
import { makeResolver } from "./entitlements";

const PORT = Number(process.env.PORT ?? 8080);
const APP_KEY = process.env.APP_KEY ?? "";
const DATABASE_URL = process.env.DATABASE_URL ?? "";
const KIT_API_KEY = process.env.KIT_API_KEY ?? "";
const KIT_TAG_ID = process.env.KIT_TAG_ID ? Number(process.env.KIT_TAG_ID) : null;
const RESEND_API_KEY = process.env.RESEND_API_KEY ?? "";
const RESEND_FROM = process.env.RESEND_FROM ?? "Rigel <login@rigel.run>";
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY ?? "";
if (!APP_KEY) { console.error("APP_KEY is required"); process.exit(1); }
if (!DATABASE_URL) { console.error("DATABASE_URL is required"); process.exit(1); }
if (!KIT_API_KEY) console.warn("KIT_API_KEY not set — signups will not sync to Kit");
if (!RESEND_API_KEY) console.warn("RESEND_API_KEY not set — auth code emails will fail");
if (!STRIPE_SECRET_KEY) console.warn("[signups] STRIPE_SECRET_KEY unset — /entitlements returns free for everyone");

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
const stripeAdapter = STRIPE_SECRET_KEY
  ? createStripeAdapter(STRIPE_SECRET_KEY)
  : makeStripeAdapter({ entitlements: { activeEntitlements: { list: async () => ({ data: [] }) } } } as never); // unset key → everyone free
const resolve = makeResolver({ db: authDb, stripe: stripeAdapter, now: () => new Date().toISOString() });
const app = createApp({
  appKey: APP_KEY,
  upsert: (s) => upsertSignup(pool, s),
  allow,
  notify,
  auth: { db: authDb, sendCode, allowRequest, allowVerify },
  billing: { db: authDb, resolve },
});

serve({ fetch: app.fetch, port: PORT, hostname: "0.0.0.0" }, (info) =>
  console.log(`signups api on :${info.port}`),
);
