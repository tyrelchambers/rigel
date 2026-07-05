# Rigel Assistant — in-cluster remediation agent

An autonomous agent that runs **inside** your Kubernetes cluster, detects
incidents, has Claude diagnose them, and auto-remediates the **safe tier** under
deterministic guardrails. Destructive actions are blocked by RBAC entirely and
only surface as suggestions for you to run in Rigel.

It authenticates with your **Claude subscription** (no API key): `claude -p`
driven by a `CLAUDE_CODE_OAUTH_TOKEN` minted with `claude setup-token`.

## Architecture (Phase A)

```
Detector (free kubectl)  →  Worker (Sonnet, claude -p)  →  Risk classifier
                                                              ├─ LOW    → circuit breaker → execute (auto)
                                                              ├─ MEDIUM → queue for approval (Opus gate = Phase B)
                                                              └─ BLOCKED→ queue (RBAC also forbids it)
```

Guardrails (always on, model-independent): the **RBAC cage** (`manifests/rbac.yaml`),
a **circuit breaker** (per-resource/hour, nightly total, per-incident attempt cap),
a **spend cap**, a **kill-switch** (`assistant-config` ConfigMap), **backup-before-mutate**,
and **fail-closed** on any model/exec error.

State is written to the `assistant-state` ConfigMap (audit timeline, queued
suggestions, status) and backups to `assistant-backups` — both read by Rigel.

## Texting the assistant

A configured channel (Signal `signalApiUrl`+`signalNumber`, or Matrix
`homeserverUrl`+`accessToken`+`roomId`) is conversational by default — there is
no two-way toggle. Only senders on the allowlist (`signalRecipients` / Matrix
`allowedSenders`, your own linked number/id by default) are answered; every
other sender is dropped silently.

```
inbound msg → authorize (allowlist) → de-dupe → route:
   free text   → agentic turn (claude -p, real kubectl/helm Bash tool),
                 threaded per sender, auto-resetting after 1h idle → reply
   "status"    → health / spend / queue summary
   "queue"     → list fixes awaiting approval/confirmation
   "approve N" / "yes" → run queued item #N (defaults to the newest) through
                 the SAME guardrails as the loop
   "help"      → command list
```

The assistant is a full agent at parity with the in-app Rigel Assistant: it
investigates freely with any read command, and **just runs reversible changes
directly** (restart, scale, rollback, apply, edit, set, cordon, uncordon, label,
helm upgrade) — no confirmation needed, you texted it to act. A **destructive**
change (delete, drain, helm uninstall, anything irreversible) is never run
directly: the assistant states what it would do and queues it, and you reply
`yes` (or `approve N`) to run it.

What it's actually allowed to do is set by RBAC, not the model or the chat
flow — **`manifests/rbac.yaml` is the assistant's real ceiling**. A verb that
isn't granted there is refused by the API server (403) regardless of what gets
confirmed over chat. The default posture is read + reversible: broad
cluster-wide reads (secrets omitted), node cordon/uncordon, and a namespaced
`rigel-assistant-write` Role granting create/update/patch (no delete) on
workloads/config/networking in the install namespace. Destructive verbs
(`delete`, pod `eviction`/drain) ship commented out, so destructive is
hard-blocked out of the box even with a confirmed "yes":
- **Enable destructive** by uncommenting the `delete`/`eviction` rules in
  `rbac.yaml` (chat confirmation still applies).
- **Widen to more namespaces** by duplicating the `rigel-assistant-write`
  Role/RoleBinding pair for each additional namespace.
- **Grant Secrets** by adding verbs on the `secrets` resource to the
  ClusterRole (omitted by default — no value exfiltration).

The **kill-switch** (`assistant-config`'s `enabled` field) is the master off —
flipping it pauses the autonomous loop and inbound mutation execution alike.
Soft, operator-editable guardrails (tone, "never echo Secrets", "smallest fix
first") live in `agent/CLAUDE.md`, mounted into the pod — edit and redeploy to
change how the assistant behaves; it's a request, not an enforcement boundary
(RBAC is the enforcement boundary).

Design notes:
- Replies thread per sender via the CLI's own session (`--resume`); the thread
  is in-memory and auto-resets after an hour of silence, so context stays
  scoped to a burst of related questions and a pod restart is a clean slate.
- Chat spends against the same monthly cap; at the cap, inbound replies say so
  instead of investigating.
- The pure routing/parsing/auth/chunking logic lives in `signalInbound.ts` /
  `matrixInbound.ts` and is fully unit-tested; `index.ts` wires the real
  receive/send/model/executor IO.

## Develop

```bash
npm install
npm test          # vitest — pure logic is fully unit-tested
npm run typecheck
npm run build
```

## Deploy (manual — Rigel's Assistant tab automates this in Phase C)

```bash
# 1. Mint a subscription token on a machine logged into your Max plan:
TOKEN=$(claude setup-token)
kubectl create secret generic assistant-claude-token -n default --from-literal=token="$TOKEN"

# 2. Apply the RBAC cage, ConfigMaps, and Deployment (set the image first):
kubectl apply -f manifests/rbac.yaml
kubectl apply -f manifests/configmaps.yaml
kubectl apply -f manifests/deployment.yaml   # edit image: ghcr.io/<owner>/rigel-assistant
```

The image is built and pushed to GHCR by `.github/workflows/agent-build.yml`.

## Verify (Phase A acceptance)

- **Happy path:** break a workload (`kubectl set image deployment/x x=does-not-exist`
  → CrashLoopBackOff). Within `CONFIRM_POLLS` intervals the agent should detect it,
  Sonnet should propose `rollback`/`restart`, a backup lands in `assistant-backups`,
  and the action + outcome appear in `assistant-state`.
- **Circuit breaker:** keep breaking the same resource → after the hourly /
  per-incident cap, actions are `skipped` with a circuit-breaker reason.
- **Kill-switch:** `kubectl patch configmap assistant-config -n default --type merge -p '{"data":{"enabled":"false"}}'`
  → the agent idles within one interval.
- **Fail-closed:** point the Secret at a bad token → the worker errors and the
  agent records a failure; it never executes.
- **Spend cap:** set `SPEND_CAP_USD=0` → the agent idles (no model calls).

Inspect state:

```bash
kubectl get configmap assistant-state -n default -o jsonpath='{.data.state\.json}' | jq
```
