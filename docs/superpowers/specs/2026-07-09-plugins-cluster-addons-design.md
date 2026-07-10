# Plugins — cluster add-ons panel

**Date:** 2026-07-09

## Problem

Kubernetes has no built-in rebalancer, and several broadly-useful capabilities
(descheduler, metrics-server, cert-manager, ingress-nginx) ship as separate
"cluster add-ons" you install yourself. Rigel has no browsable place to discover
and install them. The only cluster-infra install today is a hardcoded
metrics-server one-off (`/api/install/metrics-server`) surfaced in the Overview
empty state and onboarding. Users want a single panel to see available add-ons
and install them in one click.

## Goal

A new **Plugins** panel that lists curated Kubernetes cluster add-ons, shows
which are installed, and installs them with one click plus a few curated fields.
Reuse the existing install executors (`/api/helm`, `/api/apply`,
`/api/install/metrics-server`) rather than building a new installer.

Naming note: the panel is user-facing named **"Plugins"** (user's choice). In
code and this spec the entries are called **add-ons** (the accurate Kubernetes
term); "Plugins" is only the display label.

## Scope decisions (settled during brainstorming)

- **Dedicated surface, separate list** — not folded into the end-user Apps
  catalog (which is a closed 7-category enum mirrored 1:1 with a Swift app under
  a parity contract). The Plugins list is **web-only**, no Swift parity.
- **Install depth: one-click + a few key fields** per add-on (not full
  helm-values editing).
- **Seed set: the core four** — metrics-server, descheduler, cert-manager,
  ingress-nginx.
- **Uninstall included in v1**, guarded by the standard destructive ConfirmSheet.

## Surface & UX

- New panel at route `/plugins`, title **"Plugins"**, placed in the **Self-host**
  nav group next to "Apps" (catalog) and "Helm" — all three install into the
  cluster. (Not the "Tools" group, which holds the Apply-YAML / Compose / GitOps
  editors.)
- Card list mirroring the Apps catalog card style (`CatalogPanel` /
  `CatalogDetailSheet` are the visual reference). Each card: icon, name,
  one-line tagline, a group tag, and a status pill **Installed** (with namespace)
  or **Available**, plus an **Install** button.
- **Install** opens a small sheet with the add-on's curated fields, then runs the
  install. **Installed** add-ons show an **Uninstall** action behind a
  destructive ConfirmSheet.
- The panel UI must be designed in Pencil first (per the design-first
  convention), mirroring the catalog card/detail components; the plan's first
  task is to produce that frame and name its id.

## Data model

New web-only module `packages/catalog/src/addons.ts` exporting
`CLUSTER_ADDONS: ClusterAddon[]` plus pure helpers. No JSON/Swift mirror.

```ts
interface ClusterAddon {
  id: string;                 // "descheduler"
  name: string;               // "Descheduler"
  tagline: string;            // one line
  description: string;
  icon: string;               // lucide icon name
  group: "Scheduling" | "Metrics" | "Certificates" | "Ingress";
  docsURL: string;
  repoURL: string;
  install: AddonInstall;
  fields?: AddonField[];
  detect: AddonDetect;
}

type AddonInstall =
  | { mode: "helm"; repoName: string; repoURL: string; chart: string; version?: string; releaseName: string; namespace: string; values?: Record<string, unknown> }
  | { mode: "metricsServer" };   // uses the existing dedicated route

interface AddonField {
  key: string;
  label: string;
  type: "text" | "namespace" | "select" | "toggle";
  default: string | boolean;
  options?: string[];         // for select
  help?: string;
}

interface AddonDetect {
  namespace: string;          // where the workload lives
  workload: string;           // deployment/daemonset name to look for
  // metrics-server additionally reuses the metrics-availability signal
}
```

Pure helper `detectInstalled(addon, clusterState): boolean` — checks the live
cluster store for `detect.workload` in `detect.namespace` (metrics-server also
accepts the metrics-availability signal). Unit-tested.

`buildHelmValues(addon, fieldValues): Record<string, unknown>` — maps the
add-on's field values onto its helm values. Unit-tested.

## Install / detect / uninstall — reuse existing machinery

- **Helm add-ons** (descheduler, cert-manager, ingress-nginx): client
  `useInstallHelm()` → existing `POST /api/helm` (`repo add` → `repo update` →
  `helm upgrade --install`), with values from `buildHelmValues`.
- **metrics-server**: client `useInstallMetricsServer()` → existing
  `POST /api/install/metrics-server` (applies the upstream manifest, patches
  `--kubelet-insecure-tls`). The kubelet-insecure-TLS field toggles that patch;
  if the field forces a behavior change, extend that route to accept a boolean
  body (default true = current behavior). The existing Overview/onboarding
  buttons keep calling it unchanged.
- **Detect installed**: read the live cluster store (already watched) for each
  add-on's `detect` workload/namespace. metrics-server reuses the
  metrics-availability signal.
- **Uninstall**: helm add-ons → `helm uninstall <release> -n <ns>` (reuse the
  helm-uninstall path used by the catalog's delete counterpart); metrics-server
  → `POST /api/delete` on the upstream manifest URL (or a dedicated remove).
  Both behind ConfirmSheet.

Net server change is small: value-passing into the helm route already works;
metrics-server route gains an optional `kubeletInsecureTls` boolean.

## Seed add-ons & fields

| Add-on | group | install | fields |
|---|---|---|---|
| metrics-server | Metrics | metricsServer route | kubelet-insecure-TLS toggle (default on) |
| descheduler | Scheduling | helm `descheduler/descheduler` | schedule (default `*/30 * * * *`); strategy toggles: LowNodeUtilization (on), RemoveDuplicates (on), RemovePodsViolatingTopologySpreadConstraint (on) — installed in CronJob mode |
| cert-manager | Certificates | helm `jetstack/cert-manager` | namespace (default `cert-manager`); installCRDs (on) |
| ingress-nginx | Ingress | helm `ingress-nginx/ingress-nginx` | service type: select LoadBalancer / NodePort (default LoadBalancer) |

The descheduler's default strategies (topology-spread + low-node-utilization)
are exactly what fixes the node-imbalance-after-drain problem that motivated this.

## Navigation wiring

- `apps/web/src/shell/NavStrip.tsx`: add `plugins` to `PANEL_META` and to the
  `Self-host` member of `NAV_GROUPS`.
- `apps/web/src/App.tsx`: register the `/plugins` route.
- New panel dir `apps/web/src/panels/plugins/`.
- Command palette picks it up automatically from `PANEL_META`.

## Out of scope (follow-ups)

- Full helm-values / manifest editor before install.
- Broader add-on set: kube-state-metrics, vertical-pod-autoscaler,
  cluster-autoscaler (cloud-provider-specific config).
- Proactive tie-in: detect node imbalance on the Nodes view and suggest
  installing the descheduler. This panel is the foundation that nudge builds on.

## Testing

- Vitest for `packages/catalog/src/addons.ts`: the list is well-formed (unique
  ids, every add-on has detect + install), `detectInstalled` marks installed vs
  available from a cluster-state fixture, `buildHelmValues` maps fields to values
  (descheduler strategy toggles, ingress service type, cert-manager namespace).
- Vitest (jsdom) for the panel: renders cards, shows Installed vs Available from
  a store fixture, opens the field sheet, calls the right install mutation.
- `pnpm --filter web typecheck`, `pnpm --filter web test`, `pnpm --filter web build`.
