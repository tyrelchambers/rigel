# Organizations & Teams — Accounts Design (record)

**Related tickets:** extends HELM-15 (accounts/auth) and HELM-16 (monetization).
**Date:** 2026-07-13
**Status:** Design record (approved direction). Not yet a build plan. Slice 1 must land alongside HELM-16's resolver, before any Stripe code. Grounded on the shipped HELM-15 Phase-1 accounts backend (`apps/signups`) and the HELM-16 entitlements architecture (`docs/superpowers/specs/2026-07-04-entitlements-architecture-design.md`).

## Problem

The same system must serve two customer shapes without forking into two billing/identity code paths:
1. **Individuals** — sign up, own plan, billed personally (HELM-15 already gives them identity).
2. **Teams** — an organization holds a plan that applies to every member/seat and is billed per-seat, with members added/removed over time.

The HELM-15 token model (passwordless OTP → opaque bearer) needs **zero changes** for this. The thing that must be shaped correctly now is HELM-16's not-yet-built resolver, plus a small additive schema on top of `accounts`.

## Three decisions (everything follows from these)

### 1. "Personal" IS an organization. The billing subject is always the org.

Every account auto-gets a `kind='personal'` org with one member. The Stripe customer hangs off the **org**, never the account. Since HELM-16's Stripe mapping is unbuilt, making the billing subject `organization` from day one costs nothing and gives the resolver exactly one code path forever: `org → customer → entitlements`. (GitHub / Vercel / Clerk all converged here.) The alternative — nullable `org_id` with the resolver branching personal-vs-org — is two billing paths maintained forever.

### 2. No "acting as" / active-org context. Entitlements are the UNION across all your seats.

This is Rigel-specific and the largest simplification: **Rigel has no org-scoped resources.** Clusters, audits, cloud-connect are all local to the user's machine. An org exists only to pay for seats. So an org switcher, an org claim in the token, or an `X-Rigel-Org` header would model something the product does not have.

- The bearer token stays pure person-identity — **unchanged from Phase 1.**
- `GET /entitlements` returns the **union** of features across the account's personal org plus every team org it is a member of. Get invited to your company's org → your app lights up Pro on the next refetch. No switching, no re-login. Seat removal takes effect on next refetch, not next login.
- Org id appears only in the path of explicit admin routes (`/orgs/:id/...`), where membership + role are checked per request.

If org-scoped resources ever appear (shared fleet views, org settings), add an active-org selector then; the schema below already supports it. Do not build it now.

### 3. Seat billing = auto-sync Stripe subscription quantity to active member count (Slack model).

Quantity on a licensed per-seat price mirrors `COUNT(memberships)`. Add member → quantity+1 with `proration_behavior: 'create_prorations'`; remove → quantity-1. No seats table, no seat-cap enforcement, no "you're out of seats" flow — billing is always truthful. A `max_seats` column can be added later if enterprise procurement demands caps.

**Critically: Stripe Entitlements ignore quantity** — any active subscription grants the product's features. So quantity is purely a billing knob, and entitlement resolution is unaffected by seat count. This is the clean split we want.

## Data model (additive migration to `AUTH_SCHEMA`)

```sql
CREATE TABLE organizations (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind                text NOT NULL CHECK (kind IN ('personal','team')),
  name                text NOT NULL,
  personal_account_id uuid UNIQUE REFERENCES accounts(id) ON DELETE CASCADE,
  stripe_customer_id  text UNIQUE,          -- created lazily at first checkout
  created_at          timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'personal') = (personal_account_id IS NOT NULL))
);

CREATE TABLE memberships (                   -- a row IS a seat
  org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  role       text NOT NULL CHECK (role IN ('owner','admin','member')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, account_id)
);
CREATE INDEX memberships_account_idx ON memberships (account_id);
CREATE UNIQUE INDEX memberships_one_owner_idx ON memberships (org_id) WHERE role = 'owner';

CREATE TABLE invitations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email       text NOT NULL,                 -- lower(trim()), same canon as accounts
  role        text NOT NULL DEFAULT 'member' CHECK (role IN ('admin','member')),
  invited_by  uuid NOT NULL REFERENCES accounts(id),
  expires_at  timestamptz NOT NULL,          -- now() + 14 days, DB time
  accepted_at timestamptz,
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX invitations_pending_idx ON invitations (org_id, email)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;
```

Notes:
- **No seats table** — a membership row *is* a seat. The partial unique index guarantees exactly one owner per org.
- **No Stripe subscription mirror table** — the resolver and the quantity-sync both read the customer's active subscription live (with a ~60s in-process cache). One less thing to drift.
- `accounts`, `login_codes`, `auth_tokens` and the OTP flow are **unchanged**.
- Backfill (idempotent, inside `ensureAuthSchema`'s pattern): create a personal org + owner membership for every existing account; grow `upsertAccount` to create the personal org + owner membership on account creation, in the same transaction.

## Identity vs membership, and the new `/me`

The OTP authenticates a person (account). Membership is data, not credential. `/me` grows (the `account.id` field already shipped in HELM-15 Phase 1):

```jsonc
{
  "account": { "id": "…", "email": "…", "name": "…" },
  "orgs": [
    { "id": "…", "kind": "personal", "name": "Tyrel", "role": "owner" },
    { "id": "…", "kind": "team",     "name": "Acme",  "role": "member" }
  ],
  "invitations": [ { "id": "…", "orgName": "Globex", "role": "member" } ]
}
```

The `invitations` array is the entire invite-discovery mechanism (see below). The Electron main `me()` (HELM-15 Phase 2, unbuilt) must pass this **whole** object through contextBridge, not a trimmed `{email,name}`, or it gets re-plumbed later.

## Entitlement resolution (revises the HELM-16 resolver — do this before writing Stripe code)

`GET /entitlements` (Bearer):
1. Auth the token → account (existing `accountByToken`).
2. Load all orgs where the account has a membership (personal org always present).
3. For each org with a `stripe_customer_id`, list active Stripe Entitlements for that customer (cached ~60s in-process).
4. **Union** the feature sets: `audits` = set-union of arrays; booleans OR'd. `plan` (display only) = highest-ranked source.
5. Return the opaque resolved payload plus a `sources` array:

```jsonc
{
  "plan": "team",
  "audits": ["reliability","security","performance"],
  "cloudConnect": true,
  "sources": [ { "orgId": "…", "orgName": "Acme", "plan": "team" } ],
  "fetchedAt": "…"
}
```

"App never holds policy" is preserved: the union happens server-side; the app consumes an opaque payload through the exact provider / cache / 14-day-grace machinery HELM-16 already specifies. Seat removed → org drops out of step 2 → next refetch shrinks the payload.

**Accepted gap:** the 14-day offline grace lets a removed seat-holder keep features for up to 14 days *without connectivity*. If that ever matters commercially, shorten grace for payloads whose `sources` are all team orgs. Not solved in v1.

## Stripe objects

- **One Customer per organization** (personal orgs included, created lazily at first checkout). No Customer per person, ever. No Stripe Connect (that is for marketplaces/payouts — irrelevant here).
- **Prices:** personal plan = licensed price, quantity 1. Team plan = licensed per-seat price, quantity = member count. Features (Stripe Entitlements) attach to Products; the team Product carries the team feature set.
- **Checkout:** `POST /orgs/:id/billing/checkout` (owner only) creates the Customer server-side first if absent, then a Checkout Session bound to it, returns the URL; the desktop opens it in the system browser. Because the customer is created+linked before checkout, no webhook is needed just to learn the customer↔org mapping. `POST /orgs/:id/billing/portal` returns a Stripe Billing Portal link (card/cancel/invoices).
- **Quantity sync:** invite-accept, member-remove, and leave each end with "set active subscription quantity = `COUNT(memberships WHERE org_id=…)`, `create_prorations`". The DB change commits first; a Stripe-sync failure is surfaced loudly to the admin and caught by a daily reconcile sweep (count vs quantity across all team orgs). The reconcile is what makes the inline sync allowed to fail — keeping it simple.
- **Webhooks:** deferrable (consistent with HELM-16). Launch-fetch + periodic refetch bound staleness. When added (`customer.subscription.updated/deleted` busting the 60s resolver cache), it is one Hono route + `STRIPE_WEBHOOK_SECRET`.

## Roles & invitations

Roles: `owner` (exactly one — billing, transfer, delete org), `admin` (manage members/invites), `member` (holds a seat). **V1 ships owner + member only**; `admin` is already a valid CHECK value, enabled later with no migration.

**Invites are email-bound and OTP is the verification** (elegant for a desktop-only product with no web surface):
1. Admin: `POST /orgs/:id/invitations { email, role }` → row + Resend email ("You've been invited to Acme on Rigel. Open Rigel and sign in with this address.").
2. Invitee signs in via the normal OTP flow. The OTP already proves control of exactly the invited email, so **no separate invite token or acceptance link is needed.**
3. `/me` surfaces the pending invite; the app shows an accept/decline banner. `POST /invitations/:id/accept` (Bearer; server checks `invite.email = account.email`, unexpired, unrevoked) → membership insert + quantity sync, one transaction plus the Stripe call.

Other routes: `GET /orgs/:id/members`; `DELETE /orgs/:id/members/:accountId` (admin+, cannot remove the owner); `POST /orgs/:id/leave` (owner cannot leave); `POST /orgs/:id/transfer-ownership { accountId }` (owner only, target must be a member; swap roles in one transaction, the partial unique owner index enforces correctness); `DELETE /orgs/:id/invitations/:invId`. Code convention: one injected `orgDb` object beside `authDb`; handlers pure and vitest-able against fakes (mirrors HELM-15).

## Changes to prior specs / already-shipped code

1. **HELM-16 resolver:** change "identity → Stripe customer" to "**org → Stripe customer, union across memberships**." Single most important correction — make it before any Stripe code is written. Fold into `docs/superpowers/specs/2026-07-04-entitlements-architecture-design.md` when HELM-16 is planned.
2. **`account.id` in `/me` (+ `/auth/verify`):** DONE — shipped on `feature/helm-15-accounts` (commit `5f1c0f79`). Needed as the key for org membership/admin routes.
3. **Electron `me()` returns the full `/me` payload** (account + orgs + invitations) to the renderer — a HELM-15 Phase-2 note (that code is unbuilt); do not trim to `{email,name}`.
4. Personal-org backfill migration + `upsertAccount` personal-org-on-create.
5. Everything else (token model, `safeStorage`, session secret, rate limiting) is **org-agnostic and untouched**. Individuals never notice any of this: their personal org is invisible in the UI and their billing is their personal org's customer.

## Infrastructure

`apps/signups` stays the home — identity and billing share every table, so a separate accounts/billing service would only add a network boundary between two tightly-coupled concerns. Additions: `STRIPE_SECRET_KEY` (now, when Slice 1 starts), `STRIPE_WEBHOOK_SECRET` (later), invite + receipt templates in Resend. The in-memory rate-limiter one-replica constraint already documented in HELM-15 also binds the new 60s entitlement cache and the invite limiter. Revisit splitting the service only if a hosted/web surface ever appears.

## Recommended build order

1. **Slice 1 — personal-as-org foundation** (do *with* HELM-16, before any Stripe code): migration + backfill, personal org on account create, `/me` gains `orgs`, resolver built org-keyed from day one serving personal plans only. Individuals can buy. No team UI. **This is the slice that must land before HELM-16's resolver exists.**
2. **Slice 2 — teams, owner-only:** `POST /orgs`, email-bound OTP invites + accept, member list/remove/leave, per-seat checkout, quantity auto-sync, union resolver (structurally done in Slice 1, now exercised).
3. **Slice 3:** admin role, transfer ownership, billing portal link, invite revoke/expiry UI.
4. **Slice 4:** Stripe webhooks + daily quantity reconcile + org-grace tightening if commercially warranted.

Each slice is additive and individually shippable.

## Not in scope

- Org-scoped resources / an active-org selector (Rigel has none today; add if that changes).
- SSO / SCIM / directory sync (enterprise, far later).
- Usage/metered billing (per-seat licensed only).
- Multi-org billing consolidation, resellers, Stripe Connect.
