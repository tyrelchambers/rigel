# Security & Performance Audit Skills — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan group-by-group with spec + quality review. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Add Security and Performance audit skills to the Audits tab (flip "coming soon" → live), on a shared audit core so the three audits don't duplicate plumbing.

**Architecture:** Extract shared severity/sort/counts/input types into `packages/k8s/src/auditCommon.ts`; refactor `reliabilityAudit.ts` onto it; add pure `securityAudit.ts` (7 spec checks) and `performanceAudit.ts` (hybrid: 2 spec + 2 metrics checks reusing the right-sizing usage endpoint); extend the one adapter + generalize the prompt builder; wire two hooks and flip the two cards live. No server changes.

**Tech Stack:** TypeScript, `@rigel/k8s`, React 19 + Vite, Zustand store, vitest, Tailwind + `var(--…)` tokens.

**Precedent to mirror:** the Reliability files — `packages/k8s/src/reliabilityAudit.ts`, `apps/web/src/panels/assistant/audits/{extractAuditInputs,useReliabilityAudit,auditPrompt,AuditSkillCard}.*`, `tabs/AuditSkillsTab.tsx`. Read them; the new code follows their shape exactly.

## Resource-value principle (applies to every audit)

Rigel drives remediation from **evidence and best practices** — it must **never fabricate CPU/memory request or limit numbers**. Concrete resource values come only from observed usage (the metrics backend, the same source Right-sizing uses). Rules:

- A resource-setting fix may propose numbers **only** when the finding carries observed-usage `evidence` (present only when a metrics backend is detected). Rigel sizes from that evidence + best-practice headroom.
- **No metrics backend → no numbers.** The finding still surfaces (the problem is real), but the fix is advisory: recommend the change qualitatively and note that sizing requires a metrics backend / the Right-sizing panel.
- This is enforced two ways: (1) the shared `buildAuditPrompt` prepends a fixed instruction stating the rule; (2) resource findings carry `evidence` only when metrics exist, and the compact prompt rows preserve it.
- **Reliability is spec-only (no metrics)** → its `missingResourceRequests` fix is advisory (no numbers), NOT a numeric `setResources`. This corrects the currently-merged reliability prompt, on this branch.

---

## Group A — Shared audit core + reliability refactor

**Files:** Create `packages/k8s/src/auditCommon.ts` (+ `auditCommon.test.ts`); edit `reliabilityAudit.ts`, `reliabilityAudit.test.ts`, `packages/k8s/src/index.ts`, and the web consumers (`useReliabilityAudit.ts`, `auditPrompt.ts`, `AuditSkillCard.tsx`).

### Task A1: Create `auditCommon.ts`

- [ ] **Write the module** (`packages/k8s/src/auditCommon.ts`):

```ts
// Shared primitives for the HELM-20 audit skills (reliability / security /
// performance). Finding-shape-agnostic: severity, ordering, the base finding
// interface, the normalized workload inputs (one adapter feeds all engines), and
// the generic sort + counts. Each engine defines its own `type` union on top.

export type Severity = "critical" | "warning" | "info";

/** Severity ordering for urgency-first sorting (lower = more urgent). */
export const SEVERITY_RANK: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };

export type AuditWorkloadKind = "Deployment" | "StatefulSet" | "DaemonSet";

/** The base shape every audit's finding conforms to. */
export interface AuditFinding {
  type: string;
  severity: Severity;
  kind: AuditWorkloadKind;
  name: string;
  namespace: string;
  /** Set for container-scoped findings. */
  container?: string;
  rationale: string;
  /** Human hint describing the remediation (maps to an action-block kind). */
  fix: string;
}

export interface AuditContainer {
  name: string;
  image?: string;
  // reliability
  hasLiveness: boolean;
  hasReadiness: boolean;
  hasCpuRequest: boolean;
  hasMemRequest: boolean;
  // security (all optional/additive)
  privileged?: boolean;
  allowPrivilegeEscalation?: boolean;
  runAsNonRoot?: boolean;
  runAsUser?: number;
  readOnlyRootFilesystem?: boolean;
  addedCapabilities?: string[];
  hostPorts?: number[];
  // performance
  hasCpuLimit?: boolean;
  hasMemLimit?: boolean;
  cpuLimit?: number; // cores
  memLimit?: number; // bytes
}

export interface AuditWorkload {
  kind: AuditWorkloadKind;
  name: string;
  namespace: string;
  /** Desired replica count. Meaningless for DaemonSets. */
  replicas: number;
  /** Pod-template labels — used to match PodDisruptionBudget selectors. */
  labels: Record<string, string>;
  containers: AuditContainer[];
  hasAntiAffinity: boolean;
  hasHostPath: boolean;
  // security (pod-level, optional/additive)
  hostNetwork?: boolean;
  hostPID?: boolean;
  hostIPC?: boolean;
  podRunAsNonRoot?: boolean;
  podRunAsUser?: number;
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

export interface AuditCounts {
  critical: number;
  warning: number;
  info: number;
  total: number;
  workloadsAffected: number;
}

/** Stable urgency-first sort: severity rank, then namespace, name, type. */
export function sortFindings<T extends AuditFinding>(findings: T[]): T[] {
  return [...findings].sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      a.namespace.localeCompare(b.namespace) ||
      a.name.localeCompare(b.name) ||
      a.type.localeCompare(b.type),
  );
}

export function auditCounts(findings: AuditFinding[]): AuditCounts {
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

- [ ] **Write `auditCommon.test.ts`** — cover `sortFindings` (mixed severities across two namespaces + tie-break by name/type; must fail against identity) and `auditCounts` (mixed severities, `critical` counted, workload dedup when one workload has 2 findings). Follow the strengthened reliability tests as the model.

- [ ] **Run:** `pnpm --filter @rigel/k8s test auditCommon` → PASS.
- [ ] **Commit:** `feat(k8s): shared audit core (severity/sort/counts/inputs) (HELM-20)` + Co-Authored-By trailer.

### Task A2: Refactor `reliabilityAudit.ts` onto the shared core

- [ ] Replace the top of `reliabilityAudit.ts` (the `Severity`/`SEVERITY_RANK`/`WorkloadKind`/`AuditContainer`/`AuditWorkload`/`AuditPdb`/`AuditHpa` declarations, lines 7-50) with an import:

```ts
import {
  type Severity,
  type AuditWorkloadKind,
  type AuditContainer,
  type AuditWorkload,
  type AuditPdb,
  type AuditHpa,
  type AuditFinding,
  SEVERITY_RANK,
  sortFindings,
  auditCounts,
  type AuditCounts,
} from "./auditCommon";
```

- [ ] Change `ReliabilityFinding` to extend the base: keep only the reliability-specific `type`:

```ts
export interface ReliabilityFinding extends AuditFinding {
  type: ReliabilityFindingType;
  kind: AuditWorkloadKind;
}
```

(Its `kind`/`severity`/`name`/`namespace`/`container`/`rationale`/`fix` come from `AuditFinding`.) Update `ReliabilityAuditInput` to reference the imported types (unchanged shape).

- [ ] **Delete** the local `SEVERITY_RANK`, `sortFindings`, and `reliabilityCounts`/`ReliabilityCounts` definitions (lines ~209-240). Reliability now uses the shared `sortFindings` and `auditCounts`. Keep `imageTagIsMutable`, `analyzeReliability`, and the private helpers (`isReplicated`, `hpaKeepsMultiReplica`, `pdbSelects`).

- [ ] **Update `reliabilityAudit.test.ts`**: import `sortFindings`, `auditCounts`, `SEVERITY_RANK` (and any input types) from `./auditCommon` instead of `./reliabilityAudit`; rename `reliabilityCounts` → `auditCounts` in the test bodies. Keep `analyzeReliability`/`imageTagIsMutable`/`ReliabilityFinding` from `./reliabilityAudit`.

- [ ] **Run:** `pnpm --filter @rigel/k8s test reliabilityAudit auditCommon` → all PASS (reliability behavior unchanged).
- [ ] **Commit:** `refactor(k8s): reliability audit on shared audit core (HELM-20)`.

### Task A3: Barrel + web consumer renames

- [ ] **`packages/k8s/src/index.ts`**: replace the single reliability export block with three: export shared names from `./auditCommon` (`Severity`, `SEVERITY_RANK`, `AuditWorkloadKind` — aliased `ReliabilityWorkloadKind` kept for back-compat, `AuditFinding`, `AuditContainer`, `AuditWorkload`, `AuditPdb`, `AuditHpa`, `AuditCounts`, `sortFindings`, `auditCounts`); reliability-specific from `./reliabilityAudit` (`ReliabilityFindingType`, `ReliabilityFinding`, `ReliabilityAuditInput`, `imageTagIsMutable`, `analyzeReliability`). Ensure NO name is exported twice.

- [ ] **Web renames** (mechanical): in `apps/web/src/panels/assistant/audits/useReliabilityAudit.ts` and `auditPrompt.ts`, change `reliabilityCounts` → `auditCounts`; in `AuditSkillCard.tsx`, change type `ReliabilityCounts` → `AuditCounts`. Update imports from `@rigel/k8s` accordingly. (`ReliabilityWorkloadKind` alias still exists, so `extractAuditInputs.ts` is unchanged.)

- [ ] **Run:** `pnpm --filter @rigel/k8s test && pnpm --filter web typecheck && pnpm --filter web test extractAuditInputs auditPrompt useReliabilityAudit AuditSkillsTab` → all PASS.
- [ ] **Commit:** `refactor(k8s,web): route audit exports through shared core (HELM-20)`.

---

## Group B — Security engine

**Files:** Create `packages/k8s/src/securityAudit.ts` (+ test); edit `index.ts`.

### Task B1: `securityAudit.ts` (TDD, one check at a time — mirror the reliability test rhythm)

- [ ] **Write the engine:**

```ts
// Security audit — HELM-19 / the second HELM-20 audit skill. Pure, deterministic,
// spec-based (pod/container securityContext + pod spec). Reuses the shared audit
// core; mirrors analyzeReliability's structure.
import {
  type AuditWorkload,
  type AuditContainer,
  type AuditFinding,
  type AuditWorkloadKind,
} from "./auditCommon";

export type SecurityFindingType =
  | "privilegedContainer"
  | "hostNamespace"
  | "runsAsRoot"
  | "allowsPrivilegeEscalation"
  | "addedCapabilities"
  | "writableRootFilesystem"
  | "hostPort";

export interface SecurityFinding extends AuditFinding {
  type: SecurityFindingType;
  kind: AuditWorkloadKind;
}

export interface SecurityAuditInput {
  workloads: AuditWorkload[];
}

/** Capabilities worth calling out explicitly in the rationale. */
const DANGEROUS_CAPS = new Set(["SYS_ADMIN", "NET_ADMIN", "NET_RAW", "ALL"]);

/** Is the container effectively guaranteed to run as a non-root user? A container
 *  setting wins over the pod default. */
function runsAsNonRoot(c: AuditContainer, w: AuditWorkload): boolean {
  if (c.runAsNonRoot === true) return true;
  if (c.runAsUser !== undefined) return c.runAsUser !== 0;
  if (w.podRunAsNonRoot === true) return true;
  if (w.podRunAsUser !== undefined) return w.podRunAsUser !== 0;
  return false; // nothing establishes non-root
}

export function analyzeSecurity(input: SecurityAuditInput): SecurityFinding[] {
  const findings: SecurityFinding[] = [];
  for (const w of input.workloads) {
    const base = { kind: w.kind, name: w.name, namespace: w.namespace } as const;

    const hostNs = [
      w.hostNetwork ? "hostNetwork" : null,
      w.hostPID ? "hostPID" : null,
      w.hostIPC ? "hostIPC" : null,
    ].filter(Boolean);
    if (hostNs.length > 0) {
      findings.push({
        ...base,
        type: "hostNamespace",
        severity: "critical",
        rationale: `Pod shares the host's ${hostNs.join(", ")}, breaking the container's isolation from the node.`,
        fix: `Remove ${hostNs.join("/")} from the pod spec unless strictly required.`,
      });
    }

    for (const c of w.containers) {
      const cbase = { ...base, container: c.name } as const;

      if (c.privileged === true) {
        findings.push({
          ...cbase,
          type: "privilegedContainer",
          severity: "critical",
          rationale: "Container runs privileged, giving it near-root access to the host kernel and devices.",
          fix: "Remove securityContext.privileged (grant only the specific capabilities actually needed).",
        });
      }

      if (!runsAsNonRoot(c, w)) {
        findings.push({
          ...cbase,
          type: "runsAsRoot",
          severity: "warning",
          rationale: "Container is not pinned to a non-root user, so it may run as root and widen the blast radius of a compromise.",
          fix: "Set securityContext.runAsNonRoot: true (and a non-zero runAsUser).",
        });
      }

      if (c.allowPrivilegeEscalation !== false) {
        findings.push({
          ...cbase,
          type: "allowsPrivilegeEscalation",
          severity: "warning",
          rationale: "Container allows privilege escalation, so a process can gain more privileges than its parent (e.g. via setuid).",
          fix: "Set securityContext.allowPrivilegeEscalation: false.",
        });
      }

      if (c.addedCapabilities && c.addedCapabilities.length > 0) {
        const flagged = c.addedCapabilities.filter((cap) => DANGEROUS_CAPS.has(cap));
        const note = flagged.length > 0 ? ` including ${flagged.join(", ")}` : "";
        findings.push({
          ...cbase,
          type: "addedCapabilities",
          severity: "warning",
          rationale: `Container adds Linux capabilities${note}, expanding what a compromised process can do to the host.`,
          fix: "Drop unneeded capabilities (capabilities.drop: [ALL], then add back only what is required).",
        });
      }

      if (c.readOnlyRootFilesystem !== true) {
        findings.push({
          ...cbase,
          type: "writableRootFilesystem",
          severity: "info",
          rationale: "Container's root filesystem is writable, so a compromise can persist changes or drop tooling into the image.",
          fix: "Set securityContext.readOnlyRootFilesystem: true (mount an emptyDir for paths that need writes).",
        });
      }

      if (c.hostPorts && c.hostPorts.length > 0) {
        findings.push({
          ...cbase,
          type: "hostPort",
          severity: "info",
          rationale: `Container binds host port ${c.hostPorts.join(", ")}, exposing it directly on the node and pinning scheduling.`,
          fix: "Expose the container through a Service instead of a hostPort.",
        });
      }
    }
  }
  return findings;
}
```

- [ ] **Write `securityAudit.test.ts`**: a `healthySecure()` fixture (a locked-down workload that trips nothing: non-root, no host namespaces, `allowPrivilegeEscalation:false`, `readOnlyRootFilesystem:true`, no caps, no hostPort, not privileged) plus one focused test per check (trips + clean), a `runsAsRoot` test covering the container-overrides-pod precedence, and a `hostNamespace` multi-flag test. Assert severities match the table.

- [ ] **Run** each test red→green as you add each check; final `pnpm --filter @rigel/k8s test securityAudit` → PASS.
- [ ] **Barrel**: add `securityAudit` exports to `index.ts` (`SecurityFindingType`, `SecurityFinding`, `SecurityAuditInput`, `analyzeSecurity`).
- [ ] **Commit** per check (mirror reliability's per-check commits), final `feat(k8s): security audit engine (HELM-19)`.

---

## Group C — Performance engine

**Files:** Create `packages/k8s/src/performanceAudit.ts` (+ test); edit `index.ts`.

### Task C1: `performanceAudit.ts` (TDD)

- [ ] **Write the engine:**

```ts
// Performance audit — the third HELM-20 audit skill. Hybrid: spec-based checks
// always run; metrics-based checks run only when a usage provider is supplied
// (a Prometheus/VM backend was detected). Pure; reuses the shared audit core.
import {
  type AuditWorkload,
  type AuditHpa,
  type AuditFinding,
  type AuditWorkloadKind,
} from "./auditCommon";

export type PerformanceFindingType =
  | "noMemoryLimit"
  | "noAutoscaling"
  | "cpuThrottlingRisk"
  | "memoryPressure";

/** Observed-usage evidence attached to a resource finding so Rigel can size the
 *  fix from real data. Present ONLY when a metrics backend supplied usage — never
 *  fabricate values in its absence. */
export interface PerfEvidence {
  cpuPeak: number; // cores
  memPeak: number; // bytes
  cpuLimit?: number; // cores, current
  memLimit?: number; // bytes, current
  hoursCovered: number;
}

export interface PerformanceFinding extends AuditFinding {
  type: PerformanceFindingType;
  kind: AuditWorkloadKind;
  /** Observed usage for sizing the fix (present only when metrics were available). */
  evidence?: PerfEvidence;
}

/** Per-(namespace, workload, container) peak usage over the window. */
export interface PerfUsage {
  cpuPeak: number; // cores
  memPeak: number; // bytes
  hoursCovered: number;
}

export type PerfUsageProvider = (
  namespace: string,
  workload: string,
  container: string,
) => PerfUsage | undefined;

export interface PerformanceAuditInput {
  workloads: AuditWorkload[];
  hpas: AuditHpa[];
  /** Absent when no metrics backend is available — metrics checks are then skipped. */
  usage?: PerfUsageProvider;
}

const CPU_THROTTLE_FRACTION = 0.95;
const MEM_PRESSURE_FRACTION = 0.9;
/** Ignore metrics with too little history to trust (matches right-sizing's floor). */
const MIN_HOURS = 24;

function hasHpa(w: AuditWorkload, hpas: AuditHpa[]): boolean {
  return hpas.some((h) => h.namespace === w.namespace && h.targetKind === w.kind && h.targetName === w.name);
}

export function analyzePerformance(input: PerformanceAuditInput): PerformanceFinding[] {
  const findings: PerformanceFinding[] = [];
  for (const w of input.workloads) {
    const base = { kind: w.kind, name: w.name, namespace: w.namespace } as const;

    // Spec: multi-replica Deployment with no HPA can't scale to load.
    if (w.kind === "Deployment" && w.replicas >= 2 && !hasHpa(w, input.hpas)) {
      findings.push({
        ...base,
        type: "noAutoscaling",
        severity: "info",
        rationale: "Runs multiple fixed replicas with no HorizontalPodAutoscaler, so it can't scale up under load or down when idle.",
        fix: "Add a HorizontalPodAutoscaler targeting CPU or memory utilization.",
      });
    }

    for (const c of w.containers) {
      const cbase = { ...base, container: c.name } as const;
      // Observed usage for this container, if a metrics backend supplied it with
      // enough history. This is the ONLY source of resource numbers; when absent,
      // fixes stay advisory (no fabricated values).
      const u = input.usage?.(w.namespace, w.name, c.name);
      const evidence: PerfEvidence | undefined =
        u && u.hoursCovered >= MIN_HOURS
          ? { cpuPeak: u.cpuPeak, memPeak: u.memPeak, cpuLimit: c.cpuLimit, memLimit: c.memLimit, hoursCovered: u.hoursCovered }
          : undefined;

      // Spec: no memory limit → can OOM the node / noisy neighbor. Numbers (if any)
      // come from `evidence`; without it the fix is advisory.
      if (c.hasMemLimit !== true) {
        findings.push({
          ...cbase,
          type: "noMemoryLimit",
          severity: "warning",
          rationale: "Container has no memory limit, so a leak or spike can consume the node's memory and evict its neighbors.",
          fix: evidence
            ? "Set resources.limits.memory sized from the observed peak in the evidence (add best-practice headroom)."
            : "Set a memory limit, sized from observed usage — needs a metrics backend to recommend a value.",
          ...(evidence ? { evidence } : {}),
        });
      }

      // Metrics checks: only when usage is present with enough history.
      if (evidence) {
        if (c.cpuLimit !== undefined && u!.cpuPeak >= CPU_THROTTLE_FRACTION * c.cpuLimit) {
          findings.push({
            ...cbase,
            type: "cpuThrottlingRisk",
            severity: "warning",
            rationale: `Observed peak CPU (${u!.cpuPeak.toFixed(2)} cores) is at or above 95% of the ${c.cpuLimit}-core limit over the window, so the container is likely being CPU-throttled.`,
            fix: "Raise the CPU limit toward the observed peak (with headroom), or remove it if bursting is acceptable.",
            evidence,
          });
        }
        if (c.memLimit !== undefined && u!.memPeak >= MEM_PRESSURE_FRACTION * c.memLimit) {
          findings.push({
            ...cbase,
            type: "memoryPressure",
            severity: "warning",
            rationale: "Observed peak memory is at or above 90% of the container's memory limit over the window, so it is at risk of being OOM-killed.",
            fix: "Raise the memory limit toward the observed peak (with headroom), or reduce the workload's memory use.",
            evidence,
          });
        }
      }
    }
  }
  return findings;
}
```

- [ ] **Write `performanceAudit.test.ts`**: a fixture with a mem limit + HPA + healthy usage (trips nothing). Tests: `noMemoryLimit` trips/clears; `noAutoscaling` trips for multi-replica Deployment without HPA, clears with HPA and for single-replica; `cpuThrottlingRisk` trips when a stub `PerfUsageProvider` returns `cpuPeak` ≥ 95% of `cpuLimit` (and does NOT trip when `usage` is undefined — proving spec-only degradation); `memoryPressure` similar; and a test that metrics checks are skipped when `hoursCovered < 24`.

- [ ] Red→green per check; final `pnpm --filter @rigel/k8s test performanceAudit` → PASS.
- [ ] **Barrel**: add performance exports to `index.ts`.
- [ ] **Commit** per check; final `feat(k8s): performance audit engine (hybrid) (HELM-20)`.

---

## Group D — Adapter extension + prompt generalization

**Files:** Edit `extractAuditInputs.ts` (+ test), `auditPrompt.ts` (+ test).

### Task D1: Extend `extractAuditInputs`

- [ ] Extend the `Raw*` interfaces and the `mapContainer`/workload mapping to populate the new fields. Read `securityContext` at both pod (`spec.template.spec.securityContext`) and container level, host namespaces, `ports[].hostPort`, and resource `limits`. Use the existing right-sizing `parseQuantity` (import from `@/panels/rightsizing/displayHelper`) for `cpuLimit`/`memLimit` numbers. Key additions:
  - container: `privileged` ← `securityContext.privileged`; `allowPrivilegeEscalation`; `runAsNonRoot`; `runAsUser`; `readOnlyRootFilesystem`; `addedCapabilities` ← `securityContext.capabilities.add ?? []`; `hostPorts` ← `ports?.filter(p => p.hostPort).map(p => p.hostPort)`; `hasCpuLimit`/`hasMemLimit` ← `resources.limits.cpu`/`.memory` present; `cpuLimit`/`memLimit` ← parsed limit numbers.
  - workload (pod-level): `hostNetwork`/`hostPID`/`hostIPC` ← `podSpec`; `podRunAsNonRoot`/`podRunAsUser` ← `podSpec.securityContext`.
- [ ] **Extend `extractAuditInputs.test.ts`**: one case asserting the new security fields map (a privileged, host-network, root, capability-adding container), and one asserting perf limit parsing (`cpuLimit`/`memLimit`/`hasMemLimit`).
- [ ] **Run:** `pnpm --filter web test extractAuditInputs` → PASS. **Commit:** `feat(web): extend audit adapter for security + performance fields (HELM-20)`.

### Task D2: Generalize the prompt builder

- [ ] Refactor `auditPrompt.ts` into a generic `buildAuditPrompt(config, findings)` where `config = { title: string; dimensions: string; actionLines: string[] }`. Reuse the existing bounding logic verbatim (compact rows, `SEED_CAP=40`, severity/type summary, no-issues variant), **with two changes**:
  - **Compact rows preserve `evidence`** when present: `rows = seeded.map((f) => ({ type, severity, kind, namespace, name, ...(container?{container}:{}) , ...((f as { evidence?: unknown }).evidence ? { evidence: (f as { evidence?: unknown }).evidence } : {}) }))`. (Everything else about a finding is still dropped.)
  - **Prepend a fixed evidence rule** to the instruction block (before the action bullets), identical for every audit:
    > "Base every fix on the evidence in the finding and Kubernetes best practices. NEVER invent CPU or memory request/limit numbers: size them only from a finding's observed-usage `evidence`. If a finding has no `evidence`, do not propose specific values — recommend the change and note that sizing needs a metrics backend."
  The generic function takes `AuditFinding[]` (import from `@rigel/k8s`). Provide three configs:
  - `buildReliabilityAuditPrompt(findings)` = thin wrapper calling `buildAuditPrompt(RELIABILITY_CONFIG, findings)`. Its `actionLines` are the current reliability bullets **except** `missingResourceRequests`, which is REMOVED from the `setResources` line — it now falls under the global no-numbers rule (advisory), matching the engine fix-text change below.
  - `buildSecurityAuditPrompt(findings)` — title "Security audit"; dimensions "privileged containers, host namespaces, root users, privilege escalation, added capabilities, writable root filesystems, host ports"; actionLines all `→ applyManifest (read the live spec with kubectl get -o yaml first, then attach the patched securityContext / pod spec)`.
  - `buildPerformanceAuditPrompt(findings)` — title "Performance audit"; dimensions "memory limits, autoscaling, CPU throttling, memory pressure"; actionLines: `noMemoryLimit/cpuThrottlingRisk/memoryPressure → setResources sized from the finding's evidence (or advisory if no evidence)`, `noAutoscaling → applyManifest (create a HorizontalPodAutoscaler)`.
- [ ] **Also update the merged reliability engine fix text** (`reliabilityAudit.ts`, `missingResourceRequests`): change `fix` from "Set resources.requests for cpu and memory on the container." to "Set cpu and memory requests, sized from observed usage — a metrics backend or the Right-sizing panel is needed to recommend values." (No test asserts this string; verify reliability tests still pass.)
- [ ] **Extend `auditPrompt.test.ts`**: keep the reliability cases; add one per new builder asserting the title + a seeded `"type"` row + `SEED_CAP` capping still applies (reuse the `many()` helper). Add a test that a performance finding **with** `evidence` keeps `evidence` in the seeded row, and that the fixed "NEVER invent" rule appears in every audit's prompt. Keep the compact-rows / no-rationale assertions.
- [ ] **Run:** `pnpm --filter web test auditPrompt` → PASS. **Commit:** `refactor(web): generalize audit handoff prompt for all three audits (HELM-20)`.

---

## Group E — Hooks + tab wiring

**Files:** Create `useSecurityAudit.ts` (+ test), `usePerformanceAudit.ts` (+ test); edit `AuditSkillsTab.tsx` (+ test).

### Task E1: `useSecurityAudit`

- [ ] Mirror `useReliabilityAudit` exactly, but run `analyzeSecurity`. Same watches are fine (it only needs workloads, but sharing the subscription set is harmless and consistent); or subscribe just the three workload kinds. Return `{ findings, counts }` via `sortFindings` + `auditCounts`. Test mirrors `useReliabilityAudit.test.ts` (jsdom pragma + `@/lib/ws` mock + store snapshot → a `privilegedContainer` or `runsAsRoot` finding).
- [ ] **Commit:** `feat(web): useSecurityAudit hook (HELM-19)`.

### Task E2: `usePerformanceAudit` (hybrid — reuse the right-sizing usage path)

- [ ] Mirror `useReliabilityAudit` for the spec side, and additionally fetch usage like `useRightSizing`: detect backend (`fetchBackends`), fetch 30d usage (`fetchUsageHistory`, poll 120s), and build a `PerfUsageProvider` from `windowStatsFromUsage` (import from `@/panels/rightsizing/aggregate`). Pass `usage: undefined` when no backend so the engine degrades to spec-only. Return `{ findings, counts, usingBackend, noBackend }`.
- [ ] The provider adapts a `WindowStats` (`{ cpuPeak, memPeak, hoursCovered, ... }`) to `PerfUsage` — the field names already line up; wrap so it returns `undefined` when `hoursCovered === 0`.
- [ ] **Test**: (a) no-backend → only spec findings (mock `fetchUsageHistory` → `{available:false}`), asserting `noMemoryLimit` present and no metrics types; (b) with-backend → mock usage returning a high `cpuPeak` for a container that has a `cpuLimit`, asserting a `cpuThrottlingRisk` finding. Mock `@/lib/ws` + the metrics fetch functions.
- [ ] **Commit:** `feat(web): usePerformanceAudit hook (hybrid metrics) (HELM-20)`.

### Task E3: Flip the Security + Performance cards live

- [ ] In `AuditSkillsTab.tsx`: call `useSecurityAudit()` and `usePerformanceAudit()`. Change the Security and Performance `AuditSkillCard`s from `status="soon"` to `status="live"`, passing each card its `counts` and an `onRun` that calls `handoffToChat(build<X>AuditPrompt(findings), { newThread: true })`. For Performance, when `noBackend`, pass a prop/append to the description noting "Runs spec checks now; connect a metrics backend for CPU/memory-pressure checks." (Add an optional `note?: string` prop to `AuditSkillCard` if needed, rendered under the description — small, additive.)
- [ ] **Update `AuditSkillsTab.test.tsx`**: mock all three hooks; assert three live "Run audit" buttons (no "Coming soon"); assert Security Run hands off a prompt containing `"Security audit"` and Performance Run one containing `"Performance audit"`.
- [ ] **Run full gate:** `pnpm --filter @rigel/k8s test && pnpm --filter web test && pnpm --filter web typecheck && pnpm --filter web build` → all PASS.
- [ ] **Commit:** `feat(web): Security + Performance audits live in the Audits tab (HELM-20)`.

---

## Self-review checklist (run after the plan)

- Spec coverage: 7 security checks + 4 performance checks all present with the spec's severities; hybrid degradation (no backend → spec-only) tested; shared core replaces duplicated reliability plumbing with existing tests green.
- No new server routes/PromQL (performance reuses `/api/metrics/usage`).
- No duplicate barrel exports; `ReliabilityWorkloadKind` alias preserved so the adapter needs no import change beyond the new fields.

## Out of scope (v1)

Wide-RBAC / NetworkPolicy security checks; excessive-restarts perf check (needs pods); premium gating (HELM-16); new server metrics queries.
