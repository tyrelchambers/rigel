import { serve } from "@hono/node-server";
import pg from "pg";
import { createApp } from "./app";
import { ensureSchema, upsertSignup } from "./db";
import { createRateLimiter } from "./rateLimit";
import { createKitNotifier } from "./kit";
import { ensureAuthSchema, createAuthDb } from "./authDb";
import { createResendSender } from "./resend";
import { createStripeAdapter, makeStripeAdapter, stripeKeyMode } from "./stripeAdapter";
import { makeResolver, resolveOrgEntitlement } from "./entitlements";

const PORT = Number(process.env.PORT ?? 8080);
const APP_KEY = process.env.APP_KEY ?? "";
const DATABASE_URL = process.env.DATABASE_URL ?? "";
const KIT_API_KEY = process.env.KIT_API_KEY ?? "";
const KIT_TAG_ID = process.env.KIT_TAG_ID ? Number(process.env.KIT_TAG_ID) : null;
const RESEND_API_KEY = process.env.RESEND_API_KEY ?? "";
const RESEND_FROM = process.env.RESEND_FROM ?? "Rigel <login@rigel.run>";
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY ?? "";
const STRIPE_PRICE_ID = process.env.STRIPE_PRICE_ID ?? "";
const STRIPE_PUBLISHABLE_KEY = process.env.STRIPE_PUBLISHABLE_KEY ?? "";
// Must match the desktop's SIGNUP_ENDPOINT base (apps/desktop/src/main.ts, itself
// overridable via RIGEL_SIGNUP_ENDPOINT) — the billing window detects completion
// by prefix-matching ${endpoint}/billing/complete. Override in a test deployment.
const BILLING_ENDPOINT = process.env.BILLING_ENDPOINT ?? "https://api.rigel.run";
const FREE_BETA = /^(1|true|yes|on)$/i.test(process.env.RIGEL_FREE_BETA ?? "");
if (!APP_KEY) { console.error("APP_KEY is required"); process.exit(1); }
if (!DATABASE_URL) { console.error("DATABASE_URL is required"); process.exit(1); }
if (!KIT_API_KEY) console.warn("KIT_API_KEY not set — signups will not sync to Kit");
if (!RESEND_API_KEY) console.warn("RESEND_API_KEY not set — sign-in link emails will fail");
if (!STRIPE_SECRET_KEY) console.warn("[api] STRIPE_SECRET_KEY unset — /entitlements returns free for everyone");
if (!STRIPE_PRICE_ID) console.warn("[api] STRIPE_PRICE_ID unset — /billing/checkout will fail to create a session");
if (!STRIPE_PUBLISHABLE_KEY) console.warn("[api] STRIPE_PUBLISHABLE_KEY unset — /billing/checkout returns no usable key, the client cannot mount Embedded Checkout");
if (FREE_BETA) console.warn("[api] RIGEL_FREE_BETA on — all accounts fully entitled; billing bypassed");

const pool = new pg.Pool({ connectionString: DATABASE_URL });
await ensureSchema(pool);
await ensureAuthSchema(pool);

const allow = createRateLimiter(30, 60_000); // 30 req/min per IP
const notify = createKitNotifier({ apiKey: KIT_API_KEY, tagId: KIT_TAG_ID });
const authDb = createAuthDb(pool);
const sendLink = createResendSender({ apiKey: RESEND_API_KEY, from: RESEND_FROM });
// Tighter, separate limiters (namespaced keys prevent collision with /signups).
const allowRequest = createRateLimiter(5, 10 * 60_000);  // 5 link requests / 10 min per key
const allowVerify = createRateLimiter(10, 10 * 60_000);  // 10 confirm attempts / 10 min per key
// The desktop polls every 2s for the first 2 min, then every 15s, until the 15 min TTL.
// Keyed by poll-token hash, so one app instance cannot starve another.
const allowPoll = createRateLimiter(240, 10 * 60_000);
// Per-IP gate for /auth/poll, checked BEFORE the token key so a flood of random
// tokens cannot grow the limiter's map. Generous enough for a whole office
// behind one egress IP; each in-flight sign-in spends ~112 requests.
const allowPollIp = createRateLimiter(2000, 10 * 60_000);
const stripeAdapter = STRIPE_SECRET_KEY
  ? createStripeAdapter(STRIPE_SECRET_KEY)
  : makeStripeAdapter({ entitlements: { activeEntitlements: { list: async () => ({ data: [] }) } } } as never); // unset key → everyone free

// Log the mode (from the key prefix) so a glance at the logs says which Stripe
// account this is talking to. Then fail-fast on a key/price MODE mismatch (e.g. a
// test key with a live price id) — a confirmed mismatch is fatal (billing would be
// broken), but a network blip verifying it must NOT gate the auth backend.
const stripeMode = stripeKeyMode(STRIPE_SECRET_KEY);
console.log(`[api] Stripe: ${stripeMode} mode${STRIPE_PRICE_ID ? ` (price ${STRIPE_PRICE_ID})` : ""}`);
const publishableMode = stripeKeyMode(STRIPE_PUBLISHABLE_KEY);
if ((stripeMode === "test" || stripeMode === "live") && (publishableMode === "test" || publishableMode === "live") && publishableMode !== stripeMode) {
  console.error(
    `[api] FATAL: Stripe key is ${stripeMode} mode but STRIPE_PUBLISHABLE_KEY is ${publishableMode} mode — refusing to run with mismatched billing config.`,
  );
  process.exit(1);
}
if ((stripeMode === "test" || stripeMode === "live") && STRIPE_PRICE_ID) {
  void stripeAdapter
    .priceLivemode(STRIPE_PRICE_ID)
    .then((live) => {
      if (live !== (stripeMode === "live")) {
        console.error(
          `[api] FATAL: Stripe key is ${stripeMode} mode but STRIPE_PRICE_ID ${STRIPE_PRICE_ID} is ${live ? "live" : "test"} mode — refusing to run with mismatched billing config.`,
        );
        process.exit(1);
      }
      console.log(`[api] Stripe price mode verified (${stripeMode}).`);
    })
    .catch((e) => console.warn(`[api] could not verify Stripe price mode (${e instanceof Error ? e.message : e}) — continuing`));
}

const resolve = makeResolver({ db: authDb, stripe: stripeAdapter, now: () => new Date().toISOString(), freeBeta: FREE_BETA });
const app = createApp({
  appKey: APP_KEY,
  upsert: (s) => upsertSignup(pool, s),
  allow,
  notify,
  auth: { db: authDb, sendLink, allowRequest, allowVerify, allowPoll, allowPollIp, publicUrl: BILLING_ENDPOINT },
  billing: { db: authDb, resolve, stripe: stripeAdapter, priceId: STRIPE_PRICE_ID, publishableKey: STRIPE_PUBLISHABLE_KEY, endpoint: BILLING_ENDPOINT },
  agent: {
    db: authDb,
    resolveOrg: (orgId) => resolveOrgEntitlement(orgId, { db: authDb, stripe: stripeAdapter, now: () => new Date().toISOString(), freeBeta: FREE_BETA }),
  },
});

serve({ fetch: app.fetch, port: PORT, hostname: "0.0.0.0" }, (info) =>
  console.log(`[api] listening on :${info.port}`),
);
