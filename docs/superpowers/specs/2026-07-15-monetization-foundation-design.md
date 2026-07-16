# Monetization Foundation (HELM-16) — Build Design

**Ticket:** HELM-16 (Stream 3 — monetization)
**Date:** 2026-07-15
**Status:** Design. Consolidates two approved design records into a buildable plan now that the blocker (accounts) has shipped.

## What this is

HELM-16 turns Rigel's already-built *seams* into a working paid product. The hard
architecture was decided earlier; this spec fixes the remaining product + billing
decisions and defines the build slices. It stands on two approved records — do not
re-litigate them:

- **Entitlements architecture** (`2026-07-04-entitlements-architecture-design.md`):
  policy lives in **Stripe Entitlements**; the backend resolves `identity → org →
  Stripe customer → resolved entitlement payload`; the client caches it with a
  **14-day grace → free-tier** fallback; the consumer seam (`canRunAudit`,
  `useAuditEntitlement`, `canConnect`) is already merged as allow-all.
- **Org/teams model** (`2026-07-13-org-teams-accounts-design.md`, Slice 1 shipped):
  the **billing subject is always the org**; entitlements are the **union across
  the account's memberships** (no active-org); **seat billing = Stripe subscription
  quantity auto-synced to member count**; Stripe Entitlements ignore quantity.

The accounts/identity dependency (HELM-15) shipped this session, so both are now
buildable.

## Final product decisions (this brainstorm)

1. **Plan model: Free + Pro + Team → one per-seat paid product.** Pro and Team
   unlock the *same* features, and Team billing is already "quantity = member
   count." So there is **one paid Stripe product, "Rigel Pro," priced per seat.**
   A personal org at quantity 1 is "Pro"; a team org at quantity N is "Team."
   "Pro" / "Team" are UX labels over one per-seat subscription — not two products.
2. **Free/paid boundary:**
   - **Paid (any active Rigel Pro subscription on any of your orgs):** the **audit
     skills** (reliability/security/performance), **cloud cluster connect**
     (EKS/GKE/AKS/DOKS), and **autonomous agent** (agent acting on its own).
   - **Free:** everything needed to actually use Rigel — viewing/editing workloads,
     local kind/k3d clusters, importing a kubeconfig, the AI chat, scheduled
     digests, multi-cluster viewing, RBAC analyzer, catalog installs.
3. **Price is set in Stripe, not in code.** The app is deliberately policy-free; the
   dollar amount is a dashboard setting you choose, changeable without a release.
4. **Billing flow: in-app Electron window → Stripe hosted pages.** "Upgrade" opens
   an Electron `BrowserWindow` on a Stripe **Checkout** session; "Manage billing"
   opens the Stripe **Customer Portal**. Stripe handles the card; we embed their
   page and close the window on the success redirect, then refetch entitlements.
   No card data touches Rigel.

## Data model (additive; `organizations` already shipped)

`organizations` shipped **without** `stripe_customer_id` (the known trap). Add it
additively — `CREATE TABLE IF NOT EXISTS` will NOT evolve an existing table, so use
`ALTER TABLE`:

```sql
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS stripe_customer_id text;
CREATE UNIQUE INDEX IF NOT EXISTS organizations_stripe_customer_idx
  ON organizations (stripe_customer_id) WHERE stripe_customer_id IS NOT NULL;
```

Created lazily at first checkout. No seats table (a membership row *is* a seat), no
subscription-mirror table (resolver + quantity-sync read Stripe live with a ~60s
in-process cache).

## Backend (`apps/signups` at api.rigel.run)

1. **`GET /entitlements`** — authed by the account bearer token. Resolves the union
   of features across the account's personal org + every team org it belongs to:
   for each org with a `stripe_customer_id`, read the customer's **active
   entitlements** (Stripe Entitlements API); union the feature keys. Returns the
   **resolved payload** (below). Never exposes plan→feature policy.
2. **`POST /billing/checkout`** — `{ orgId }`. Lazily creates the Stripe customer on
   the org if absent, creates a per-seat Checkout session (quantity = current member
   count) with `success_url`/`cancel_url` the desktop can detect, returns the URL.
3. **`POST /billing/portal`** — `{ orgId }` → Stripe Customer Portal session URL for
   managing/cancelling. Owner/admin only.
4. **Seat quantity sync** — on membership add/remove (org admin routes, deferred to
   the Org Slice-2 backend HELM-92), set the subscription quantity to
   `COUNT(memberships)` with `proration_behavior: 'create_prorations'`. Billing is
   always truthful; no seat caps.

## Resolved payload (from the architecture doc, concrete)

```jsonc
{
  "plan": "pro",                                        // display only; app never branches on it
  "audits": ["reliability", "security", "performance"], // unlocked audit kinds
  "cloudConnect": true,
  "agentAutonomy": true,
  "fetchedAt": "2026-07-15T00:00:00Z"
}
```

Free tier = `{ plan: "free", audits: [], cloudConnect: false, agentAutonomy: false }`.
Adding a future paid feature = a new field + a consumer reading it; the
resolution/cache machinery is untouched.

## Client (desktop)

1. **Entitlement provider** — fetch `/entitlements` on launch + every ~6h; persist
   the last payload + `fetchedAt` to a local cache; apply **cache → 14-day grace →
   free-tier** fallback (offline / brief outage never locks out a payer; first run
   with no cache = free until one success). Exposes the current entitlement.
2. **Repoint the three swap points** (no gate rewrites — they already take an
   entitlement): `useAuditEntitlement()` (web), `canConnect` (cloud), and the
   agent/CLI `RIGEL_UNLOCKED_AUDITS` env stop returning defaults and read the
   provider. `agentAutonomy` gates the autonomous-agent controls.
3. **Billing window + upgrade UX** — a `rigel:billing:checkout` / `:portal` IPC that
   asks the backend for a session URL and opens it in an Electron `BrowserWindow`;
   on navigation to `success_url`, close + refetch entitlements. Upgrade entry
   points: (a) an **Account-panel billing section** (plan, seats, Upgrade / Manage
   billing), and (b) **in-context prompts** when a Free user hits a gated action
   (run an audit / connect a cloud cluster / enable agent autonomy) → "Upgrade to
   unlock" → checkout.

## Slices + build order

One design, three implementation plans. **Order matters so no one is ever locked
out with no way to pay:**

1. **Slice A — Billing schema + resolver + Stripe setup.** `stripe_customer_id`
   migration; `GET /entitlements` (union resolution); create the "Rigel Pro"
   per-seat Product + its Features (reliability/security/performance/cloudConnect/
   agentAutonomy) in Stripe. Resolver returns free for everyone until a subscription
   exists. *No client behavior change yet.*
2. **Slice B — Billing flow.** `/billing/checkout` + `/billing/portal`; the in-app
   billing window + Account-panel billing section. A user can now **subscribe and
   manage** — but gates are still allow-all, so paying just shows "Pro" cosmetically.
3. **Slice C — Flip the gates.** Repoint the three swap points to the provider +
   add the in-context upgrade prompts. This is the moment enforcement goes live —
   done **last**, after checkout works, so the paid path exists before the wall.

Seat quantity-sync (backend) lands with the Org Slice-2 member routes (HELM-92),
not here; until teams exist, every subscription is quantity 1 (personal Pro).

## Fail modes / edge cases

- **Offline / resolver down:** cached entitlement honored for 14 days, then free.
- **New team member:** app lights up Pro on next `/entitlements` refetch (≤6h, or
  immediately on a manual refresh) — no re-login. Seat removal downgrades on refetch.
- **Checkout abandoned / card declined:** no customer subscription → resolver keeps
  returning free; nothing to clean up.
- **Owner cancels:** the resolver returns free on the next successful refetch, so
  the plan drops to free within ~6h (or immediately on a manual refresh). The
  14-day client grace applies **only when the resolver is unreachable**
  (offline/outage) — it never props up a real cancellation.

## Out of scope (v1)

- **Webhook-driven cache invalidation** — launch + 6h polling + manual refresh
  suffices; add a webhook nudge later.
- **Usage/metering billing** — per-seat only.
- **Seat caps / "out of seats" flows** — quantity mirrors reality (Slack model).
- **Org admin/member management UI** — that's Org Slice 2 (HELM-91/92/93); this
  spec assumes personal orgs (quantity 1) and is forward-compatible with teams.
