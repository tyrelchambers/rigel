---
title: "Getting Started"
description: "Install Helmsman into a Kubernetes cluster (Helm) or a single host (Docker), then log in and connect the AI copilot."
category: "Get started"
order: 1
icon: "lucide:rocket"
---

Helmsman is a self-hostable, AI-native Kubernetes admin UI — you're the captain, it runs the ship. This guide is the onboarding entry point: it gets Helmsman running in your cluster (or on a single host), logs you in, and connects the optional AI copilot.

Helmsman runs as a single [Bun](https://bun.sh) server (`apps/server`) that serves the React UI (`apps/web`) plus `/api/*` and `/ws` on **port 8787**. It drives `kubectl` and `helm` through a confirm gate, and an optional chat copilot ("the Helmsman") suggests and runs the commands you approve.

> ⚠️ **Helmsman is a cluster-admin tool.** It can read everything and — through a confirm gate — install, scale, and delete across the cluster. Protect it with a password and never expose it publicly without TLS (ideally behind an SSO proxy).

This guide covers installing Helmsman **into a Kubernetes cluster** with the Helm chart. For a single-host / laptop setup, see [Docker (single host)](#docker-single-host) at the end.

---

## Prerequisites

* A Kubernetes cluster and `kubectl` access to it.
* **Helm 3.8+** (OCI registry support is required to pull the chart).
* Permission to create a ServiceAccount and a cluster-admin ClusterRoleBinding in the install namespace (Helmsman needs broad RBAC to be fully functional — see [RBAC & permissions](#rbac-permissions)).

Optional, for richer data:

* **metrics-server** — enables CPU/memory sparklines for pods and nodes, and powers the Right-sizing panel.
* **CloudNativePG (CNPG)** — enables the Databases panel.
* A **default StorageClass** — only needed if you enable persistence for the chat copilot's home, or use the in-app Signal bridge.

---

## Quick start (Helm)

The chart is published as an OCI artifact to GHCR:

```sh
helm install hm oci://ghcr.io/tyrelchambers/charts/helmsman-web --version 0.1.0
```

…or install from a checkout of the repo:

```sh
helm install hm ./deploy/helm/helmsman-web
```

That's enough for a working, **secure-by-default** install: it creates a ServiceAccount bound to `cluster-admin`, runs in-cluster (no kubeconfig needed), and **generates a random admin password**. The AI chat is the only thing left to configure, and it's optional.

> The release name `hm` is used throughout this guide. The resources it creates are named `hm-helmsman-web` (Deployment/Service), `hm-helmsman-web-auth` (auth Secret), etc.

---

## Reach the UI

By default the Service is `ClusterIP`. The quickest way in is a port-forward:

```sh
kubectl port-forward svc/hm-helmsman-web 8787:8787
# then open http://localhost:8787
```

For real exposure, enable the Ingress instead — see [Expose via Ingress](#expose-via-ingress).

## First login

If you didn't set a password, the chart generated one into a Secret. Retrieve it:

```sh
kubectl get secret hm-helmsman-web-auth \
  -o jsonpath='{.data.HELMSMAN_PASSWORD}' | base64 -d; echo
```

Log in with that password. The login sets an `httpOnly` session cookie that also authorizes the WebSocket (`/ws`).

---

## Cluster access

When running **in-cluster**, Helmsman does **not** need a kubeconfig. The container entrypoint detects the mounted ServiceAccount token and synthesizes a kubeconfig pointing at the in-cluster API server (`kubectl` shells out, so unlike client-go it needs an explicit kubeconfig). `automountServiceAccountToken` is on for the pod.

To instead target a **different / remote cluster**, mount a kubeconfig as a Secret and point the chart at it:

```sh
kubectl create secret generic helmsman-kubeconfig --from-file=config=$HOME/.kube/config

helm upgrade hm oci://ghcr.io/tyrelchambers/charts/helmsman-web --version 0.1.0 \
  --set kubeconfig.secretName=helmsman-kubeconfig
```

The Secret must have a key named `config` holding the kubeconfig file. When set, the chart mounts it read-only at `/kube/config`, points `KUBECONFIG` at it, and the in-cluster ServiceAccount is ignored. The API-server URL in that kubeconfig must be reachable from inside the pod.

---

## RBAC & permissions

Helmsman installs arbitrary Helm charts, applies manifests, scales, and deletes any resource **on confirmed request** — so to be *fully* functional it needs `cluster-admin`. The chart binds the ServiceAccount to the built-in `cluster-admin` ClusterRole by default.

| Goal | Values |
|------|--------|
| Full functionality (default) | `rbac.create=true`, `rbac.clusterAdmin=true` |
| Bind your own (narrower) ClusterRole | `rbac.clusterAdmin=false`, `rbac.byoClusterRole=<role>` |
| Read-mostly | `rbac.clusterAdmin=false` (binds the built-in `view` role; mutations/installs will be denied) |
| Manage RBAC yourself | `rbac.create=false`, `serviceAccount.name=<existing-sa>` |

The right way to lock Helmsman down is **app auth + network controls** (below), not narrowing the RBAC — a narrowed role just makes parts of the UI fail with permission errors.

---

## Auth

Helmsman ships **secure by default** because it can scale/delete/install cluster-wide. A built-in browser login (admin password → `httpOnly` session cookie) protects both `/api` and `/ws`.

| Mode | How |
|------|-----|
| Generated password (default) | Set nothing — the chart creates `hm-helmsman-web-auth` with a random `HELMSMAN_PASSWORD`. Retrieve it as shown in [First login](#first-login). |
| Choose your own password | `--set auth.password=<your-password>` (templated into the Secret). |
| Bring your own Secret | `--set auth.existingSecret=<secret>` with keys `HELMSMAN_PASSWORD` (and optional `HELMSMAN_TOKEN`). |
| SSO in front | `--set auth.disable=true` and front it with oauth2-proxy / Cloudflare Access. ⚠️ With `auth.disable=true` and **no** proxy, anyone who can reach it runs cluster-admin commands. |
| Stable logins across restarts/replicas | `--set auth.sessionSecret=<random>` (otherwise a new signing secret is generated per pod, invalidating sessions on restart). |

`auth.token` (a bearer token, `Authorization: Bearer …`) is for non-browser / CLI callers only — the browser UI uses the password.

---

## AI chat token (optional)

The chat copilot shells out to the `claude` CLI and authenticates with a **Claude subscription — no API key**. The read/observe panels work without it; only the chat needs it.

```sh
claude setup-token   # on a machine signed into your Claude plan → prints an sk-ant-oat… token
```

Provide it one of three ways:

* **Inline:** `--set claude.token=sk-ant-oat…` (templated into a Secret).
* **Existing Secret:** `--set claude.existingSecret=<secret>` (key `CLAUDE_CODE_OAUTH_TOKEN`, overridable via `claude.existingSecretKey`).
* **In-app:** add it later from the **Settings** screen (persisted to the claude home volume).

The `claude` CLI needs a **writable** home at `/root/.claude` (it writes session state/history). The chart handles this with an `emptyDir` by default. To persist it across pod restarts:

```sh
--set claudeHome.persistence.enabled=true \
--set claudeHome.persistence.size=1Gi
# optional: --set claudeHome.persistence.storageClass=<class>
```

---

## Expose via Ingress

```sh
helm upgrade hm oci://ghcr.io/tyrelchambers/charts/helmsman-web --version 0.1.0 \
  --set ingress.enabled=true \
  --set ingress.className=nginx \
  --set ingress.hosts[0].host=helmsman.example.com \
  --set ingress.hosts[0].paths[0].path=/ \
  --set ingress.hosts[0].paths[0].pathType=Prefix
```

Add TLS via `ingress.tls` (and annotations such as cert-manager's `cert-manager.io/cluster-issuer`). For anything beyond a trusted private network, terminate TLS and put auth in front. A values file is cleaner than `--set` for ingress/TLS — see [Using a values file](#using-a-values-file).

---

## Helm values reference

Key values (see `deploy/helm/helmsman-web/values.yaml` for the complete list):

| Value | Default | Purpose |
|-------|---------|---------|
| `image.repository` | `ghcr.io/tyrelchambers/helmsman-web` | Container image. |
| `image.tag` | `latest` | Pin to a release for reproducible deploys. |
| `replicaCount` | `1`     | Number of pods (set `auth.sessionSecret` if >1). |
| `auth.password` | *(generated)* | Browser login password; empty = chart generates + persists one. |
| `auth.existingSecret` | *(none)* | Bring your own Secret (`HELMSMAN_PASSWORD`, opt. `HELMSMAN_TOKEN`). |
| `auth.disable` | `false` | Run with **no** login (only behind an SSO proxy / private net). |
| `auth.token` | *(none)* | Bearer token for CLI/non-browser callers. |
| `auth.sessionSecret` | *(per-pod random)* | Fix it to keep logins valid across restarts/replicas. |
| `rbac.create` | `true`  | Create the ClusterRoleBinding. |
| `rbac.clusterAdmin` | `true`  | Bind the SA to `cluster-admin` (full install/scale/delete). |
| `rbac.byoClusterRole` | *(none)* | Bind a narrower ClusterRole instead when `clusterAdmin=false`. |
| `serviceAccount.create` | `true`  | Create the ServiceAccount. |
| `kubeconfig.secretName` | *(none)* | Target a remote cluster via a mounted kubeconfig Secret (key `config`). |
| `claude.token` | *(none)* | Inline Claude token → templated into a Secret (enables chat). |
| `claude.existingSecret` | *(none)* | Secret holding `CLAUDE_CODE_OAUTH_TOKEN`. |
| `claudeHome.persistence.enabled` | `false` | PVC for the `claude` CLI home (else `emptyDir`). |
| `ingress.enabled` | `false` | Expose via Ingress (set `className`, `hosts`, `tls`). |
| `service.type` / `service.port` | `ClusterIP` / `8787` | Service exposure + port. |
| `resources` | 100m / 256Mi req, 1Gi mem limit | Pod resource requests/limits. |

### Using a values file

For non-trivial installs, keep a `values.yaml`:

```yaml
auth:
  password: "a-strong-password"
  sessionSecret: "a-fixed-random-string"
claude:
  token: "sk-ant-oat…"
ingress:
  enabled: true
  className: nginx
  hosts:
    - host: helmsman.example.com
      paths:
        - path: /
          pathType: Prefix
  tls:
    - hosts: [helmsman.example.com]
      secretName: helmsman-tls
```

```sh
helm install hm oci://ghcr.io/tyrelchambers/charts/helmsman-web --version 0.1.0 -f values.yaml
```

---

## Upgrade

```sh
helm upgrade hm oci://ghcr.io/tyrelchambers/charts/helmsman-web --version <new-version> -f values.yaml
```

To bump just the app image without a chart change, `--set image.tag=<tag>` (or `kubectl rollout restart deployment/hm-helmsman-web` when on a moving tag like `latest`).

## Uninstall

```sh
helm uninstall hm
```

This removes the Deployment, Service, ServiceAccount, ClusterRoleBinding, and chart-generated Secrets. A persisted claude-home PVC (if enabled) and any BYO Secrets are left in place — delete them manually if you want them gone.

---

## Troubleshooting

* **Can't log in / no password:** retrieve the generated one from the `hm-helmsman-web-auth` Secret (see [First login](#first-login)). Sessions dropping after a restart? Set `auth.sessionSecret`.
* **Panels show permission errors:** the ServiceAccount isn't bound to `cluster-admin`. Check `rbac.clusterAdmin` / `rbac.byoClusterRole`.
* **Chat does nothing:** no Claude token. Add `claude.token` / `claude.existingSecret`, or set it in the in-app Settings. Also confirm `/root/.claude` is writable (it is by default).
* **No CPU/memory graphs:** install metrics-server.
* **Pod healthchecks:** the container serves `GET /api/health` on port 8787 for liveness/readiness.

---

## Docker (single host)

For a laptop or single host instead of a cluster, run with Docker Compose from a repo checkout:

```sh
HELMSMAN_PASSWORD=changeme docker compose up --build
# open http://localhost:8787
```

`compose.yaml` mounts your `~/.kube/config` read-only at `/kube/config` and keeps the chat copilot's writable home in the `helmsman-claude` named volume. ⚠️ The API-server URL in that kubeconfig must be reachable **from inside the container** — for kind/minikube/`localhost`, uncomment the `extra_hosts` stanza in `compose.yaml` and point the config at `host.docker.internal`. For the AI chat, put `CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat…` in a `.env` next to `compose.yaml` (Compose auto-loads it).
