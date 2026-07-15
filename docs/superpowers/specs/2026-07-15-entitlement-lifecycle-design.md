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
When the entitlement provider pushes an entitlement with `agentAutonomy: false` to
the forked server, the server **writes `assistant-config` `mode → advisory`** (reusing
the existing `patchConfig`/`setMode` path in `apps/server/src/assistant.ts`). The
agent reverts within one poll (~30s). Covers the common case: the user cancels while
using the app.
- **Gap:** the forked server only runs while the desktop app is open. If the
  subscription lapses while the app is closed, nothing writes the ConfigMap and the
  agent keeps remediating until the user next opens the app (which then reverts it).

### Layer 2 — backstop (desktop app closed)
Make the agent **entitlement-aware**: the desktop deploys it with a **scoped
credential** (a k8s Secret) so the agent can call `GET /entitlements` on its own
schedule and **fail-closed to advisory** when `agentAutonomy` is false (or it can't
confirm entitlement). This closes the "cancelled while the app was closed" leak — the
agent self-governs with no desktop present. Requires: (a) deploying the agent with the
credential env (`packages/k8s/src/assistant.ts` + `agent/manifests/deployment.yaml`),
(b) an entitlement check gating the remediation phase in `agent/src/index.ts` (a new
gate alongside the kill switch / autonomy-mode / breaker gauntlet).

## Re-upgrade

Because downgrade is non-destructive (agent still deployed, contexts intact),
re-upgrade just lifts the gates. **Recommendation: require the user to re-enable
autonomy** (don't silently resume autonomous cluster remediation — that's surprising
and risky), but remember the pre-downgrade mode and offer a one-click "Resume
autonomy" in the app.

## Open decisions (discuss before build)

1. **Advisory vs fully silent on downgrade.** Recommend **advisory** — keep
   observing/notifying/digesting; only stop autonomous actions.
2. **Layer 2 now, or v1 = Layer 1 only?** Layer 1 alone leaves the "cancelled while
   the app was closed" leak (a lapsed subscriber's agent keeps acting until they next
   open the app). Layer 2 is the robust fix but adds a credential-in-cluster + agent
   code. Recommend **both**, Layer 1 first.
3. **Re-upgrade:** auto-restore prior autonomy mode vs require re-enable. Recommend
   **require re-enable** (with a remembered-mode one-click).
4. **If Layer 2: credential scope.** A dedicated **entitlement-read-only token** (not
   the full account bearer) in the cluster, so a cluster compromise can't act as the
   account. Recommend the scoped token.

## Out of scope (v1)

- Ripping away already-connected cloud clusters on downgrade (hostile; kept usable).
- Per-feature partial entitlements (all paid features move together).
- Billing dunning/retry UX (Stripe owns it).
