# Entitlement Lifecycle (Pro → Free → Pro) — Design

**Ticket:** HELM-16 (monetization) follow-up
**Date:** 2026-07-15
**Status:** Draft for review. Follows the shipped monetization slices (resolver + billing + gates + upgrade UI on `feature/helm-16-monetization`).

## Problem

When a user goes **Pro → Free** (and later Free → Pro again), what happens to the
*stateful* paid features — above all the **autonomous in-cluster agent**, plus cloud
connections and notifications? Today the gates only prevent *new* paid actions taken
*through the desktop app*; they do not govern persistent in-cluster state.

## Current reality (verified from code)

- **The in-cluster agent has no entitlement awareness.** It is a long-running
  Deployment that polls every ~30s (`agent/src/index.ts:1058`), reading `mode` /
  `enabled` from the **`assistant-config` ConfigMap in the cluster**
  (`agent/src/runtimeConfig.ts:280-321`). It holds only model API tokens — **no
  account credential**, so it cannot call `GET /entitlements` even in principle
  (`agent/manifests/deployment.yaml`, `packages/k8s/src/assistant.ts`). On downgrade
  it keeps remediating on whatever `mode`/`enabled` were last written.
- **The Slice C autonomy gate only blocks a *new* `setMode → auto/window` request
  from the desktop** (`apps/server/src/index.ts` + `assistant.ts` `isAutonomyRequest`).
  It never touches an already-persisted mode, and the agent never consults it.
- **Notifications + digests are independent of autonomy mode** (gated by the kill
  switch `enabled` + channel config). Advisory mode still notifies; digests run even
  with the kill switch off (`agent/src/index.ts:745-757`, `digest.ts`).
- **Cloud connect is already non-destructive:** `canConnect` is enforced only at
  connect/import time (`apps/server/src/index.ts:248,276`); existing kubeconfig
  contexts stay usable, and nothing re-checks entitlement on use.
- Entitlement lives **only in desktop main + the forked `apps/server` memory**
  (`main.ts` provider → postMessage → `entitlements.ts` `setEntitlement`); it never
  reaches the cluster.

## Principle

The in-cluster agent is a **free feature** that always runs in **observe-only** mode; the
agent's **premium capabilities** (outbound notifications, scheduled digests, autonomous
remediation, autofix PRs) are what Pro unlocks. Downgrade is a **soft, non-destructive**
drop back to observe-only, not a teardown. Re-upgrade re-unlocks without re-provisioning.

**Why not gate the whole agent (the prize-size argument).** An earlier design made the
agent Pro-only and enforced it with a signed Ed25519 lease the agent verified offline.
That was correct *for a binary gate* — bypassing it stole the entire product, so
cryptographic tamper-resistance against the cluster owner was worth the keypair, the
courier, and a 7–14 day "open the app or it dies" cliff. Once the agent is **free and
only its capabilities are gated**, the prize for bypassing collapses to "notifications
and remediation on a process that is already running." That shrunken prize — not any
air-gap argument (the agent needs egress to reach the model API anyway) — is what makes
the lease apparatus not worth its weight. We match enforcement to the now-lower stakes.

## Per-feature behavior

| Feature | On downgrade | On re-upgrade |
|---|---|---|
| **Audits** | Can't run new (RIGEL_UNLOCKED_AUDITS empties). Stateless — nothing to preserve. | Run again. |
| **Cloud connect** | Keep existing contexts usable; block *new* connects (already the behavior). Do **not** sever access. | Connect more. |
| **In-cluster agent** | Drops to **observe-only**: keeps watching + recording incident history (the free job), but **no** notifications, digests, autonomous remediation, or autofix PRs. Agent stays deployed and running. The app *also* scales the Deployment to 0 as an edge-triggered courtesy. | Next entitlement check (≤ ~a day) re-unlocks the capabilities. If scaled to 0, user resumes/scales it up. |
| **Notifications / digests / remediation / autofix** | **Stop** — these are the agent's premium capabilities. (Metric-threshold alerts the desktop app computes itself are unaffected.) | Return on re-upgrade. |

**The free-tier job — overnight incident history.** Observe-only is not dead weight: the
free agent records what broke while the desktop app was closed, so the user opens Rigel
to "here are the 3 things that broke overnight." That is both the free hook and the
sharpest Pro upsell ("you weren't notified about these — upgrade").

## The enforcement mechanism — the agent checks entitlement live (the crux)

Nothing the agent does passes through Rigel's servers (it runs on the user's
ServiceAccount, calls the model API with the *user's* token, notifies channels directly,
opens PRs with the *user's* GitHub token), so there is no server-side chokepoint. The
only reliable gate is for the agent to **ask our backend, on a schedule, whether its org
is still entitled** — which requires giving it a scoped identity.

### The scoped agent token
- At install/setup, the **desktop** (authed as the account) calls a new route
  `POST /agent/token` with the org this install serves. The backend verifies membership,
  mints an **install-scoped, org-bound, revocable** token (only capability: "return this
  org's entitlement"), stores its hash, and returns it. The desktop writes it into the
  agent's **existing credentials Secret** (next to the far-more-valuable model token, so
  it does not move the exposure needle) — **no new Secret, no new agent RBAC**.

### The live entitlement check (agent-side)
- The agent reads the token from env and calls `GET /agent/entitlement` on
  `api.rigel.run` **every ~12–24h**. **`orgId` is derived from the token server-side,
  never accepted as a request parameter** — otherwise the route is an entitlement
  enumeration oracle. The route is rate-limited (single-digit calls/day/install).
- The agent **caches** the answer in its existing **`assistant-state` ConfigMap** (zero
  new RBAC, no Secret) with a `fetchedAt` timestamp, and honors a **30-day grace window**
  so a backend outage or connectivity blip never strands a paying customer.
- **Downgrade requires a positive, authenticated "free" answer.** An unreachable backend,
  5xx, or malformed response **holds last-known-good** within grace — otherwise one bad
  `api.rigel.run` deploy returning "free" would flip the entire paying fleet to
  observe-only within a day. This distinction is load-bearing.
- Cheap plausibility guard on the cache: reject a cached entitlement whose `fetchedAt` is
  in the future or older than the grace window (stops a pasted far-future timestamp from
  making a stale "entitled" cache immortal). **Do not sign the cache** — signing it is
  just rebuilding the lease.

### What the agent gates
Observe + incident-history recording **always run**. The live-check result gates only the
premium branches: outbound notifications, scheduled digests, autonomous remediation
(kubectl actions), and autofix PRs. The check lands **once, at the top of `tick()`** —
structurally above the digest path, which today deliberately bypasses the `enabled`
kill-switch — setting an "entitled" flag the premium branches consult.

### Residual bypass (named honestly)
The grace cache is a softer surface than the lease: a `kubectl exec` + edit the cached
value to `entitled:true` is easier than patching the image. Two things make it acceptable:
the **live re-fetch self-heals it** within 12–24h (to make an edit stick the user must
*also* NetworkPolicy-block the agent's egress to `api.rigel.run` while leaving the model
API reachable, and re-apply before each grace expiry — deliberate-piracy tier, not a
one-liner), and **the prize is small**. The determined pirate still wins by patching the
image, exactly as with the lease; the casual `kubectl scale` bypass buys nothing because
the agent is free anyway.

### Scale-to-zero (app-side courtesy)
On a **fresh, successfully-fetched free result** (edge-triggered via the already-built
`entitlementProvider.detectAgentDowngrade` — **not** the null/no-cache default, which
would strand a Pro user on a glitchy fetch), the forked server **scales the agent
Deployment to 0** in every installed context, so an honest downgraded user isn't running
even an observe-only pod. Purely resource hygiene; enforcement of the premium capabilities
is the live-check, independent of replica count.

## Re-upgrade

The agent's next entitlement check (≤ ~a day, or immediately on the desktop pushing a
refresh) re-unlocks the premium capabilities — no re-provisioning. If the Deployment was
scaled to 0 on downgrade, the user resumes it explicitly (one-click "Resume" / scale to
1); the live-check already permits the capabilities.

## Decisions (resolved via two Fable reviews + user)

1. **Downgrade posture: observe-only, not off.** The agent is a **free feature**; only its
   premium capabilities (notify/digest/remediate/autofix) are gated. Free-tier job =
   overnight incident history.
2. **Enforcement: the agent checks entitlement live** against `api.rigel.run` using a
   scoped token, cached with a 30-day grace. The **signed lease is dropped** — its
   tamper-resistance guarded a prize that no longer exists.
3. **`orgId` derived from the token server-side, never a request param** (the one
   security-critical detail — prevents an enumeration oracle).
4. **Grace distinguishes authenticated-free (downgrade) from unreachable/error (hold
   last-known-good)** so a backend bug can't cause a fleet-wide paid-feature outage.
5. **Token: install-scoped, org-bound, revocable**, stored in the agent's existing
   credentials Secret. **No new agent RBAC, no Secret read** — cache lives in
   `assistant-state` (a ConfigMap the agent already writes).
6. **Scale-to-0 stays** as the edge-triggered downgrade courtesy (reuses
   `detectAgentDowngrade`, already built + tested). Replaces L1's advisory-revert.
7. **Install path fail-closed defaults** (seeded advisory + agent's fail-closed mode read)
   remain correct defense-in-depth; the live-check is the real capability gate.

## Build slices

- **Slice E1 — signups mints the token + serves entitlement:** `agent_tokens` table
  (hash, orgId, installId, revoked, createdAt); authed `POST /agent/token` (verify
  membership → mint org-bound install-scoped token); agent-token-authed
  `GET /agent/entitlement` (orgId from token, per-org resolve, rate-limited). Reuses the
  existing per-org billing lookup (`orgBilling`) + Stripe feature keys.
- **Slice E2 — agent live-check + capability gating:** read the token from env; a
  scheduled (~12–24h) `GET /agent/entitlement` with cache in `assistant-state` +
  30-day grace + authenticated-free-vs-error distinction + timestamp plausibility guard;
  a single entitlement flag set at the top of `tick()` that gates the notify / digest /
  remediation / autofix branches. Observe + incident recording always run.
- **Slice E3 — desktop/server: mint on install + scale-to-0 courtesy:** desktop mints the
  agent token (`POST /agent/token`) during agent install/setup and threads it into the
  credentials Secret; **replace** the committed `revertAgentsToAdvisory` downgrade action
  with `scaleAgentsToZero` (keep `detectAgentDowngrade`).
- **Slice E4 — "Resume" UI:** one-click resume (scale the Deployment back to 1) surfaced
  after re-upgrade when the agent is at 0 replicas.

## Out of scope (v1)

- Ripping away already-connected cloud clusters on downgrade (hostile; kept usable).
- Per-capability partial entitlements (all premium capabilities move together).
- The overnight-incident-history *desktop surface* itself (separate feature slice/ticket;
  the agent already observes + writes state — this design only guarantees observe keeps
  running on free).
- Billing dunning/retry UX (Stripe owns it).
- Token rotation / a revocation UI (schema supports revoke; no admin surface in v1).
