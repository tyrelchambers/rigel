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
| **In-cluster agent** | Drops to **observe-only**: keeps watching + recording incident history (the free job), but **no** LLM diagnosis, notifications, digests, autonomous remediation, or autofix PRs. Agent stays deployed and **running at its normal replica count** — a downgraded user gets the exact same free tier as a never-Pro install. | Next entitlement check (≤ ~a day) re-unlocks the capabilities in place — nothing to resume or re-provision. |
| **LLM diagnosis / notifications / digests / remediation / autofix** | **Stop** — these are the agent's premium capabilities. Free = cheap: detection + recording only, **zero model spend** (the diagnosis worker/supervisor never runs). (Metric-threshold alerts the desktop app computes itself are unaffected.) | Return on re-upgrade. |

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
Observe (detection) + incident-history recording **always run** — that is the free tier,
and it costs **zero model spend**. The live-check result gates every premium branch: the
**LLM diagnosis** (worker + supervisor model calls — the expensive part, so free never
burns the user's model budget), outbound notifications, scheduled digests, autonomous
remediation (kubectl actions), autofix PRs, and the interactive chat surface. The check
lands **once, near the top of `tick()`** — structurally above the digest path, which today
deliberately bypasses the `enabled` kill-switch — setting an "entitled" flag every premium
branch consults.

### Residual bypass (named honestly)
The grace cache is a softer surface than the lease: a `kubectl exec` + edit the cached
value to `entitled:true` is easier than patching the image. Two things make it acceptable:
the **live re-fetch self-heals it** within 12–24h (to make an edit stick the user must
*also* NetworkPolicy-block the agent's egress to `api.rigel.run` while leaving the model
API reachable, and re-apply before each grace expiry — deliberate-piracy tier, not a
one-liner), and **the prize is small**. The determined pirate still wins by patching the
image, exactly as with the lease; the casual `kubectl scale` bypass buys nothing because
the agent is free anyway.

### No scale-to-zero; the agent stays running observe-only
An earlier iteration also scaled the agent Deployment to 0 on downgrade (a resource-hygiene
"courtesy") and added a "Resume" button to undo it. That was dropped: it contradicted the
free tier. If the free tier is "the agent runs observe-only and records incident history,"
then a **downgraded** user must get exactly that — not a stopped agent needing a manual
Resume. Scaling to 0 made a downgraded user's free experience differ from a never-Pro
install's. So on downgrade the agent simply **keeps running**; its own live-check flips it
to observe-only within a day. Uniform free tier, and less machinery (no downgrade→scale-to-0
signal, no `detectAgentDowngrade`, no Resume UI).

## Re-upgrade

The agent's next entitlement check (≤ ~a day) re-unlocks the premium capabilities **in
place** — the agent was running the whole time, so there is nothing to resume or
re-provision. The capabilities simply switch back on.

## Decisions (resolved via two Fable reviews + user)

1. **Downgrade posture: observe-only, not off.** The agent is a **free feature**; only its
   premium capabilities (**LLM diagnosis**, notify/digest/remediate/autofix/chat) are gated.
   Free = detection + recording only, **zero model spend**. Free-tier job = overnight
   incident history. A downgraded agent keeps running observe-only — same as a never-Pro
   install.
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
6. **No scale-to-0 on downgrade** (and no "Resume" UI). The agent keeps running observe-only;
   the live-check is the sole enforcement, independent of replica count. The downgrade→
   scale-to-0 signal (`detectAgentDowngrade`, the `agent-downgrade` message, `scaleAgentsToZero`)
   is removed as vestigial. Uninstall (not scale-to-0) is how a user stops the agent entirely.
7. **Install path fail-closed defaults** (seeded advisory + agent's fail-closed mode read)
   remain correct defense-in-depth; the live-check is the real capability gate.
8. **Two grace windows, intentional.** The **agent** honors a **30-day** grace on its own
   live-check (the real enforcement wall). The **desktop** entitlement provider keeps a
   separate **14-day** grace governing the *desktop-side* gates (canConnect / canBeAutonomous /
   audits) and UI — a different subsystem with a different failure mode. They are not the
   same number by design.

## Build slices

- **Slice E1 — signups mints the token + serves entitlement:** `agent_tokens` table
  (hash, orgId, installId, revoked, createdAt); authed `POST /agent/token` (verify
  membership → mint org-bound install-scoped token); agent-token-authed
  `GET /agent/entitlement` (orgId from token, per-org resolve, rate-limited). Reuses the
  existing per-org billing lookup (`orgBilling`) + Stripe feature keys.
- **Slice E2 — agent live-check + capability gating:** read the token from env; a
  scheduled (~12–24h) `GET /agent/entitlement` with cache in `assistant-state` +
  30-day grace + authenticated-free-vs-error distinction + timestamp plausibility guard;
  a single entitlement flag set near the top of `tick()` that gates the **LLM diagnosis**,
  notify, digest, remediation, autofix, and chat branches. Observe + incident recording
  always run (free = detection + recording, zero model spend).
- **Slice E3 — desktop/server: mint on install:** desktop mints the agent token
  (`POST /agent/token`) during agent install/setup and threads it into the credentials
  Secret. (No downgrade action — the agent self-enforces via the live-check.)

_(An interim iteration built a `scaleAgentsToZero` downgrade action + a "Resume" UI + the
`detectAgentDowngrade` signal; all were removed per Decision 6 once the free tier settled on
"agent keeps running observe-only." Not part of the final design.)_

## Out of scope (v1)

- Ripping away already-connected cloud clusters on downgrade (hostile; kept usable).
- Per-capability partial entitlements (all premium capabilities move together).
- The overnight-incident-history *desktop surface* itself (separate feature slice/ticket;
  the agent already observes + writes state — this design only guarantees observe keeps
  running on free).
- Billing dunning/retry UX (Stripe owns it).
- Token rotation / a revocation UI (schema supports revoke; no admin surface in v1).
