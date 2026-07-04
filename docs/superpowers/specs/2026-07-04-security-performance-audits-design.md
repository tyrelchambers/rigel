# Security & Performance Audit Skills — Design

**Ticket:** HELM-20 (audit skills family) / HELM-19 (security audit)
**Date:** 2026-07-04
**Status:** Approved (check sets + hybrid Performance confirmed), ready for plan
**Builds on:** `2026-07-04-reliability-audit-skill-design.md` (the template)

## Summary

Add the second and third audit skills — **Security** and **Performance** — to the
Audits tab, flipping their "coming soon" cards to live. Both reuse the Reliability
template (deterministic engine → hook → chat handoff with action-block fixes).
This work also **extracts a shared audit core** so the three audits do not each
duplicate severity/sort/counts/input plumbing.

- **Security** is spec-based (reads pod/container `securityContext` + pod spec), so
  it runs on every cluster like Reliability. This is effectively HELM-19.
- **Performance** is **hybrid**: spec-based checks always run; metrics-backed
  checks run only when a Prometheus/VM backend is detected, reusing the existing
  right-sizing `/api/metrics/usage` endpoint — **no server changes**.

## Resource-value principle (cross-cutting)

Rigel drives remediation from **evidence + best practices** and must **never fabricate CPU/memory request/limit numbers**. Concrete values come only from observed usage (the metrics backend, same source as Right-sizing). Resource fixes carry `evidence` (present only when a backend exists); with no backend the finding still surfaces but the fix is advisory (no numbers). Enforced by a fixed rule in `buildAuditPrompt` + `evidence` on findings. This also corrects the merged Reliability `missingResourceRequests` fix (now advisory, not a numeric `setResources`).

## Non-goals (v1)

- Wide-RBAC / missing-NetworkPolicy security checks (different data sources; RBAC
  already has its own analyzer panel). Deferred.
- Excessive-restarts performance check (needs per-pod `restartCount` → a pods
  watch + pod→workload mapping). Deferred.
- New server PromQL. Performance reuses the existing usage endpoint only.
- Premium gating (still HELM-16; cards stay free/open).

## Part 1 — Shared audit core (`packages/k8s/src/auditCommon.ts`)

Extract the finding-shape-agnostic pieces currently living in `reliabilityAudit.ts`
so all three engines share them (DRY — three audits, one core):

```ts
export type Severity = "critical" | "warning" | "info";
export const SEVERITY_RANK: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };
export type AuditWorkloadKind = "Deployment" | "StatefulSet" | "DaemonSet";

/** Base shape every audit's finding conforms to. */
export interface AuditFinding {
  type: string;
  severity: Severity;
  kind: AuditWorkloadKind;
  name: string;
  namespace: string;
  container?: string;
  rationale: string;
  fix: string;
}

export interface AuditCounts { critical: number; warning: number; info: number; total: number; workloadsAffected: number; }

export function sortFindings<T extends AuditFinding>(findings: T[]): T[]; // severity, ns, name, type
export function auditCounts(findings: AuditFinding[]): AuditCounts;
```

The **normalized input types** (`AuditContainer`, `AuditWorkload`, `AuditPdb`,
`AuditHpa`) also move here and are **extended with additive optional fields** for
security and performance, so a single adapter (`extractAuditInputs`) feeds all
three engines:

```ts
export interface AuditContainer {
  name: string;
  image?: string;
  // reliability
  hasLiveness: boolean; hasReadiness: boolean; hasCpuRequest: boolean; hasMemRequest: boolean;
  // security
  privileged?: boolean; allowPrivilegeEscalation?: boolean;
  runAsNonRoot?: boolean; runAsUser?: number;
  readOnlyRootFilesystem?: boolean; addedCapabilities?: string[]; hostPorts?: number[];
  // performance
  hasCpuLimit?: boolean; hasMemLimit?: boolean; cpuLimit?: number; memLimit?: number; // cores / bytes
}

export interface AuditWorkload {
  kind: AuditWorkloadKind; name: string; namespace: string; replicas: number;
  labels: Record<string, string>; containers: AuditContainer[];
  hasAntiAffinity: boolean; hasHostPath: boolean;
  // security (pod-level)
  hostNetwork?: boolean; hostPID?: boolean; hostIPC?: boolean;
  podRunAsNonRoot?: boolean; podRunAsUser?: number;
}
```

**`reliabilityAudit.ts` is refactored** to import `Severity`/`SEVERITY_RANK`/
`AuditWorkloadKind`/input types from `auditCommon`, and its `ReliabilityFinding`
becomes `extends AuditFinding` (with `type: ReliabilityFindingType`). The generic
`sortFindings`/`auditCounts` replace the reliability-specific `sortFindings`/
`reliabilityCounts`.

**Consumer updates** (rename, mechanical): `useReliabilityAudit`, `auditPrompt`,
`AuditSkillCard`, and the reliability test switch `reliabilityCounts`→`auditCounts`
and `ReliabilityCounts`→`AuditCounts`. All existing tests must stay green.

**Barrel** (`index.ts`): export shared names from `auditCommon`, reliability-
specific from `reliabilityAudit`, security-specific from `securityAudit`, perf-
specific from `performanceAudit` — no duplicate exports.

## Part 2 — Security engine (`packages/k8s/src/securityAudit.ts`)

`analyzeSecurity(input: { workloads: AuditWorkload[] }) -> SecurityFinding[]`
(`SecurityFinding extends AuditFinding` with a `SecurityFindingType` union). Pure,
spec-only. Checks:

| type | Severity | Rule |
|---|---|---|
| `privilegedContainer` | critical | container `privileged === true` |
| `hostNamespace` | critical | pod `hostNetwork` OR `hostPID` OR `hostIPC` === true (one finding, names which) |
| `runsAsRoot` | warning | not effectively non-root: neither container nor pod sets `runAsNonRoot: true`, and no non-zero `runAsUser` (container overrides pod) |
| `allowsPrivilegeEscalation` | warning | container `allowPrivilegeEscalation !== false` |
| `addedCapabilities` | warning | container `addedCapabilities` non-empty (call out `SYS_ADMIN`/`NET_ADMIN`/`NET_RAW`) |
| `writableRootFilesystem` | info | container `readOnlyRootFilesystem !== true` |
| `hostPort` | info | container binds a `hostPort` |

Fixes map to `applyManifest` (patch the securityContext / pod spec). `hostNamespace`
and `privilegedContainer` are workload-level; the rest are container-scoped.

**Effective-non-root logic** (`runsAsRoot`): non-root if the container sets
`runAsNonRoot: true` OR a non-zero `runAsUser`; else fall back to the pod's
`podRunAsNonRoot`/`podRunAsUser`; if neither establishes non-root → flag.

## Part 3 — Performance engine (`packages/k8s/src/performanceAudit.ts`)

`analyzePerformance(input: { workloads, hpas, usage? }) -> PerformanceFinding[]`.
`usage` is an optional per-container peak-usage provider (present only when a
metrics backend is detected):

```ts
export interface PerfUsage { cpuPeak: number; memPeak: number; hoursCovered: number } // cores / bytes
export type PerfUsageProvider = (namespace: string, workload: string, container: string) => PerfUsage | undefined;
```

| type | Severity | Source | Rule |
|---|---|---|---|
| `noMemoryLimit` | warning | spec | container has no memory limit (`hasMemLimit` false) → can OOM the node / noisy neighbor |
| `noAutoscaling` | info | spec+hpa | multi-replica **Deployment** with no HPA targeting it → can't scale to load |
| `cpuThrottlingRisk` | warning | metrics | container has a `cpuLimit` AND `usage.cpuPeak >= 0.95 * cpuLimit` over the window → sustained throttling likely |
| `memoryPressure` | warning | metrics | container has a `memLimit` AND `usage.memPeak >= 0.90 * memLimit` → OOM risk |

- Metrics checks are skipped entirely when `usage` is undefined (no backend) or
  returns undefined for a container (insufficient data). Spec checks always run.
- `noMemoryLimit`/`cpuThrottlingRisk`/`memoryPressure` → `setResources`;
  `noAutoscaling` → `applyManifest` (create an HPA).
- Deliberately excludes "no CPU limit" (contentious — CPU limits cause throttling)
  and over/under-provisioning (that is right-sizing's job).

## Part 4 — Web wiring (`apps/web/src/panels/assistant/audits/`)

- **Adapter**: extend `extractAuditInputs` to populate the new security + perf
  container/pod fields (parse `securityContext`, host namespaces, `hostPort`,
  resource `limits` via the existing `parseQuantity`).
- **Hooks**: `useSecurityAudit()` mirrors `useReliabilityAudit` (spec-only, same
  watches). `usePerformanceAudit()` additionally fetches 30d usage exactly like
  `useRightSizing` (backend detect + `fetchUsageHistory` + `windowStatsFromUsage`
  → a `PerfUsageProvider`), passing `usage: undefined` when no backend so it
  degrades to spec-only. Both return `{ findings, counts, ... }`; performance also
  returns `usingBackend`/`noBackend` for the card hint.
- **Prompt**: generalize `buildReliabilityAuditPrompt` into a shared
  `buildAuditPrompt(config, findings)` (config = audit title, dimensions line for
  the no-issues case, and the `type → action-kind` bullet lines). Keep the same
  bounding behavior (compact rows, `SEED_CAP` cap, severity/type summary).
  Reliability/Security/Performance each pass their config. `buildReliabilityAuditPrompt`
  becomes a thin wrapper (preserves its test/consumer).
- **UI**: in `AuditSkillsTab`, flip the Security and Performance cards from
  `status="soon"` to `status="live"`, wiring each to its hook + prompt. The
  Performance card shows a subtle "needs a metrics backend for full coverage" note
  when `noBackend` (it still runs spec checks).

## Testing

- **Engine unit tests** per check (trips + clean + severity), for both new engines,
  mirroring `reliabilityAudit.test.ts`. Performance: test spec checks with no
  `usage`, and metrics checks with a stub `PerfUsageProvider`.
- **Shared core**: `auditCommon` tests for generic `sortFindings` (mixed severities/
  namespaces) and `auditCounts` (mixed severities, workload dedup).
- **Adapter**: extend `extractAuditInputs.test.ts` for the new security/perf fields.
- **Hooks**: `useSecurityAudit`/`usePerformanceAudit` tests (store snapshot →
  findings; performance with mocked usage fetch → metrics findings, and no-backend →
  spec-only).
- **Prompt**: `buildAuditPrompt` tests (per-config output; bounding preserved).
- **Tab**: `AuditSkillsTab` test — three live cards, each Run hands off its prompt.
- No live-cluster / mutation tests.

## Files

**New:** `packages/k8s/src/auditCommon.ts` (+test), `securityAudit.ts` (+test),
`performanceAudit.ts` (+test); `apps/web/.../audits/useSecurityAudit.ts` (+test),
`usePerformanceAudit.ts` (+test).

**Edited:** `reliabilityAudit.ts` (use shared core), `packages/k8s/src/index.ts`
(barrel), `extractAuditInputs.ts` (+test) (new fields), `auditPrompt.ts` (+test)
(generalize), `useReliabilityAudit.ts` + `AuditSkillCard.tsx` (rename to
`auditCounts`/`AuditCounts`), `AuditSkillsTab.tsx` (+test) (flip cards live).

**No server changes.**

## Rollout note

After merge: update the HELM-20 Outline doc (now three audits) and Plane tickets
(HELM-19 done; performance metrics-follow-ups; gating still HELM-16).
