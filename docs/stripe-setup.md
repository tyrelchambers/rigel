# Stripe setup — Rigel Pro entitlements

Manual dashboard setup that backs `GET /entitlements` in `apps/signups`. The app is
deliberately policy-free: the plan → feature mapping and the price live entirely in
Stripe, never in code. The backend only ever resolves a customer's **active
entitlements** and unions the feature keys.

> The Feature **lookup keys must match** the keys in
> `apps/signups/src/entitlements.ts` exactly — `reliability`, `security`,
> `performance`, `cloudConnect`, `agentAutonomy`. A typo silently resolves to free.

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

## 4. Restricted API key

Create a **restricted API key** with:

- **write** on Checkout / Billing / Customers (needed by Slice B's checkout + portal)
- **read** on Entitlements (needed by Slice A's resolver)

Put it in the `rigel-signups` Secret as `STRIPE_SECRET_KEY`. With the key unset the
service still runs and `GET /entitlements` returns free for everyone (the stub
adapter).

## 5. Changing the free/paid boundary later

- **Make a feature free:** detach its Feature from the Product. Active subscriptions
  stop entitling it; the resolver drops it on the next refresh.
- **Add a new paid feature:** create its Feature (with a new lookup key), attach it to
  the Product, then add a matching field in `resolvePayload` in
  `apps/signups/src/entitlements.ts` plus the consumer that reads it. The
  resolution/cache machinery is untouched.
