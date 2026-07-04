# Metric-threshold Alert Conditions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the in-cluster alert agent fire on node CPU % and node memory % thresholds (e.g. "node memory > 90% for 10m"), evaluated against the auto-detected Prometheus/VictoriaMetrics backend, gated on that backend being present.

**Architecture:** Add a `metricThreshold` condition and a `node` scope to the shared alert types (`packages/k8s`). Extract the pure Prometheus detect/encode/parse helpers out of the server into `packages/k8s/src/prometheus.ts` and add node-percent PromQL builders, so both the server and the standalone agent import one copy. The agent's deterministic tick collects a per-node metric snapshot (only when a metric rule exists and a backend is detected) and passes it into the pure `evaluateAlertRules`, which tracks a per-node for-duration timer in `AlertState` and reuses the existing cooldown gate. The web New-alert form gains the condition (gated on `/api/metrics/backends`) with a node dropdown.

**Tech Stack:** TypeScript monorepo, pnpm workspaces, Vitest. `packages/k8s` (shared domain), `agent` (standalone esbuild bundle, imports `@rigel/k8s/src/*.js` via tsconfig path alias), `apps/server` (Node backend), `apps/web` (React 19 + Vite, TanStack Query + Zustand store).

**Design doc:** `docs/superpowers/specs/2026-07-03-metric-threshold-alerts-design.md`

**Conventions to match:**
- `packages/k8s` test imports are extensionless (`from "./alerts"`); `agent` test/source imports use explicit `.js` (`from "./alerts.js"`, `from "@rigel/k8s/src/prometheus.js"`).
- Run a single package's tests with `pnpm --filter <pkg> test <path>`; typecheck with `pnpm --filter <pkg> typecheck`.
- Commit after each green task.

---

## Task 1: Shared alert types — `node` scope + `metricThreshold` condition

**Files:**
- Modify: `packages/k8s/src/alerts.ts`
- Test: `packages/k8s/src/alerts.test.ts` (exists)

- [ ] **Step 1: Write failing tests**

Append to `packages/k8s/src/alerts.test.ts`:

```ts
import {
  normalizeAlertRule,
  alertRuleSummary,
  type SuggestedAlert,
} from "./alerts";

describe("metricThreshold condition", () => {
  const metricBlock = (over: Partial<SuggestedAlert> = {}): SuggestedAlert => ({
    label: "Alert: node memory high",
    text: "alert when a node's memory goes above 90%",
    target: { scope: "node" },
    condition: { type: "metricThreshold", metric: "memoryPercent", comparator: "above", threshold: 90, minutes: 10 },
    ...over,
  });

  it("normalizes a node metric rule and defaults cooldown from the for-duration", () => {
    const r = normalizeAlertRule(metricBlock(), "id-m", 1_700_000_000_000);
    expect(r.condition.type).toBe("metricThreshold");
    expect(r.target.scope).toBe("node");
    expect(r.cooldownMinutes).toBe(10); // conditionWindowMinutes → minutes(10) ≥ 5 floor
  });

  it("accepts an optional specific node name", () => {
    const r = normalizeAlertRule(metricBlock({ target: { scope: "node", name: "node-a" } }), "id-m2", 0);
    expect(r.target.name).toBe("node-a");
  });

  it("rejects a metric rule whose target is not node scope", () => {
    expect(() =>
      normalizeAlertRule(metricBlock({ target: { scope: "namespace", namespace: "prod" } }), "x", 0),
    ).toThrow(/require a node target/);
  });

  it("rejects a node-scoped rule with a non-metric condition", () => {
    expect(() =>
      normalizeAlertRule(
        { label: "l", text: "t", target: { scope: "node" }, condition: { type: "crashLoop" } },
        "x",
        0,
      ),
    ).toThrow(/node-scoped/);
  });

  it("rejects an out-of-range threshold", () => {
    expect(() =>
      normalizeAlertRule(metricBlock({ condition: { type: "metricThreshold", metric: "cpuPercent", comparator: "above", threshold: 150, minutes: 5 } }), "x", 0),
    ).toThrow(/threshold/);
  });

  it("summarizes node metric rules", () => {
    const r = normalizeAlertRule(metricBlock(), "id-m", 0);
    expect(alertRuleSummary(r)).toBe("any node — memory above 90% for 10m");
    const r2 = normalizeAlertRule(metricBlock({ target: { scope: "node", name: "node-a" }, condition: { type: "metricThreshold", metric: "cpuPercent", comparator: "above", threshold: 80, minutes: 5 } }), "id-c", 0);
    expect(alertRuleSummary(r2)).toBe("node node-a — CPU above 80% for 5m");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @rigel/k8s test src/alerts.test.ts`
Expected: FAIL (type errors / `require a node target` not thrown — `metricThreshold`/`node` don't exist yet).

- [ ] **Step 3: Edit `packages/k8s/src/alerts.ts`**

Replace the `AlertScope` line (line 6):

```ts
export type AlertScope = "cluster" | "namespace" | "workload" | "pod" | "database" | "node";
```

Add metric helper types and extend the condition union (replace lines 16-22):

```ts
export type MetricKind = "cpuPercent" | "memoryPercent";
export type MetricComparator = "above" | "below";

export type AlertCondition =
  | { type: "podRestarts"; threshold: number; windowMinutes: number }
  | { type: "crashLoop" }
  | { type: "oomKilled" }
  | { type: "pendingTooLong"; minutes: number }
  | { type: "notReady"; minutes: number }
  | { type: "deploymentDegraded"; minutes: number }
  | { type: "metricThreshold"; metric: MetricKind; comparator: MetricComparator; threshold: number; minutes: number };
```

Extend `SCOPES` and `CONDITION_TYPES` (replace lines 42-45):

```ts
const SCOPES = new Set<AlertScope>(["cluster", "namespace", "workload", "pod", "database", "node"]);
const CONDITION_TYPES = new Set([
  "podRestarts", "crashLoop", "oomKilled", "pendingTooLong", "notReady", "deploymentDegraded", "metricThreshold",
]);
```

Extend `conditionWindowMinutes` (replace line 50):

```ts
  if (c.type === "pendingTooLong" || c.type === "notReady" || c.type === "deploymentDegraded" || c.type === "metricThreshold") return c.minutes;
```

Extend `validateTarget` so `node` needs neither name nor namespace (replace line 57):

```ts
  if (t.scope !== "cluster" && t.scope !== "namespace" && t.scope !== "node" && !t.name) {
```

Extend `validateCondition` — add the metric checks before the closing brace (insert after line 73, before the `for (const k of ["minutes"]...` loop):

```ts
  if (c.type === "metricThreshold") {
    if (c.metric !== "cpuPercent" && c.metric !== "memoryPercent") throw new Error("metricThreshold needs a valid metric");
    if (c.comparator !== "above" && c.comparator !== "below") throw new Error("metricThreshold needs a valid comparator");
    if (!(c.threshold > 0) || !(c.threshold <= 100)) throw new Error("metricThreshold needs threshold in (0,100]");
  }
```

Add cross-field scope/condition guards in `normalizeAlertRule` — insert after the existing `deploymentDegraded` guard (after line 86):

```ts
  if (block.condition.type === "metricThreshold" && block.target.scope !== "node") {
    throw new Error("metricThreshold alerts require a node target");
  }
  if (block.target.scope === "node" && block.condition.type !== "metricThreshold") {
    throw new Error("node-scoped alerts require a metric-threshold condition");
  }
```

Extend `alertRuleSummary` — add a `node` branch to `loc` (replace lines 158-161) and a `metricThreshold` branch to `cond` (replace lines 163-169):

```ts
  const loc =
    t.scope === "cluster" ? "anything in the cluster"
    : t.scope === "namespace" ? `namespace ${t.namespace}`
    : t.scope === "node" ? (t.name ? `node ${t.name}` : "any node")
    : `${t.scope} ${t.namespace ? `${t.namespace}/` : ""}${t.name}`;
  const c = rule.condition;
  const cond =
    c.type === "podRestarts" ? `restarts >${c.threshold} in ${c.windowMinutes}m`
    : c.type === "crashLoop" ? "crash-looping"
    : c.type === "oomKilled" ? "OOM-killed"
    : c.type === "pendingTooLong" ? `pending >${c.minutes}m`
    : c.type === "notReady" ? `not ready ${c.minutes}m`
    : c.type === "deploymentDegraded" ? `degraded ${c.minutes}m`
    : `${c.metric === "cpuPercent" ? "CPU" : "memory"} ${c.comparator} ${c.threshold}% for ${c.minutes}m`;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @rigel/k8s test src/alerts.test.ts`
Expected: PASS (all metricThreshold tests + existing tests green).

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @rigel/k8s typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/k8s/src/alerts.ts packages/k8s/src/alerts.test.ts
git commit -m "feat(k8s): add node scope + metricThreshold alert condition (HELM-29)"
```

---

## Task 2: Shared Prometheus helpers — extract to `packages/k8s` + node-percent queries

**Files:**
- Create: `packages/k8s/src/prometheus.ts`
- Create: `packages/k8s/src/prometheus.test.ts`
- Modify: `apps/server/src/prometheusMetrics.ts` (import/re-export the pure helpers instead of defining them)

- [ ] **Step 1: Write failing tests**

Create `packages/k8s/src/prometheus.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  detectAllBackendsFromServices,
  pickBackend,
  proxyBase,
  promEncode,
  parsePromInstant,
  seriesToNodeMap,
  nodeCpuPercentQuery,
  nodeMemoryPercentQuery,
} from "./prometheus";

describe("detectAllBackendsFromServices", () => {
  it("recognizes the rigel-metrics install service by port", () => {
    const b = detectAllBackendsFromServices([
      { metadata: { name: "rigel-metrics", namespace: "rigel-metrics" }, spec: { ports: [{ port: 8428 }] } },
    ]);
    expect(b).toEqual([{ namespace: "rigel-metrics", service: "rigel-metrics", port: 8428, flavor: "VictoriaMetrics" }]);
  });
});

describe("pickBackend", () => {
  it("prefers the installed rigel-metrics service", () => {
    const chosen = pickBackend([
      { namespace: "x", service: "prometheus", port: 9090, flavor: "Prometheus" },
      { namespace: "m", service: "rigel-metrics", port: 8428, flavor: "VictoriaMetrics" },
    ]);
    expect(chosen?.service).toBe("rigel-metrics");
  });
});

describe("proxyBase + promEncode", () => {
  it("builds the API-server service-proxy path", () => {
    expect(proxyBase({ namespace: "ns", service: "svc", port: 8428, flavor: "VictoriaMetrics" }))
      .toBe("/api/v1/namespaces/ns/services/svc:8428/proxy");
  });
  it("percent-encodes reserved PromQL chars", () => {
    expect(promEncode("a b")).toBe("a%20b");
  });
});

describe("node percent query builders", () => {
  it("memory query has no node filter when node omitted", () => {
    expect(nodeMemoryPercentQuery()).toBe(
      '100 * max by (kubernetes_io_hostname) (container_memory_working_set_bytes{id="/"}) / max by (kubernetes_io_hostname) (machine_memory_bytes)',
    );
  });
  it("cpu query filters by hostname when node given", () => {
    expect(nodeCpuPercentQuery("node-a")).toBe(
      '100 * sum by (kubernetes_io_hostname) (rate(container_cpu_usage_seconds_total{id="/",kubernetes_io_hostname="node-a"}[5m])) / max by (kubernetes_io_hostname) (machine_cpu_cores{kubernetes_io_hostname="node-a"})',
    );
  });
});

describe("seriesToNodeMap", () => {
  it("maps hostname → numeric percent, dropping non-finite values", () => {
    const map = seriesToNodeMap([
      { metric: { kubernetes_io_hostname: "node-a" }, value: [0, "91.5"] },
      { metric: { kubernetes_io_hostname: "node-b" }, value: [0, "NaN"] },
      { metric: {}, value: [0, "50"] },
    ]);
    expect(map).toEqual({ "node-a": 91.5 });
  });
});

describe("parsePromInstant", () => {
  it("returns [] on a non-success payload", () => {
    expect(parsePromInstant('{"status":"error"}')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @rigel/k8s test src/prometheus.test.ts`
Expected: FAIL (`./prometheus` does not exist).

- [ ] **Step 3: Create `packages/k8s/src/prometheus.ts`**

Move the pure helpers out of the server verbatim and add the new builders:

```ts
// packages/k8s/src/prometheus.ts
// Pure Prometheus/VictoriaMetrics backend detection + PromQL helpers, shared by
// the server (apps/server/src/prometheusMetrics.ts) and the in-cluster agent
// (agent/src/metrics.ts). No kubectl here — each caller supplies its own runner.

/** Service name Rigel's own metrics-install flow creates (MetricsInstallManifests). */
const INSTALL_SERVICE = "rigel-metrics";

export interface PromBackend {
  namespace: string;
  service: string;
  port: number;
  flavor: "VictoriaMetrics" | "Prometheus" | "Metrics";
}

export interface PromSeries {
  metric: Record<string, string>;
  value: [number, string];
}

interface ServicePort {
  name?: string;
  port: number;
}
export interface ServiceJson {
  metadata?: { name?: string; namespace?: string };
  spec?: { ports?: ServicePort[] };
}

export function flavorForPort(port: number): PromBackend["flavor"] {
  if (port === 8428 || port === 8481) return "VictoriaMetrics";
  if (port === 9090) return "Prometheus";
  return "Metrics";
}

export function detectAllBackendsFromServices(services: ServiceJson[]): PromBackend[] {
  const candidates: PromBackend[] = [];
  for (const svc of services) {
    const rawName = svc.metadata?.name ?? "";
    const name = rawName.toLowerCase();
    const ns = svc.metadata?.namespace ?? "default";
    const ports = svc.spec?.ports ?? [];
    if (!rawName) continue;

    if (
      name.includes("operator") ||
      name.includes("node-exporter") ||
      name.includes("alertmanager") ||
      name.includes("kube-state")
    ) {
      continue;
    }

    if (name === INSTALL_SERVICE) {
      const p =
        ports.find((x) => x.port === 8428 || x.port === 9090 || x.port === 8481) ?? ports[0];
      if (p) candidates.push({ namespace: ns, service: rawName, port: p.port, flavor: flavorForPort(p.port) });
      continue;
    }

    if (name.includes("prometheus")) {
      const p =
        ports.find((x) => x.port === 9090) ??
        ports.find((x) => (x.name ?? "").includes("web") || (x.name ?? "") === "http");
      if (p) {
        candidates.push({ namespace: ns, service: rawName, port: p.port, flavor: "Prometheus" });
        continue;
      }
    }

    if (name.includes("victoria") || name.startsWith("vmsingle") || name.includes("vmselect")) {
      const p = ports.find((x) => x.port === 8428 || x.port === 8481) ?? ports[0];
      if (p) candidates.push({ namespace: ns, service: rawName, port: p.port, flavor: "VictoriaMetrics" });
    }
  }

  const seen = new Set<string>();
  return candidates.filter((c) => {
    const key = `${c.namespace}/${c.service}:${c.port}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function pickBackend(list: PromBackend[]): PromBackend | null {
  return (
    list.find((c) => c.service === INSTALL_SERVICE) ??
    list.find((c) => c.flavor === "VictoriaMetrics") ??
    list.find((c) => c.flavor === "Prometheus") ??
    list[0] ??
    null
  );
}

export function proxyBase(b: PromBackend): string {
  return `/api/v1/namespaces/${b.namespace}/services/${b.service}:${b.port}/proxy`;
}

export function promEncode(promql: string): string {
  return promql.replace(/[^A-Za-z0-9]/g, (c) =>
    "%" + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0"),
  );
}

export function parsePromInstant(stdout: string): PromSeries[] {
  try {
    const json = JSON.parse(stdout) as { status?: string; data?: { result?: unknown } };
    if (json?.status !== "success") return [];
    return Array.isArray(json.data?.result) ? (json.data!.result as PromSeries[]) : [];
  } catch {
    return [];
  }
}

/** Percent-of-capacity per node, grouped by the cAdvisor scrape's node label
 * (kubernetes_io_hostname). The rigel-metrics install scrapes cAdvisor via the
 * API-server node proxy; the root cgroup ({id="/"}) is the node total and
 * machine_* gauges are node capacity. */
export function nodeMemoryPercentQuery(node?: string): string {
  const w = node ? `,kubernetes_io_hostname="${node}"` : "";
  const cap = node ? `{kubernetes_io_hostname="${node}"}` : "";
  return `100 * max by (kubernetes_io_hostname) (container_memory_working_set_bytes{id="/"${w}}) / max by (kubernetes_io_hostname) (machine_memory_bytes${cap})`;
}

export function nodeCpuPercentQuery(node?: string): string {
  const w = node ? `,kubernetes_io_hostname="${node}"` : "";
  const cap = node ? `{kubernetes_io_hostname="${node}"}` : "";
  return `100 * sum by (kubernetes_io_hostname) (rate(container_cpu_usage_seconds_total{id="/"${w}}[5m])) / max by (kubernetes_io_hostname) (machine_cpu_cores${cap})`;
}

/** Fold an instant-query result into { nodeName: percent }, dropping series
 * without a hostname label or a finite value. */
export function seriesToNodeMap(series: PromSeries[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of series) {
    const node = s.metric["kubernetes_io_hostname"];
    const v = Number(s.value?.[1]);
    if (node && Number.isFinite(v)) out[node] = v;
  }
  return out;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @rigel/k8s test src/prometheus.test.ts`
Expected: PASS.

- [ ] **Step 5: Re-point the server at the shared helpers**

In `apps/server/src/prometheusMetrics.ts`, delete the local definitions of `PromBackend`, `PromSeries`, `ServicePort`, `ServiceJson`, `flavorForPort`, `detectAllBackendsFromServices`, `pickBackend`, `proxyBase`, `promEncode`, `parsePromInstant`, and the `INSTALL_SERVICE` const. Replace them with an import + re-export near the top of the file (keep the `kubectl` import and the `SCRAPE_INTERVAL_SECONDS`/`WINDOW` consts):

```ts
import { kubectl } from "@rigel/k8s/src/run";
import {
  type PromBackend,
  type PromSeries,
  type ServiceJson,
  flavorForPort,
  detectAllBackendsFromServices,
  pickBackend,
  proxyBase,
  promEncode,
  parsePromInstant,
} from "@rigel/k8s/src/prometheus";

// Re-export so existing importers of this module keep working unchanged.
export {
  type PromBackend,
  type PromSeries,
  flavorForPort,
  detectAllBackendsFromServices,
  pickBackend,
  proxyBase,
  promEncode,
  parsePromInstant,
};
```

Leave the kubectl-executing functions (`detectAllBackends`, the private `instantQuery`, `usageQueries`, `mergeUsage`, `getUsageHistory`) in place — they now use the imported pure helpers.

- [ ] **Step 6: Verify the server still compiles and tests pass**

Run: `pnpm --filter @rigel/k8s typecheck && pnpm --filter @rigel/server typecheck && pnpm --filter @rigel/server test`
Expected: no type errors; server tests green (any existing prometheus tests still pass against the re-exports).

- [ ] **Step 7: Commit**

```bash
git add packages/k8s/src/prometheus.ts packages/k8s/src/prometheus.test.ts apps/server/src/prometheusMetrics.ts
git commit -m "refactor(k8s): share Prometheus helpers + add node-percent queries (HELM-29)"
```

---

## Task 3: Agent evaluator — mirror type + metric snapshot + for-duration

**Files:**
- Modify: `agent/src/alerts.ts`
- Test: `agent/src/alerts.test.ts` (exists)

- [ ] **Step 1: Write failing tests**

Append to `agent/src/alerts.test.ts` (the file already has `rule`, `T0`, `min` helpers and imports `evaluateAlertRules`, `emptyAlertState`, `type AlertRule` from `./alerts.js`):

```ts
import { type MetricSnapshot } from "./alerts.js";

const metricRule = (over: Partial<AlertRule> = {}): AlertRule => ({
  id: "m1", enabled: true, text: "node mem", cooldownMinutes: 5,
  target: { scope: "node" },
  condition: { type: "metricThreshold", metric: "memoryPercent", comparator: "above", threshold: 90, minutes: 10 },
  createdAt: "", ...over,
});

const snap = (mem: Record<string, number> = {}, cpu: Record<string, number> = {}): MetricSnapshot => ({
  cpuPercentByNode: cpu, memoryPercentByNode: mem,
});

describe("metricThreshold", () => {
  it("does not fire before the for-duration elapses, fires after", () => {
    const r = metricRule();
    // First tick: breach starts, timer at 0 → no fire.
    let s = evaluateAlertRules([r], [], [], emptyAlertState(), T0, snap({ "node-a": 95 }));
    expect(s.events).toEqual([]);
    expect(s.alertState.metricBreaches["m1|node-a"].since).toBe(new Date(T0).toISOString());
    // 11 min later, still breached, timer ≥ 10m → fire.
    const s2 = evaluateAlertRules([r], [], [], s.alertState, T0 + min(11), snap({ "node-a": 95 }));
    expect(s2.events).toHaveLength(1);
    expect(s2.events[0].message).toContain('node "node-a" memory at 95%');
  });

  it("clears the breach timer when the node drops below threshold", () => {
    const r = metricRule();
    let s = evaluateAlertRules([r], [], [], emptyAlertState(), T0, snap({ "node-a": 95 }));
    const s2 = evaluateAlertRules([r], [], [], s.alertState, T0 + min(5), snap({ "node-a": 70 }));
    expect(s2.alertState.metricBreaches["m1|node-a"]).toBeUndefined();
  });

  it("preserves the breach timer when metric data is missing this tick", () => {
    const r = metricRule();
    let s = evaluateAlertRules([r], [], [], emptyAlertState(), T0, snap({ "node-a": 95 }));
    const s2 = evaluateAlertRules([r], [], [], s.alertState, T0 + min(5), snap({})); // empty (query failed)
    expect(s2.alertState.metricBreaches["m1|node-a"].since).toBe(new Date(T0).toISOString());
    expect(s2.events).toEqual([]);
  });

  it("honors comparator=below", () => {
    const r = metricRule({ condition: { type: "metricThreshold", metric: "cpuPercent", comparator: "below", threshold: 5, minutes: 0 } });
    const s = evaluateAlertRules([r], [], [], emptyAlertState(), T0, snap({}, { "node-a": 2 }));
    expect(s.events).toHaveLength(1);
    expect(s.events[0].message).toContain("CPU");
  });

  it("filters to a specific target node", () => {
    const r = metricRule({ condition: { type: "metricThreshold", metric: "memoryPercent", comparator: "above", threshold: 90, minutes: 0 }, target: { scope: "node", name: "node-b" } });
    const s = evaluateAlertRules([r], [], [], emptyAlertState(), T0, snap({ "node-a": 99, "node-b": 91 }));
    expect(s.events).toHaveLength(1);
    expect(s.events[0].message).toContain("node-b");
    expect(s.events[0].message).not.toContain("node-a");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter rigel-assistant-agent test src/alerts.test.ts`
Expected: FAIL (`MetricSnapshot` not exported; `evaluateAlertRules` takes no metrics arg; `metricThreshold` not handled).

- [ ] **Step 3: Edit `agent/src/alerts.ts`**

Extend the mirrored `AlertCondition` union (replace lines 17-23):

```ts
export type AlertCondition =
  | { type: "podRestarts"; threshold: number; windowMinutes: number }
  | { type: "crashLoop" }
  | { type: "oomKilled" }
  | { type: "pendingTooLong"; minutes: number }
  | { type: "notReady"; minutes: number }
  | { type: "deploymentDegraded"; minutes: number }
  | { type: "metricThreshold"; metric: "cpuPercent" | "memoryPercent"; comparator: "above" | "below"; threshold: number; minutes: number };
```

Add the metric-snapshot type and extend `AlertState` (replace lines 35-38):

```ts
export interface MetricSnapshot {
  cpuPercentByNode: Record<string, number>;
  memoryPercentByNode: Record<string, number>;
}

export interface AlertState {
  lastFiredAt: Record<string, string>;
  restartBaselines: Record<string, { count: number; since: string }>;
  metricBreaches: Record<string, { since: string }>;
}
```

Extend `emptyAlertState` (replace line 46):

```ts
  return { lastFiredAt: {}, restartBaselines: {}, metricBreaches: {} };
```

Extend `CONDITION_TYPES` (replace lines 50-52):

```ts
const CONDITION_TYPES = new Set([
  "podRestarts", "crashLoop", "oomKilled", "pendingTooLong", "notReady", "deploymentDegraded", "metricThreshold",
]);
```

Extend `conditionFieldsValid` — add before its final `return true;` (after line 56):

```ts
  if (c.type === "metricThreshold") {
    return typeof c.threshold === "number" && c.threshold > 0 && c.threshold <= 100 &&
      typeof c.minutes === "number" && c.minutes >= 0;
  }
```

Add `metrics` to `evaluateAlertRules` (replace lines 197-205):

```ts
export function evaluateAlertRules(
  rules: AlertRule[],
  pods: Pod[],
  deps: Dep[],
  prev: AlertState,
  now: number,
  metrics: MetricSnapshot = { cpuPercentByNode: {}, memoryPercentByNode: {} },
): { events: AlertEvent[]; alertState: AlertState } {
  const events: AlertEvent[] = [];
  const next: AlertState = { lastFiredAt: {}, restartBaselines: {}, metricBreaches: {} };
```

Thread `metrics` into the `evaluateCondition` call (replace line 213):

```ts
    const detail = evaluateCondition(rule, pods, deps, prev, next, now, metrics);
```

Add `metrics` to the `evaluateCondition` signature (replace lines 227-229):

```ts
function evaluateCondition(
  rule: AlertRule, pods: Pod[], deps: Dep[], prev: AlertState, next: AlertState, now: number, metrics: MetricSnapshot,
): string {
```

Add the `metricThreshold` branch at the top of `evaluateCondition`, right after `const c = rule.condition;` (before the `if (c.type === "deploymentDegraded")` block):

```ts
  if (c.type === "metricThreshold") {
    const byNode = c.metric === "cpuPercent" ? metrics.cpuPercentByNode : metrics.memoryPercentByNode;
    const prevBreaches = prev.metricBreaches ?? {};
    const nodes = Object.keys(byNode);
    if (nodes.length === 0) {
      // No metric data this tick (backend missing/failed). Preserve the rule's
      // breach timers so a transient blip doesn't reset the for-duration clock.
      for (const [key, b] of Object.entries(prevBreaches)) {
        if (key.startsWith(`${rule.id}|`)) next.metricBreaches[key] = b;
      }
      return "";
    }
    let hit = "";
    for (const node of nodes) {
      if (rule.target.name && node !== rule.target.name) continue;
      const pct = byNode[node];
      if (pct === undefined) continue;
      const breached = c.comparator === "above" ? pct > c.threshold : pct < c.threshold;
      if (!breached) continue; // not copying to next clears the timer
      const b = prevBreaches[`${rule.id}|${node}`] ?? { since: new Date(now).toISOString() };
      next.metricBreaches[`${rule.id}|${node}`] = b;
      if (!hit && now - Date.parse(b.since) >= c.minutes * 60_000) {
        const label = c.metric === "cpuPercent" ? "CPU" : "memory";
        const op = c.comparator === "above" ? ">" : "<";
        hit = `node "${node}" ${label} at ${Math.round(pct)}% (${op}${c.threshold}% for ${c.minutes}m)`;
      }
    }
    return hit;
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter rigel-assistant-agent test src/alerts.test.ts`
Expected: PASS (metricThreshold tests + all existing alert tests green).

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter rigel-assistant-agent typecheck`
Expected: no errors. (If `agent/src/state.ts` references `AlertState`, it inherits the new field automatically; a persisted state from an older agent that lacks `metricBreaches` is tolerated because `evaluateCondition` reads `prev.metricBreaches ?? {}`.)

- [ ] **Step 6: Commit**

```bash
git add agent/src/alerts.ts agent/src/alerts.test.ts
git commit -m "feat(agent): evaluate metricThreshold node alerts with for-duration (HELM-29)"
```

---

## Task 4: Agent metrics collector — detect backend + query node percents

**Files:**
- Create: `agent/src/metrics.ts`
- Create: `agent/src/metrics.test.ts`

- [ ] **Step 1: Write failing test**

Create `agent/src/metrics.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { collectMetricSnapshot } from "./metrics.js";
import { type AlertRule } from "./alerts.js";

const healthRule: AlertRule = {
  id: "h1", enabled: true, text: "t", cooldownMinutes: 5,
  target: { scope: "namespace", namespace: "prod" }, condition: { type: "crashLoop" }, createdAt: "",
};

describe("collectMetricSnapshot", () => {
  it("returns an empty snapshot without touching the cluster when no metric rules exist", async () => {
    const snap = await collectMetricSnapshot([healthRule], Date.parse("2026-06-15T00:00:00Z"));
    expect(snap).toEqual({ cpuPercentByNode: {}, memoryPercentByNode: {} });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter rigel-assistant-agent test src/metrics.test.ts`
Expected: FAIL (`./metrics.js` does not exist).

- [ ] **Step 3: Create `agent/src/metrics.ts`**

```ts
// agent/src/metrics.ts
// Collects a per-node CPU%/memory% snapshot for metricThreshold alert rules,
// querying the auto-detected Prometheus/VictoriaMetrics backend through the
// API-server service proxy (kubectl get --raw). Uses the in-cluster
// ServiceAccount token (agent kubectl takes no --context). Only runs when at
// least one enabled metricThreshold rule exists and a backend is present.

import { kubectl } from "./kubectl.js";
import { type AlertRule, type MetricSnapshot } from "./alerts.js";
import {
  detectAllBackendsFromServices,
  pickBackend,
  proxyBase,
  promEncode,
  parsePromInstant,
  seriesToNodeMap,
  nodeCpuPercentQuery,
  nodeMemoryPercentQuery,
  type PromBackend,
  type ServiceJson,
} from "@rigel/k8s/src/prometheus.js";

const EMPTY: MetricSnapshot = { cpuPercentByNode: {}, memoryPercentByNode: {} };
const REDETECT_MS = 5 * 60_000;

let cachedBackend: PromBackend | null | undefined; // undefined = never detected
let lastDetectMs = 0;

/** Detect (and cache) the metrics backend from cluster Services. Re-detects at
 * most every REDETECT_MS; on a kubectl failure keeps the previous cache. */
export async function resolveBackend(now: number): Promise<PromBackend | null> {
  if (cachedBackend !== undefined && now - lastDetectMs < REDETECT_MS) return cachedBackend ?? null;
  const res = await kubectl(["get", "services", "--all-namespaces", "-o", "json"]);
  if (res.code === 0) {
    try {
      const json = JSON.parse(res.stdout) as { items?: ServiceJson[] };
      const items = Array.isArray(json.items) ? json.items : [];
      cachedBackend = pickBackend(detectAllBackendsFromServices(items));
      lastDetectMs = now;
    } catch {
      // malformed output — keep whatever we had
    }
  }
  return cachedBackend ?? null;
}

async function instantQuery(base: string, promql: string) {
  const path = `${base}/api/v1/query?query=${promEncode(promql)}`;
  const res = await kubectl(["get", "--raw", path]);
  if (res.code !== 0) return [];
  return parsePromInstant(res.stdout);
}

async function queryNodeMetric(
  backend: PromBackend, metric: "cpuPercent" | "memoryPercent",
): Promise<Record<string, number>> {
  const q = metric === "cpuPercent" ? nodeCpuPercentQuery() : nodeMemoryPercentQuery();
  return seriesToNodeMap(await instantQuery(proxyBase(backend), q));
}

/** Snapshot of node CPU%/memory% needed by the enabled metricThreshold rules.
 * Empty when there are no metric rules or no backend (metric rules then simply
 * don't fire; health rules are unaffected). */
export async function collectMetricSnapshot(rules: AlertRule[], now: number): Promise<MetricSnapshot> {
  const metricRules = rules.filter((r) => r.enabled && r.condition.type === "metricThreshold");
  if (metricRules.length === 0) return EMPTY;
  const backend = await resolveBackend(now);
  if (!backend) return EMPTY;
  const needCpu = metricRules.some((r) => r.condition.type === "metricThreshold" && r.condition.metric === "cpuPercent");
  const needMem = metricRules.some((r) => r.condition.type === "metricThreshold" && r.condition.metric === "memoryPercent");
  const [cpuPercentByNode, memoryPercentByNode] = await Promise.all([
    needCpu ? queryNodeMetric(backend, "cpuPercent") : Promise.resolve({}),
    needMem ? queryNodeMetric(backend, "memoryPercent") : Promise.resolve({}),
  ]);
  return { cpuPercentByNode, memoryPercentByNode };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter rigel-assistant-agent test src/metrics.test.ts`
Expected: PASS (no kubectl invoked — the health-only rule list short-circuits).

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter rigel-assistant-agent typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add agent/src/metrics.ts agent/src/metrics.test.ts
git commit -m "feat(agent): collect node CPU/mem snapshot for metric alerts (HELM-29)"
```

---

## Task 5: Wire the metric snapshot into the agent tick

**Files:**
- Modify: `agent/src/index.ts` (alert block ~lines 316-325)

- [ ] **Step 1: Add the import**

Near the existing `evaluateAlertRules`/`emptyAlertState` import in `agent/src/index.ts`, add:

```ts
import { collectMetricSnapshot } from "./metrics.js";
```

- [ ] **Step 2: Collect the snapshot and pass it in**

Replace the alert block (lines 316-325):

```ts
    // Custom alert rules — deterministic, model-less, free-riding the fetch above.
    // Metric-threshold rules additionally need a per-node usage snapshot from the
    // metrics backend; collectMetricSnapshot is a no-op (no cluster calls) unless
    // an enabled metricThreshold rule exists and a backend is detected.
    const metricSnapshot = await collectMetricSnapshot(rc.alertRules, now);
    const alertResult = evaluateAlertRules(
      rc.alertRules,
      detection.pods,
      detection.deps,
      state.alertState ?? emptyAlertState(),
      now,
      metricSnapshot,
    );
    state = { ...state, alertState: alertResult.alertState };
    for (const ev of alertResult.events) notifications.push(ev.message);
```

- [ ] **Step 3: Typecheck + full agent test run**

Run: `pnpm --filter rigel-assistant-agent typecheck && pnpm --filter rigel-assistant-agent test`
Expected: no type errors; all agent tests pass.

- [ ] **Step 4: Verify the agent bundles**

Run: `pnpm --filter rigel-assistant-agent build`
Expected: esbuild bundle succeeds (confirms `@rigel/k8s/src/prometheus.js` is resolvable/bundled into the agent).

- [ ] **Step 5: Commit**

```bash
git add agent/src/index.ts
git commit -m "feat(agent): evaluate metric-threshold rules each tick (HELM-29)"
```

---

## Task 6: Grant the agent ServiceAccount `services/proxy`

**Files:**
- Modify: `packages/k8s/src/assistant.ts` (the `rbac(ns)` ClusterRole, rules block lines 446-470)

**Context:** The agent's ClusterRole already grants `services` get/list/watch, but reaching the metrics backend uses the API-server **service proxy** subresource, which is a distinct RBAC resource (`services/proxy`). Without it, `kubectl get --raw /api/v1/namespaces/<ns>/services/rigel-metrics:<port>/proxy/...` is Forbidden.

- [ ] **Step 1: Add the proxy rule**

In `packages/k8s/src/assistant.ts`, inside the ClusterRole `rules:` block, add a new rule after the existing read rule that lists `services` (i.e. after the first `- apiGroups: [""]` block ending in `verbs: [get, list, watch]`):

```yaml
  - apiGroups: [""]
    resources: [services/proxy]
    verbs: [get]
```

- [ ] **Step 2: Verify the rendered manifest contains it**

Run:

```bash
cd /Users/tyrelchambers/home/claude-k8s && node -e "import('@rigel/k8s/src/assistant.ts').catch(()=>{}); " 2>/dev/null; grep -n "services/proxy" packages/k8s/src/assistant.ts
```

Expected: the `grep` prints the new `services/proxy` line (confirming it's in the template).

- [ ] **Step 3: Typecheck the package**

Run: `pnpm --filter @rigel/k8s typecheck`
Expected: no errors (YAML lives in a template string, so this just confirms nothing else broke).

- [ ] **Step 4: Commit**

```bash
git add packages/k8s/src/assistant.ts
git commit -m "feat(k8s): grant agent SA services/proxy for metrics queries (HELM-29)"
```

---

## Task 7: Expose node names from the assistant hook

**Files:**
- Modify: `apps/web/src/panels/assistant/useAssistant.ts`

- [ ] **Step 1: Subscribe to nodes**

In the `useEffect` kinds array (line 149), add `"nodes"`:

```ts
    const kinds = ["deployments", "pods", "configmaps", "secrets", "namespaces", "nodes"];
```

- [ ] **Step 2: Derive the nodes list**

After the `namespaces` `useMemo` (lines 201-204), add:

```ts
  const nodes = useMemo(
    () => Object.values((resources["nodes"] ?? {}) as Record<string, { metadata: { name: string } }>),
    [resources],
  );
```

- [ ] **Step 3: Return `allNodeNames`**

In the returned object, next to `allNamespaceNames` (line 275), add:

```ts
      allNodeNames: nodes.map((n) => n.metadata.name).sort(),
```

Add `nodes` to the outer `useMemo` dependency array (line 289):

```ts
  }, [deployments, pods, configMaps, secrets, namespaces, nodes, installNamespaceHint, credStatus.data]);
```

- [ ] **Step 4: Add `allNodeNames` to the `AssistantDerived` type**

Find the `AssistantDerived` interface and add the field next to `allNamespaceNames`:

```bash
grep -n "allNamespaceNames" apps/web/src/panels/assistant/*.ts
```

In whichever file declares `allNamespaceNames: string[];` on `AssistantDerived`, add directly below it:

```ts
  allNodeNames: string[];
```

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter web typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/panels/assistant/useAssistant.ts
git commit -m "feat(web): expose cluster node names from assistant hook (HELM-29)"
```

---

## Task 8: New-alert form — metric condition, gating, node dropdown

**Files:**
- Modify: `apps/web/src/panels/assistant/AlertsCard.tsx`

**Context:** The metric condition is only offered when a metrics backend is detected (`fetchBackends()` from `useRightSizing.ts`). Selecting it forces a node target and swaps the namespace/name selectors for a node dropdown (per the namespace-dropdown convention — never free text).

- [ ] **Step 1: Add imports and the backend-gating query**

Add imports near the top of `AlertsCard.tsx`:

```ts
import { useQuery } from "@tanstack/react-query";
import { fetchBackends } from "@/panels/rightsizing/useRightSizing";
import { Gauge } from "lucide-react";
```

Inside the component, after `const { d, ns, working, run } = useAssistantCtx();`, add:

```ts
  const backendsQuery = useQuery({ queryKey: ["metrics-backends"], queryFn: fetchBackends });
  const hasBackend = (backendsQuery.data?.length ?? 0) > 0;
```

- [ ] **Step 2: Add the condition type + labels + verb**

Extend `AlertCondType` (lines 142-148) with `| "metricThreshold"`.

Add to `COND_LABELS` (lines 150-157):

```ts
  metricThreshold: "Resource usage",
```

Add to `COND_VERBS` (lines 110-117):

```ts
  metricThreshold: "over its resource threshold",
```

- [ ] **Step 3: Add metric-specific form state**

Next to the other `useState` hooks (lines 164-178), add:

```ts
  const [metric, setMetric] = useState<"cpuPercent" | "memoryPercent">("memoryPercent");
  const [comparator, setComparator] = useState<"above" | "below">("above");
  const [metricPct, setMetricPct] = useState(90);
  const [nodeName, setNodeName] = useState(""); // "" = all nodes
```

- [ ] **Step 4: Couple condition ⇄ node scope**

Add a condition-change handler (near `handleScopeChange`, lines 180-185):

```ts
  function handleCondChange(next: AlertCondType) {
    setCondType(next);
    if (next === "metricThreshold") setScope("node");
    else if (scope === "node") setScope("workload");
  }
```

- [ ] **Step 5: Gate + wire the condition select**

Replace the condition `<select>` (lines 476-489) so it uses `handleCondChange` and hides `metricThreshold` when no backend:

```tsx
              <AlertField label="When" right={<SeverityChip critical={critical} />}>
                <AlertSelect
                  value={condType}
                  onChange={(e) => handleCondChange(e.target.value as AlertCondType)}
                >
                  {(Object.keys(COND_LABELS) as AlertCondType[])
                    .filter((c) => c !== "deploymentDegraded" || allowsDegraded)
                    .filter((c) => c !== "metricThreshold" || hasBackend)
                    .map((c) => (
                      <option key={c} value={c}>
                        {COND_LABELS[c]}
                      </option>
                    ))}
                </AlertSelect>
              </AlertField>
```

- [ ] **Step 6: Swap the target row for a node dropdown when metric-scoped**

Wrap the existing "Watch" scope `<select>` (lines 419-430) so it renders the node dropdown instead when `condType === "metricThreshold"`:

```tsx
                <AlertField label="Watch" className="flex-1">
                  {condType === "metricThreshold" ? (
                    <AlertSelect value={nodeName} onChange={(e) => setNodeName(e.target.value)}>
                      <option value="">All nodes</option>
                      {d.allNodeNames.map((n) => (
                        <option key={n} value={n}>{n}</option>
                      ))}
                    </AlertSelect>
                  ) : (
                    <AlertSelect
                      value={scope}
                      onChange={(e) => handleScopeChange(e.target.value as AlertScope)}
                    >
                      <option value="cluster">Cluster</option>
                      <option value="namespace">Namespace</option>
                      <option value="workload">Workload</option>
                      <option value="pod">Pod</option>
                      <option value="database">Database</option>
                    </AlertSelect>
                  )}
                </AlertField>
```

Guard the namespace/name selectors (lines 431-470) so they don't render for metric rules. Wrap that block:

```tsx
                {condType !== "metricThreshold" && (
                  <>
                    {/* existing Kind + Namespace + Name selectors unchanged */}
                  </>
                )}
```

- [ ] **Step 7: Add the metric inputs**

After the "For (minutes)" block (ends line 526), add a metric-inputs block (the metric select, comparator, percent, and reuse of `minutes` for for-duration):

```tsx
              {condType === "metricThreshold" && (
                <>
                  <AlertField label="Metric">
                    <AlertSelect value={metric} onChange={(e) => setMetric(e.target.value as "cpuPercent" | "memoryPercent")}>
                      <option value="memoryPercent">Memory %</option>
                      <option value="cpuPercent">CPU %</option>
                    </AlertSelect>
                  </AlertField>
                  <AlertField label="Threshold">
                    <div className="flex items-center gap-2.5 text-sm text-[var(--fg-secondary)]">
                      <AlertSelect value={comparator} onChange={(e) => setComparator(e.target.value as "above" | "below")} className="w-28">
                        <option value="above">above</option>
                        <option value="below">below</option>
                      </AlertSelect>
                      <input
                        type="number"
                        min={1}
                        max={100}
                        value={metricPct}
                        onChange={(e) => setMetricPct(Math.min(100, Math.max(1, Number(e.target.value) || 1)))}
                        className={cn(controlClass, "w-20 font-mono")}
                      />
                      <span>%</span>
                    </div>
                  </AlertField>
                  <AlertField label="For (minutes)">
                    <input
                      type="number"
                      min={0}
                      value={minutes}
                      onChange={(e) => setMinutes(Math.max(0, Number(e.target.value) || 0))}
                      className={cn(controlClass, "font-mono")}
                    />
                  </AlertField>
                </>
              )}
```

Note: `AlertSelect` may not accept a `className` prop today — if typecheck flags it, add `className?: string` to `AlertSelect`'s props and spread it onto the underlying `<select>`. Remove the `className="w-28"`/`"w-full"` usages otherwise.

- [ ] **Step 8: Extend `valid` and `create()`**

Replace the `valid` useMemo (lines 201-210):

```ts
  const valid = useMemo(() => {
    if (condType === "metricThreshold") return metricPct > 0 && metricPct <= 100 && minutes >= 0;
    return (
      (!needsNamespace || namespace.trim() !== "") &&
      (!needsName || name.trim() !== "") &&
      (condType !== "podRestarts" || (threshold > 0 && windowMinutes > 0)) &&
      (condType !== "pendingTooLong" || minutes >= 0) &&
      (condType !== "notReady" || minutes >= 0) &&
      (condType !== "deploymentDegraded" || minutes >= 0)
    );
  }, [needsNamespace, needsName, namespace, name, condType, threshold, windowMinutes, minutes, metricPct]);
```

In `create()` (lines 212-249), branch for the metric condition at the very top of the function body:

```ts
  function create() {
    if (condType === "metricThreshold") {
      const target: AlertTarget = { scope: "node" };
      if (nodeName.trim()) target.name = nodeName.trim();
      const condition: AlertCondition = {
        type: "metricThreshold",
        metric,
        comparator,
        threshold: Number(metricPct),
        minutes: Number(minutes),
      };
      const text = label.trim() || defaultLabel();
      const alert: SuggestedAlert = {
        label: `Alert: ${text}`,
        text,
        target,
        condition,
        ...(cooldown > 0 ? { cooldownMinutes: Number(cooldown) } : {}),
      };
      run({ action: "saveAlert", namespace: ns, alert }, () => {
        setOpen(false);
        setName("");
        setLabel("");
      });
      return;
    }
    // ...existing non-metric body unchanged...
```

- [ ] **Step 9: Make the "Node memory > 90%" suggestion open the form**

The `ALERT_SUGGESTIONS` "Node memory > 90%" chip currently hands its `prompt` to chat. Change that entry to pre-fill and open the structured form. Update its object in `ALERT_SUGGESTIONS` (lines 129-133) to add a `preset` marker:

```ts
  {
    icon: Cpu,
    label: "Node memory > 90%",
    preset: "nodeMemory",
  },
```

Where the suggestion chips are rendered (find the `.map` over `ALERT_SUGGESTIONS` and its `onClick`), branch on `preset`:

```tsx
                onClick={() => {
                  if ("preset" in s && s.preset === "nodeMemory") {
                    handleCondChange("metricThreshold");
                    setMetric("memoryPercent");
                    setComparator("above");
                    setMetricPct(90);
                    setMinutes(10);
                    setNodeName("");
                    setOpen(true);
                  } else if ("prompt" in s) {
                    handoffToChat(s.prompt);
                  }
                }}
```

(If `ALERT_SUGGESTIONS` is typed `as const` and the union now differs, keep both `prompt`-bearing and `preset`-bearing shapes; the `"preset" in s` / `"prompt" in s` narrowing above handles either.)

- [ ] **Step 10: Typecheck + build**

Run: `pnpm --filter web typecheck && pnpm --filter web build`
Expected: no type errors; production build succeeds.

- [ ] **Step 11: Commit**

```bash
git add apps/web/src/panels/assistant/AlertsCard.tsx
git commit -m "feat(web): node metric-threshold condition in New alert form (HELM-29)"
```

---

## Task 9: Full verification sweep

- [ ] **Step 1: Typecheck the whole monorepo**

Run: `pnpm -r typecheck`
Expected: no errors across all packages. (Note: the memory index records pre-existing `apps/server` `assistant.ts` webhook typecheck errors unrelated to this work — if those appear, confirm they are the same pre-existing ones and not introduced here by diffing against `git stash`-clean if needed.)

- [ ] **Step 2: Run the whole test suite**

Run: `pnpm -r test`
Expected: all packages green (`@rigel/k8s`, `rigel-assistant-agent`, `@rigel/server`, `web`).

- [ ] **Step 3: Build the agent bundle**

Run: `pnpm --filter rigel-assistant-agent build`
Expected: esbuild succeeds.

- [ ] **Step 4: Final commit (if any lint/format fixups were needed)**

```bash
git add -A
git commit -m "chore: verification fixups for metric-threshold alerts (HELM-29)" || echo "nothing to commit"
```

---

## Post-implementation (per user's global workflow — do after code is merged/verified)

- Update the app's Outline docs for the alert feature (new node CPU%/memory% condition, backend gating).
- Derive/close Plane ticket HELM-29 and file follow-up tickets for the deferred slices:
  - Pod/workload CPU % and memory % (reuses `metricThreshold` with `scope=pod|workload`).
  - Node disk % and PVC usage % (needs kubelet volume-stats scraping added to the metrics install).

## Self-review notes (coverage check)

- Spec "add condition variant + node scope" → Task 1. ✅
- Spec "share pure Prom helpers + node-percent PromQL" → Task 2. ✅
- Spec "agent evaluates with for-duration in AlertState, transient-empty guard, cooldown reuse" → Task 3. ✅
- Spec "agent detects backend + queries via proxy, no-op when no metric rule/backend" → Task 4 + Task 5. ✅
- Spec "RBAC services/proxy on agent SA" → Task 6. ✅
- Spec "UI gating + node dropdown + inputs + suggestion chip" → Tasks 7 + 8. ✅
- Spec "gate on backend present; health conditions unaffected" → Task 4 (`collectMetricSnapshot` empty ⇒ no fire) + Task 8 (option hidden). ✅
- Type consistency: `MetricKind`/comparator/threshold/minutes identical across `packages/k8s` (Task 1) and `agent` mirror (Task 3); `MetricSnapshot` shape identical in agent alerts (Task 3) and metrics (Task 4); `evaluateAlertRules` metrics arg added in Task 3 and supplied in Task 5. ✅
