# Workloads Row Drop-down Detail Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fill the wired-but-empty Workloads panel row drop-downs (StatefulSets, DaemonSets, Jobs, CronJobs) with a rich expanded detail matching the existing `DeploymentDetail` pattern.

**Architecture:** Introduce one shared `WorkloadDetail` component driven by `kind`, fed by pure display helpers. Extract the container-card and `Field` markup out of `DeploymentDetail` into shared components so both it and `WorkloadDetail` reuse them (no duplication). Extend the pure `relatedResources.ts` resolver to cover `job` (→ pods/configmaps/secrets via ownerRef + podRefs) and `cronjob` (→ jobs via ownerRef). No server-side changes — the Zustand store already holds the full workload objects.

**Tech Stack:** React 19 + TypeScript, Tailwind v4 (token arbitrary values), Zustand store, vitest + @testing-library/react (component tests use a `// @vitest-environment jsdom` file directive; pure-logic suites run in node).

**Spec:** `docs/superpowers/specs/2026-07-01-workloads-row-detail-design.md`

**Working dir for all commands:** `apps/web` (run `pnpm --filter web <script>` from repo root, or `cd apps/web` first). All file paths below are relative to the repo root `/Users/tyrelchambers/home/claude-k8s`.

---

## Task 1: Shared `ContainerCards` component + `summarizeContainers`

Extracts the container-card markup + `ResourceCell` + `ContainerSummary` type out of `DeploymentDetail`, plus a `summarizeContainers` helper that takes a raw container array (so any workload kind can reuse it).

**Files:**
- Create: `apps/web/src/panels/components/ContainerCards.tsx`
- Create: `apps/web/src/panels/components/ContainerCards.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/panels/components/ContainerCards.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ContainerCards, summarizeContainers } from "./ContainerCards";

describe("summarizeContainers", () => {
  it("maps raw containers to summaries with resource req/lim", () => {
    const out = summarizeContainers([
      {
        name: "web",
        image: "nginx:1.27",
        ports: [{ containerPort: 80 }],
        resources: { requests: { cpu: "100m", memory: "64Mi" }, limits: { cpu: "500m", memory: "128Mi" } },
      },
    ]);
    expect(out).toEqual([
      { name: "web", image: "nginx:1.27", ports: [80], cpuReq: "100m", cpuLim: "500m", memReq: "64Mi", memLim: "128Mi" },
    ]);
  });

  it("defaults a missing image to a dash and drops undefined ports", () => {
    const out = summarizeContainers([{ name: "c", ports: [{}] }]);
    expect(out[0].image).toBe("—");
    expect(out[0].ports).toEqual([]);
  });

  it("returns an empty array for undefined input", () => {
    expect(summarizeContainers(undefined)).toEqual([]);
  });
});

describe("ContainerCards", () => {
  it("renders a card per container with image and ports", () => {
    render(
      <ContainerCards
        containers={[{ name: "web", image: "nginx:1.27", ports: [80, 443] }]}
      />,
    );
    expect(screen.getByText("web")).toBeTruthy();
    expect(screen.getByText("nginx:1.27")).toBeTruthy();
    expect(screen.getByText(":80 :443")).toBeTruthy();
  });

  it("renders nothing when there are no containers", () => {
    const { container } = render(<ContainerCards containers={[]} />);
    expect(container.firstChild).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter web test -- ContainerCards`
Expected: FAIL — `Cannot find module './ContainerCards'`.

- [ ] **Step 3: Write the implementation**

Create `apps/web/src/panels/components/ContainerCards.tsx`:

```tsx
import { type ReactNode } from "react";
import { Box, Cpu, MemoryStick } from "lucide-react";

/** Minimal shape of a k8s container as it appears in a raw pod template spec. */
export interface RawContainer {
  name: string;
  image?: string;
  ports?: { containerPort?: number }[];
  resources?: {
    requests?: { cpu?: string; memory?: string };
    limits?: { cpu?: string; memory?: string };
  };
}

/** Summary of a single container for the expanded SPEC block. */
export interface ContainerSummary {
  name: string;
  image: string;
  ports: number[];
  cpuReq?: string;
  cpuLim?: string;
  memReq?: string;
  memLim?: string;
}

/** Map raw containers (from any workload's pod template) to display summaries. */
export function summarizeContainers(containers: RawContainer[] | undefined): ContainerSummary[] {
  return (containers ?? []).map((c) => ({
    name: c.name,
    image: c.image ?? "—",
    ports: (c.ports ?? []).map((p) => p.containerPort).filter((n): n is number => typeof n === "number"),
    cpuReq: c.resources?.requests?.cpu,
    cpuLim: c.resources?.limits?.cpu,
    memReq: c.resources?.requests?.memory,
    memLim: c.resources?.limits?.memory,
  }));
}

/** The per-container cards shown in a resource detail's SPEC block. */
export function ContainerCards({ containers }: { containers: ContainerSummary[] }) {
  if (containers.length === 0) return null;
  return (
    <div className="space-y-2">
      {containers.map((c) => (
        <div
          key={c.name}
          className="overflow-hidden rounded-md text-xs"
          style={{ background: "var(--surface-sunken)", border: "1px solid #26272B" }}
        >
          {/* Header strip: container name + ports */}
          <div
            className="flex items-center gap-2 px-2.5 py-1.5"
            style={{ background: "#101014", borderBottom: "1px solid #26272B" }}
          >
            <Box className="size-3 shrink-0 text-muted-foreground" />
            <span className="font-mono font-medium text-primary">{c.name}</span>
            {c.ports.length > 0 && (
              <span className="ml-auto font-mono text-[10px] text-muted-foreground">
                {c.ports.map((p) => `:${p}`).join(" ")}
              </span>
            )}
          </div>
          {/* Body: image + resource cells */}
          <div className="space-y-2 px-2.5 py-2">
            <div className="font-mono text-[11px] text-muted-foreground break-all">{c.image}</div>
            <div className="grid grid-cols-2 gap-1.5">
              <ResourceCell icon={<Cpu className="size-3 shrink-0 text-muted-foreground" />} label="CPU" req={c.cpuReq} lim={c.cpuLim} />
              <ResourceCell icon={<MemoryStick className="size-3 shrink-0 text-muted-foreground" />} label="MEM" req={c.memReq} lim={c.memLim} />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

/** A request/limit cell — icon + uppercase label, then `req → lim` in mono. */
function ResourceCell({
  icon,
  label,
  req,
  lim,
}: {
  icon: ReactNode;
  label: string;
  req?: string | null;
  lim?: string | null;
}) {
  return (
    <div
      className="flex items-center gap-2 rounded px-2 py-1"
      style={{ background: "var(--surface-sunken)", border: "1px solid #26272B" }}
    >
      {icon}
      <span className="text-[9px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">{label}</span>
      <span className="ml-auto font-mono text-[11px] text-foreground/90 tabular-nums">
        {req ?? "—"} <span className="text-muted-foreground">→</span> {lim ?? "—"}
      </span>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter web test -- ContainerCards`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/panels/components/ContainerCards.tsx apps/web/src/panels/components/ContainerCards.test.tsx
git commit -m "feat(web): shared ContainerCards + summarizeContainers"
```

---

## Task 2: Shared `Field` component

Extracts the label/value grid cell out of `DeploymentDetail`.

**Files:**
- Create: `apps/web/src/panels/components/Field.tsx`
- Create: `apps/web/src/panels/components/Field.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/panels/components/Field.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Field } from "./Field";

describe("Field", () => {
  it("renders label and value", () => {
    render(<Field label="Namespace">prod</Field>);
    expect(screen.getByText("Namespace")).toBeTruthy();
    expect(screen.getByText("prod")).toBeTruthy();
  });

  it("adds the full-width span class when span is set", () => {
    const { container } = render(<Field label="Selector" span>app=web</Field>);
    expect(container.querySelector(".col-span-2")).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter web test -- Field`
Expected: FAIL — `Cannot find module './Field'`.

- [ ] **Step 3: Write the implementation**

Create `apps/web/src/panels/components/Field.tsx`:

```tsx
import { type ReactNode } from "react";

/** One label/value row in a detail SPEC grid. `span` makes it full-width. */
export function Field({ label, span, children }: { label: string; span?: boolean; children: ReactNode }) {
  return (
    <div className={`flex gap-2 ${span ? "col-span-2" : ""}`}>
      <dt className="w-24 shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-all font-mono text-foreground/90">{children}</dd>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter web test -- Field`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/panels/components/Field.tsx apps/web/src/panels/components/Field.test.tsx
git commit -m "feat(web): shared Field detail-grid cell"
```

---

## Task 3: Refactor `DeploymentDetail` to consume the shared pieces

Make `DeploymentDetail` use the extracted `ContainerCards` / `Field`, and turn `deploymentDisplay.containerSummaries` into a thin wrapper over `summarizeContainers`. No visual change.

**Files:**
- Modify: `apps/web/src/panels/deployments/types.ts` (re-export `ContainerSummary`)
- Modify: `apps/web/src/panels/deployments/deploymentDisplay.ts:176-187` (wrapper)
- Modify: `apps/web/src/panels/deployments/DeploymentDetail.tsx` (use shared components)

- [ ] **Step 1: Re-export `ContainerSummary` from the shared module**

In `apps/web/src/panels/deployments/types.ts`, delete the local `ContainerSummary` interface (lines 81-90):

```ts
/** Summary of a single container for the expanded SPEC block. */
export interface ContainerSummary {
  name: string;
  image: string;
  ports: number[];
  cpuReq?: string;
  cpuLim?: string;
  memReq?: string;
  memLim?: string;
}
```

Replace it with a re-export:

```ts
export type { ContainerSummary } from "@/panels/components/ContainerCards";
```

- [ ] **Step 2: Make `containerSummaries` a wrapper**

In `apps/web/src/panels/deployments/deploymentDisplay.ts`, replace the body of `containerSummaries` (lines 175-187):

```ts
/** Per-container summaries for the expanded SPEC block. */
export function containerSummaries(d: Deployment): ContainerSummary[] {
  const containers = d.spec?.template?.spec?.containers ?? [];
  return containers.map((c) => ({
    name: c.name,
    image: c.image ?? "—",
    ports: (c.ports ?? []).map((p) => p.containerPort),
    cpuReq: c.resources?.requests?.cpu,
    cpuLim: c.resources?.limits?.cpu,
    memReq: c.resources?.requests?.memory,
    memLim: c.resources?.limits?.memory,
  }));
}
```

with:

```ts
/** Per-container summaries for the expanded SPEC block. */
export function containerSummaries(d: Deployment): ContainerSummary[] {
  return summarizeContainers(d.spec?.template?.spec?.containers);
}
```

Add the import near the top of the file (below the existing `import type { Deployment, ContainerSummary } from "./types";` line):

```ts
import { summarizeContainers } from "@/panels/components/ContainerCards";
```

- [ ] **Step 3: Use shared components in `DeploymentDetail`**

In `apps/web/src/panels/deployments/DeploymentDetail.tsx`:

(a) Update imports — replace the `lucide-react` import (line 2) and add the two shared components:

```tsx
import { GitBranch, ExternalLink } from "lucide-react";
import { ContainerCards } from "@/panels/components/ContainerCards";
import { Field } from "@/panels/components/Field";
```

(remove `Box, Cpu, MemoryStick` — they now live in `ContainerCards`; also remove the `type ReactNode` import if it is no longer referenced after step (d)).

(b) Replace the container-card block (lines 96-136, the `<div className="space-y-2 pt-1">…</div>` that maps `containers`) with:

```tsx
        <div className="pt-1">
          <ContainerCards containers={containers} />
        </div>
```

(c) Delete the local `Field` function (lines 207-215) and the local `ResourceCell` function (lines 217-246). Both are now imported / live in `ContainerCards`.

(d) Leave the `<Field …>` usages in the SPEC grid unchanged — they now resolve to the imported `Field`.

- [ ] **Step 4: Verify typecheck + tests + build**

Run: `pnpm --filter web typecheck`
Expected: PASS (no unused-import or missing-symbol errors).

Run: `pnpm --filter web test -- ContainerCards Field`
Expected: PASS.

Run: `pnpm --filter web build`
Expected: build succeeds.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/panels/deployments/types.ts apps/web/src/panels/deployments/deploymentDisplay.ts apps/web/src/panels/deployments/DeploymentDetail.tsx
git commit -m "refactor(web): DeploymentDetail uses shared ContainerCards + Field"
```

---

## Task 4: Extend workload types

Widen `workloads/types.ts` to type the fields the detail reads (currently the store delivers them at runtime but they are untyped). No `any`.

**Files:**
- Modify: `apps/web/src/panels/workloads/types.ts`

- [ ] **Step 1: Add the shared sub-shapes and widen each kind**

In `apps/web/src/panels/workloads/types.ts`:

(a) Add this import at the top (below the file's opening comment):

```ts
import type { RawContainer } from "@/panels/components/ContainerCards";
```

(b) Add `annotations` to `WorkloadMeta`:

```ts
export interface WorkloadMeta {
  name: string;
  namespace?: string;
  uid?: string;
  creationTimestamp?: string; // ISO 8601
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
}
```

(c) Add shared sub-shapes (place after `WorkloadMeta`):

```ts
/** Pod template embedded in a workload spec. */
export interface PodTemplateSpec {
  metadata?: { labels?: Record<string, string> };
  spec?: {
    containers?: RawContainer[];
    nodeSelector?: Record<string, string>;
  };
}
export interface LabelSelector {
  matchLabels?: Record<string, string>;
}
export interface UpdateStrategy {
  type?: string;
}
```

(d) Replace `StatefulSetSpec` with:

```ts
export interface VolumeClaimTemplate {
  metadata?: { name?: string };
  spec?: {
    storageClassName?: string;
    resources?: { requests?: { storage?: string } };
  };
}

export interface StatefulSetSpec {
  replicas?: number;
  serviceName?: string;
  selector?: LabelSelector;
  updateStrategy?: UpdateStrategy;
  template?: PodTemplateSpec;
  volumeClaimTemplates?: VolumeClaimTemplate[];
}
```

(e) Replace the DaemonSet block (`DaemonSetStatus` + `DaemonSet`) with:

```ts
export interface DaemonSetSpec {
  selector?: LabelSelector;
  updateStrategy?: UpdateStrategy;
  template?: PodTemplateSpec;
}

export interface DaemonSetStatus {
  numberReady?: number;
  desiredNumberScheduled?: number;
  numberAvailable?: number;
  updatedNumberScheduled?: number;
}

export interface DaemonSet {
  metadata: WorkloadMeta;
  spec?: DaemonSetSpec;
  status?: DaemonSetStatus;
}
```

(f) Replace the Job block (`JobCondition` + `JobSpec` + `JobStatus`) with:

```ts
export interface JobCondition {
  type?: string;
  status?: string;
  reason?: string;
  message?: string;
}

export interface JobSpec {
  completions?: number;
  parallelism?: number;
  backoffLimit?: number;
  suspend?: boolean;
  selector?: LabelSelector;
  template?: PodTemplateSpec;
}

export interface JobStatus {
  active?: number;
  succeeded?: number;
  failed?: number;
  startTime?: string; // ISO 8601
  completionTime?: string; // ISO 8601
  conditions?: JobCondition[];
}
```

(g) Replace the CronJob block (`CronJobSpec` + `CronJobStatus`) with:

```ts
export interface ActiveObjectRef {
  name?: string;
  namespace?: string;
  uid?: string;
}

export interface CronJobSpec {
  schedule?: string;
  suspend?: boolean;
  concurrencyPolicy?: string;
  successfulJobsHistoryLimit?: number;
  failedJobsHistoryLimit?: number;
  jobTemplate?: { spec?: JobSpec };
}

export interface CronJobStatus {
  active?: ActiveObjectRef[];
  lastScheduleTime?: string; // ISO 8601
}
```

- [ ] **Step 2: Verify typecheck**

Run: `pnpm --filter web typecheck`
Expected: PASS. (Existing helpers read only pre-existing fields, so nothing breaks; `cronJobActiveCount` still reads `status.active?.length` which now types `active` as `ActiveObjectRef[]`.)

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/panels/workloads/types.ts
git commit -m "feat(web): widen workload types for the detail view"
```

---

## Task 5: Workload detail display helpers

Pure, unit-tested helpers that feed `WorkloadDetail`: per-kind spec fields, containers, volume-claim templates, job conditions, cronjob active job names, selector/strategy formatting.

**Files:**
- Modify: `apps/web/src/panels/workloads/workloadsDisplay.ts`
- Modify: `apps/web/src/panels/workloads/workloads.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `apps/web/src/panels/workloads/workloads.test.ts` (the file already imports `describe/expect/test` from vitest, `Job`/`CronJob` types, and defines `NOW`, `job()`, `cron()` helpers — reuse them; add the new imports to the existing import block from `./workloadsDisplay`):

```ts
import {
  formatSelector,
  workloadUpdateStrategy,
  workloadContainers,
  volumeClaimTemplateSummaries,
  jobConditionSummaries,
  cronJobActiveNames,
  workloadSpecFields,
} from "./workloadsDisplay";
import type { StatefulSet, DaemonSet } from "./types";

describe("formatSelector", () => {
  test("joins sorted matchLabels", () => {
    expect(formatSelector({ tier: "web", app: "x" })).toBe("app=x,tier=web");
  });
  test("returns a dash when empty or undefined", () => {
    expect(formatSelector({})).toBe("—");
    expect(formatSelector(undefined)).toBe("—");
  });
});

describe("workloadUpdateStrategy", () => {
  test("reads spec.updateStrategy.type, defaulting to RollingUpdate", () => {
    expect(workloadUpdateStrategy({ metadata: { name: "s" }, spec: { updateStrategy: { type: "OnDelete" } } } as StatefulSet)).toBe("OnDelete");
    expect(workloadUpdateStrategy({ metadata: { name: "s" } } as StatefulSet)).toBe("RollingUpdate");
  });
});

describe("workloadContainers", () => {
  test("reads spec.template for sts/ds/job", () => {
    const j = job({ spec: { template: { spec: { containers: [{ name: "c", image: "busybox" }] } } } });
    expect(workloadContainers(j, "jobs")).toEqual([{ name: "c", image: "busybox" }]);
  });
  test("reads spec.jobTemplate.spec.template for cronjobs", () => {
    const c = cron({ spec: { jobTemplate: { spec: { template: { spec: { containers: [{ name: "cj", image: "alpine" }] } } } } } });
    expect(workloadContainers(c, "cronjobs")).toEqual([{ name: "cj", image: "alpine" }]);
  });
  test("returns an empty array when there is no template", () => {
    expect(workloadContainers(job(), "jobs")).toEqual([]);
  });
});

describe("volumeClaimTemplateSummaries", () => {
  test("summarizes name / storage / storageClass", () => {
    const sts = { metadata: { name: "db" }, spec: { volumeClaimTemplates: [
      { metadata: { name: "data" }, spec: { storageClassName: "fast", resources: { requests: { storage: "10Gi" } } } },
    ] } } as StatefulSet;
    expect(volumeClaimTemplateSummaries(sts)).toEqual([{ name: "data", storage: "10Gi", storageClass: "fast" }]);
  });
  test("returns an empty array when absent", () => {
    expect(volumeClaimTemplateSummaries({ metadata: { name: "db" } } as StatefulSet)).toEqual([]);
  });
});

describe("jobConditionSummaries", () => {
  test("maps conditions with reason/message", () => {
    const j = job({ status: { conditions: [{ type: "Failed", status: "True", reason: "BackoffLimitExceeded", message: "too many retries" }] } });
    expect(jobConditionSummaries(j)).toEqual([{ type: "Failed", status: "True", reason: "BackoffLimitExceeded", message: "too many retries" }]);
  });
  test("returns an empty array when there are no conditions", () => {
    expect(jobConditionSummaries(job())).toEqual([]);
  });
});

describe("cronJobActiveNames", () => {
  test("extracts names of active job refs", () => {
    const c = cron({ status: { active: [{ name: "run-1" }, { name: "run-2" }, {}] } });
    expect(cronJobActiveNames(c)).toEqual(["run-1", "run-2"]);
  });
});

describe("workloadSpecFields", () => {
  test("statefulset fields", () => {
    const sts = { metadata: { name: "db", namespace: "prod", creationTimestamp: undefined }, spec: { replicas: 3, serviceName: "db-svc", selector: { matchLabels: { app: "db" } } }, status: { readyReplicas: 2 } } as StatefulSet;
    const f = workloadSpecFields(sts, "statefulsets", NOW);
    expect(f.find((x) => x.label === "Replicas")?.value).toBe("3");
    expect(f.find((x) => x.label === "Ready")?.value).toBe("2/3");
    expect(f.find((x) => x.label === "Service")?.value).toBe("db-svc");
    expect(f.find((x) => x.label === "Selector")?.value).toBe("app=db");
  });
  test("daemonset fields", () => {
    const ds = { metadata: { name: "cni", namespace: "kube-system" }, status: { numberReady: 4, desiredNumberScheduled: 5, numberAvailable: 4, updatedNumberScheduled: 5 } } as DaemonSet;
    const f = workloadSpecFields(ds, "daemonsets", NOW);
    expect(f.find((x) => x.label === "Desired")?.value).toBe("5");
    expect(f.find((x) => x.label === "Available")?.value).toBe("4");
  });
  test("job fields include status, completions and duration", () => {
    const j = job({ status: { succeeded: 1, startTime: new Date(NOW - 60_000).toISOString(), completionTime: new Date(NOW).toISOString(), conditions: [{ type: "Complete", status: "True" }] }, spec: { completions: 1 } });
    const f = workloadSpecFields(j, "jobs", NOW);
    expect(f.find((x) => x.label === "Status")?.value).toBe("Complete");
    expect(f.find((x) => x.label === "Completions")?.value).toBe("1/1");
    expect(f.find((x) => x.label === "Duration")?.value).toBe("1m");
  });
  test("cronjob fields include schedule and concurrency", () => {
    const c = cron({ spec: { schedule: "*/5 * * * *", concurrencyPolicy: "Forbid" } });
    const f = workloadSpecFields(c, "cronjobs", NOW);
    expect(f.find((x) => x.label === "Schedule")?.value).toBe("*/5 * * * *");
    expect(f.find((x) => x.label === "Concurrency")?.value).toBe("Forbid");
    expect(f.find((x) => x.label === "Last schedule")?.value).toBe("Never");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter web test -- workloads.test`
Expected: FAIL — `formatSelector` / `workloadSpecFields` (etc.) are not exported.

- [ ] **Step 3: Write the implementation**

Append to `apps/web/src/panels/workloads/workloadsDisplay.ts`. First add the type imports to the existing top import block:

```ts
import type {
  StatefulSet,
  DaemonSet,
  Job,
  CronJob,
  Workload,
  WorkloadKind,
} from "./types";
import type { RawContainer } from "@/panels/components/ContainerCards";
```

Then append these functions at the end of the file:

```ts
// --- Detail helpers --------------------------------------------------------

/** "app=web,tier=frontend" from matchLabels sorted by key. "—" when empty. */
export function formatSelector(matchLabels: Record<string, string> | undefined): string {
  const keys = Object.keys(matchLabels ?? {}).sort();
  if (keys.length === 0) return "—";
  return keys.map((k) => `${k}=${matchLabels![k]}`).join(",");
}

/** Update-strategy type for a StatefulSet/DaemonSet, defaulting to RollingUpdate. */
export function workloadUpdateStrategy(workload: StatefulSet | DaemonSet): string {
  return workload.spec?.updateStrategy?.type ?? "RollingUpdate";
}

/** The pod-template containers for a workload (jobTemplate path for cronjobs). */
export function workloadContainers(workload: Workload, kind: WorkloadKind): RawContainer[] {
  if (kind === "cronjobs") {
    return (workload as CronJob).spec?.jobTemplate?.spec?.template?.spec?.containers ?? [];
  }
  return (workload as StatefulSet | DaemonSet | Job).spec?.template?.spec?.containers ?? [];
}

export interface VolumeClaimSummary {
  name: string;
  storage: string;
  storageClass: string;
}

/** Summaries of a StatefulSet's volumeClaimTemplates. */
export function volumeClaimTemplateSummaries(sts: StatefulSet): VolumeClaimSummary[] {
  return (sts.spec?.volumeClaimTemplates ?? []).map((v) => ({
    name: v.metadata?.name ?? "—",
    storage: v.spec?.resources?.requests?.storage ?? "—",
    storageClass: v.spec?.storageClassName ?? "—",
  }));
}

export interface JobConditionSummary {
  type: string;
  status: string;
  reason?: string;
  message?: string;
}

/** A Job's status conditions, normalized for display. */
export function jobConditionSummaries(job: Job): JobConditionSummary[] {
  return (job.status?.conditions ?? []).map((c) => ({
    type: c.type ?? "—",
    status: c.status ?? "—",
    reason: c.reason,
    message: c.message,
  }));
}

/** Names of a CronJob's currently-active jobs. */
export function cronJobActiveNames(cronJob: CronJob): string[] {
  return (cronJob.status?.active ?? []).map((a) => a?.name).filter((n): n is string => !!n);
}

/** One label/value pair in the detail SPEC grid. */
export interface SpecField {
  label: string;
  value: string;
}

/** Per-kind SPEC grid fields for the expanded workload detail. */
export function workloadSpecFields(workload: Workload, kind: WorkloadKind, now: number = Date.now()): SpecField[] {
  const base: SpecField[] = [
    { label: "Namespace", value: workload.metadata.namespace ?? "default" },
    { label: "Age", value: relativeAge(workload.metadata.creationTimestamp, now) },
  ];
  switch (kind) {
    case "statefulsets": {
      const s = workload as StatefulSet;
      return [
        ...base,
        { label: "Replicas", value: String(statefulSetDesired(s)) },
        { label: "Ready", value: readyFraction(statefulSetReady(s), statefulSetDesired(s)) },
        { label: "Service", value: s.spec?.serviceName ?? "—" },
        { label: "Strategy", value: workloadUpdateStrategy(s) },
        { label: "Selector", value: formatSelector(s.spec?.selector?.matchLabels) },
      ];
    }
    case "daemonsets": {
      const d = workload as DaemonSet;
      return [
        ...base,
        { label: "Desired", value: String(daemonSetDesired(d)) },
        { label: "Ready", value: String(daemonSetReady(d)) },
        { label: "Available", value: String(d.status?.numberAvailable ?? 0) },
        { label: "Up-to-date", value: String(d.status?.updatedNumberScheduled ?? 0) },
        { label: "Node selector", value: formatSelector(d.spec?.template?.spec?.nodeSelector) },
        { label: "Strategy", value: workloadUpdateStrategy(d) },
        { label: "Selector", value: formatSelector(d.spec?.selector?.matchLabels) },
      ];
    }
    case "jobs": {
      const j = workload as Job;
      return [
        ...base,
        { label: "Status", value: jobPhase(j) },
        { label: "Completions", value: jobCompletionsLabel(j) },
        { label: "Parallelism", value: String(j.spec?.parallelism ?? 1) },
        { label: "Succeeded", value: String(j.status?.succeeded ?? 0) },
        { label: "Failed", value: String(j.status?.failed ?? 0) },
        { label: "Started", value: j.status?.startTime ? relativeAge(j.status.startTime, now) : "—" },
        { label: "Completed", value: j.status?.completionTime ? relativeAge(j.status.completionTime, now) : "—" },
        { label: "Duration", value: jobDuration(j, now) ?? "—" },
        { label: "Backoff limit", value: String(j.spec?.backoffLimit ?? 6) },
      ];
    }
    case "cronjobs": {
      const c = workload as CronJob;
      return [
        ...base,
        { label: "Schedule", value: c.spec?.schedule ?? "—" },
        { label: "Suspend", value: isCronJobSuspended(c) ? "Yes" : "No" },
        { label: "Concurrency", value: c.spec?.concurrencyPolicy ?? "Allow" },
        { label: "Last schedule", value: lastScheduleAgo(c, now) ?? "Never" },
        { label: "Active", value: String(cronJobActiveCount(c)) },
        { label: "History (ok/fail)", value: `${c.spec?.successfulJobsHistoryLimit ?? 3}/${c.spec?.failedJobsHistoryLimit ?? 1}` },
      ];
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter web test -- workloads.test`
Expected: PASS (existing + new tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/panels/workloads/workloadsDisplay.ts apps/web/src/panels/workloads/workloads.test.ts
git commit -m "feat(web): workload detail display helpers"
```

---

## Task 6: Extend `relatedResources` for Jobs and CronJobs

Add owner-reference-based resolution: Job → its pods (+ configmaps/secrets from the pod template), CronJob → its jobs.

**Files:**
- Modify: `apps/web/src/lib/relatedResources.ts`
- Modify: `apps/web/src/lib/relatedResources.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `apps/web/src/lib/relatedResources.test.ts` (reuse the existing `store()` helper defined at the top of the file):

```ts
describe("relatedKindsFor — jobs & cronjobs", () => {
  it("job resolves pods + config kinds", () => {
    expect(relatedKindsFor("job")).toEqual(["pods", "configmaps", "secrets", "persistentvolumeclaims"]);
  });
  it("cronjob resolves jobs", () => {
    expect(relatedKindsFor("cronjob")).toEqual(["jobs"]);
  });
});

describe("computeRelated — job", () => {
  const jobObj = {
    metadata: { name: "backup", namespace: "prod", uid: "j1" },
    spec: { template: { spec: { containers: [{ envFrom: [{ secretRef: { name: "backup-creds" } }] }] } } },
  };
  it("finds pods owned by the job and secrets from its template", () => {
    const podA = { metadata: { name: "backup-abc", namespace: "prod", uid: "p1", ownerReferences: [{ uid: "j1", kind: "Job" }] }, spec: { containers: [] }, status: { phase: "Succeeded", containerStatuses: [{ ready: true }] } };
    const podB = { metadata: { name: "other-xyz", namespace: "prod", uid: "p2", ownerReferences: [{ uid: "zzz" }] }, spec: { containers: [] }, status: { phase: "Running" } };
    const groups = computeRelated("job", jobObj, store({ pods: [podA, podB], secrets: [{ metadata: { name: "backup-creds", namespace: "prod", uid: "s1" } }] }));
    const pods = groups.find((g) => g.kind === "pods");
    expect(pods?.items.map((i) => i.name)).toEqual(["backup-abc"]);
    const secrets = groups.find((g) => g.kind === "secrets");
    expect(secrets?.items.map((i) => i.name)).toEqual(["backup-creds"]);
  });
});

describe("computeRelated — cronjob", () => {
  const cronObj = { metadata: { name: "nightly", namespace: "prod", uid: "cj1" } };
  it("finds jobs owned by the cronjob", () => {
    const jobA = { metadata: { name: "nightly-1", namespace: "prod", uid: "j1", ownerReferences: [{ uid: "cj1", kind: "CronJob" }] } };
    const jobB = { metadata: { name: "unrelated", namespace: "prod", uid: "j2", ownerReferences: [{ uid: "other" }] } };
    const groups = computeRelated("cronjob", cronObj, store({ jobs: [jobA, jobB] }));
    const jobs = groups.find((g) => g.kind === "jobs");
    expect(jobs?.items.map((i) => i.name)).toEqual(["nightly-1"]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter web test -- relatedResources.test`
Expected: FAIL — `relatedKindsFor("job")` returns `[]`; the job/cronjob groups are empty.

- [ ] **Step 3: Write the implementation**

In `apps/web/src/lib/relatedResources.ts`:

(a) Add a `jobs` entry to `GROUP_META` (after the `daemonsets` line):

```ts
  jobs: { label: "Jobs", icon: "layers" },
```

(b) Add an owner-reference helper next to `sameNs` (after line 95):

```ts
function ownedByUid(child: Obj, uid: string | undefined): boolean {
  if (!uid) return false;
  return (child?.metadata?.ownerReferences ?? []).some((r: Obj) => r?.uid === uid);
}
```

(c) Extend `relatedKindsFor` — add these cases before `default:` (after the `case "service":` block):

```ts
    case "job":
      return ["pods", "configmaps", "secrets", "persistentvolumeclaims"];
    case "cronjob":
      return ["jobs"];
```

(d) Extend `computeRelated` — add these branches inside the `if/else if` chain, before the final `return groups.filter(...)` (i.e. after the `sourceKind === "service"` branch):

```ts
  } else if (sourceKind === "job") {
    const uid = source?.metadata?.uid;
    groups.push(group("pods", values(store.pods)
      .filter((p) => sameNs(p, n) && ownedByUid(p, uid))
      .map((p) => ({ ...refFromObj("pods", p, podStatus(p)), node: p?.spec?.nodeName }))));
    const refs = podRefs(source?.spec?.template?.spec);
    groups.push(group("configmaps", refsByName("configmaps", refs.configmaps, n, store.configmaps)));
    groups.push(group("secrets", refsByName("secrets", refs.secrets, n, store.secrets)));
    groups.push(group("persistentvolumeclaims", refsByName("persistentvolumeclaims", refs.pvcs, n, store.persistentvolumeclaims)));
  } else if (sourceKind === "cronjob") {
    const uid = source?.metadata?.uid;
    groups.push(group("jobs", values(store.jobs)
      .filter((j) => sameNs(j, n) && ownedByUid(j, uid))
      .map((j) => refFromObj("jobs", j))));
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter web test -- relatedResources.test`
Expected: PASS (existing + new tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/relatedResources.ts apps/web/src/lib/relatedResources.test.ts
git commit -m "feat(web): relatedResources supports jobs and cronjobs"
```

---

## Task 7: `WorkloadDetail` component

The shared expanded-detail view rendered in every workload row's drop-down.

**Files:**
- Create: `apps/web/src/panels/workloads/WorkloadDetail.tsx`
- Create: `apps/web/src/panels/workloads/WorkloadDetail.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/panels/workloads/WorkloadDetail.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";

vi.mock("@/lib/ws", () => ({ subscribe: vi.fn(), unsubscribe: vi.fn() }));

import { WorkloadDetail } from "./WorkloadDetail";
import { useCluster } from "@/store/cluster";
import type { StatefulSet, CronJob } from "./types";

beforeEach(() => {
  useCluster.setState({ resources: {} });
});

function renderDetail(ui: React.ReactElement) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

describe("WorkloadDetail", () => {
  it("renders StatefulSet spec fields, container cards and volume claim templates", () => {
    const sts: StatefulSet = {
      metadata: { name: "db", namespace: "prod", uid: "s1", labels: { app: "db" } },
      spec: {
        replicas: 3,
        serviceName: "db-svc",
        selector: { matchLabels: { app: "db" } },
        template: { spec: { containers: [{ name: "postgres", image: "postgres:16" }] } },
        volumeClaimTemplates: [{ metadata: { name: "data" }, spec: { storageClassName: "fast", resources: { requests: { storage: "10Gi" } } } }],
      },
      status: { readyReplicas: 3, replicas: 3 },
    };
    renderDetail(<WorkloadDetail workload={sts} kind="statefulsets" />);
    expect(screen.getByText("db-svc")).toBeTruthy();
    expect(screen.getByText("postgres:16")).toBeTruthy();
    expect(screen.getByText("Volume Claim Templates")).toBeTruthy();
    expect(screen.getByText("data")).toBeTruthy();
  });

  it("renders CronJob active jobs", () => {
    const cron: CronJob = {
      metadata: { name: "nightly", namespace: "prod", uid: "c1" },
      spec: { schedule: "0 0 * * *", jobTemplate: { spec: { template: { spec: { containers: [{ name: "runner", image: "alpine" }] } } } } },
      status: { active: [{ name: "nightly-123" }] },
    };
    renderDetail(<WorkloadDetail workload={cron} kind="cronjobs" />);
    expect(screen.getByText("0 0 * * *")).toBeTruthy();
    expect(screen.getByText("Active Jobs")).toBeTruthy();
    expect(screen.getByText("nightly-123")).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter web test -- WorkloadDetail`
Expected: FAIL — `Cannot find module './WorkloadDetail'`.

- [ ] **Step 3: Write the implementation**

Create `apps/web/src/panels/workloads/WorkloadDetail.tsx`:

```tsx
import { ContainerCards, summarizeContainers } from "@/panels/components/ContainerCards";
import { Field } from "@/panels/components/Field";
import { SectionCard } from "@/panels/components/SectionCard";
import { MetaChips } from "@/panels/components/MetaChips";
import { RelatedResources } from "@/panels/components/RelatedResources";
import {
  workloadSpecFields,
  workloadContainers,
  volumeClaimTemplateSummaries,
  jobConditionSummaries,
  cronJobActiveNames,
} from "./workloadsDisplay";
import type { Workload, WorkloadKind, StatefulSet, Job, CronJob } from "./types";

/** Store (plural) kind → singular sourceKind expected by RelatedResources. */
const SINGULAR: Record<WorkloadKind, string> = {
  statefulsets: "statefulset",
  daemonsets: "daemonset",
  jobs: "job",
  cronjobs: "cronjob",
};

/** Expanded detail for one workload row (all four kinds). */
export function WorkloadDetail({ workload, kind }: { workload: Workload; kind: WorkloadKind }) {
  const fields = workloadSpecFields(workload, kind);
  const containers = summarizeContainers(workloadContainers(workload, kind));

  return (
    <div className="space-y-4">
      {/* SPEC */}
      <div className="space-y-2">
        <h3 className="text-[9px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">Spec</h3>
        <dl className="grid max-w-3xl grid-cols-2 gap-x-6 gap-y-1.5 text-xs">
          {fields.map((f) => (
            <Field key={f.label} label={f.label}>{f.value}</Field>
          ))}
        </dl>
        {containers.length > 0 && (
          <div className="pt-1">
            <ContainerCards containers={containers} />
          </div>
        )}
      </div>

      {kind === "statefulsets" && <VolumeClaimTemplates sts={workload as StatefulSet} />}
      {kind === "jobs" && <JobConditions job={workload as Job} />}
      {kind === "cronjobs" && <ActiveJobs cron={workload as CronJob} />}

      <MetaChips title="Labels" entries={workload.metadata.labels} />
      <MetaChips title="Annotations" entries={workload.metadata.annotations} />

      <RelatedResources sourceKind={SINGULAR[kind]} source={workload as Record<string, unknown>} />
    </div>
  );
}

function VolumeClaimTemplates({ sts }: { sts: StatefulSet }) {
  const vcts = volumeClaimTemplateSummaries(sts);
  if (vcts.length === 0) return null;
  return (
    <SectionCard title="Volume Claim Templates" count={vcts.length}>
      <div className="flex flex-col gap-1.5">
        {vcts.map((v) => (
          <div key={v.name} className="flex flex-wrap items-center gap-2 font-mono text-[11px] text-muted-foreground">
            <span className="text-foreground/90">{v.name}</span>
            <span>·</span>
            <span>{v.storage}</span>
            <span>·</span>
            <span>{v.storageClass}</span>
          </div>
        ))}
      </div>
    </SectionCard>
  );
}

function JobConditions({ job }: { job: Job }) {
  const conds = jobConditionSummaries(job);
  if (conds.length === 0) return null;
  return (
    <SectionCard title="Conditions" count={conds.length}>
      <div className="flex flex-col gap-1.5">
        {conds.map((c, i) => (
          <div key={`${c.type}-${i}`} className="flex flex-wrap items-center gap-2 text-[11px]">
            <span className="font-mono text-foreground/90">{c.type}={c.status}</span>
            {c.reason && <span className="text-muted-foreground">{c.reason}</span>}
            {c.message && <span className="text-muted-foreground">{c.message}</span>}
          </div>
        ))}
      </div>
    </SectionCard>
  );
}

function ActiveJobs({ cron }: { cron: CronJob }) {
  const names = cronJobActiveNames(cron);
  if (names.length === 0) return null;
  return (
    <SectionCard title="Active Jobs" count={names.length}>
      <div className="flex flex-col gap-1">
        {names.map((n) => (
          <span key={n} className="font-mono text-[11px] text-muted-foreground">{n}</span>
        ))}
      </div>
    </SectionCard>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter web test -- WorkloadDetail`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/panels/workloads/WorkloadDetail.tsx apps/web/src/panels/workloads/WorkloadDetail.test.tsx
git commit -m "feat(web): WorkloadDetail expanded row view"
```

---

## Task 8: Wire `expandedContent` into the four workload rows

Each `*Row` renders `<WorkloadDetail>` in its `ListRow` drop-down.

**Files:**
- Modify: `apps/web/src/panels/workloads/StatefulSetRow.tsx:40`
- Modify: `apps/web/src/panels/workloads/DaemonSetRow.tsx:38`
- Modify: `apps/web/src/panels/workloads/JobRow.tsx:34`
- Modify: `apps/web/src/panels/workloads/CronJobRow.tsx:46`
- Modify: `apps/web/src/panels/workloads/workloads.test.ts` (row wiring smoke — new jsdom test file, see note)

- [ ] **Step 1: Add the `expandedContent` prop to each row**

In each file, add the import and pass `expandedContent` to the `ListRow`.

`StatefulSetRow.tsx` — add import after line 1, and edit the `ListRow` open tag (line 40):

```tsx
import { WorkloadDetail } from "./WorkloadDetail";
```

```tsx
    <ListRow
      rowKey={k}
      isOpen={isOpen}
      onToggle={() => toggleExpand(k)}
      contextMenu={rowMenu}
      expandedContent={<WorkloadDetail workload={s} kind="statefulsets" />}
    >
```

`DaemonSetRow.tsx` — add the import and edit the `ListRow` (line 38):

```tsx
import { WorkloadDetail } from "./WorkloadDetail";
```

```tsx
    <ListRow
      rowKey={k}
      isOpen={isOpen}
      onToggle={() => toggleExpand(k)}
      contextMenu={rowMenu}
      expandedContent={<WorkloadDetail workload={d} kind="daemonsets" />}
    >
```

`JobRow.tsx` — add the import and edit the `ListRow` (line 34):

```tsx
import { WorkloadDetail } from "./WorkloadDetail";
```

```tsx
    <ListRow
      rowKey={k}
      isOpen={isOpen}
      onToggle={() => toggleExpand(k)}
      contextMenu={rowMenu}
      expandedContent={<WorkloadDetail workload={j} kind="jobs" />}
    >
```

`CronJobRow.tsx` — add the import and edit the `ListRow` (line 46):

```tsx
import { WorkloadDetail } from "./WorkloadDetail";
```

```tsx
    <ListRow
      rowKey={k}
      isOpen={isOpen}
      onToggle={() => toggleExpand(k)}
      contextMenu={rowMenu}
      expandedContent={<WorkloadDetail workload={c} kind="cronjobs" />}
    >
```

- [ ] **Step 2: Write a row-wiring smoke test**

Create `apps/web/src/panels/workloads/StatefulSetRow.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";

vi.mock("@/lib/ws", () => ({ subscribe: vi.fn(), unsubscribe: vi.fn() }));

import { StatefulSetRow } from "./StatefulSetRow";
import { useCluster } from "@/store/cluster";
import type { StatefulSet } from "./types";

beforeEach(() => useCluster.setState({ resources: {} }));

const sts: StatefulSet = {
  metadata: { name: "db", namespace: "prod", uid: "s1" },
  spec: { replicas: 1, serviceName: "db-svc", template: { spec: { containers: [{ name: "pg", image: "postgres:16" }] } } },
  status: { readyReplicas: 1, replicas: 1 },
};

const noop = vi.fn();

function row(isOpen: boolean) {
  return render(
    <MemoryRouter>
      <StatefulSetRow s={sts} k="prod/db" isOpen={isOpen} toggleExpand={noop} askClaude={noop} restartStatefulSet={noop} openScale={noop} deleteStatefulSet={noop} />
    </MemoryRouter>,
  );
}

describe("StatefulSetRow expandedContent", () => {
  it("shows the detail when open", () => {
    row(true);
    expect(screen.getByText("db-svc")).toBeTruthy();
    expect(screen.getByText("postgres:16")).toBeTruthy();
  });

  it("hides the detail when collapsed", () => {
    row(false);
    expect(screen.queryByText("db-svc")).toBeNull();
  });
});
```

- [ ] **Step 3: Run the row + detail tests**

Run: `pnpm --filter web test -- StatefulSetRow WorkloadDetail`
Expected: PASS.

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter web typecheck`
Expected: PASS (all four rows compile; `WorkloadDetail` accepts the narrowed row types via the `Workload` union).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/panels/workloads/StatefulSetRow.tsx apps/web/src/panels/workloads/DaemonSetRow.tsx apps/web/src/panels/workloads/JobRow.tsx apps/web/src/panels/workloads/CronJobRow.tsx apps/web/src/panels/workloads/StatefulSetRow.test.tsx
git commit -m "feat(web): workload rows render WorkloadDetail in the drop-down"
```

---

## Task 9: Full verification gates

**Files:** none (verification only).

- [ ] **Step 1: Typecheck the whole web package**

Run: `pnpm --filter web typecheck`
Expected: PASS, zero errors.

- [ ] **Step 2: Run the whole web test suite**

Run: `pnpm --filter web test`
Expected: PASS — all suites green (the pre-existing ~930 tests plus the new `ContainerCards`, `Field`, `workloads`, `relatedResources`, `WorkloadDetail`, `StatefulSetRow` cases).

- [ ] **Step 3: Build**

Run: `pnpm --filter web build`
Expected: build succeeds with no errors.

- [ ] **Step 4: Manual smoke (optional, when a cluster is connected)**

In the desktop app (`pnpm --filter desktop dev`), open the Workloads panel, switch across all four tabs, expand a row of each kind, and confirm the drop-down shows the SPEC grid, container cards, kind-specific section, labels/annotations, and Related resources. (Do NOT start the web dev server for verification.)

- [ ] **Step 5: Final commit (if any lint fixups were needed)**

```bash
git add -A
git commit -m "chore(web): workloads row detail — verification fixups" || echo "nothing to commit"
```

---

## Self-Review notes

- **Spec coverage:** SPEC grid + container cards + kind-specific extras + labels/annotations + Related resources → Tasks 5/7; volumeClaimTemplates (sts), conditions (job), active jobs (cronjob) → Task 7; relatedResources job/cronjob → Task 6; type widening → Task 4; row wiring → Task 8; shared reuse (ContainerCards/Field, generalized containerSummaries) → Tasks 1-3; testing gates → Task 9. All spec sections mapped.
- **Type consistency:** `summarizeContainers`, `ContainerSummary`, `RawContainer` (Task 1) are imported unchanged in Tasks 3/4/5/7. `workloadSpecFields`/`workloadContainers`/`volumeClaimTemplateSummaries`/`jobConditionSummaries`/`cronJobActiveNames` defined in Task 5 are consumed with identical names in Task 7. `SINGULAR` maps plural `WorkloadKind` → the singular `sourceKind` strings added to `relatedResources.ts` in Task 6 (`job`, `cronjob`).
- **Styling:** new markup in Task 7 (VolumeClaimTemplates/JobConditions/ActiveJobs) uses Tailwind utilities + token classes only; existing inline-hex lives only in the verbatim-extracted `ContainerCards` and reused `SectionCard`/`MetaChips`.
- **No placeholders:** every code step has complete code; every run step has an exact command + expected result.
