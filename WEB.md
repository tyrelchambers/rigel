# Helmsman Web

A self-hostable, AI-native Kubernetes admin UI. The whole app is a single
[Bun](https://bun.sh) server (`apps/server`) that serves the React UI
(`apps/web`) plus `/api/*` and `/ws` on **port 8787**. It drives `kubectl` and
`helm` through a confirm gate, and an optional chat copilot ("the Helmsman")
suggests and runs commands you approve.

> Helmsman is a cluster-admin tool: it can read everything and — through a
> confirm gate — install, scale, and delete across the cluster. Protect it with
> a password and don't expose it publicly without TLS.

---

## Install

### Docker (single host — quickest)

```sh
# from the repo root
HELMSMAN_PASSWORD=changeme docker compose up --build
# open http://localhost:8787
```

`compose.yaml` wires up everything for you:

- Mounts `~/.kube/config` read-only into the container at `/kube/config`.
- Persists the chat copilot's writable home in the `helmsman-claude` volume.

### Kubernetes (Helm)

The chart is published as an OCI artifact to GHCR:

```sh
helm install hm oci://ghcr.io/tyrelchambers/charts/helmsman-web --version 0.1.0
```

…or from a checkout: `helm install hm ./deploy/helm/helmsman-web`.

Reach the UI:

```sh
kubectl port-forward svc/hm-helmsman-web 8787:8787   # then open http://localhost:8787
```

…or set `ingress.enabled=true` (host + TLS) for real exposure.

---

## Setup

Three things, only the first is required.

### 1. Cluster access (required)

- **Docker:** uses your mounted `~/.kube/config`. ⚠️ The API-server URL in that
  file must be reachable **from inside the container**. A remote cluster IP just
  works; for kind/minikube/`localhost`, uncomment the `extra_hosts` stanza in
  `compose.yaml` and point the config at `host.docker.internal`.
- **Kubernetes:** runs in-cluster — the entrypoint synthesizes a kubeconfig from
  the pod's ServiceAccount. To target a *different* cluster, put a kubeconfig in
  a Secret (key `config`) and set `kubeconfig.secretName`.

### 2. Auth (strongly recommended)

Helmsman can scale/delete/install cluster-wide, so it's **secure by default**.

- **Docker:** set `HELMSMAN_PASSWORD` to require a browser login (httpOnly
  session cookie, also covers the WebSocket).
- **Kubernetes:** if you set no password, the chart **generates** one. Retrieve it:
  ```sh
  kubectl get secret hm-helmsman-web-auth -o jsonpath='{.data.HELMSMAN_PASSWORD}' | base64 -d; echo
  ```
  For SSO, set `auth.disable=true` and front it with oauth2-proxy / Cloudflare Access.

### 3. AI chat token (optional)

The chat copilot shells out to the `claude` CLI and authenticates with a **Claude
subscription** — no API key. The read/observe panels work without it.

```sh
claude setup-token          # on a machine signed into your Claude plan
# → paste the sk-ant-oat… token into the config below (or the in-app Settings screen)
```

- **Docker:** put `CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat…` in a `.env` next to
  `compose.yaml` (compose auto-loads it).
- **Kubernetes:** `--set claude.token=sk-ant-oat…`, or `claude.existingSecret`,
  or add it later from the in-app Settings screen.

---

## Configuration

### Docker — environment variables

| Variable                 | Default        | Purpose                                                       |
| ------------------------ | -------------- | ------------------------------------------------------------- |
| `HELMSMAN_PASSWORD`      | _(none)_       | Browser login password. Unset = **no login** (trusted nets).  |
| `HELMSMAN_TOKEN`         | _(none)_       | Optional bearer token for CLI/non-browser callers.            |
| `HELMSMAN_SESSION_SECRET`| random per-pod | Fix it to keep logins valid across restarts/replicas.         |
| `CLAUDE_CODE_OAUTH_TOKEN`| _(none)_       | Enables the AI chat copilot.                                  |
| `KUBECONFIG`             | `/kube/config` | Path to the kubeconfig inside the container.                  |
| `PORT`                   | `8787`         | Server listen port.                                           |

### Kubernetes — key Helm values

| Value                       | Default                  | Purpose                                                            |
| --------------------------- | ------------------------ | ----------------------------------------------------------------- |
| `image.tag`                 | `latest`                 | Pin to a release for reproducible deploys.                        |
| `auth.password`             | _(generated)_            | Browser login password; empty = chart generates + persists one.  |
| `auth.existingSecret`       | _(none)_                 | Bring your own Secret (`HELMSMAN_PASSWORD`, opt. `HELMSMAN_TOKEN`).|
| `auth.disable`              | `false`                  | Run with **no** login (only behind an SSO proxy / private net).   |
| `rbac.clusterAdmin`         | `true`                   | Bind the SA to cluster-admin (full install/scale/delete).         |
| `rbac.byoClusterRole`       | _(none)_                 | Bind a narrower ClusterRole instead when `clusterAdmin=false`.    |
| `kubeconfig.secretName`     | _(none)_                 | Target a remote cluster via a mounted kubeconfig Secret.          |
| `claude.token`              | _(none)_                 | Inline Claude token → templated into a Secret (enables chat).     |
| `claude.existingSecret`     | _(none)_                 | Secret holding `CLAUDE_CODE_OAUTH_TOKEN`.                         |
| `claudeHome.persistence.enabled` | `false`             | PVC for the `claude` CLI home (else `emptyDir`).                  |
| `ingress.enabled`           | `false`                  | Expose via Ingress (set `hosts` + `tls`).                         |
| `service.port`              | `8787`                   | Service port.                                                     |

See `deploy/helm/helmsman-web/values.yaml` for the complete list.

---

## Notes

- All cluster mutations are surfaced and confirmed before they run — Helmsman
  never changes your cluster without an explicit click.
- The `claude` CLI needs a **writable** home (`/root/.claude`); don't mount it
  read-only or the chat's tools break. Both Docker (named volume) and the chart
  (emptyDir/PVC) handle this for you.
