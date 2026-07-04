# Entitlements Architecture — Design (record)

**Ticket:** HELM-16 (monetization / plan configuration)
**Date:** 2026-07-04
**Status:** Design recorded. **Not yet implementable** — depends on HELM-16 accounts + Stripe billing, which do not exist yet. The client-side gate seam is already in place (see "Current state").

## Problem

Change what a plan unlocks (audits, cloud providers, future premium features),
run promos, or flip a feature — **without releasing a new desktop app version.**

## Principle

The app must never contain the plan→feature policy. It fetches a **resolved
entitlement** from the backend at runtime; the policy lives server-side where it
is edited freely. The app only ever sees "you have these features," never "Pro
means X." One entitlements payload covers all gated surfaces (audits, cloud
connect, future) — plumb it once.

```
identity (account credential)
  → backend resolves: identity → Stripe customer → active entitlements
  → app fetches the RESULT: { audits: ["reliability","security"], cloudConnect: true, ... }
  → cached locally; canRunAudit()/canConnect()/… read the cache
```

## Decisions (approved)

- **Policy source: Stripe Entitlements.** Define Features on Stripe Products; a
  customer's active subscription yields their entitlements. The backend reads
  Stripe's entitlements API. Changing access = editing Products/Features in the
  Stripe dashboard. No app release, no custom admin UI, native to HELM-16 billing.
- **Fail mode: cache + grace, then free tier.** Cache the last resolved
  entitlement with a timestamp. Honor it for a grace window (14 days) so a brief
  outage or offline use never locks a paying user out. Past the window with no
  successful refresh → fall back to the free/base tier. First-ever run with no
  cache → free tier until one successful fetch.

## Components

1. **Stripe (policy):** Products carry Features; subscriptions grant entitlements.
   Source of truth for both "what a plan includes" and "what plan this customer is
   on."
2. **Backend resolver** (`api.rigel.run`, or a route it owns): `GET /entitlements`
   authenticated by the account credential → looks up the Stripe customer → reads
   active entitlements → returns a **resolved payload** (feature flags + unlocked
   audit kinds). The app never talks to Stripe directly.
3. **Client entitlement provider** (desktop): fetch on launch + periodically (and
   on a billing webhook nudge if added later); persist the last payload + fetch
   time to a local cache; expose the current entitlement to consumers. Applies the
   cache + grace + free-tier fallback.
4. **Consumers:** `useAuditEntitlement()` (web) and the CLI's `RIGEL_UNLOCKED_AUDITS`
   env stop returning hardcoded defaults and read from the provider's current
   entitlement; `canConnect` (cloud) does the same. `canRunAudit` /
   `parseUnlockedAudits` are unchanged — they already take an entitlement.

## Identity (dependency: HELM-16 accounts)

The app needs an account credential to send to the resolver so it can find the
Stripe customer. This is the accounts/auth piece of HELM-16 (the existing
first-run name+email signup + `api.rigel.run` are the seed). Until accounts exist,
the resolver has nothing to key on — hence this whole layer is gated on HELM-16.

## Resolved payload (shape)

```jsonc
{
  "plan": "pro",                     // display only; app never branches on it
  "audits": ["reliability", "security", "performance"],
  "cloudConnect": true,
  "fetchedAt": "2026-07-04T00:00:00Z"
}
```

The app maps `audits` → the `AuditEntitlement { unlocked }` the existing seam
consumes. Adding a future premium feature = a new field here + a consumer reading
it; no change to the resolution/cache machinery.

## Current state (the seam is already ready)

The audit gate already implements the *consumer* side cleanly (merged, allow-all):
- `@rigel/k8s`: `canRunAudit(kind, entitlement)`, `AuditEntitlement`,
  `DEFAULT_AUDIT_ENTITLEMENT`, `parseUnlockedAudits(env)`.
- Desktop: `useAuditEntitlement()` returns the default today — **the swap point**
  becomes "read the provider's cached entitlement."
- Agent/CLI: `RIGEL_UNLOCKED_AUDITS` env — set by the agent/desktop from the
  fetched entitlement when this lands.

So "turning it on" = build components 1–3 (Stripe + resolver + client provider)
and repoint the three swap points. No consumer/gate rewrites.

## Not in scope here

Building it — blocked on HELM-16 accounts + Stripe. This document is the design to
execute once those exist. Also deferred: webhook-driven cache invalidation
(polling + launch fetch suffices for v1), and per-seat/usage metering.
