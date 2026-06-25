# Connect to Existing Cloud Clusters (EKS / GKE / AKS / DOKS) — design

**App:** Rigel (desktop Electron app for Kubernetes management)
**Date:** 2026-06-25
**Status:** Approved design, pending implementation plan
**Epic:** HELM-14 (Stream 1 of 3: cloud-provider support + monetization foundation)

## Summary

Add a **Connect to an existing cluster** path to the cluster rail's `+`, alongside
today's *Create local* (kind/k3d) flow. The user creates the cluster in the
provider's own console; Rigel connects to it. Picking a cloud provider
(DigitalOcean, AWS, GCP, Azure) opens a short guided wizard that detects the
provider CLI, checks that the user is logged in, lists their clusters, and runs the
provider's own `update-kubeconfig`-style command to write a context into
`~/.kube/config`. The new context appears as a rail tile, already classified and
iconed by the existing `classifyProvider`. A generic **Import a kubeconfig** option
covers everything else (on-prem, Rancher, a coworker's config).

The connection is durable for free: the kubeconfig the provider CLI writes contains
an `exec` credential block that re-mints the cluster's short-lived bearer token on
every kubectl call, using the login the user already maintains as a customer of that
cloud. Rigel never stores cloud credentials. The CLI does.

This is Stream 1. The user account surface (Stream 2, HELM-15) and the monetization
gating that turns the seam below into real enforcement (Stream 3, HELM-16) are
separate, later features. This spec lays the seam but does not enforce anything.

## Decisions (settled in brainstorming)

- **Auth approach: shell out to the provider CLI (option A), not mint tokens
  ourselves.** The provider's own `exec` credential plugin keeps the connection
  alive in perpetuity, it is far less code, and Rigel holds no cloud secrets. Self
  minting (our own token refresher + stored credentials) is kept in pocket for a
  future hosted/managed Rigel, not built now.
- **Automation boundary: Rigel drives, the user logs in.** Rigel runs the CLI for
  the read-only and connect steps (detect, auth-check, list, connect). The user runs
  only their own provider login in their terminal, guided by Rigel's inline help.
  Cloud secrets never pass through Rigel.
- **Inline help is a first-class surface.** Each step that can fail (CLI missing,
  not logged in, login expired) shows copy-paste commands with a one-line
  explanation and a re-check. The same help panel serves first-time setup and
  expiry recovery.
- **Cloud is connect-only.** Creating a cluster on a cloud provider is out of scope
  (the user creates it in the provider console).
- **Provider abstraction.** The wizard/engine is written once; each provider is a
  data **descriptor**. Adding AWS/GCP/Azure later is filling in a descriptor, not new
  code paths.
- **Build scope this pass: engine + DigitalOcean.** The wizard, the descriptor
  abstraction, generic import, and the monetization seam, plus DigitalOcean as the
  first real provider (simplest to verify end to end). AWS/GCP/Azure land as
  fast-follow descriptors.
- **Monetization seam, not enforcement.** A single `canConnect(provider)` returns
  allow-all today. Stream 3 changes that one function and adds an upgrade panel.

## Current state (what this builds on)

- The rail (`apps/web/src/shell/ClusterRail.tsx`) renders one tile per kubeconfig
  context from `GET /api/contexts` (`apps/server/src/contexts.ts` `listContexts`,
  which runs `kubectl config view -o json`). A new context appears once the
  `["contexts"]` query refetches.
- `apps/web/src/shell/clusterTile.ts` `classifyProvider({ name, server })` already
  returns `local | aws | gcp | azure | digitalocean | generic`, and
  `clusterIcons.tsx` already has per-provider icons. So once a context lands, the
  tile is correct with no extra work. This same function maps a tile back to its
  provider for the re-login help panel (no separate registry needed in v1).
- `apps/server/src/kubeconfigBackup.ts` `backupKubeconfig(path, now)` copies the
  kubeconfig in place before mutations; reused before every connect/import.
- `packages/k8s/src/run.ts` `runProcess` / `runProcessWithStdin` is the no-shell
  argv spawn helper used for all CLI shell-outs; reused to run the provider CLIs.
- `apps/server/src/clusterTools.ts` (`GET /api/cluster-tools`) is the model for
  "probe for a binary and report presence"; the cloud CLI check mirrors it.
- The rail `+` opens `CreateClusterModal` (local create). The new chooser sits in
  front of it. Modals use `components/ui/modal.tsx` (Dialog), not Sheet.

## Design

### Shared package: `packages/cloud-connect`

Pure, framework-free, imported by both server (runs the commands) and web (renders
the help and required-param UI). Exports a `ProviderDescriptor` per provider and the
pure helpers that operate on them. No I/O lives here; the server injects the runner.

```ts
interface ProviderDescriptor {
  id: "digitalocean" | "aws" | "gcp" | "azure";
  displayName: string;
  binary: string;                 // "doctl" | "aws" | "gcloud" | "az"
  extraBinaries?: string[];       // gcp: ["gke-gcloud-auth-plugin"]; azure(AAD): ["kubelogin"]
  installHelp: { macos: string; linux: string; windows: string; docsUrl: string };
  authCheckArgs: string[];        // read-only "am I logged in" probe
  loginHelp: { command: string; explanation: string; docsUrl: string };
  requiredParams: ParamSpec[];    // do: []; aws: [region]; gcp: [project, location]; azure: [resourceGroup]
  prefill?: Record<string, string[]>; // param -> CLI args that print the default (e.g. region)
  listClustersArgs(params): string[];
  parseClusterList(stdout: string): CloudCluster[];   // [{ id, name, region }]
  connectArgs(cluster, params): string[];             // update-kubeconfig / get-credentials / save
  authErrorPatterns: string[];    // stderr substrings meaning "login expired, re-auth"
  reloginHelp: { command: string; explanation: string };
  gated: boolean;                 // cloud = true (seam only; not enforced yet)
}
```

**DigitalOcean descriptor (the one built this pass), concretely:**
- `binary: "doctl"`, no `extraBinaries`.
- `authCheckArgs: ["account", "get"]`.
- `loginHelp`: `doctl auth init` (paste a `kubernetes:read` Personal Access Token).
- `requiredParams: []` (no region/project needed).
- `listClustersArgs: () => ["kubernetes", "cluster", "list", "-o", "json"]`,
  `parseClusterList` reads the JSON array into `{ id, name, region }`.
- `connectArgs: (c) => ["kubernetes", "cluster", "kubeconfig", "save", c.id]`. This
  writes a context whose `exec` block runs `doctl ... exec-credential`, so the token
  auto-refreshes in perpetuity.
- `authErrorPatterns: ["401", "Unable to authenticate"]`.
- `reloginHelp`: re-run `doctl auth init`.

The AWS/GCP/Azure descriptors (fast-follow, sketched for completeness):
`aws eks list-clusters` + `aws eks update-kubeconfig --region R --name N` (region
prefilled from `aws configure get region`; surface the IAM-vs-cluster-RBAC access
entry caveat in help); `gcloud container clusters list/get-credentials` plus a
**separate** `gke-gcloud-auth-plugin` presence check; `az aks list/get-credentials`
plus a `kubelogin` check for the AAD path.

### Server: `apps/server/src/cloudConnect.ts` (+ routes)

Thin HTTP handlers over the descriptors, each running the relevant command through an
injectable runner. Read-only routes always return 200 with a status payload; the
connect route mutates the kubeconfig.

- `POST /api/cloud/check { provider }` -> `{ cliInstalled, extraBinariesInstalled,
  authenticated, account? }`. Runs `binary --version` (presence), each `extraBinaries`
  presence, then `authCheckArgs`. Pure parsing of exit code / stdout.
- `POST /api/cloud/clusters { provider, params }` -> `{ clusters }` or
  `{ error, stderr }`. Runs `listClustersArgs(params)` and `parseClusterList`.
- `POST /api/cloud/connect { provider, clusterId, params }` -> calls
  `canConnect(provider)` (seam), then `backupKubeconfig()`, then `connectArgs`, with
  the server's resolved `KUBECONFIG` in env so the context lands where `/api/contexts`
  reads it. Returns `{ context, backupPath }` or `{ error, stderr }`.
- `POST /api/cloud/import { kubeconfig }` (generic) -> `canConnect("import")`,
  `backupKubeconfig()`, merge by flattening the existing config with the pasted one
  (`KUBECONFIG=existing:incoming kubectl config view --flatten`) and writing the
  result. Returns the contexts added.

**Re-login detection.** kubectl shell-outs already flow through `runProcess`. When a
command for a context that `classifyProvider` maps to a cloud provider fails with
stderr matching that descriptor's `authErrorPatterns`, the server emits a WebSocket
`cluster.authExpired { context, provider }` frame. No new persistence: provider comes
from `classifyProvider`, help comes from the descriptor.

### Server: `apps/server/src/entitlements.ts` (the seam)

`canConnect(target: ProviderId | "import"): { allowed: boolean; reason?: string }`.
v1 returns `{ allowed: true }` for everything. Called by `/api/cloud/connect` and
`/api/cloud/import`. Stream 3 edits only this function (consult the user's plan; keep
`local` + `import` free, gate the cloud providers) and adds the upgrade panel.

### Client

**Rail `+` -> "Add a cluster" chooser** (new small Dialog): two choices, *Create
local* (routes to the existing `CreateClusterModal`, unchanged) and *Connect
existing* (routes to the new `ConnectClusterModal`).

**`ConnectClusterModal`** (Dialog): a provider grid (DigitalOcean, AWS, GCP, Azure,
and *Import a kubeconfig*). Selecting a provider runs a wizard state machine:

```
checking -> needs-cli        (installHelp + re-check)
         -> needs-extra      (extra-binary installHelp + re-check)   // gcp/azure only
         -> needs-login      (loginHelp + re-check)
         -> needs-params     (collect requiredParams, prefilled)     // skipped for DO/import
         -> listing -> pick  (cluster list)
         -> connecting -> done (backup path shown; ["contexts"] invalidated; offer Switch)
         -> error            (message + stderr, with the relevant help panel)
```

For DigitalOcean the path is `checking -> (needs-cli | needs-login) -> listing ->
pick -> connecting -> done` with no params, which is why it is the cleanest first
provider. *Import a kubeconfig* skips straight to a paste/file-pick step calling
`/api/cloud/import`. Help content (install, login, re-login) is read from the
descriptor, so it is consistent and lives in one place.

**Tile "Needs re-login" state.** On a `cluster.authExpired` frame, the matching rail
tile shows a re-login badge; clicking it opens that provider's `reloginHelp` panel.

**WebSocket / API** (`apps/web/src/lib/ws.ts`, `api.ts`): an `onClusterAuthExpired`
subscription (mirroring `onClusterProgress`), and query/mutation wrappers for the
four `/api/cloud/*` routes that invalidate `["contexts"]` on connect/import success.

### Error handling

- CLI or extra binary missing: caught by `/api/cloud/check`; the wizard parks on the
  install-help step and re-checks on demand. Rigel never auto-installs.
- Not logged in / login expired: caught by the auth-check (setup) or
  `authErrorPatterns` (ongoing); both route to the same provider help panel.
- List or connect command fails: the command's stderr is returned and shown, with
  the provider help panel attached so the user can act on it.
- Cloud RBAC denial (valid login, but no cluster permission, e.g. EKS access
  entries): surfaced as the command's stderr; the AWS descriptor's help calls this
  out specifically.
- Kubeconfig backup failure (read-only dir): non-fatal; log and continue, but report
  that the backup could not be written.

### Testing

Pure / unit-tested with injected runners and sample CLI output (no real cloud):
- Per-descriptor `listClustersArgs` / `connectArgs` / `parseClusterList` (from a
  captured `doctl ... -o json` sample), and `authErrorPatterns` matching.
- The `/api/cloud/*` handlers with a fake runner (installed/not, logged-in/not,
  list/connect success and stderr failure).
- `canConnect` returns allow-all for every target.
- The wizard state machine (web): transitions across checking/needs-cli/needs-login/
  listing/pick/connecting/done/error from mocked responses; the chooser routing.

End-to-end DigitalOcean connect needs a real DO account + `doctl`, which are not on
the dev machine, so it is a **manual verification step**, like kind/k3d was for
create-local. Everything else is type-checked, unit-tested, and built. Verify via
vitest/typecheck/build and `pnpm --filter desktop dev`, not a web dev server.

## Out of scope (YAGNI / separate features)

- **Cloud cluster creation** (EKS/GKE/AKS/DOKS via eksctl/gcloud/az/doctl or
  Terraform). Connect-only here.
- **Self-managed auth / token minting** and storing cloud credentials. Kept for a
  possible future hosted Rigel.
- **User accounts, billing, Stripe** (Stream 2 / HELM-15) and **enforcing** the
  `canConnect` gate (Stream 3 / HELM-16). The seam is built; enforcement is not.
- **A persisted connection registry** (region/project per context, re-list from
  saved params). v1 derives provider from `classifyProvider`; richer persistence is
  a later nicety.
- **AWS/GCP/Azure descriptors** in this build pass (the engine supports them; they
  are fast-follow).

## Implementation notes

- **Branch:** off `master` (multi-cluster + create-local merged via PR #23,
  `bcfeed4a`). Suggested `feat/cloud-cluster-connect`.
- **New package** `packages/cloud-connect` so server and web share descriptors and
  pure helpers without duplication.
- **Reuse, do not reinvent:** `backupKubeconfig`, `runProcess`, `classifyProvider`,
  the `clusterTools` detection shape, and the `Modal`/Dialog components.
- **Pencil first:** design the "Add a cluster" chooser, the connect wizard, the
  inline help panels, and the tile re-login state in Pencil before coding, then
  implement in Tailwind + app CSS-var tokens at the app's type scale.
- Pass the server's resolved `KUBECONFIG` to every provider CLI shell-out so the
  connected context lands in the file the server enumerates.
- Rebuild the desktop bundle before shipping.
