# Add AWS (EKS), GCP (GKE), Azure (AKS) to cloud connect — design

**App:** Rigel (desktop Electron app for Kubernetes management)
**Date:** 2026-06-25
**Status:** Approved design, pending implementation plan
**Epic:** HELM-14 (Stream 1 cloud-provider support) — follow-on to the DigitalOcean-first merge (`185fc54b`)

## Summary

The cloud-connect engine shipped with DigitalOcean as the first provider. This adds
the remaining three managed providers — **AWS EKS, GCP GKE, Azure AKS** — as
descriptors on that same engine. Each is mostly data (CLI commands + help text), but
two new shared pieces are needed: a wizard **"pick params" step** (the user selects a
region for EKS / project for GKE from a dropdown), and an **extra-binary install
panel** (GKE's `gke-gcloud-auth-plugin`, AKS's `kubelogin`). Azure needs no params
(its `az aks list` returns every cluster). Auth stays shell-out (the provider CLI's
own `exec` credential plugin keeps the connection alive); Rigel stores no cloud
credentials.

## Decisions (settled in brainstorming)

- **Build all three this round** (AWS, GCP, Azure), on the existing descriptor engine.
- **Params are dropdowns, pre-selected to the CLI's configured default** (the
  namespace-bar precedent: pick from a known set, never free-text). AWS region = a
  built-in static list (no extra IAM perms); GCP project = fetched live via
  `gcloud projects list`. Azure has no params.
- **Per-cluster connect params** (GKE location, AKS resource group) are captured from
  the list output onto the cluster, not prompted for separately.
- **Extra binaries** (`gke-gcloud-auth-plugin`, `kubelogin`) get their own install
  panel via a new `extraInstallHelp` descriptor field, shown in the wizard's existing
  `needs-extra` phase.
- **AWS IAM-vs-cluster-RBAC** caveat is surfaced in help: connect can succeed yet
  kubectl still gets RBAC-denied if the IAM principal isn't in the cluster's access
  entries.
- **Pencil-first for the two new surfaces** (the params step, the extra-binary panel)
  before any code. Everything else (grid, install cards, connect flow, empty state,
  "Connected as", re-login badge, remove dialog) is already designed.

## Current state (what this builds on)

- `packages/cloud-connect/src/descriptors.ts` holds the `digitalocean` descriptor and
  `DESCRIPTORS`/`descriptorFor`/`listCloudProviders`. The `ProviderDescriptor` type
  (`types.ts`) already has binary, extraBinaries, installHelp, versionArgs,
  authCheckArgs, loginHelp, reloginHelp, requiredParams, listClustersArgs,
  parseClusterList, connectArgs, authErrorPatterns, parseAccount, consoleUrl.
- `apps/server/src/cloudConnect.ts` — `cloudCheck` (loops extraBinaries; parses the
  account), `cloudListClusters(provider, params)`, `cloudConnect(provider, cluster,
  params, deps)`, `cloudHealth`, `importKubeconfig`. Routes `/api/cloud/{check,
  clusters,connect,health,import}` in `index.ts`.
- `apps/web/src/shell/ConnectWizard.tsx` — the state machine: `checking →
  needs-cli|needs-extra|needs-login | listing → pick → connecting | error`. The
  `needs-extra` phase exists but currently renders the same install help as
  `needs-cli`. There is no params phase (DigitalOcean has none).
- `apps/web/src/shell/ConnectClusterModal.tsx` — the provider grid renders the live
  providers from `listCloudProviders()`, an Import tile, and three disabled
  "Coming soon" tiles for AWS/GCP/Azure (`COMING_SOON`).
- `CLUSTER_ICONS` already has aws/gcp/azure/digitalocean brand icons;
  `classifyProvider` already detects all four; `providerLabel` returns
  "Amazon EKS"/"Google GKE"/"Azure AKS"/"DigitalOcean".

## Design

### A. Descriptor type extensions (`packages/cloud-connect/src/types.ts`)

- `extraInstallHelp?: InstallHelp` — install help for the `extraBinaries` (GKE plugin,
  AKS kubelogin), shown in the `needs-extra` panel.
- `CloudCluster` gains optional `location?: string` and `resourceGroup?: string`
  (captured during list, used by `connectArgs`). DO/AWS leave them unset.
- `requiredParams` changes from `string[]` to `ParamSpec[]`:

```ts
export interface ParamSpec {
  key: string;                 // "region" | "project"
  label: string;               // "Region" | "Project"
  /** Built-in option list (AWS regions). */
  staticOptions?: string[];
  /** CLI args that print options, one per line (GCP: gcloud projects list). */
  optionsArgs?: string[];
  /** CLI args that print the configured default value (one line). */
  defaultArgs?: string[];
}
```

DigitalOcean and Azure keep `requiredParams: []`.

### B. The three descriptors (`descriptors.ts`)

**AWS (`id: "aws"`, `displayName: "Amazon EKS"`):**
- `binary: "aws"`, `extraBinaries: []`, `versionArgs: ["--version"]`.
- `authCheckArgs: ["sts", "get-caller-identity", "--output", "json"]`;
  `parseAccount` → the `Arn` field (identifies the IAM principal).
- `loginHelp`: `aws configure` (note SSO via `aws configure sso` / `aws sso login`).
- `requiredParams: [{ key:"region", label:"Region", staticOptions: AWS_REGIONS,
  defaultArgs:["configure","get","region"] }]` where `AWS_REGIONS` is the built-in
  list of standard AWS commercial regions.
- `listClustersArgs: (p) => ["eks","list-clusters","--region",p.region,"--output","json"]`;
  `parseClusterList` reads `{ clusters: string[] }` (EKS returns names) → each
  `{ id: name, name, region: <from the list call's region> }`. (The region isn't in
  the list payload; the server passes it through — see Data flow.)
- `connectArgs: (c, p) => ["eks","update-kubeconfig","--region",p.region,"--name",c.name]`.
- `authErrorPatterns: ["expiredtoken","unable to locate credentials",
  "invalidclienttoken","the security token included in the request is expired"]`.
- `consoleUrl: "https://console.aws.amazon.com/eks/home"`.
- `reloginHelp`: `aws sso login` (or re-run `aws configure`).
- A help note on the IAM-vs-RBAC access-entry gotcha (rendered in the wizard for AWS).

**GCP (`id: "gcp"`, `displayName: "Google GKE"`):**
- `binary: "gcloud"`, `extraBinaries: ["gke-gcloud-auth-plugin"]`,
  `versionArgs: ["--version"]`.
- `extraInstallHelp`: all OSes `gcloud components install gke-gcloud-auth-plugin`,
  docsUrl to the GKE auth-plugin page.
- `authCheckArgs: ["config","get-value","account"]`; `parseAccount` → the email
  (treat `(unset)`/empty as not-authenticated/no-account).
- `loginHelp`: `gcloud auth login`.
- `requiredParams: [{ key:"project", label:"Project",
  optionsArgs:["projects","list","--format=value(projectId)"],
  defaultArgs:["config","get-value","project"] }]`.
- `listClustersArgs: (p) => ["container","clusters","list","--project",p.project,"--format=json"]`;
  `parseClusterList` → each `{ id:name, name, region:location, location }`.
- `connectArgs: (c, p) => ["container","clusters","get-credentials",c.name,
  "--location",c.location!,"--project",p.project]`.
- `authErrorPatterns: ["invalid_grant","reauthentication","token has been expired or revoked"]`.
- `consoleUrl: "https://console.cloud.google.com/kubernetes/list"`.

**Azure (`id: "azure"`, `displayName: "Azure AKS"`):**
- `binary: "az"`, `extraBinaries: ["kubelogin"]`, `versionArgs: ["--version"]`.
- `extraInstallHelp`: all OSes `az aks install-cli` (installs kubelogin + kubectl),
  docsUrl.
- `authCheckArgs: ["account","show","--output","json"]`; `parseAccount` → `user.name`.
- `loginHelp`: `az login`.
- `requiredParams: []` (paramless).
- `listClustersArgs: () => ["aks","list","--output","json"]`; `parseClusterList` →
  each `{ id:name, name, region:location, resourceGroup }`.
- `connectArgs: (c) => ["aks","get-credentials","--resource-group",c.resourceGroup!,"--name",c.name]`.
- `authErrorPatterns: ["aadsts","az login","no subscription found"]`.
- `consoleUrl: "https://portal.azure.com"`.

Add all three to `DESCRIPTORS`; `listCloudProviders()` then returns four, and the
provider grid's `COMING_SOON` list is emptied (the grid renders all four live tiles).

### C. Param options (server)

New pure-ish function + route:
- `cloudParamOptions(provider, paramKey, run?)` in `cloudConnect.ts`: find the
  descriptor + the `ParamSpec`. If `staticOptions`, use them; else run `optionsArgs`
  and split stdout into lines. Run `defaultArgs` (if present) for the pre-selected
  default (trim; ignore `(unset)`/empty). Returns `{ options: string[], default?: string }`.
- `POST /api/cloud/param-options { provider, param }` → that result (200; read-only).

### D. Per-cluster connect params (data flow)

`cloudListClusters(provider, params)` already passes `params` to `listClustersArgs`.
For AWS the region isn't echoed in the list payload, so the server stamps each parsed
cluster's `region` from `params.region` after `parseClusterList` (a small post-step in
`cloudListClusters`, applied generically: if a cluster has no `region` and
`params.region` exists, set it). GKE/AKS already carry `location`/`resourceGroup`
from their own list output via `parseClusterList`. `cloudConnect` passes the full
`CloudCluster` (incl. `location`/`resourceGroup`) and `params` to `connectArgs`.

### E. Web — the wizard params step (`ConnectWizard.tsx`)

- After `runCheck` reaches "ready": if `descriptor.requiredParams.length > 0`, set a
  new `"params"` phase and fetch options for each param via `POST /api/cloud/param-options`
  (a new `cloudParamOptions(provider, key)` in `api.ts`); else go straight to listing
  (unchanged, DO/Azure).
- The **params phase** renders, per required param, a labelled **dropdown**
  pre-selected to the returned default, plus a **Continue** button. Continue calls
  `cloudListClusters(provider, chosenParams)` (the api helper gains a `params` arg) →
  `pick`. The chosen params are held in wizard state and passed to `cloudConnect` at
  connect time.
- The **`needs-extra` panel** renders `descriptor.extraInstallHelp` (its own install
  card) instead of the main CLI install help, with its own Re-check.
- For AWS, show the IAM-vs-RBAC note near the cluster list / connect.

`api.ts`: `cloudListClusters(provider, params)` and `cloudConnect(provider, cluster, params)`
gain a `params: Record<string,string>` argument (DO/Azure pass `{}`); add
`cloudParamOptions(provider, param)`.

### F. New UI to design in Pencil first

1. **The params step** — the wizard panel with a Region/Project dropdown
   (pre-selected) + Continue, in the connect-modal family.
2. **The extra-binary install panel** — the `needs-extra` card (e.g. "Install the
   GKE auth plugin" with `gcloud components install gke-gcloud-auth-plugin` + Copy +
   Re-check), reusing the install-card vocabulary.

The provider grid simply drops the "Coming soon" tiles (the four live tiles use the
existing brand icons) — a trivial change, confirmed against the existing grid design.

### Error handling

- Missing CLI / extra binary: caught by `cloudCheck`; the wizard parks on the
  matching install panel (CLI install vs `extraInstallHelp`) with Re-check.
- Not logged in / expired: caught by the auth check / `authErrorPatterns`; routes to
  the login / re-login help.
- `param-options` fetch fails (e.g. `gcloud projects list` errors): the params step
  shows the error + a Re-try. It does NOT silently fall back to the configured default
  (no unrequested fallbacks); the user retries or fixes their CLI auth.
- List/connect command failure: the command's stderr is returned and shown.
- AWS connect succeeds but kubectl is RBAC-denied: surfaced as the kubectl stderr;
  the AWS IAM note pre-warns the user.

### Testing

Pure/unit (injected runners, sample CLI JSON captured per provider):
- Per-descriptor `listClustersArgs`/`connectArgs`/`parseClusterList` (EKS names-only;
  GKE list with `location`; AKS list with `resourceGroup`), `parseAccount`,
  `authErrorPatterns`.
- `cloudParamOptions` (static AWS regions + default; GCP projects via fake
  `gcloud projects list` + default; `(unset)` default handling).
- `cloudListClusters` AWS region stamping; `cloudConnect` passing
  `location`/`resourceGroup` to `connectArgs`.
- Web: the wizard params phase (dropdown render from mocked options, Continue →
  listing), the `needs-extra` panel rendering `extraInstallHelp`, the grid showing
  four live tiles.

End-to-end against real AWS/GCP/Azure accounts is a **manual verification step** (no
aws/gcloud/az on the dev machine), as DigitalOcean was.

## Out of scope (YAGNI / later)

- Cloud cluster **creation**; **token minting / self-auth** (still shell-out only).
- AKS **`--admin`** path and EKS **access-entry management** from the app (we only
  surface the RBAC caveat in help).
- Subscription/account **switching** UI for Azure/GCP beyond the active one
  (the existing "switch account" chip covers re-auth).
- Multi-param providers beyond region/project (none needed for these three).

## Implementation notes

- **Branch:** `feat/cloud-providers-aws-gcp-azure` off `master` (`185fc54b`).
- Reuse the engine: descriptors are data; the only new code is `cloudParamOptions` +
  its route, the `params` phase + `extraInstallHelp` panel in `ConnectWizard`, the
  `params` args threaded through `api.ts`, and the `CloudCluster`/`ParamSpec` type
  additions.
- **Pencil-design the two new surfaces before coding them.**
- Keep DigitalOcean's behavior byte-for-byte unchanged (it has no params, no extra
  binary).
