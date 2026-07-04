# Metric-threshold alert conditions (HELM-29)

**Date:** 2026-07-03
**Ticket:** HELM-29 — "Metrics-based alert conditions (node/pod CPU, memory, disk % thresholds)"

## Problem

The in-cluster alert agent evaluates only health/lifecycle conditions (restarts,
crash-loops, OOM, pending, not-ready, deployment-degraded). It cannot watch
resource-usage percentages, so a request like *"alert me when a node's memory
usage goes above 90%"* has to be declined. This design adds a metric-threshold
condition that watches **node CPU %** and **node memory %** against the metrics
backend Rigel already uses for right-sizing.

## Scope (v1)

**In scope:** node CPU % and node memory % thresholds, evaluated in the agent on
its existing poll cadence, gated on a metrics backend being present.

**Explicitly deferred** (schema is designed to extend to these later, but they are
not built now):

- Pod / workload CPU % and memory % (usage vs container limit).
- Node disk % and PVC usage % — the Rigel metrics install scrapes **cAdvisor
  only**, so kubelet volume-stats (`kubelet_volume_stats_*`) are not collected;
  supporting disk/PVC needs extra scrape + install work out of this slice.

Node CPU/mem is the exact case the ticket was filed from and is cleanly derivable
from what the install already scrapes, so it is the first shippable slice.

## Background: how the pieces work today

- **Alert evaluation** is deterministic and model-less, running in the in-cluster
  agent (`agent/src/alerts.ts`, `evaluateAlertRules`). The agent ticks every 30s
  (`agent/src/index.ts`, `POLL_INTERVAL_MS` default `30_000`) and free-rides the
  pods+deployments already fetched that tick. It delivers notifications through
  the agent's notify channels. **This is the only 24/7 poller** — the desktop
  server is only up while the desktop app is open, so evaluation must stay in the
  agent for alerts to fire reliably.
- **Alert wire types** are a discriminated union duplicated across the
  ConfigMap-JSON boundary: canonical in `packages/k8s/src/alerts.ts`, mirrored in
  `agent/src/alerts.ts`, re-exported by `apps/web/src/lib/alerts.ts`. Rules
  persist as JSON under the `alertRules` key of the per-namespace
  `assistant-config` ConfigMap.
- **Metrics querying** lives server-side only today
  (`apps/server/src/prometheusMetrics.ts`). It auto-detects a Prometheus/
  VictoriaMetrics backend by listing Services, then runs PromQL through the
  **API-server service proxy** via `kubectl get --raw
  /api/v1/namespaces/<ns>/services/<svc>:<port>/proxy/api/v1/query?query=...`.
  No Prometheus HTTP client, no direct network exposure needed.
- **The metrics install** (`packages/k8s/src/metricsInstall.ts`) scrapes cAdvisor
  through the API-server node proxy with `scrape_interval: 60s`. A `labelmap`
  relabel copies each node's labels onto its series, so `kubernetes_io_hostname`
  identifies the node (every series shares `instance=kubernetes.default.svc:443`,
  so hostname is the grouping key). cAdvisor exposes node capacity
  (`machine_cpu_cores`, `machine_memory_bytes`) and node-level usage via the root
  cgroup (`{id="/"}`).

## Approach

Evaluate in the agent (required — it is the persistent poller), querying the
metrics backend with the same API-server-proxy PromQL primitive the server uses.
Share the pure query/detection helpers via `packages/k8s` so the server and agent
do not diverge; each side supplies its own `kubectl` runner.

### Data model

Add one condition variant to the `AlertCondition` union and one scope value.

```ts
// packages/k8s/src/alerts.ts (canonical), mirrored in agent/src/alerts.ts
export type AlertScope =
  | "cluster" | "namespace" | "workload" | "pod" | "database" | "node"; // + node

export type MetricKind = "cpuPercent" | "memoryPercent";
export type MetricComparator = "above" | "below";

export type AlertCondition =
  | { type: "podRestarts"; threshold: number; windowMinutes: number }
  | { type: "crashLoop" }
  | { type: "oomKilled" }
  | { type: "pendingTooLong"; minutes: number }
  | { type: "notReady"; minutes: number }
  | { type: "deploymentDegraded"; minutes: number }
  | { type: "metricThreshold";
      metric: MetricKind;
      comparator: MetricComparator;
      threshold: number;   // percent, (0, 100]
      minutes: number };   // for-duration
```

Rationale for splitting "what" from "the rule":

- **Target = which nodes.** `metricThreshold` requires `target.scope === "node"`.
  `target.name` (optional) selects one node; empty means all nodes. Namespace is
  ignored for node scope. `node` is the only scope `metricThreshold` accepts, and
  `metricThreshold` is the only condition that accepts `node` — the same
  condition↔scope coupling `deploymentDegraded` already has via `DEGRADED_SCOPES`.
- **Condition = the rule.** `metric` is kept scope-agnostic (`cpuPercent` /
  `memoryPercent`) so a later pod/workload slice reuses the same condition with a
  different scope; the node-vs-pod PromQL is chosen by scope in the evaluator.
- **`comparator`** is `above`/`below` (strict). "% above" is the real case; gt-vs-gte
  hair-splitting at percent granularity is not worth a four-way enum. Reads
  naturally in `alertRuleSummary` ("Node memory above 90% for 10m").
- **`minutes`** is the for-duration/hysteresis window, tracked in agent state (see
  below), consistent with the other `minutes`-bearing conditions.

Validator/helper updates in `packages/k8s/src/alerts.ts`:
`CONDITION_TYPES`, `validateCondition` (threshold in `(0,100]`, `minutes >= 0`,
valid `metric`/`comparator`), `validateTarget` (accept `node` scope),
`conditionWindowMinutes` (return `minutes`, driving the default cooldown),
`alertRuleSummary` (node-metric phrasing). Mirror the type + `CONDITION_TYPES` +
`conditionFieldsValid` in `agent/src/alerts.ts`.

### Shared PromQL helpers (new: `packages/k8s/src/prometheus.ts`)

Extract the **pure, kubectl-free** helpers currently in
`apps/server/src/prometheusMetrics.ts` into `packages/k8s` so both consumers
share one source of truth: `flavorForPort`, `detectAllBackendsFromServices`,
`pickBackend`, `proxyBase`, `promEncode`, `parsePromInstant`, and the
`PromBackend` type. `apps/server/src/prometheusMetrics.ts` keeps its
`kubectl`-executing wrappers (`detectAllBackends`, `instantQuery`,
`getUsageHistory`) and imports the pure helpers (re-exporting for existing
importers so nothing else changes).

Add pure query builders:

```ts
// percent per node, grouped by kubernetes_io_hostname
export function nodeMemoryPercentQuery(node?: string): string;
export function nodeCpuPercentQuery(node?: string): string;
```

Query shapes (node optional filter on `kubernetes_io_hostname`):

```promql
# memory %
100 * max by (kubernetes_io_hostname) (container_memory_working_set_bytes{id="/"})
    / max by (kubernetes_io_hostname) (machine_memory_bytes)

# cpu %
100 * sum by (kubernetes_io_hostname) (rate(container_cpu_usage_seconds_total{id="/"}[5m]))
    / max by (kubernetes_io_hostname) (machine_cpu_cores)
```

Each returns one instant value per node (already a percent). The `[5m]` rate
smooths CPU; the for-duration is enforced by agent state, not by the query, so the
query stays a simple instant read. The exact hostname label
(`kubernetes_io_hostname`) is verified against a live scrape during
implementation.

### Agent evaluation (`agent/src/metrics.ts` + `agent/src/alerts.ts`)

New `agent/src/metrics.ts`:

- `instantQuery(base, promql)` — agent's `kubectl(["get","--raw", ...])` (SA
  token, no `--context`) + shared `proxyBase`/`promEncode`/`parsePromInstant`.
- `detectBackend()` — `kubectl get services --all-namespaces -o json` +
  `detectAllBackendsFromServices`/`pickBackend`. Cached, with periodic refresh
  (services change rarely; re-detect on query failure and every few minutes).
- `queryNodeMetric(backend, metric, node?)` → `Map<nodeName, percent>`.

Tick integration (`agent/src/index.ts`, near the existing alert call ~line 317):

1. If no enabled rule uses `metricThreshold`, do nothing — zero backend calls,
   zero overhead for clusters not using the feature.
2. Otherwise resolve the cached backend. If none is detected, skip metric rules
   (they simply do not fire); health/lifecycle rules are unaffected. Optionally
   surface "metrics backend not found" once via existing agent logging.
3. For each metric rule, run the matching query, get per-node percents, and pass
   them into the evaluator alongside pods/deployments.

Evaluation + hysteresis in `evaluateCondition`:

- Extend `AlertState` with `metricBreaches: Record<string, { since: string }>`
  keyed by `ruleId + "/" + nodeName`, mirroring the existing `restartBaselines`
  pattern.
- Per matched node: compute `breached = comparator === "above" ? pct > threshold
  : pct < threshold`. If breached and no entry, stamp `since = now`. If not
  breached, clear the entry.
- Fire when a breach has persisted `>= minutes * 60_000` **and** the per-rule
  `cooldownMinutes` has elapsed (reuse the existing `lastFiredAt` cooldown gate).
  Detail string e.g. `node "ip-10-0-1-5" memory at 93% (> 90% for 10m)`.
- Prune `metricBreaches` for nodes no longer returned, keeping the map bounded
  like `restartBaselines`.

No new cadence: reuse the 30s tick. No new cooldown mechanism: reuse
`cooldownMinutes` + `lastFiredAt`.

### RBAC

The agent's ServiceAccount must be allowed to reach the metrics backend through
the proxy and to list Services for detection. Add to the agent's ClusterRole:

```yaml
- apiGroups: [""]
  resources: [services]
  verbs: [get, list]
- apiGroups: [""]
  resources: [services/proxy]
  verbs: [get]
```

(Locate the agent's existing RBAC manifest during implementation and extend it;
the metrics install grants `services/proxy` to its own SA, not the agent's.)

### Server

No new route needed. `GET /api/metrics/backends` already exists and is reused by
the UI for gating. `saveAlert` → `normalizeAlertRule` → `validateCondition` accept
the new variant automatically once `packages/k8s/src/alerts.ts` is updated
(default cooldown from `conditionWindowMinutes` returning `minutes`).

### UI (`apps/web/src/panels/assistant/AlertsCard.tsx`)

Extend the existing structured form (no new Pencil frame):

- Add `metricThreshold` to `AlertCondType`, `COND_LABELS`, `COND_VERBS`.
- **Gating:** fetch `GET /api/metrics/backends`. When no backend is detected, the
  metric condition option is hidden/disabled with a hint ("Install metrics to
  enable resource-usage alerts") pointing at the metrics-install flow. When a
  backend exists, the option is available.
- **Scope coupling:** selecting the metric condition forces `scope = "node"` and
  shows a node picker. Per the namespace-input convention, the node picker is a
  **dropdown of cluster nodes** (reusing the nodes watch/list), defaulting to
  "All nodes"; it is not free-text. Other conditions continue to hide the `node`
  scope.
- **Inputs:** metric select (CPU % / Memory %), comparator (Above / Below,
  default Above), threshold number input (`%`, 1–100), "For (minutes)"
  for-duration, and the existing Cooldown input. Live preview via `COND_VERBS`
  ("Node memory above 90% for 10m").
- `create()` builds `target = { scope: "node", name? }` + the `metricThreshold`
  condition; `valid` requires threshold in `(0,100]`.
- Update the empty-state "Node memory > 90%" suggestion chip
  (`ALERT_SUGGESTIONS`) to open this structured condition instead of handing the
  sentence to chat, now that the form can express it.

## Error handling

- **No backend:** metric rules silently do not fire; health rules unaffected; UI
  hides the option. (Chosen behavior — "gate on backend present".)
- **Query/proxy failure or empty result:** treat as "no data this tick" — do not
  fire, do not clear breach timers on a transient empty (only clear on an explicit
  not-breached reading), so a blip does not reset a legitimate for-duration.
  Log at debug.
- **Backend disappears mid-life:** detection cache refresh returns none →
  behaves as "no backend".

## Testing

- **packages/k8s:** `validateCondition`/`normalizeAlertRule`/`alertRuleSummary`
  for `metricThreshold`; `validateTarget` accepts `node`; `nodeCpuPercentQuery`/
  `nodeMemoryPercentQuery` produce expected PromQL (with and without a node
  filter); `parsePromInstant` on sample payloads.
- **agent:** `evaluateCondition` for `metricThreshold` with injected per-node
  percents — comparator above/below, for-duration accrual across ticks, cooldown
  gating, no-backend skip, transient-empty does not reset breach timer, breach map
  pruning.
- **web:** form renders metric inputs; gating hides the option when
  `/api/metrics/backends` is empty; `create()` emits the expected target+condition
  payload; node picker is a dropdown.

## Files touched

- `packages/k8s/src/prometheus.ts` (new — extracted pure helpers + query builders)
- `packages/k8s/src/alerts.ts` (scope + condition + validators/summary)
- `apps/server/src/prometheusMetrics.ts` (import/re-export shared helpers)
- `agent/src/alerts.ts` (mirror type, evaluate metric condition, `AlertState`)
- `agent/src/metrics.ts` (new — backend detect + instant query in-cluster)
- `agent/src/index.ts` (tick wiring)
- agent RBAC manifest (add `services` + `services/proxy`)
- `apps/web/src/lib/alerts.ts` (re-export — usually no change)
- `apps/web/src/panels/assistant/AlertsCard.tsx` (form + gating + node picker)
- Tests alongside each of the above.

## Out of scope / follow-ups

- Pod/workload CPU % and memory % (reuses this condition with `scope=pod|workload`).
- Node disk % and PVC usage % (needs kubelet volume-stats scraping added to the
  install).
- Documenting the feature in Outline and deriving any follow-up Plane tickets.
