# Reliability Audit Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the first HELM-20 "audit skill" — a Reliability / SRE audit whose detection is a deterministic engine and whose findings are presented in the assistant chat with confirm-gated fix buttons, launched from a new "Audits" tab.

**Architecture:** A pure rules engine in `packages/k8s/src/reliabilityAudit.ts` takes normalized workload/PDB/HPA inputs and returns typed `ReliabilityFinding[]` (8 checks). A web hook (`useReliabilityAudit`) subscribes to the relevant watch kinds, adapts the live Zustand store objects into engine inputs, and runs the engine. A new "Audits" tab in the Assistant panel lists audit skills; the Reliability card's **Run** button builds a findings-seeded prompt and calls `handoffToChat(prompt, { newThread: true })`, so Rigel presents the findings grouped by severity and emits `action` blocks (which render as the existing confirm-gated fix buttons). No server changes; no new mutation surface; no gating.

**Tech Stack:** TypeScript, React 19 + Vite, Zustand store (`@/store/cluster`), shared `@rigel/k8s` package, vitest. Tailwind v4 with `var(--…)` design tokens.

---

## File structure

**New files**
- `packages/k8s/src/reliabilityAudit.ts` — pure engine (types + `analyzeReliability` + helpers).
- `packages/k8s/src/reliabilityAudit.test.ts` — engine unit tests.
- `apps/web/src/panels/assistant/audits/extractAuditInputs.ts` — store-object → engine-input adapter.
- `apps/web/src/panels/assistant/audits/extractAuditInputs.test.ts`
- `apps/web/src/panels/assistant/audits/useReliabilityAudit.ts` — hook (subscribe + run engine + counts).
- `apps/web/src/panels/assistant/audits/useReliabilityAudit.test.ts`
- `apps/web/src/panels/assistant/audits/auditPrompt.ts` — `buildReliabilityAuditPrompt`.
- `apps/web/src/panels/assistant/audits/auditPrompt.test.ts`
- `apps/web/src/panels/assistant/audits/AuditSkillCard.tsx` — launcher card (live / coming-soon).
- `apps/web/src/panels/assistant/tabs/AuditSkillsTab.tsx` — the tab body.
- `apps/web/src/panels/assistant/tabs/AuditSkillsTab.test.tsx`

**Edited files**
- `packages/k8s/src/index.ts` — barrel-export the engine.
- `apps/web/src/panels/assistant/AssistantContext.tsx:34` — add `"audits"` to `TabKey`.
- `apps/web/src/panels/assistant/components/TabBar.tsx:40-49` — add the tab entry.
- `apps/web/src/panels/assistant/components/TabContent.tsx` — import + `case "audits"`.

**No server changes.** The workload/PDB/HPA watches are client subscriptions; `WatchManager` runs `kubectl get <kind>` for any kind with no allowlist, so `subscribe("poddisruptionbudgets", "*")` and `subscribe("horizontalpodautoscalers", "*")` work like the existing `deployments` watch.

---

## Task 1: Engine scaffolding — types + empty `analyzeReliability`

**Files:**
- Create: `packages/k8s/src/reliabilityAudit.ts`
- Test: `packages/k8s/src/reliabilityAudit.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/k8s/src/reliabilityAudit.test.ts
import { describe, it, expect } from "vitest";
import {
  analyzeReliability,
  SEVERITY_RANK,
  type AuditWorkload,
} from "./reliabilityAudit";

/** A minimal healthy Deployment with 2 replicas, both probes, requests, a fixed
 *  image, anti-affinity, no hostPath — trips NOTHING. Spread + override per test. */
function healthy(over: Partial<AuditWorkload> = {}): AuditWorkload {
  return {
    kind: "Deployment",
    name: "web",
    namespace: "default",
    replicas: 2,
    labels: { app: "web" },
    hasAntiAffinity: true,
    hasHostPath: false,
    containers: [
      {
        name: "web",
        image: "nginx:1.27.0",
        hasLiveness: true,
        hasReadiness: true,
        hasCpuRequest: true,
        hasMemRequest: true,
      },
    ],
    ...over,
  };
}

describe("analyzeReliability", () => {
  it("returns no findings for a healthy workload", () => {
    const out = analyzeReliability({ workloads: [healthy()], pdbs: [{ namespace: "default", selector: { app: "web" } }], hpas: [] });
    expect(out).toEqual([]);
  });

  it("exposes a severity rank ordering critical < warning < info", () => {
    expect(SEVERITY_RANK.critical).toBeLessThan(SEVERITY_RANK.warning);
    expect(SEVERITY_RANK.warning).toBeLessThan(SEVERITY_RANK.info);
  });
});

export { healthy };
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rigel/k8s test reliabilityAudit`
Expected: FAIL — `Failed to resolve import "./reliabilityAudit"` / `analyzeReliability is not a function`.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/k8s/src/reliabilityAudit.ts
// Reliability / SRE audit — the first HELM-20 "audit skill". A pure, deterministic
// rules engine over normalized workload specs (+ PodDisruptionBudgets + HPAs). The
// source of truth for detection; the assistant only presents these findings in chat.
// Mirrors the discriminated-union + pure-helper shape of alerts.ts. Reusable by the
// web hook, a future report panel, and the in-cluster agent.

export type Severity = "critical" | "warning" | "info";
export type WorkloadKind = "Deployment" | "StatefulSet" | "DaemonSet";

/** Severity ordering for urgency-first sorting (lower = more urgent). */
export const SEVERITY_RANK: Record<Severity, number> = {
  critical: 0,
  warning: 1,
  info: 2,
};

export interface AuditContainer {
  name: string;
  image?: string;
  hasLiveness: boolean;
  hasReadiness: boolean;
  hasCpuRequest: boolean;
  hasMemRequest: boolean;
}

export interface AuditWorkload {
  kind: WorkloadKind;
  name: string;
  namespace: string;
  /** Desired replica count. Meaningless for DaemonSets (excluded from replica checks). */
  replicas: number;
  /** Pod-template labels — used to match PodDisruptionBudget selectors. */
  labels: Record<string, string>;
  containers: AuditContainer[];
  hasAntiAffinity: boolean;
  hasHostPath: boolean;
}

export interface AuditPdb {
  namespace: string;
  /** `spec.selector.matchLabels`. Empty object matches every pod in the namespace. */
  selector: Record<string, string>;
}

export interface AuditHpa {
  namespace: string;
  targetKind: string;
  targetName: string;
  minReplicas: number;
}

export type ReliabilityFindingType =
  | "singleReplica"
  | "noLivenessProbe"
  | "noReadinessProbe"
  | "noPodDisruptionBudget"
  | "noAntiAffinity"
  | "missingResourceRequests"
  | "latestImageTag"
  | "hostPathVolume";

export interface ReliabilityFinding {
  type: ReliabilityFindingType;
  severity: Severity;
  kind: WorkloadKind;
  name: string;
  namespace: string;
  /** Set for container-scoped findings (probes, requests, image tag). */
  container?: string;
  rationale: string;
  /** Human hint describing the remediation (maps to an action-block kind). */
  fix: string;
}

export interface ReliabilityAuditInput {
  workloads: AuditWorkload[];
  pdbs: AuditPdb[];
  hpas: AuditHpa[];
}

export function analyzeReliability(_input: ReliabilityAuditInput): ReliabilityFinding[] {
  return [];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @rigel/k8s test reliabilityAudit`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/k8s/src/reliabilityAudit.ts packages/k8s/src/reliabilityAudit.test.ts
git commit -m "feat(k8s): reliability audit engine scaffold (HELM-20)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: `singleReplica` check (DaemonSet-excluded, HPA-suppressed)

**Files:**
- Modify: `packages/k8s/src/reliabilityAudit.ts`
- Test: `packages/k8s/src/reliabilityAudit.test.ts`

- [ ] **Step 1: Write the failing test** (append inside the `describe`, importing `healthy` from the same file's export — it is already exported in Task 1)

```ts
  it("flags a single-replica Deployment as a warning", () => {
    const out = analyzeReliability({ workloads: [healthy({ replicas: 1 })], pdbs: [], hpas: [] });
    const f = out.find((x) => x.type === "singleReplica");
    expect(f).toBeDefined();
    expect(f?.severity).toBe("warning");
    expect(f?.container).toBeUndefined();
  });

  it("does not flag single replica when an HPA sets minReplicas >= 2", () => {
    const out = analyzeReliability({
      workloads: [healthy({ replicas: 1 })],
      pdbs: [],
      hpas: [{ namespace: "default", targetKind: "Deployment", targetName: "web", minReplicas: 2 }],
    });
    expect(out.some((x) => x.type === "singleReplica")).toBe(false);
  });

  it("does not flag single replica on a DaemonSet", () => {
    const out = analyzeReliability({ workloads: [healthy({ kind: "DaemonSet", replicas: 1 })], pdbs: [], hpas: [] });
    expect(out.some((x) => x.type === "singleReplica")).toBe(false);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rigel/k8s test reliabilityAudit`
Expected: FAIL — the single-replica finding is never produced.

- [ ] **Step 3: Write minimal implementation** (replace the `analyzeReliability` stub and add helpers)

```ts
/** Does a workload participate in replica-based checks? DaemonSets run one pod
 *  per node, so replica count / PDB / anti-affinity don't apply the same way. */
function isReplicated(w: AuditWorkload): boolean {
  return w.kind === "Deployment" || w.kind === "StatefulSet";
}

/** Is this workload scaled by an HPA that guarantees >= 2 replicas? */
function hpaKeepsMultiReplica(w: AuditWorkload, hpas: AuditHpa[]): boolean {
  return hpas.some(
    (h) =>
      h.namespace === w.namespace &&
      h.targetKind === w.kind &&
      h.targetName === w.name &&
      h.minReplicas >= 2,
  );
}

export function analyzeReliability(input: ReliabilityAuditInput): ReliabilityFinding[] {
  const findings: ReliabilityFinding[] = [];
  for (const w of input.workloads) {
    const base = { kind: w.kind, name: w.name, namespace: w.namespace } as const;

    if (isReplicated(w) && w.replicas <= 1 && !hpaKeepsMultiReplica(w, input.hpas)) {
      findings.push({
        ...base,
        type: "singleReplica",
        severity: "warning",
        rationale: "Runs a single replica, so any pod restart, eviction, or node failure causes downtime.",
        fix: "Scale to 2 or more replicas (or set an HPA with minReplicas >= 2).",
      });
    }
  }
  return findings;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @rigel/k8s test reliabilityAudit`
Expected: PASS (5 tests). The healthy-workload test still returns `[]` (2 replicas).

- [ ] **Step 5: Commit**

```bash
git add packages/k8s/src/reliabilityAudit.ts packages/k8s/src/reliabilityAudit.test.ts
git commit -m "feat(k8s): reliability single-replica check (HELM-20)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: `noLivenessProbe` + `noReadinessProbe` checks (per container)

**Files:**
- Modify: `packages/k8s/src/reliabilityAudit.ts`
- Test: `packages/k8s/src/reliabilityAudit.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
  it("flags a container missing a liveness probe", () => {
    const w = healthy();
    w.containers[0].hasLiveness = false;
    const out = analyzeReliability({ workloads: [w], pdbs: [{ namespace: "default", selector: { app: "web" } }], hpas: [] });
    const f = out.find((x) => x.type === "noLivenessProbe");
    expect(f?.severity).toBe("warning");
    expect(f?.container).toBe("web");
  });

  it("flags a container missing a readiness probe", () => {
    const w = healthy();
    w.containers[0].hasReadiness = false;
    const out = analyzeReliability({ workloads: [w], pdbs: [{ namespace: "default", selector: { app: "web" } }], hpas: [] });
    expect(out.some((x) => x.type === "noReadinessProbe" && x.container === "web")).toBe(true);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rigel/k8s test reliabilityAudit`
Expected: FAIL — probe findings not produced.

- [ ] **Step 3: Write minimal implementation** (add a per-container loop inside `analyzeReliability`, after the single-replica block, before `return`)

```ts
    for (const c of w.containers) {
      const cbase = { ...base, container: c.name } as const;
      if (!c.hasLiveness) {
        findings.push({
          ...cbase,
          type: "noLivenessProbe",
          severity: "warning",
          rationale: "Container has no liveness probe, so Kubernetes cannot detect and restart a hung process.",
          fix: "Add a livenessProbe to the container spec.",
        });
      }
      if (!c.hasReadiness) {
        findings.push({
          ...cbase,
          type: "noReadinessProbe",
          severity: "warning",
          rationale: "Container has no readiness probe, so traffic can be routed to it before it is ready to serve.",
          fix: "Add a readinessProbe to the container spec.",
        });
      }
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @rigel/k8s test reliabilityAudit`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/k8s/src/reliabilityAudit.ts packages/k8s/src/reliabilityAudit.test.ts
git commit -m "feat(k8s): reliability probe checks (HELM-20)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: `missingResourceRequests` check (per container)

**Files:**
- Modify: `packages/k8s/src/reliabilityAudit.ts`
- Test: `packages/k8s/src/reliabilityAudit.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
  it("flags a container missing cpu or memory requests", () => {
    const w = healthy();
    w.containers[0].hasCpuRequest = false;
    const out = analyzeReliability({ workloads: [w], pdbs: [{ namespace: "default", selector: { app: "web" } }], hpas: [] });
    const f = out.find((x) => x.type === "missingResourceRequests");
    expect(f?.severity).toBe("warning");
    expect(f?.container).toBe("web");
  });

  it("does not flag requests when both cpu and memory are set", () => {
    const out = analyzeReliability({ workloads: [healthy()], pdbs: [{ namespace: "default", selector: { app: "web" } }], hpas: [] });
    expect(out.some((x) => x.type === "missingResourceRequests")).toBe(false);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rigel/k8s test reliabilityAudit`
Expected: FAIL — `missingResourceRequests` not produced.

- [ ] **Step 3: Write minimal implementation** (add inside the per-container loop, after the readiness block)

```ts
      if (!c.hasCpuRequest || !c.hasMemRequest) {
        const missing = [!c.hasCpuRequest ? "cpu" : null, !c.hasMemRequest ? "memory" : null]
          .filter(Boolean)
          .join(" and ");
        findings.push({
          ...cbase,
          type: "missingResourceRequests",
          severity: "warning",
          rationale: `Container has no ${missing} request, so the scheduler cannot place it reliably and it is first to be evicted under pressure.`,
          fix: "Set resources.requests for cpu and memory on the container.",
        });
      }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @rigel/k8s test reliabilityAudit`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/k8s/src/reliabilityAudit.ts packages/k8s/src/reliabilityAudit.test.ts
git commit -m "feat(k8s): reliability missing-requests check (HELM-20)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: `latestImageTag` check (per container) + `imageTagIsMutable` helper

**Files:**
- Modify: `packages/k8s/src/reliabilityAudit.ts`
- Test: `packages/k8s/src/reliabilityAudit.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
  it("flags a :latest image and an untagged image, but not a pinned one", () => {
    const latest = healthy({ name: "a", labels: { app: "a" } });
    latest.containers[0].image = "nginx:latest";
    const untagged = healthy({ name: "b", labels: { app: "b" } });
    untagged.containers[0].image = "nginx";
    const pinned = healthy({ name: "c", labels: { app: "c" } });
    pinned.containers[0].image = "registry:5000/nginx:1.27.0";
    const pdbs = ["a", "b", "c"].map((app) => ({ namespace: "default", selector: { app } }));
    const out = analyzeReliability({ workloads: [latest, untagged, pinned], pdbs, hpas: [] });
    const flagged = out.filter((x) => x.type === "latestImageTag").map((x) => x.name).sort();
    expect(flagged).toEqual(["a", "b"]);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rigel/k8s test reliabilityAudit`
Expected: FAIL — `latestImageTag` not produced.

- [ ] **Step 3: Write minimal implementation** (add the helper near the top helpers, and a block inside the per-container loop)

```ts
/** Extract the tag from an image ref, or null if untagged. Strips any @digest,
 *  and only treats a ':' after the last '/' as a tag (not a registry :port). */
export function imageTagIsMutable(image?: string): boolean {
  if (!image) return false;
  const noDigest = image.split("@")[0];
  const lastSlash = noDigest.lastIndexOf("/");
  const lastColon = noDigest.lastIndexOf(":");
  const tag = lastColon > lastSlash ? noDigest.slice(lastColon + 1) : null;
  return tag === null || tag === "latest"; // untagged implies :latest
}
```

Add inside the per-container loop (after the requests block):

```ts
      if (imageTagIsMutable(c.image)) {
        findings.push({
          ...cbase,
          type: "latestImageTag",
          severity: "warning",
          rationale: "Container uses a mutable image tag (:latest or untagged), so the running image can change unexpectedly and cannot be rolled back to a known version.",
          fix: "Pin the image to a specific version tag or digest.",
        });
      }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @rigel/k8s test reliabilityAudit`
Expected: PASS (10 tests). Healthy uses `nginx:1.27.0`, so still clean.

- [ ] **Step 5: Commit**

```bash
git add packages/k8s/src/reliabilityAudit.ts packages/k8s/src/reliabilityAudit.test.ts
git commit -m "feat(k8s): reliability mutable-image-tag check (HELM-20)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: `hostPathVolume` check (workload-level)

**Files:**
- Modify: `packages/k8s/src/reliabilityAudit.ts`
- Test: `packages/k8s/src/reliabilityAudit.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
  it("flags a workload with a hostPath volume", () => {
    const out = analyzeReliability({
      workloads: [healthy({ hasHostPath: true })],
      pdbs: [{ namespace: "default", selector: { app: "web" } }],
      hpas: [],
    });
    const f = out.find((x) => x.type === "hostPathVolume");
    expect(f?.severity).toBe("warning");
    expect(f?.container).toBeUndefined();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rigel/k8s test reliabilityAudit`
Expected: FAIL — `hostPathVolume` not produced.

- [ ] **Step 3: Write minimal implementation** (add inside the workload loop, after the single-replica block, before the per-container loop)

```ts
    if (w.hasHostPath) {
      findings.push({
        ...base,
        type: "hostPathVolume",
        severity: "warning",
        rationale: "Pod mounts a hostPath volume, which pins it to a specific node and loses its data if the pod is rescheduled elsewhere.",
        fix: "Replace the hostPath volume with a PersistentVolumeClaim.",
      });
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @rigel/k8s test reliabilityAudit`
Expected: PASS (11 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/k8s/src/reliabilityAudit.ts packages/k8s/src/reliabilityAudit.test.ts
git commit -m "feat(k8s): reliability hostPath check (HELM-20)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: `noAntiAffinity` check (multi-replica, info severity)

**Files:**
- Modify: `packages/k8s/src/reliabilityAudit.ts`
- Test: `packages/k8s/src/reliabilityAudit.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
  it("flags a multi-replica workload without anti-affinity as info", () => {
    const out = analyzeReliability({
      workloads: [healthy({ hasAntiAffinity: false })],
      pdbs: [{ namespace: "default", selector: { app: "web" } }],
      hpas: [],
    });
    const f = out.find((x) => x.type === "noAntiAffinity");
    expect(f?.severity).toBe("info");
  });

  it("does not flag anti-affinity on a single-replica workload", () => {
    const out = analyzeReliability({
      workloads: [healthy({ replicas: 1, hasAntiAffinity: false })],
      pdbs: [],
      hpas: [],
    });
    expect(out.some((x) => x.type === "noAntiAffinity")).toBe(false);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rigel/k8s test reliabilityAudit`
Expected: FAIL — `noAntiAffinity` not produced.

- [ ] **Step 3: Write minimal implementation** (add inside the workload loop, after the hostPath block)

```ts
    if (isReplicated(w) && w.replicas >= 2 && !w.hasAntiAffinity) {
      findings.push({
        ...base,
        type: "noAntiAffinity",
        severity: "info",
        rationale: "Multiple replicas have no pod anti-affinity, so Kubernetes may co-locate them on one node — a single node failure can take them all down.",
        fix: "Add podAntiAffinity across kubernetes.io/hostname to spread replicas over nodes.",
      });
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @rigel/k8s test reliabilityAudit`
Expected: PASS (13 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/k8s/src/reliabilityAudit.ts packages/k8s/src/reliabilityAudit.test.ts
git commit -m "feat(k8s): reliability anti-affinity check (HELM-20)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: `noPodDisruptionBudget` check + `pdbSelects` helper

**Files:**
- Modify: `packages/k8s/src/reliabilityAudit.ts`
- Test: `packages/k8s/src/reliabilityAudit.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
  it("flags a multi-replica workload with no PDB, and clears when one selects it", () => {
    const withoutPdb = analyzeReliability({ workloads: [healthy()], pdbs: [], hpas: [] });
    expect(withoutPdb.some((x) => x.type === "noPodDisruptionBudget")).toBe(true);

    const withPdb = analyzeReliability({
      workloads: [healthy()],
      pdbs: [{ namespace: "default", selector: { app: "web" } }],
      hpas: [],
    });
    expect(withPdb.some((x) => x.type === "noPodDisruptionBudget")).toBe(false);
  });

  it("does not count a PDB in another namespace or with a non-matching selector", () => {
    const out = analyzeReliability({
      workloads: [healthy()],
      pdbs: [
        { namespace: "other", selector: { app: "web" } },
        { namespace: "default", selector: { app: "api" } },
      ],
      hpas: [],
    });
    expect(out.some((x) => x.type === "noPodDisruptionBudget")).toBe(true);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rigel/k8s test reliabilityAudit`
Expected: FAIL — `noPodDisruptionBudget` not produced.

- [ ] **Step 3: Write minimal implementation** (add the helper near the other helpers, and a block inside the workload loop after the anti-affinity block)

```ts
/** A PDB selects a workload when it is in the same namespace and every label in
 *  its matchLabels is present (with the same value) on the workload's pod labels.
 *  An empty selector matches every pod in the namespace. */
function pdbSelects(pdb: AuditPdb, w: AuditWorkload): boolean {
  if (pdb.namespace !== w.namespace) return false;
  return Object.entries(pdb.selector).every(([k, v]) => w.labels[k] === v);
}
```

Inside the workload loop:

```ts
    if (isReplicated(w) && w.replicas >= 2 && !input.pdbs.some((p) => pdbSelects(p, w))) {
      findings.push({
        ...base,
        type: "noPodDisruptionBudget",
        severity: "warning",
        rationale: "Multiple replicas have no PodDisruptionBudget, so a voluntary disruption (node drain/upgrade) can evict every replica at once.",
        fix: "Create a PodDisruptionBudget selecting this workload (e.g. minAvailable: 1).",
      });
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @rigel/k8s test reliabilityAudit`
Expected: PASS (15 tests). The healthy-workload test (Task 1) already passes a matching PDB, so it stays clean.

- [ ] **Step 5: Commit**

```bash
git add packages/k8s/src/reliabilityAudit.ts packages/k8s/src/reliabilityAudit.test.ts
git commit -m "feat(k8s): reliability PodDisruptionBudget check (HELM-20)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: `sortFindings` + `reliabilityCounts` helpers

**Files:**
- Modify: `packages/k8s/src/reliabilityAudit.ts`
- Test: `packages/k8s/src/reliabilityAudit.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { sortFindings, reliabilityCounts } from "./reliabilityAudit";

describe("sortFindings / reliabilityCounts", () => {
  it("orders findings by severity (critical, warning, info)", () => {
    const findings = analyzeReliability({
      workloads: [healthy({ replicas: 1, hasAntiAffinity: false })], // singleReplica (warning) + noAntiAffinity is skipped (replicas<2) → only warnings + PDB
      pdbs: [],
      hpas: [],
    });
    const sorted = sortFindings(findings);
    const ranks = sorted.map((f) => SEVERITY_RANK[f.severity]);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  });

  it("counts findings by severity and affected workloads", () => {
    const w = healthy({ replicas: 1, hasAntiAffinity: false, name: "web" });
    w.containers[0].hasLiveness = false;
    const counts = reliabilityCounts(analyzeReliability({ workloads: [w], pdbs: [], hpas: [] }));
    expect(counts.warning).toBeGreaterThan(0);
    expect(counts.total).toBe(counts.critical + counts.warning + counts.info);
    expect(counts.workloadsAffected).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rigel/k8s test reliabilityAudit`
Expected: FAIL — `sortFindings` / `reliabilityCounts` not exported.

- [ ] **Step 3: Write minimal implementation** (append to `reliabilityAudit.ts`)

```ts
export interface ReliabilityCounts {
  critical: number;
  warning: number;
  info: number;
  total: number;
  workloadsAffected: number;
}

/** Stable urgency-first sort: severity rank, then namespace, then name, then type. */
export function sortFindings(findings: ReliabilityFinding[]): ReliabilityFinding[] {
  return [...findings].sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      a.namespace.localeCompare(b.namespace) ||
      a.name.localeCompare(b.name) ||
      a.type.localeCompare(b.type),
  );
}

export function reliabilityCounts(findings: ReliabilityFinding[]): ReliabilityCounts {
  const affected = new Set<string>();
  let critical = 0;
  let warning = 0;
  let info = 0;
  for (const f of findings) {
    affected.add(`${f.kind}/${f.namespace}/${f.name}`);
    if (f.severity === "critical") critical++;
    else if (f.severity === "warning") warning++;
    else info++;
  }
  return { critical, warning, info, total: findings.length, workloadsAffected: affected.size };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @rigel/k8s test reliabilityAudit`
Expected: PASS (17 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/k8s/src/reliabilityAudit.ts packages/k8s/src/reliabilityAudit.test.ts
git commit -m "feat(k8s): reliability finding sort + counts (HELM-20)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: Barrel-export the engine from `@rigel/k8s`

**Files:**
- Modify: `packages/k8s/src/index.ts`

- [ ] **Step 1: Add the export** (insert after the `export * from "./digest";` line near the top)

```ts
export {
  type Severity,
  type WorkloadKind as ReliabilityWorkloadKind,
  type AuditContainer,
  type AuditWorkload,
  type AuditPdb,
  type AuditHpa,
  type ReliabilityAuditInput,
  type ReliabilityFindingType,
  type ReliabilityFinding,
  type ReliabilityCounts,
  SEVERITY_RANK,
  imageTagIsMutable,
  analyzeReliability,
  sortFindings,
  reliabilityCounts,
} from "./reliabilityAudit";
```

Note: `WorkloadKind` is aliased to `ReliabilityWorkloadKind` on export to avoid any collision with other kind types re-exported by the barrel.

- [ ] **Step 2: Verify the package builds and the consumer resolves the types**

Run: `pnpm --filter @rigel/k8s typecheck`
Expected: PASS (no type errors).

- [ ] **Step 3: Commit**

```bash
git add packages/k8s/src/index.ts
git commit -m "feat(k8s): export reliability audit engine (HELM-20)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 11: Web adapter `extractAuditInputs` (store objects → engine inputs)

**Files:**
- Create: `apps/web/src/panels/assistant/audits/extractAuditInputs.ts`
- Test: `apps/web/src/panels/assistant/audits/extractAuditInputs.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/src/panels/assistant/audits/extractAuditInputs.test.ts
import { describe, it, expect } from "vitest";
import { extractAuditInputs } from "./extractAuditInputs";

describe("extractAuditInputs", () => {
  it("maps a Deployment's spec into an AuditWorkload", () => {
    const resources = {
      deployments: {
        "default/web": {
          metadata: { name: "web", namespace: "default" },
          spec: {
            replicas: 3,
            template: {
              metadata: { labels: { app: "web" } },
              spec: {
                affinity: { podAntiAffinity: {} },
                volumes: [{ name: "data", hostPath: { path: "/data" } }],
                containers: [
                  {
                    name: "web",
                    image: "nginx:1.27.0",
                    livenessProbe: {},
                    resources: { requests: { cpu: "100m" } },
                  },
                ],
              },
            },
          },
        },
      },
    };
    const { workloads } = extractAuditInputs(resources);
    expect(workloads).toHaveLength(1);
    const w = workloads[0];
    expect(w).toMatchObject({ kind: "Deployment", name: "web", namespace: "default", replicas: 3 });
    expect(w.labels).toEqual({ app: "web" });
    expect(w.hasAntiAffinity).toBe(true);
    expect(w.hasHostPath).toBe(true);
    expect(w.containers[0]).toMatchObject({
      name: "web",
      image: "nginx:1.27.0",
      hasLiveness: true,
      hasReadiness: false,
      hasCpuRequest: true,
      hasMemRequest: false,
    });
  });

  it("defaults replicas to 1 and namespace to default; reads PDB and HPA slices", () => {
    const resources = {
      statefulsets: { "x/db": { metadata: { name: "db" }, spec: { template: { spec: { containers: [] } } } } },
      poddisruptionbudgets: { "default/pdb": { metadata: { namespace: "default" }, spec: { selector: { matchLabels: { app: "web" } } } } },
      horizontalpodautoscalers: {
        "default/hpa": {
          metadata: { namespace: "default" },
          spec: { scaleTargetRef: { kind: "Deployment", name: "web" }, minReplicas: 2 },
        },
      },
    };
    const out = extractAuditInputs(resources);
    expect(out.workloads[0]).toMatchObject({ kind: "StatefulSet", name: "db", namespace: "default", replicas: 1 });
    expect(out.pdbs).toEqual([{ namespace: "default", selector: { app: "web" } }]);
    expect(out.hpas).toEqual([{ namespace: "default", targetKind: "Deployment", targetName: "web", minReplicas: 2 }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter web test extractAuditInputs`
Expected: FAIL — `Failed to resolve import "./extractAuditInputs"`.

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/web/src/panels/assistant/audits/extractAuditInputs.ts
// Adapter: turn the live Zustand cluster store (raw kubectl -o json objects,
// keyed by watch-kind then name) into the normalized inputs the pure
// reliability engine consumes. Mirrors rightsizing/aggregate.ts:buildRightSizing.
import type {
  AuditWorkload,
  AuditPdb,
  AuditHpa,
  AuditContainer,
  ReliabilityAuditInput,
  ReliabilityWorkloadKind,
} from "@rigel/k8s";

type Dict = Record<string, unknown>;

interface RawContainer {
  name: string;
  image?: string;
  livenessProbe?: unknown;
  readinessProbe?: unknown;
  resources?: { requests?: Record<string, string> };
}

interface RawWorkload {
  metadata?: { name?: string; namespace?: string };
  spec?: {
    replicas?: number;
    template?: {
      metadata?: { labels?: Record<string, string> };
      spec?: {
        affinity?: { podAntiAffinity?: unknown };
        volumes?: Array<{ hostPath?: unknown }>;
        containers?: RawContainer[];
      };
    };
  };
}

interface RawPdb {
  metadata?: { namespace?: string };
  spec?: { selector?: { matchLabels?: Record<string, string> } };
}

interface RawHpa {
  metadata?: { namespace?: string };
  spec?: { scaleTargetRef?: { kind?: string; name?: string }; minReplicas?: number };
}

const WORKLOAD_KINDS: Record<string, ReliabilityWorkloadKind> = {
  deployments: "Deployment",
  statefulsets: "StatefulSet",
  daemonsets: "DaemonSet",
};

function mapContainer(c: RawContainer): AuditContainer {
  const req = c.resources?.requests ?? {};
  return {
    name: c.name,
    image: c.image,
    hasLiveness: c.livenessProbe != null,
    hasReadiness: c.readinessProbe != null,
    hasCpuRequest: req.cpu != null,
    hasMemRequest: req.memory != null,
  };
}

function sliceOf(resources: Dict, kind: string): Record<string, unknown> {
  return (resources[kind] as Record<string, unknown> | undefined) ?? {};
}

export function extractAuditInputs(resources: Dict): ReliabilityAuditInput {
  const workloads: AuditWorkload[] = [];
  for (const [watchKind, kind] of Object.entries(WORKLOAD_KINDS)) {
    for (const obj of Object.values(sliceOf(resources, watchKind))) {
      const w = obj as RawWorkload;
      const podSpec = w.spec?.template?.spec;
      workloads.push({
        kind,
        name: w.metadata?.name ?? "",
        namespace: w.metadata?.namespace ?? "default",
        replicas: w.spec?.replicas ?? 1,
        labels: w.spec?.template?.metadata?.labels ?? {},
        containers: (podSpec?.containers ?? []).map(mapContainer),
        hasAntiAffinity: podSpec?.affinity?.podAntiAffinity != null,
        hasHostPath: (podSpec?.volumes ?? []).some((v) => v.hostPath != null),
      });
    }
  }

  const pdbs: AuditPdb[] = Object.values(sliceOf(resources, "poddisruptionbudgets")).map((obj) => {
    const p = obj as RawPdb;
    return { namespace: p.metadata?.namespace ?? "default", selector: p.spec?.selector?.matchLabels ?? {} };
  });

  const hpas: AuditHpa[] = Object.values(sliceOf(resources, "horizontalpodautoscalers")).map((obj) => {
    const h = obj as RawHpa;
    return {
      namespace: h.metadata?.namespace ?? "default",
      targetKind: h.spec?.scaleTargetRef?.kind ?? "",
      targetName: h.spec?.scaleTargetRef?.name ?? "",
      minReplicas: h.spec?.minReplicas ?? 1,
    };
  });

  return { workloads, pdbs, hpas };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter web test extractAuditInputs`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/panels/assistant/audits/extractAuditInputs.ts apps/web/src/panels/assistant/audits/extractAuditInputs.test.ts
git commit -m "feat(web): reliability audit store adapter (HELM-20)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 12: `useReliabilityAudit` hook

**Files:**
- Create: `apps/web/src/panels/assistant/audits/useReliabilityAudit.ts`
- Test: `apps/web/src/panels/assistant/audits/useReliabilityAudit.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/src/panels/assistant/audits/useReliabilityAudit.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useReliabilityAudit } from "./useReliabilityAudit";
import { useCluster } from "@/store/cluster";

vi.mock("@/lib/ws", () => ({ subscribe: vi.fn(), unsubscribe: vi.fn() }));
import { subscribe, unsubscribe } from "@/lib/ws";

beforeEach(() => {
  vi.clearAllMocks();
  useCluster.setState({ resources: {} });
});

describe("useReliabilityAudit", () => {
  it("subscribes to the workload/PDB/HPA kinds and unsubscribes on unmount", () => {
    const { unmount } = renderHook(() => useReliabilityAudit());
    expect(subscribe).toHaveBeenCalledWith("poddisruptionbudgets", "*");
    expect(subscribe).toHaveBeenCalledWith("horizontalpodautoscalers", "*");
    unmount();
    expect(unsubscribe).toHaveBeenCalledWith("deployments", "*");
  });

  it("returns findings + counts computed from the store", () => {
    useCluster.setState({
      resources: {
        deployments: {
          "default/web": {
            metadata: { name: "web", namespace: "default" },
            spec: { replicas: 1, template: { metadata: { labels: {} }, spec: { containers: [{ name: "web", image: "nginx:1.27.0", livenessProbe: {}, readinessProbe: {}, resources: { requests: { cpu: "1", memory: "1Gi" } } }] } } },
          },
        },
      },
    });
    const { result } = renderHook(() => useReliabilityAudit());
    expect(result.current.findings.some((f) => f.type === "singleReplica")).toBe(true);
    expect(result.current.counts.workloadsAffected).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter web test useReliabilityAudit`
Expected: FAIL — `Failed to resolve import "./useReliabilityAudit"`.

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/web/src/panels/assistant/audits/useReliabilityAudit.ts
// Reliability audit data hook: subscribe to the workload + PDB + HPA watch kinds
// (cluster-wide, like useRightSizing — the store slice is keyed by kind only),
// adapt the live store into engine inputs, and run the pure engine. Read-only.
import { useEffect, useMemo } from "react";
import { useCluster } from "@/store/cluster";
import { subscribe, unsubscribe } from "@/lib/ws";
import {
  analyzeReliability,
  sortFindings,
  reliabilityCounts,
  type ReliabilityFinding,
  type ReliabilityCounts,
} from "@rigel/k8s";
import { extractAuditInputs } from "./extractAuditInputs";

const WATCH_KINDS = [
  "deployments",
  "statefulsets",
  "daemonsets",
  "poddisruptionbudgets",
  "horizontalpodautoscalers",
];

export interface ReliabilityAuditData {
  findings: ReliabilityFinding[];
  counts: ReliabilityCounts;
}

export function useReliabilityAudit(): ReliabilityAuditData {
  const resources = useCluster((s) => s.resources);

  useEffect(() => {
    WATCH_KINDS.forEach((k) => subscribe(k, "*"));
    return () => WATCH_KINDS.forEach((k) => unsubscribe(k, "*"));
  }, []);

  return useMemo(() => {
    const findings = sortFindings(analyzeReliability(extractAuditInputs(resources)));
    return { findings, counts: reliabilityCounts(findings) };
  }, [resources]);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter web test useReliabilityAudit`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/panels/assistant/audits/useReliabilityAudit.ts apps/web/src/panels/assistant/audits/useReliabilityAudit.test.ts
git commit -m "feat(web): useReliabilityAudit hook (HELM-20)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 13: `buildReliabilityAuditPrompt` (handoff prompt builder)

**Files:**
- Create: `apps/web/src/panels/assistant/audits/auditPrompt.ts`
- Test: `apps/web/src/panels/assistant/audits/auditPrompt.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/src/panels/assistant/audits/auditPrompt.test.ts
import { describe, it, expect } from "vitest";
import { buildReliabilityAuditPrompt } from "./auditPrompt";
import type { ReliabilityFinding } from "@rigel/k8s";

const finding: ReliabilityFinding = {
  type: "singleReplica",
  severity: "warning",
  kind: "Deployment",
  name: "web",
  namespace: "default",
  rationale: "Runs a single replica.",
  fix: "Scale to 2+.",
};

describe("buildReliabilityAuditPrompt", () => {
  it("embeds the findings JSON and asks for severity grouping + action blocks", () => {
    const p = buildReliabilityAuditPrompt([finding]);
    expect(p).toContain("Reliability");
    expect(p).toContain("grouped by severity");
    expect(p).toContain("```action");
    expect(p).toContain('"type": "singleReplica"');
  });

  it("uses a no-issues prompt when there are no findings", () => {
    const p = buildReliabilityAuditPrompt([]);
    expect(p).toContain("no reliability issues");
    expect(p).not.toContain("```json");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter web test auditPrompt`
Expected: FAIL — `Failed to resolve import "./auditPrompt"`.

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/web/src/panels/assistant/audits/auditPrompt.ts
// Build the chat handoff prompt for the Reliability audit. The deterministic
// engine has already produced the findings; this prompt seeds them so Rigel
// presents them (grouped by severity) and emits confirm-gated fix action blocks,
// rather than re-deriving detection. See buildRightSizing / AlertsCard handoff.
import type { ReliabilityFinding } from "@rigel/k8s";

export function buildReliabilityAuditPrompt(findings: ReliabilityFinding[]): string {
  if (findings.length === 0) {
    return [
      "Run the **Reliability / SRE audit**.",
      "A deterministic pre-scan found no reliability issues across the cluster's workloads",
      "(single replicas, missing probes, PodDisruptionBudgets, anti-affinity, resource requests,",
      "mutable :latest images, hostPath volumes).",
      "Confirm the cluster looks healthy on these dimensions and mention anything else worth checking.",
    ].join(" ");
  }

  return [
    "Run the **Reliability / SRE audit**. A deterministic pre-scan of the cluster's workloads has already run; its findings are the JSON below.",
    "",
    "Present them to me grouped by severity (Critical, then Warning, then Info) as a markdown list. For each finding, name the workload (kind namespace/name, and container if given) and explain in one plain sentence why it is a reliability risk.",
    "",
    "For each finding, emit an ```action block so it renders as a confirm-gated button, using the right kind:",
    "- singleReplica → scale (2 or more replicas)",
    "- latestImageTag → setImage (inspect the live image first, then pin to a specific tag or digest)",
    "- noLivenessProbe, noReadinessProbe, missingResourceRequests, noAntiAffinity, hostPathVolume, noPodDisruptionBudget → applyManifest (read the live spec with `kubectl get -o yaml` first, then attach the patched YAML)",
    "",
    "Do not re-run detection or invent findings beyond this list, but you may use read-only kubectl to gather what you need to write a correct fix.",
    "",
    "Findings JSON:",
    "```json",
    JSON.stringify(findings, null, 2),
    "```",
  ].join("\n");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter web test auditPrompt`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/panels/assistant/audits/auditPrompt.ts apps/web/src/panels/assistant/audits/auditPrompt.test.ts
git commit -m "feat(web): reliability audit handoff prompt (HELM-20)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 14: `AuditSkillCard` component

**Files:**
- Create: `apps/web/src/panels/assistant/audits/AuditSkillCard.tsx`

- [ ] **Step 1: Write the component** (no separate unit test — it is exercised by the tab test in Task 15)

```tsx
// apps/web/src/panels/assistant/audits/AuditSkillCard.tsx
// A single audit-skill launcher card on the Audits tab. Live cards show a live
// finding count + severity breakdown + Run button; "coming soon" cards are
// disabled placeholders (the future home of premium/locked state, HELM-16).
import type { LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ReliabilityCounts } from "@rigel/k8s";

export interface AuditSkillCardProps {
  title: string;
  description: string;
  Icon: LucideIcon;
  status: "live" | "soon";
  counts?: ReliabilityCounts;
  onRun?: () => void;
}

export function AuditSkillCard({ title, description, Icon, status, counts, onRun }: AuditSkillCardProps) {
  const soon = status === "soon";
  return (
    <div
      className={`rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-elevated)] p-4 ${
        soon ? "opacity-60" : ""
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <Icon className="mt-0.5 size-[18px] shrink-0 text-[var(--accent-primary)]" />
          <div className="min-w-0">
            <p className="text-sm font-semibold text-[var(--fg-primary)]">{title}</p>
            <p className="mt-0.5 text-xs text-[var(--fg-tertiary)]">{description}</p>
          </div>
        </div>
        {soon ? (
          <span className="shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] font-medium text-[var(--fg-tertiary)] ring-1 ring-[var(--border-subtle)]">
            Coming soon
          </span>
        ) : (
          <Button size="sm" className="shrink-0" onClick={onRun}>
            Run audit
          </Button>
        )}
      </div>

      {!soon && counts && (
        <div className="mt-3 flex items-center gap-3 border-t border-[var(--border-subtle)] pt-3 font-mono text-xs">
          {counts.total === 0 ? (
            <span className="text-green-600 dark:text-green-400">No issues found</span>
          ) : (
            <>
              <span className="text-[var(--fg-secondary)]">
                {counts.total} issue{counts.total === 1 ? "" : "s"} · {counts.workloadsAffected} workload
                {counts.workloadsAffected === 1 ? "" : "s"}
              </span>
              {counts.warning > 0 && (
                <span className="text-amber-600 dark:text-amber-400">{counts.warning} warning</span>
              )}
              {counts.info > 0 && <span className="text-[var(--fg-tertiary)]">{counts.info} info</span>}
            </>
          )}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Verify it typechecks**

Run: `pnpm --filter web typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/panels/assistant/audits/AuditSkillCard.tsx
git commit -m "feat(web): AuditSkillCard launcher card (HELM-20)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 15: `AuditSkillsTab` component + test

**Files:**
- Create: `apps/web/src/panels/assistant/tabs/AuditSkillsTab.tsx`
- Test: `apps/web/src/panels/assistant/tabs/AuditSkillsTab.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// apps/web/src/panels/assistant/tabs/AuditSkillsTab.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AuditSkillsTab } from "./AuditSkillsTab";

vi.mock("@/lib/chatHandoff", () => ({ handoffToChat: vi.fn() }));
import { handoffToChat } from "@/lib/chatHandoff";

vi.mock("../audits/useReliabilityAudit", () => ({
  useReliabilityAudit: () => ({
    findings: [
      { type: "singleReplica", severity: "warning", kind: "Deployment", name: "web", namespace: "default", rationale: "x", fix: "y" },
    ],
    counts: { critical: 0, warning: 1, info: 0, total: 1, workloadsAffected: 1 },
  }),
}));

beforeEach(() => vi.clearAllMocks());

describe("AuditSkillsTab", () => {
  it("renders the Reliability card and Coming soon cards", () => {
    render(<AuditSkillsTab />);
    expect(screen.getByText("Reliability")).toBeInTheDocument();
    expect(screen.getByText("Security")).toBeInTheDocument();
    expect(screen.getByText("Performance")).toBeInTheDocument();
    expect(screen.getAllByText("Coming soon")).toHaveLength(2);
  });

  it("hands off a findings-seeded prompt to a new chat thread on Run", () => {
    render(<AuditSkillsTab />);
    fireEvent.click(screen.getByRole("button", { name: /run audit/i }));
    expect(handoffToChat).toHaveBeenCalledWith(
      expect.stringContaining('"type": "singleReplica"'),
      { newThread: true },
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter web test AuditSkillsTab`
Expected: FAIL — `Failed to resolve import "./AuditSkillsTab"`.

- [ ] **Step 3: Write minimal implementation**

```tsx
// apps/web/src/panels/assistant/tabs/AuditSkillsTab.tsx
// Audits tab — the launcher for HELM-20 audit skills. Reliability is live
// (deterministic engine → chat handoff); Security and Performance are disabled
// "coming soon" cards (future home of premium/locked state, HELM-16). Findings
// are surfaced in chat, so this tab is a launcher, not a report view.
import { ShieldCheck, Gauge, HeartPulse } from "lucide-react";
import { handoffToChat } from "@/lib/chatHandoff";
import { AuditSkillCard } from "../audits/AuditSkillCard";
import { useReliabilityAudit } from "../audits/useReliabilityAudit";
import { buildReliabilityAuditPrompt } from "../audits/auditPrompt";

export function AuditSkillsTab() {
  const { findings, counts } = useReliabilityAudit();

  function runReliability() {
    handoffToChat(buildReliabilityAuditPrompt(findings), { newThread: true });
  }

  return (
    <div className="space-y-3.5">
      <div className="min-w-0">
        <p className="text-sm font-semibold text-[var(--fg-primary)]">Audit skills</p>
        <p className="text-xs text-[var(--fg-tertiary)]">
          Focused, deterministic audits of your cluster. Run one and Rigel walks the findings with you in chat,
          with a one-click fix for each.
        </p>
      </div>

      <div className="space-y-2.5">
        <AuditSkillCard
          title="Reliability"
          description="Single replicas, missing probes, PodDisruptionBudgets, anti-affinity, resource requests, mutable image tags, hostPath volumes."
          Icon={HeartPulse}
          status="live"
          counts={counts}
          onRun={runReliability}
        />
        <AuditSkillCard
          title="Security"
          description="Privileged containers, root users, missing securityContext, hostPath / hostNetwork, wide RBAC."
          Icon={ShieldCheck}
          status="soon"
        />
        <AuditSkillCard
          title="Performance"
          description="CPU throttling, hotspots, slow startups, HPA tuning. Needs a metrics backend."
          Icon={Gauge}
          status="soon"
        />
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter web test AuditSkillsTab`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/panels/assistant/tabs/AuditSkillsTab.tsx apps/web/src/panels/assistant/tabs/AuditSkillsTab.test.tsx
git commit -m "feat(web): Audits tab launcher (HELM-20)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 16: Register the "Audits" tab + full verification

**Files:**
- Modify: `apps/web/src/panels/assistant/AssistantContext.tsx:34`
- Modify: `apps/web/src/panels/assistant/components/TabBar.tsx:40-49`
- Modify: `apps/web/src/panels/assistant/components/TabContent.tsx`

- [ ] **Step 1: Add `"audits"` to the `TabKey` union** (`AssistantContext.tsx:34`)

Replace:

```ts
export type TabKey = "overview" | "needs" | "alerts" | "autofix" | "agents" | "activity" | "reports" | "settings";
```

with:

```ts
export type TabKey = "overview" | "needs" | "alerts" | "autofix" | "agents" | "activity" | "reports" | "audits" | "settings";
```

- [ ] **Step 2: Add the tab entry** (`TabBar.tsx`, in the `tabs` array — insert after the `reports` entry)

```ts
    { id: "reports", label: "Reports" },
    { id: "audits", label: "Audits" },
    { id: "settings", label: "Settings" },
```

- [ ] **Step 3: Wire the tab content** (`TabContent.tsx`)

Add the import alongside the other tab imports:

```ts
import { AuditSkillsTab } from "../tabs/AuditSkillsTab";
```

Add the case in the `switch (tab)` block (after the `reports` case):

```ts
    case "audits":
      return <AuditSkillsTab />;
```

Note: do NOT add `"audits"` to the `needsState` list — the audit reads the live cluster store directly and does not depend on the agent's own written state, so the tab renders as soon as the panel is ready.

- [ ] **Step 4: Run the full web + package test/typecheck**

Run: `pnpm --filter @rigel/k8s test && pnpm --filter web test && pnpm --filter web typecheck`
Expected: PASS — all reliability engine tests, the web audit tests (`extractAuditInputs`, `useReliabilityAudit`, `auditPrompt`, `AuditSkillsTab`), and typecheck all green. `TabContent`'s `switch` is now exhaustive over the new `TabKey`.

- [ ] **Step 5: Build the web app**

Run: `pnpm --filter web build`
Expected: PASS (no type or bundling errors).

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/panels/assistant/AssistantContext.tsx apps/web/src/panels/assistant/components/TabBar.tsx apps/web/src/panels/assistant/components/TabContent.tsx
git commit -m "feat(web): register Audits tab in the assistant (HELM-20)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Post-implementation (per user's global workflow)

After the plan is green and merged, follow the user's docs+tickets workflow:
- **Outline:** update the Rigel app doc with the new "Audit skills" feature (Reliability audit + the Audits tab), and capture the follow-up ideas (Security audit / HELM-19, Performance audit, premium gating / HELM-16).
- **Plane:** move HELM-20 forward and derive follow-up tickets (Security audit, Performance audit, `canRunAudit` gating) from the Outline doc.
- Consider verifying live via `pnpm --filter desktop dev` (desktop-only; do not start a web dev server).

## Out of scope (v1) — do not implement here

- Security and Performance audits (shown only as disabled "coming soon" cards).
- Premium gating / billing / `canRunAudit` (the `entitlements.ts` `canConnect` seam stays untouched).
- A persistent audit history or a web-rendered report view (findings live in chat).
- Autonomous-agent reuse of the engine.
- Any server-side change (no new routes, no new mutation kinds).
