# Stripe setup — Rigel Pro entitlements

Manual dashboard setup that backs `GET /entitlements` in `apps/signups`. The app is
deliberately policy-free: the plan → feature mapping and the price live entirely in
Stripe, never in code. The backend only ever resolves a customer's **active
entitlements** and unions the feature keys.

> The Feature **lookup keys must match** the keys in
> `apps/signups/src/entitlements.ts` exactly — `reliability`, `security`,
> `performance`, `cloudConnect`, `agentAutonomy`. A typo silently resolves to free.

## Test vs live mode

Stripe **mode is set by the key**: `sk_test_`/`rk_test_` ⇒ test, `sk_live_`/`rk_live_`
⇒ live. `STRIPE_PRICE_ID` **must match the key's mode** — a test key with a live price
id (or vice versa) is an error. Test and live have separate products/prices/features
and separate keys; you never mix them in one deployment. The service logs its mode on
boot (`[signups] Stripe: test mode (price_...)`) and **refuses to start on a
key/price mode mismatch**.

Run this whole setup **twice** — once in **test** (a sandbox account) to verify the
flow end to end, then again in **live** for launch — and keep two Secrets:

| Secret | Deployment | Key + price |
|---|---|---|
| `rigel-signups` | production (`api.rigel.run`) | **live** key + **live** price |
| `rigel-signups-test` | test deployment / local run | **test** key + **test** price |

A test/dev desktop build points at the test backend via `RIGEL_SIGNUP_ENDPOINT`
(release builds stay on `api.rigel.run`); that endpoint must equal the test
deployment's `BILLING_ENDPOINT` so the in-app billing window detects the redirect.

## 1. Product + Price

Create one **Product**: "Rigel Pro". Add a **recurring, per-seat (licensed) Price**,
billed monthly. The dollar amount is your choice and is changeable in the dashboard
without an app release — it never appears in code.

Per-seat billing means the subscription quantity mirrors the org's member count. A
personal org at quantity 1 is "Pro"; a team org at quantity N is "Team". These are UX
labels over the one per-seat subscription — not two products.

## 2. Features

In **Product catalog → Features**, create five Features with these **lookup keys
exactly**:

- `reliability`
- `security`
- `performance`
- `cloudConnect`
- `agentAutonomy`

## 3. Attach the Features to the Product

Attach **all five** Features to the "Rigel Pro" Product. Any active subscription then
grants all five. Stripe Entitlements ignore quantity, so seats are billing-only — one
seat or a hundred, the same five features are entitled.

## 4. Activate the Customer Portal

The Customer Portal must be **configured once per mode** or `/billing/portal`
(`billingPortal.sessions.create`) errors. In **Settings → Billing → Customer portal**,
activate it and enable **cancel subscription** (optionally plan switching + payment-method
update). The code creates a session against the account's **default** configuration, so
this activation is what makes "Manage billing" work.

## 5. Restricted API key

Create a **restricted API key** with:

- **write** on Checkout / Billing / Customers (needed by Slice B's checkout + portal)
- **read** on Entitlements (needed by Slice A's resolver)

Put it in the `rigel-signups` Secret as `STRIPE_SECRET_KEY`. With the key unset the
service still runs and `GET /entitlements` returns free for everyone (the stub
adapter).

## 6. Changing the free/paid boundary later

- **Make a feature free:** detach its Feature from the Product. Active subscriptions
  stop entitling it; the resolver drops it on the next refresh.
- **Add a new paid feature:** create its Feature (with a new lookup key), attach it to
  the Product, then add a matching field in `resolvePayload` in
  `apps/signups/src/entitlements.ts` plus the consumer that reads it. The
  resolution/cache machinery is untouched.

## Configured values (record)

### Test (sandbox — `acct_1TtXi5LV2nDXZUGB`, "Rigel sandbox")

Created and verified via the Stripe CLI/MCP:

| Thing | Value |
|---|---|
| Product | `prod_UtKVhNnDFsRPBl` (Rigel Pro) |
| Price (per-seat / mo, licensed) | `price_1TtXr8LV2nDXZUGBi2rUVGYy` — $20 placeholder → `STRIPE_PRICE_ID` (test) |
| Features (attached) | `reliability` · `security` · `performance` · `cloudConnect` · `agentAutonomy` |
| Customer Portal | default config active (cancel + payment-method + invoice history) |
| `STRIPE_SECRET_KEY` (test) | grab an `sk_test_`/`rk_test_` key from the sandbox's Developers → API keys |

Put these in the `rigel-signups-test` Secret.

### Live (fill at launch)

Re-run steps 1–5 in the **live** account, then record:

| Thing | Value |
|---|---|
| Product | `prod_…` |
| Price | `price_…` → `STRIPE_PRICE_ID` (live) |
| `STRIPE_SECRET_KEY` (live) | `sk_live_`/`rk_live_` key |

Put these in the `rigel-signups` Secret (production).
