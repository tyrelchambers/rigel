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
| **In-cluster agent** | Goes **fully idle**: with no valid lease the agent's whole loop no-ops — no remediation, no observing, no notifying, no digests. The app also scales the Deployment to 0 (courtesy, when it can reach the cluster). | User re-enables (scales it back up / "Resume"); a fresh valid lease lets the loop run again. |
| **Notifications / digests** | **Stop** — they are the agent's output, and the agent is a Pro feature. (Metric-threshold alerts the desktop app computes itself are unaffected.) | Return when the agent runs again. |

## The enforcement mechanism — the signed lease (the crux)

The agent is a **Pro-only feature**. On Free it runs **nothing**. Because the cluster is
the user's, no app-side action (scaling, ConfigMap edits) can be trusted to hold — a
downgraded user can `kubectl scale --replicas=1` or edit the ConfigMap back. Enforcement
therefore lives **inside the agent**, gated on a **short-lived signed lease** it cannot
forge:

### The lease (real enforcement, works offline, survives manual scale-up)
- The **signups backend signs a lease** `{ orgId, agentEntitled, exp, kid }` with an
  **Ed25519 private key** (`LEASE_SIGNING_KEY` in the `rigel-signups` Secret). A new
  authed route `GET /billing/lease` returns it (the resolver already knows the org
  entitlement; `agentEntitled` is true only when the org's plan includes the agent).
- The **desktop**, on each entitlement refresh (boot + 6h), fetches the lease and
  **writes it into a cluster Secret** (`assistant-lease`) in each agent's namespace —
  via the forked server (postMessage → `kubectl apply`), reusing the existing
  per-installed-context machinery.
- The **agent** reads the lease **every tick**, **verifies signature + expiry against a
  public key baked into the agent image**, and runs its loop **only** while a valid,
  unexpired lease has `agentEntitled: true`. **No valid lease → the whole loop no-ops**:
  no observe, no notify, no digest, no remediation, no autofix PR. Fail-closed. Grace =
  the lease TTL (**7–14 days**), mirroring the desktop's grace.
- **Why a lease beats a credential-in-cluster:** nothing to steal (public-key verify,
  no account token in the cluster), works on **air-gapped clusters** (no agent egress),
  can't be forged by editing the ConfigMap **or by scaling the Deployment back up** —
  the pod boots, finds no valid lease, and idles. Degrades gracefully (the agent simply
  goes idle if the app isn't opened within the TTL). Trade-off: the user must open the
  app within the lease window to keep the agent alive — acceptable for a desktop-first
  product.
- **Whose entitlement:** the lease carries `orgId`, so the **org's** plan governs the
  agent (a Pro team keeps its cluster's agent alive even if the deploying member
  downgrades personally).

### Scale-to-zero (app-side courtesy, not the wall)
On a **fresh, successfully-fetched free result** (edge-triggered — **not** the
null/no-cache default, which would strand a Pro user on a glitchy fetch), the forked
server **scales the agent Deployment to 0** in every installed context, so an honest
Free user isn't running an inert pod at all. This is purely resource hygiene; if the
user scales it back up, the **lease** is what keeps the loop idle. Reuses the
edge-detection already built in `entitlementProvider.detectAgentDowngrade`.

## Re-upgrade

Re-upgrade re-issues a valid lease, so the agent is **permitted** to run again — but it
does **not** silently reactivate. The Deployment was scaled to 0 on downgrade, so the
user **re-enables** it explicitly (a one-click "Resume" that scales it back to 1). The
lease permits the loop; the user re-affirms by turning it on.

## Decisions (resolved via Fable review + user)

1. **Downgrade posture: fully idle (off entirely)** — no observe/notify/digest/remediate
   without a valid lease. NOT advisory. The agent is a Pro-only feature.
2. **Enforcement: the signed lease inside the agent** — the only mechanism that survives
   a manual `kubectl scale` / ConfigMap edit and works air-gapped. Scale-to-0 is a
   courtesy layered on top, not the wall.
3. **Entitlement scope: org** (the lease carries `orgId`).
4. **Re-upgrade: require explicit re-enable** (user scales it back up / "Resume").
   Scale-to-0 edge-triggers on a genuine free result so a transient fetch glitch can't
   strand a paying user.
5. **Install path: already hardened** (seed advisory + agent fail-closes) — shipped as
   a separate commit before this work. (The lease supersedes the mode-seed as the real
   gate, but fail-closed defaults remain correct defense-in-depth.)

## Build slices

- **Slice L2a — signups signs the lease:** generate the Ed25519 keypair; `LEASE_SIGNING_KEY`
  in the signups Secret; authed `GET /billing/lease` resolves the org entitlement and
  returns a signed `{ orgId, agentEntitled, exp, kid }`. Public key committed for the
  agent to bake in. Support `kid` for rotation.
- **Slice L2b — agent verifies + gates its whole loop:** bake the public key into the
  agent image; each tick read the `assistant-lease` Secret, verify signature + expiry,
  and **short-circuit the entire loop to a no-op** unless a valid lease grants
  `agentEntitled`. Fail-closed.
- **Slice L2c — desktop/server deliver the lease + scale-to-0 courtesy:** desktop fetches
  the lease on each entitlement refresh and hands it to the server, which writes the
  `assistant-lease` Secret to every installed context; **replace** L1's advisory-revert
  with a scale-Deployment-to-0 on edge-detected downgrade (keep `detectAgentDowngrade`).
- **Slice L3 — re-enable UI:** a one-click "Resume" that scales the Deployment back to 1
  (the fresh lease already permits the loop).

## Out of scope (v1)

- Ripping away already-connected cloud clusters on downgrade (hostile; kept usable).
- Per-feature partial entitlements (all paid features move together).
- Billing dunning/retry UX (Stripe owns it).
