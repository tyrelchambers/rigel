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

Downgrade is a **soft, non-destructive revert to free-tier behavior**, not a teardown.
Re-upgrade reactivates without re-provisioning.

## Per-feature behavior

| Feature | On downgrade | On re-upgrade |
|---|---|---|
| **Audits** | Can't run new (RIGEL_UNLOCKED_AUDITS empties). Stateless — nothing to preserve. | Run again. |
| **Cloud connect** | Keep existing contexts usable; block *new* connects (already the behavior). Do **not** sever access. | Connect more. |
| **Autonomous agent** | Flip to **advisory**: stops autonomous remediation, keeps observing + notifying + running digests. Agent stays deployed. | Autonomy can be turned back on. |
| **Notifications / digests** | **Keep flowing** (advisory alerts + digests are free-tier-appropriate and retention-friendly). Only autonomous *actions* stop. | Unchanged. |

## The enforcement mechanism — the agent (the crux)

Stopping autonomous remediation on downgrade requires something to **write the
cluster** (the agent will never self-govern on plan state today). Two layers:

### Layer 1 — immediate revert (desktop app open)
When the entitlement provider observes a **fresh, successfully-fetched free result**
(edge-triggered — **not** the null/no-cache default, which would strand a Pro user on a
glitchy fetch), the forked server writes `assistant-config`: **`mode → advisory` AND
`autofixEnabled → false`**. Both matter: the autofix-PR branch (`agent/src/index.ts:518`)
runs *before* the autonomy gate, so flipping mode alone does **not** stop autonomous
fix-PRs. It writes **every kubeconfig context that has an agent installed** (each with
its own namespace), with retry — unreachable clusters are picked up on the next push
(boot + 6h). Reuses `patchConfig`.
- Layer 1 is **honor-system only** — the user can edit the ConfigMap back (Rigel ships
  a ConfigMap editor / Apply YAML). Layer 2 is what makes it real.

### Layer 2 — the signed lease (real enforcement, works offline)
The agent gates autonomy on a **short-lived signed lease**, not a credential:
- The **signups backend signs a lease** `{ orgId, agentAutonomy, exp }` with an
  **Ed25519 private key** (`LEASE_SIGNING_KEY` in the `rigel-signups` Secret). A new
  authed route `GET /billing/lease` returns it (the resolver already knows the org
  entitlement).
- The **desktop**, on each entitlement refresh (boot + 6h), fetches the lease and
  **writes it into a cluster Secret** (`assistant-lease`) in each agent's namespace.
- The **agent** reads the lease each tick, **verifies signature + expiry with a public
  key baked into the agent image**, and permits `auto`/`window` **and** autofix **only**
  while a valid, unexpired lease grants `agentAutonomy`. Fail-closed: no valid lease →
  advisory. Grace = the lease TTL (**7–14 days**), mirroring the desktop's grace.
- **Why a lease beats a credential-in-cluster:** nothing to steal (public-key verify,
  no account token in the cluster), works on **air-gapped clusters** (no agent egress),
  can't be forged by editing the ConfigMap, and degrades gracefully (autonomy simply
  expires if the app isn't opened within the TTL). Trade-off: the user must open the
  app within the lease window to keep autonomy alive — acceptable for a desktop-first
  product.
- **Whose entitlement:** the lease carries `orgId`, so the **org's** plan governs the
  agent (a Pro team keeps its cluster's agent alive even if the deploying member
  downgrades personally).

## Re-upgrade

Non-destructive downgrade means re-upgrade just re-issues a lease granting autonomy.
But **the ConfigMap `mode` stays `advisory`** (Layer 1 set it), so autonomy does **not**
silently resume — the user **re-enables** it (a one-click "Resume autonomy" that
restores the remembered prior mode). The lease permits it again; the user re-affirms.

## Decisions (resolved via Fable review)

1. **Downgrade posture: advisory** — keep observing/notifying/digesting; stop only
   autonomous actions **and** autofix PRs.
2. **Backstop: the signed lease** (over a credential-in-cluster).
3. **Entitlement scope: org** (the lease carries `orgId`).
4. **Re-upgrade: require re-enable** (remembered-mode one-click). Layer 1 edge-triggers
   on a genuine free result so a transient fetch glitch can't strand a paying user.
5. **Install path: already hardened** (seed advisory + agent fail-closes) — shipped as
   a separate commit before this work.

## Build slices

- **Slice L1 — Layer 1 + edge-trigger:** desktop provider edge-detects a fresh free →
  server writes `mode: advisory` + `autofixEnabled: false` to every agent-cluster (with
  retry). No crypto; self-contained.
- **Slice L2 — the lease:** signups `LEASE_SIGNING_KEY` + `GET /billing/lease`; desktop
  writes the `assistant-lease` Secret per cluster; agent verifies the lease (baked-in
  public key) and gates `auto`/`window` + autofix on it. Public key is a build-time
  constant in the agent image; support a `kid` for rotation.
- **Slice L3 — re-enable UI:** "Resume autonomy" affordance on re-upgrade (remembered
  mode).

## Out of scope (v1)

- Ripping away already-connected cloud clusters on downgrade (hostile; kept usable).
- Per-feature partial entitlements (all paid features move together).
- Billing dunning/retry UX (Stripe owns it).
