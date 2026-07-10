# Plugins (Cluster Add-ons) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A new "Plugins" panel that lists curated Kubernetes cluster add-ons (metrics-server, descheduler, cert-manager, ingress-nginx), shows which are installed, and installs/uninstalls them one-click with a few curated fields — reusing the existing helm/metrics-server executors.

**Architecture:** A web-only curated add-on list in `packages/catalog/src/addons.ts` (pure, tested) drives a new `apps/web/src/panels/plugins/` panel. Helm add-ons install via the existing `POST /api/helm` (values built by substituting a baked YAML template) and uninstall via `POST /api/helm/uninstall`; metrics-server uses its existing dedicated route (extended with an optional kubelet-insecure-TLS flag). Installed state is detected by looking up each add-on's workload in the live cluster store.

**Tech Stack:** React 19 + Vite + Tailwind v4, TanStack Query, Zustand cluster store, vitest (+ jsdom / @testing-library/react), Pencil (design), Node/helm/kubectl server.

---

## Design tokens / reused APIs (exact shapes)

- `POST /api/helm` body: `{ repoName, repoURL, chart, version?, releaseName, namespace, values: string }` (values = YAML string; the server writes it to a temp file and runs `helm upgrade --install -n <ns> --create-namespace -f <file>`). Client: `useInstallHelm()` in `apps/web/src/panels/catalog/installApi.ts`, param type `HelmInstallParams`.
- `POST /api/helm/uninstall` body: `{ release, namespace }`. Client: `useHelmUninstall()` in `apps/web/src/panels/helm/helmApi.ts`, param type `HelmUninstallParams`.
- `POST /api/install/metrics-server` (`apps/server/src/index.ts`): applies the upstream manifest, then patches `--kubelet-insecure-tls`. Client: `useInstallMetricsServer()` in `apps/web/src/lib/api.ts` (currently `void`).
- `substitute(text, vars: Record<string,string>)` in `packages/catalog/src/substitute.ts` — replaces `{{key}}`.
- Nav registry: `apps/web/src/shell/NavStrip.tsx` (`PANEL_META`, `NAV_GROUPS`). Route registry: `apps/web/src/App.tsx`.
- Cluster store: `useCluster((s) => s.resources)` — `resources[kind]` is a `Record<key, RawObj>` of raw K8s objects; subscribe with `subscribe(kind, "*")` / `unsubscribe` from `@/lib/ws`.

## File structure

- Create `packages/catalog/src/addons.ts` — `ClusterAddon`/`AddonField`/`AddonInstall`/`AddonDetect` types, `CLUSTER_ADDONS`, `detectInstalled`, `buildHelmValues`.
- Create `packages/catalog/src/addons.test.ts` — pure unit tests.
- Modify `packages/catalog/src/index.ts` — re-export the add-on API.
- Modify `apps/server/src/index.ts` — metrics-server route reads optional `{ kubeletInsecureTls }`.
- Modify `apps/web/src/lib/api.ts` — `useInstallMetricsServer` accepts optional `{ kubeletInsecureTls }`.
- Create `apps/web/src/panels/plugins/PluginsPanel.tsx` — the panel.
- Create `apps/web/src/panels/plugins/PluginInstallSheet.tsx` — the fields + confirm sheet.
- Create `apps/web/src/panels/plugins/PluginsPanel.test.tsx` — jsdom render test.
- Modify `apps/web/src/shell/NavStrip.tsx` and `apps/web/src/App.tsx` — register the panel.

---

## Task 1: Pencil design for the Plugins panel

**Files:** none (Pencil `.pen` design only)

Per the design-first convention, produce the panel design before building it. Mirror the existing Apps-catalog card system (`CatalogPanel` / `CatalogDetailSheet`) for visual consistency.

- [ ] **Step 1: Read the design system + catalog frames**

Use the Pencil MCP: `mcp__pencil__get_editor_state({ include_schema: true })`, then `batch_get` to find the catalog/card components and the design-system tokens.

- [ ] **Step 2: Create the Plugins frame**

Create a frame "Plugins — cluster add-ons" containing: a panel header ("Plugins" / "Cluster add-ons" subtitle, count pill), a responsive card grid where each card has an icon, name, one-line tagline, a small group tag (Scheduling/Metrics/Certificates/Ingress), a status pill (Installed with namespace vs Available), and a primary Install button (secondary Uninstall when installed). Also design the install sheet: a title, one row per field (toggle / text / select / namespace dropdown), and a primary Install action. Reuse the catalog card colors, radii, and typography tokens.

- [ ] **Step 3: Record the frame id**

Note the created frame id(s) here for Task 4 to reference: `__________`.

- [ ] **Step 4: Screenshot to verify**

`mcp__pencil__get_screenshot` the frame; confirm no broken/overflowing layout. No commit (design lives in the `.pen` file).

---

## Task 2: Add-on data model + list + helpers

**Files:**
- Create: `packages/catalog/src/addons.ts`
- Test: `packages/catalog/src/addons.test.ts`
- Modify: `packages/catalog/src/index.ts`

- [ ] **Step 1: Write the failing test (`packages/catalog/src/addons.test.ts`)**

```ts
import { describe, it, expect } from "vitest";
import { CLUSTER_ADDONS, detectInstalled, buildHelmValues, type ClusterAddon } from "./addons";

const byId = (id: string): ClusterAddon => {
  const a = CLUSTER_ADDONS.find((x) => x.id === id);
  if (!a) throw new Error(`no add-on ${id}`);
  return a;
};

describe("CLUSTER_ADDONS", () => {
  it("has the seed four with unique ids", () => {
    expect(CLUSTER_ADDONS.map((a) => a.id).sort()).toEqual(
      ["cert-manager", "descheduler", "ingress-nginx", "metrics-server"],
    );
  });
  it("every add-on declares detect + install; helm add-ons carry chart coordinates", () => {
    for (const a of CLUSTER_ADDONS) {
      expect(a.detect.namespace).toBeTruthy();
      expect(a.detect.name).toBeTruthy();
      if (a.install.mode === "helm") {
        expect(a.install.repoURL).toMatch(/^https?:\/\//);
        expect(a.install.chart).toBeTruthy();
        expect(a.install.releaseName).toBeTruthy();
        expect(a.install.namespace).toBeTruthy();
      }
    }
  });
});

describe("detectInstalled", () => {
  const workloads = [
    { kind: "deployments", namespace: "kube-system", name: "metrics-server" },
    { kind: "cronjobs", namespace: "kube-system", name: "descheduler" },
  ];
  it("true when the add-on's workload is present", () => {
    expect(detectInstalled(byId("metrics-server"), workloads)).toBe(true);
    expect(detectInstalled(byId("descheduler"), workloads)).toBe(true);
  });
  it("false when absent", () => {
    expect(detectInstalled(byId("cert-manager"), workloads)).toBe(false);
    expect(detectInstalled(byId("ingress-nginx"), [])).toBe(false);
  });
  it("kind must match (a same-named Deployment is not the descheduler CronJob)", () => {
    expect(detectInstalled(byId("descheduler"), [
      { kind: "deployments", namespace: "kube-system", name: "descheduler" },
    ])).toBe(false);
  });
});

describe("buildHelmValues", () => {
  it("ingress-nginx maps the service type", () => {
    expect(buildHelmValues(byId("ingress-nginx"), { serviceType: "NodePort" })).toContain("type: NodePort");
  });
  it("descheduler runs as a CronJob with the schedule and only the enabled strategies", () => {
    const v = buildHelmValues(byId("descheduler"), {
      schedule: "0 * * * *", lowNodeUtilization: true, removeDuplicates: true, topologySpread: false,
    });
    const parsed = JSON.parse(v);
    expect(parsed.kind).toBe("CronJob");
    expect(parsed.schedule).toBe("0 * * * *");
    const balance = parsed.deschedulerPolicy.profiles[0].plugins.balance.enabled as string[];
    expect(balance).toContain("LowNodeUtilization");
    expect(balance).toContain("RemoveDuplicates");
    expect(balance).not.toContain("RemovePodsViolatingTopologySpreadConstraint");
    // LowNodeUtilization is invalid without threshold args — they must be present when it's enabled.
    const lnu = (parsed.deschedulerPolicy.profiles[0].pluginConfig as { name: string; args?: { targetThresholds?: unknown } }[])
      .find((p) => p.name === "LowNodeUtilization");
    expect(lnu?.args?.targetThresholds).toBeTruthy();
  });
  it("cert-manager CRDs follow the installCRDs toggle", () => {
    expect(buildHelmValues(byId("cert-manager"), { installCRDs: true })).toContain("enabled: true");
    expect(buildHelmValues(byId("cert-manager"), { installCRDs: false })).toContain("enabled: false");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rigel/catalog test src/addons.test.ts` (if that filter name differs, use the catalog package's test script — check `packages/catalog/package.json` `name`)
Expected: FAIL — `Cannot find module './addons'`.

- [ ] **Step 3: Implement (`packages/catalog/src/addons.ts`)**

```ts
import { substitute } from "./substitute";

export type AddonGroup = "Scheduling" | "Metrics" | "Certificates" | "Ingress";
export type AddonWorkloadKind = "deployments" | "cronjobs";

export interface AddonField {
  key: string;
  label: string;
  type: "toggle" | "text" | "select" | "namespace";
  default: string | boolean;
  options?: string[];
  help?: string;
}

export type AddonInstall =
  | { mode: "metricsServer" }
  | {
      mode: "helm";
      repoName: string;
      repoURL: string;
      chart: string;
      version?: string;
      releaseName: string;
      namespace: string;
      /** Baked helm values with `{{field}}` tokens (used when buildValues is absent). */
      valuesTemplate?: string;
      /** Programmatic values, for policy shapes a flat template can't express. */
      buildValues?: (fields: Record<string, string | boolean>) => Record<string, unknown>;
    };

/** Descheduler v1alpha2 policy: CronJob + only the toggled-on balance strategies. */
function deschedulerValues(f: Record<string, string | boolean>): Record<string, unknown> {
  const enabled: string[] = [];
  if (f.lowNodeUtilization !== false) enabled.push("LowNodeUtilization");
  if (f.removeDuplicates !== false) enabled.push("RemoveDuplicates");
  if (f.topologySpread !== false) enabled.push("RemovePodsViolatingTopologySpreadConstraint");
  const pluginConfig: Record<string, unknown>[] = [
    { name: "DefaultEvictor", args: { evictSystemCriticalPods: false, evictLocalStoragePods: false } },
  ];
  if (enabled.includes("LowNodeUtilization")) {
    pluginConfig.push({
      name: "LowNodeUtilization",
      args: { thresholds: { cpu: 20, memory: 20, pods: 20 }, targetThresholds: { cpu: 50, memory: 50, pods: 50 } },
    });
  }
  return {
    kind: "CronJob",
    schedule: String(f.schedule ?? "*/30 * * * *"),
    deschedulerPolicy: { profiles: [{ name: "default", plugins: { balance: { enabled } }, pluginConfig }] },
  };
}

export interface AddonDetect {
  kind: AddonWorkloadKind;
  namespace: string;
  name: string;
}

export interface ClusterAddon {
  id: string;
  name: string;
  tagline: string;
  description: string;
  icon: string; // lucide icon name, mapped in the panel
  group: AddonGroup;
  docsURL: string;
  repoURL: string;
  install: AddonInstall;
  fields: AddonField[];
  detect: AddonDetect;
}

export const CLUSTER_ADDONS: ClusterAddon[] = [
  {
    id: "metrics-server",
    name: "Metrics Server",
    tagline: "Live pod & node CPU/memory for kubectl top and autoscaling.",
    description:
      "Installs the upstream metrics-server. Required for live resource readouts and Horizontal Pod Autoscaling.",
    icon: "Activity",
    group: "Metrics",
    docsURL: "https://github.com/kubernetes-sigs/metrics-server",
    repoURL: "https://github.com/kubernetes-sigs/metrics-server",
    install: { mode: "metricsServer" },
    fields: [
      {
        key: "kubeletInsecureTls",
        label: "Allow insecure kubelet TLS",
        type: "toggle",
        default: true,
        help: "Needed on k3s/kind/homelab clusters with self-signed kubelet certs. Turn off on managed clusters with valid certs.",
      },
    ],
    detect: { kind: "deployments", namespace: "kube-system", name: "metrics-server" },
  },
  {
    id: "descheduler",
    name: "Descheduler",
    tagline: "Rebalances pods across nodes on a schedule (fixes lopsided nodes).",
    description:
      "Runs the Kubernetes SIG descheduler as a CronJob. Evicts pods that violate its policy so the scheduler re-places them evenly — the piece core Kubernetes lacks. Respects PodDisruptionBudgets.",
    icon: "Scale",
    group: "Scheduling",
    docsURL: "https://github.com/kubernetes-sigs/descheduler",
    repoURL: "https://github.com/kubernetes-sigs/descheduler",
    install: {
      mode: "helm",
      repoName: "descheduler",
      repoURL: "https://kubernetes-sigs.github.io/descheduler/",
      chart: "descheduler",
      releaseName: "descheduler",
      namespace: "kube-system",
      buildValues: deschedulerValues,
    },
    fields: [
      { key: "schedule", label: "Run schedule (cron)", type: "text", default: "*/30 * * * *", help: "How often to rebalance." },
      { key: "lowNodeUtilization", label: "Low-node utilization (move pods off busy nodes)", type: "toggle", default: true },
      { key: "removeDuplicates", label: "Spread duplicate replicas off the same node", type: "toggle", default: true },
      { key: "topologySpread", label: "Enforce topology spread constraints", type: "toggle", default: true },
    ],
    detect: { kind: "cronjobs", namespace: "kube-system", name: "descheduler" },
  },
  {
    id: "cert-manager",
    name: "cert-manager",
    tagline: "Automated TLS certificates (Let's Encrypt and more).",
    description:
      "Installs cert-manager and its CRDs. Issue and auto-renew TLS certificates for Ingress and workloads.",
    icon: "BadgeCheck",
    group: "Certificates",
    docsURL: "https://cert-manager.io/docs/",
    repoURL: "https://github.com/cert-manager/cert-manager",
    install: {
      mode: "helm",
      repoName: "jetstack",
      repoURL: "https://charts.jetstack.io",
      chart: "cert-manager",
      releaseName: "cert-manager",
      namespace: "cert-manager",
      valuesTemplate: "crds:\n  enabled: {{installCRDs}}\n",
    },
    fields: [
      { key: "namespace", label: "Namespace", type: "namespace", default: "cert-manager" },
      { key: "installCRDs", label: "Install CRDs", type: "toggle", default: true, help: "Turn off only if the cert-manager CRDs are already installed separately." },
    ],
    detect: { kind: "deployments", namespace: "cert-manager", name: "cert-manager" },
  },
  {
    id: "ingress-nginx",
    name: "ingress-nginx",
    tagline: "The NGINX Ingress controller for HTTP routing.",
    description:
      "Installs the community ingress-nginx controller. Routes external HTTP(S) traffic to Services via Ingress objects.",
    icon: "Signpost",
    group: "Ingress",
    docsURL: "https://kubernetes.github.io/ingress-nginx/",
    repoURL: "https://github.com/kubernetes/ingress-nginx",
    install: {
      mode: "helm",
      repoName: "ingress-nginx",
      repoURL: "https://kubernetes.github.io/ingress-nginx",
      chart: "ingress-nginx",
      releaseName: "ingress-nginx",
      namespace: "ingress-nginx",
      valuesTemplate: "controller:\n  service:\n    type: {{serviceType}}\n",
    },
    fields: [
      {
        key: "serviceType",
        label: "Service type",
        type: "select",
        default: "LoadBalancer",
        options: ["LoadBalancer", "NodePort"],
      },
    ],
    detect: { kind: "deployments", namespace: "ingress-nginx", name: "ingress-nginx-controller" },
  },
];

export interface InstalledWorkload {
  kind: AddonWorkloadKind;
  namespace: string;
  name: string;
}

/** True when the add-on's declared workload is present in the cluster. */
export function detectInstalled(addon: ClusterAddon, workloads: InstalledWorkload[]): boolean {
  const d = addon.detect;
  return workloads.some((w) => w.kind === d.kind && w.namespace === d.namespace && w.name === d.name);
}

/** Build the helm values (YAML, or JSON — valid YAML for helm) for an add-on's fields. */
export function buildHelmValues(addon: ClusterAddon, fields: Record<string, string | boolean>): string {
  if (addon.install.mode !== "helm") return "";
  if (addon.install.buildValues) return JSON.stringify(addon.install.buildValues(fields));
  const vars: Record<string, string> = {};
  for (const [k, v] of Object.entries(fields)) vars[k] = String(v);
  return substitute(addon.install.valuesTemplate ?? "", vars);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @rigel/catalog test src/addons.test.ts`
Expected: PASS.

- [ ] **Step 5: Re-export from the barrel (`packages/catalog/src/index.ts`)**

Add: `export * from "./addons";`

Note on the descheduler values: `deschedulerValues` targets the descheduler chart's `descheduler/v1alpha2` policy schema (`deschedulerPolicy.profiles[].plugins.balance.enabled` + `pluginConfig`, with `LowNodeUtilization` requiring `thresholds`/`targetThresholds`). If `helm` is available, sanity-check once with `helm repo add descheduler https://kubernetes-sigs.github.io/descheduler/ && helm template descheduler descheduler/descheduler -f <(node -e '…print buildHelmValues output…')` — it should render without a policy error. If helm/network is unavailable in this environment, note that this render check is pending; the unit test already pins the value shape.

- [ ] **Step 6: Commit**

```bash
git add packages/catalog/src/addons.ts packages/catalog/src/addons.test.ts packages/catalog/src/index.ts
git commit -m "feat(catalog): cluster add-on registry (metrics-server, descheduler, cert-manager, ingress-nginx)"
```

End the commit body with:
Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>

---

## Task 3: metrics-server route + hook accept a kubelet-insecure-TLS flag

**Files:**
- Modify: `apps/server/src/index.ts` (the `/api/install/metrics-server` handler)
- Modify: `apps/web/src/lib/api.ts` (`useInstallMetricsServer`)

No unit test — the route shells out to kubectl and has no existing test; verify by typecheck + code read (repo convention: don't execute mutation routes to verify).

- [ ] **Step 1: Make the route read an optional body**

In `apps/server/src/index.ts`, replace the metrics-server handler body so it only patches when the flag is true (default true = current behavior):

```ts
if (url.pathname === "/api/install/metrics-server" && req.method === "POST") {
  let kubeletInsecureTls = true;
  try {
    const body = (await req.json()) as { kubeletInsecureTls?: boolean };
    if (typeof body?.kubeletInsecureTls === "boolean") kubeletInsecureTls = body.kubeletInsecureTls;
  } catch {
    // no body → keep the default (true)
  }
  const apply = await kubectl(context, ["apply", "-f", METRICS_SERVER_URL]);
  if (apply.code === 0 && kubeletInsecureTls) {
    await kubectl(context, [
      "patch", "deployment", "metrics-server", "-n", "kube-system", "--type=json",
      "-p", '[{"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--kubelet-insecure-tls"}]',
    ]);
  }
  return Response.json(apply);
}
```

Then add the uninstall counterpart right after that handler:

```ts
// POST /api/uninstall/metrics-server — delete the upstream metrics-server manifest.
if (url.pathname === "/api/uninstall/metrics-server" && req.method === "POST") {
  const del = await kubectl(context, ["delete", "-f", METRICS_SERVER_URL, "--ignore-not-found"]);
  return Response.json(del);
}
```

- [ ] **Step 2: Make the hook accept the optional flag (`apps/web/src/lib/api.ts`)**

Change `useInstallMetricsServer` to take an optional variable (existing `.mutate()` callers still work — the variable is optional):

```ts
export function useInstallMetricsServer() {
  const qc = useQueryClient();
  return useMutation<ActionResponse, Error, { kubeletInsecureTls?: boolean } | void>({
    mutationFn: async (vars) => {
      const res = await fetch("/api/install/metrics-server", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(vars ?? {}),
      });
      if (!res.ok) throw new Error((await res.text()) || "install failed");
      return (await res.json()) as ActionResponse;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["metrics"] }),
  });
}

/** Uninstall the upstream metrics-server (POST /api/uninstall/metrics-server). */
export function useUninstallMetricsServer() {
  const qc = useQueryClient();
  return useMutation<ActionResponse, Error, void>({
    mutationFn: async () => {
      const res = await fetch("/api/uninstall/metrics-server", { method: "POST" });
      if (!res.ok) throw new Error((await res.text()) || "uninstall failed");
      return (await res.json()) as ActionResponse;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["metrics"] }),
  });
}
```

- [ ] **Step 3: Verify existing callers still typecheck**

`MetricsServerEmptyState.tsx` and `OnboardingWizard.tsx` call `install.mutate()` with no args — still valid (variable is optional). Run:

Run: `pnpm --filter web typecheck && pnpm --filter @rigel/server typecheck`
Expected: clean (server has 4 pre-existing `assistant.ts` webhook errors unrelated to this change — confirm they predate the change via `git stash`; anything else is a real error).

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/index.ts apps/web/src/lib/api.ts
git commit -m "feat: metrics-server install (kubelet-TLS flag) + uninstall route/hook"
```

End the commit body with:
Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>

---

## Task 4: Plugins panel + install sheet

**Files:**
- Create: `apps/web/src/panels/plugins/PluginInstallSheet.tsx`
- Create: `apps/web/src/panels/plugins/PluginsPanel.tsx`
- Test: `apps/web/src/panels/plugins/PluginsPanel.test.tsx`

Reference the Task 1 Pencil frame for layout. Reuse `PanelHeader` (`@/panels/components/PanelHeader`), `ConfirmSheet` (`@/components/ConfirmSheet`) patterns, and the dialog primitives in `@/components/ui/dialog`.

- [ ] **Step 1: Write the failing test (`apps/web/src/panels/plugins/PluginsPanel.test.tsx`)**

```tsx
// @vitest-environment jsdom
import { afterEach, describe, it, expect } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { useCluster } from "@/store/cluster";
import PluginsPanel from "./PluginsPanel";

afterEach(cleanup);

function renderPanel() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter><PluginsPanel /></MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("PluginsPanel", () => {
  it("lists the four add-ons", () => {
    useCluster.setState({ resources: {} as never });
    renderPanel();
    expect(screen.getByText("Metrics Server")).toBeTruthy();
    expect(screen.getByText("Descheduler")).toBeTruthy();
    expect(screen.getByText("cert-manager")).toBeTruthy();
    expect(screen.getByText("ingress-nginx")).toBeTruthy();
  });

  it("marks an add-on Installed when its workload is present in the store", () => {
    useCluster.setState({
      resources: {
        deployments: { "kube-system/metrics-server": { metadata: { name: "metrics-server", namespace: "kube-system" } } },
      } as never,
    });
    renderPanel();
    expect(screen.getAllByText(/installed/i).length).toBeGreaterThan(0);
  });
});
```

Note: confirm the store's shape/import (`useCluster` from `@/store/cluster`) and that `resources[kind]` is keyed by `"<namespace>/<name>"` by reading `apps/web/src/store/cluster.ts`; adjust the fixture keys to match the real key format if it differs.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter web test src/panels/plugins/PluginsPanel.test.tsx`
Expected: FAIL — `Cannot find module './PluginsPanel'`.

- [ ] **Step 3: Implement the install sheet (`apps/web/src/panels/plugins/PluginInstallSheet.tsx`)**

```tsx
import { useState } from "react";
import type { ClusterAddon, AddonField } from "@rigel/catalog";
import { buildHelmValues } from "@rigel/catalog";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogBody, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { NamespaceField } from "@/components/NamespaceField";
import { useInstallHelm } from "@/panels/catalog/installApi";
import { useInstallMetricsServer } from "@/lib/api";

function defaults(addon: ClusterAddon): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (const f of addon.fields) out[f.key] = f.default;
  return out;
}

/** Field-collection dialog that installs a single add-on via the right executor. */
export function PluginInstallSheet({ addon, open, onClose, onDone }: {
  addon: ClusterAddon;
  open: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const [values, setValues] = useState<Record<string, string | boolean>>(() => defaults(addon));
  const helm = useInstallHelm();
  const metrics = useInstallMetricsServer();
  const pending = helm.isPending || metrics.isPending;
  const error = (helm.error ?? metrics.error)?.message ?? null;

  function set(key: string, v: string | boolean) {
    setValues((prev) => ({ ...prev, [key]: v }));
  }

  function install() {
    if (addon.install.mode === "metricsServer") {
      metrics.mutate(
        { kubeletInsecureTls: values.kubeletInsecureTls === true },
        { onSuccess: () => { onDone(); onClose(); } },
      );
      return;
    }
    const namespace = typeof values.namespace === "string" && values.namespace ? values.namespace : addon.install.namespace;
    helm.mutate(
      {
        repoName: addon.install.repoName,
        repoURL: addon.install.repoURL,
        chart: addon.install.chart,
        version: addon.install.version ?? null,
        releaseName: addon.install.releaseName,
        namespace,
        values: buildHelmValues(addon, values),
      },
      { onSuccess: () => { onDone(); onClose(); } },
    );
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{`Install ${addon.name}`}</DialogTitle>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-3">
          {addon.fields.map((f) => (
            <Field key={f.key} field={f} value={values[f.key]} onChange={(v) => set(f.key, v)} />
          ))}
          {error && <p role="alert" className="text-2xs text-[var(--status-failed)]">{error}</p>}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={pending}>Cancel</Button>
          <Button onClick={install} disabled={pending}>{pending ? "Installing…" : "Install"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({ field, value, onChange }: { field: AddonField; value: string | boolean; onChange: (v: string | boolean) => void }) {
  const cls = "h-8 rounded-[6px] border border-[var(--border-subtle)] bg-[var(--surface-sunken)] px-2 text-xs text-foreground outline-none focus:ring-2 focus:ring-ring/50";
  return (
    <label className="flex flex-col gap-1 text-xs">
      <span className="text-[var(--fg-secondary)]">{field.label}</span>
      {field.type === "toggle" ? (
        <input type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} className="size-4" />
      ) : field.type === "select" ? (
        <select value={String(value)} onChange={(e) => onChange(e.target.value)} className={cls}>
          {(field.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      ) : field.type === "namespace" ? (
        <NamespaceField value={String(value)} onChange={onChange} />
      ) : (
        <input type="text" value={String(value)} onChange={(e) => onChange(e.target.value)} className={cls} />
      )}
      {field.help && <span className="text-2xs text-[var(--fg-tertiary)]">{field.help}</span>}
    </label>
  );
}
```

Note: `NamespaceField` (`apps/web/src/components/NamespaceField.tsx`) takes `value` / `onChange` (+ optional `disabled`, `className`, `ariaLabel`) and owns its own namespaces subscription. The dialog primitives (`Dialog`, `DialogContent`, `DialogHeader`, `DialogTitle`, `DialogBody`, `DialogFooter`) are verified against `apps/web/src/components/ui/dialog.tsx`.

- [ ] **Step 4: Implement the panel (`apps/web/src/panels/plugins/PluginsPanel.tsx`)**

```tsx
import { useEffect, useMemo, useState } from "react";
import * as Icons from "lucide-react";
import { CLUSTER_ADDONS, detectInstalled, type ClusterAddon, type InstalledWorkload } from "@rigel/catalog";
import { useCluster } from "@/store/cluster";
import { subscribe, unsubscribe } from "@/lib/ws";
import { PanelHeader } from "@/panels/components/PanelHeader";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogBody, DialogFooter } from "@/components/ui/dialog";
import { useHelmUninstall } from "@/panels/helm/helmApi";
import { useUninstallMetricsServer } from "@/lib/api";
import { PluginInstallSheet } from "./PluginInstallSheet";

function uninstallCommand(addon: ClusterAddon): string {
  return addon.install.mode === "helm"
    ? `helm uninstall ${addon.install.releaseName} -n ${addon.install.namespace}`
    : "kubectl delete -f <metrics-server upstream manifest>";
}

/** Destructive confirm shown before an add-on is removed (helm or metrics-server). */
function UninstallConfirm({ addon, running, error, onCancel, onConfirm }: {
  addon: ClusterAddon; running: boolean; error: string | null; onCancel: () => void; onConfirm: () => void;
}) {
  return (
    <Dialog open onOpenChange={(o) => !o && onCancel()}>
      <DialogContent>
        <DialogHeader><DialogTitle>{`Uninstall ${addon.name}`}</DialogTitle></DialogHeader>
        <DialogBody>
          <p className="mb-2 text-sm text-muted-foreground">This will run:</p>
          <pre className="overflow-x-auto rounded-md bg-black/30 p-3 text-xs">{uninstallCommand(addon)}</pre>
          {error && <p className="mt-3 text-2xs text-[var(--status-failed)]">{error}</p>}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={onCancel} disabled={running}>Cancel</Button>
          <Button variant="destructive" onClick={onConfirm} disabled={running}>{running ? "Removing…" : "Uninstall"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface RawObj { metadata?: { name?: string; namespace?: string } }

function workloadsFrom(resources: Record<string, Record<string, RawObj>>, kind: InstalledWorkload["kind"]): InstalledWorkload[] {
  const map = resources[kind] ?? {};
  return Object.values(map).map((o) => ({
    kind,
    namespace: o.metadata?.namespace ?? "",
    name: o.metadata?.name ?? "",
  }));
}

export default function PluginsPanel() {
  const resources = useCluster((s) => s.resources) as Record<string, Record<string, RawObj>>;
  const [installing, setInstalling] = useState<ClusterAddon | null>(null);
  const [uninstalling, setUninstalling] = useState<ClusterAddon | null>(null);
  const helmUninstall = useHelmUninstall();
  const metricsUninstall = useUninstallMetricsServer();

  useEffect(() => {
    subscribe("deployments", "*");
    subscribe("cronjobs", "*");
    return () => { unsubscribe("deployments", "*"); unsubscribe("cronjobs", "*"); };
  }, []);

  const workloads = useMemo(
    () => [...workloadsFrom(resources, "deployments"), ...workloadsFrom(resources, "cronjobs")],
    [resources],
  );

  return (
    <div className="flex h-full flex-col">
      <PanelHeader title="Plugins" subtitle="Cluster add-ons" count={CLUSTER_ADDONS.length} />
      <div className="flex-1 overflow-auto p-3">
        <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-3">
          {CLUSTER_ADDONS.map((addon) => {
            const installed = detectInstalled(addon, workloads);
            const Icon = (Icons as Record<string, Icons.LucideIcon>)[addon.icon] ?? Icons.Puzzle;
            return (
              <div key={addon.id} className="flex flex-col gap-2 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-elevated)] p-4">
                <div className="flex items-center gap-2">
                  <Icon className="size-5 text-[var(--accent-primary)]" />
                  <span className="text-sm font-semibold text-foreground">{addon.name}</span>
                  <span className="ml-auto rounded-full border border-[var(--border-subtle)] px-2 py-0.5 text-3xs text-[var(--fg-tertiary)]">{addon.group}</span>
                </div>
                <p className="text-xs text-[var(--fg-secondary)]">{addon.tagline}</p>
                <div className="mt-auto flex items-center justify-between pt-2">
                  <span className={installed ? "text-2xs text-[var(--status-running)]" : "text-2xs text-[var(--fg-tertiary)]"}>
                    {installed ? `Installed · ${addon.detect.namespace}` : "Available"}
                  </span>
                  {installed ? (
                    <Button variant="ghost" size="sm" onClick={() => setUninstalling(addon)}>Uninstall</Button>
                  ) : (
                    <Button size="sm" onClick={() => setInstalling(addon)}>Install</Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {installing && (
        <PluginInstallSheet addon={installing} open onClose={() => setInstalling(null)} onDone={() => setInstalling(null)} />
      )}

      {uninstalling && (
        <UninstallConfirm
          addon={uninstalling}
          running={helmUninstall.isPending || metricsUninstall.isPending}
          error={(helmUninstall.error ?? metricsUninstall.error)?.message ?? null}
          onCancel={() => setUninstalling(null)}
          onConfirm={() => {
            const a = uninstalling;
            if (a.install.mode === "helm") {
              helmUninstall.mutate(
                { release: a.install.releaseName, namespace: a.install.namespace },
                { onSuccess: () => setUninstalling(null) },
              );
            } else {
              metricsUninstall.mutate(undefined, { onSuccess: () => setUninstalling(null) });
            }
          }}
        />
      )}
    </div>
  );
}
```

Uninstall is unified: every installed add-on shows an Uninstall button; the local `UninstallConfirm` shows the exact command and calls `useHelmUninstall` (helm add-ons) or `useUninstallMetricsServer` (metrics-server). The Dialog primitives are verified against `apps/web/src/components/ui/dialog.tsx`.

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter web test src/panels/plugins/PluginsPanel.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/panels/plugins/
git commit -m "feat(web): Plugins panel — browse & install cluster add-ons"
```

End the commit body with:
Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>

---

## Task 5: Register the panel in nav + routes

**Files:**
- Modify: `apps/web/src/shell/NavStrip.tsx`
- Modify: `apps/web/src/App.tsx`

- [ ] **Step 1: Add the panel meta + nav group member (`NavStrip.tsx`)**

Add a `PANEL_META` entry (place it near `catalog`/`helm`); import the `Puzzle` icon from `lucide-react` at the top of the file if not already imported:

```tsx
  plugins:      { route: "/plugins",      title: "Plugins",      subtitle: "Cluster add-ons",       icon: Puzzle },
```

Then add `"plugins"` to the `Self-host` group in `NAV_GROUPS`:

```tsx
  { title: "Self-host", panels: ["catalog", "helm", "plugins"] },
```

- [ ] **Step 2: Register the route (`App.tsx`)**

Import the panel at the top with the other panel imports:

```tsx
import PluginsPanel from "@/panels/plugins/PluginsPanel";
```

Add a route inside the `<Routes>` block (next to the other panel routes):

```tsx
<Route path="/plugins" element={<PluginsPanel />} />
```

Match the exact `<Route>` style used by neighboring routes (lazy vs eager) — read the surrounding routes first and mirror them.

- [ ] **Step 3: Verify it renders in nav + routes**

Run: `pnpm --filter web typecheck && pnpm --filter web build`
Expected: clean build.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/shell/NavStrip.tsx apps/web/src/App.tsx
git commit -m "feat(web): add Plugins to nav + routes (Self-host group)"
```

End the commit body with:
Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>

---

## Task 6: Full verification

**Files:** none

- [ ] **Step 1: Typecheck, test, build the web app**

Run: `pnpm --filter web typecheck && pnpm --filter web test && pnpm --filter web build`
Expected: all pass.

- [ ] **Step 2: Test catalog + server packages**

Run: `pnpm --filter @rigel/catalog test && pnpm --filter @rigel/server test`
Expected: pass (server retains only the 4 pre-existing `assistant.ts` webhook typecheck errors, unrelated to this work).

- [ ] **Step 3: Visual check (only if the user asks to run the app)**

Per project convention, do NOT start a web dev server. If the user wants a live look, `pnpm --filter desktop dev`, open Plugins, and confirm: four add-on cards, correct Installed/Available status, the install sheet's fields render per add-on, and a helm add-on uninstall shows the destructive confirm. Otherwise rely on Steps 1-2.

---

## Task 7: Docs + tickets (per user workflow)

**Files:** none (Outline + Plane)

- [ ] **Step 1:** Create an Outline doc in the Rigel/Helmsman collection ("Plugins — cluster add-ons"): what it is, the seed four (with their fields), how install/detect/uninstall reuse the helm + metrics-server executors, and the follow-ups (broader add-on set, node-imbalance nudge).
- [ ] **Step 2:** Create a Plane issue in the HELM project recording the feature as shipped, linked to the Outline doc and this plan.
