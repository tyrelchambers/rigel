# Helmsman Assistant — in-cluster remediation agent

An autonomous agent that runs **inside** your Kubernetes cluster, detects
incidents, has Claude diagnose them, and auto-remediates the **safe tier** under
deterministic guardrails. Destructive actions are blocked by RBAC entirely and
only surface as suggestions for you to run in Helmsman.

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
suggestions, status) and backups to `assistant-backups` — both read by Helmsman.

## Develop

```bash
npm install
npm test          # vitest — pure logic is fully unit-tested
npm run typecheck
npm run build
```

## Deploy (manual — Helmsman's Assistant tab automates this in Phase C)

```bash
# 1. Mint a subscription token on a machine logged into your Max plan:
TOKEN=$(claude setup-token)
kubectl create secret generic assistant-claude-token -n default --from-literal=token="$TOKEN"

# 2. Apply the RBAC cage, ConfigMaps, and Deployment (set the image first):
kubectl apply -f manifests/rbac.yaml
kubectl apply -f manifests/configmaps.yaml
kubectl apply -f manifests/deployment.yaml   # edit image: ghcr.io/<owner>/helmsman-assistant
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
