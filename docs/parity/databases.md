# Databases Panel — Parity Specification

**Source of truth:** `Sources/Helmsman/Panels/Databases/` (Swift), ported to
`apps/web/src/panels/databases/` (TypeScript).

## Overview

The Databases panel detects and displays **CloudNativePG (CNPG) clusters** and
**image-detected databases** (Postgres, MySQL, Redis, Mongo, Cassandra, Elasticsearch,
etc. running as Deployment or StatefulSet). It shows cluster status, instance
health, primary pod assignment, and connection details. It is **read-only**
(no mutations from the panel itself; actions run through chat action-blocks
routed to the server).

---

## Watch subscriptions & CRD handling

The panel requires:
- `clusters.postgresql.cnpg.io` — CNPG cluster CRD.
- `scheduledbackups.postgresql.cnpg.io` — CNPG backup schedules.
- Generic resources already watched: `pods`, `deployments`, `statefulsets`, `secrets`.

### Subscribe logic

```typescript
subscribe('clusters.postgresql.cnpg.io', namespaceFilter ?? '*');
subscribe('scheduledbackups.postgresql.cnpg.io', namespaceFilter ?? '*');
// (pods, deployments, statefulsets already subscribed by other panels)
```

### Empty state (CRD not installed)

If no CNPG clusters are found AND no image-detected databases exist:
- Display icon: `database`
- Title: "No databases detected"
- Subtitle: "Nothing matched a known database operator CRD or a recognized database image."
- No error banner; this is a normal state.

If a watch error occurs (transient network blip, RBAC issue):
- Show error banner: monospace text, destructive styling (red background).
- Do not hide the list; keep showing existing instances.

### Loading state

- Show spinner in the header during initial subscription.
- Dismiss spinner once first snapshot arrives (or fails).

---

## Resource types & detection

### Type 1: CNPG Clusters (source = "cnpg")

**Detection:** `clusters.postgresql.cnpg.io` resources in the cluster.

**Fields extracted from `CNPGCluster`:**
- `metadata.uid` → id (stable key, used for expansion tracking)
- `metadata.name` → name
- `metadata.namespace` → namespace (defaults to "default")
- `metadata.creationTimestamp` → age (relative, e.g., "2d", "5m")
- `spec.instances` or `status.instances` → desired replicas
- `status.readyInstances` → ready replicas
- `status.phase` → phase text (e.g., "Cluster in healthy state", "Unavailable", "Unknown")
- `status.currentPrimary` → primary pod name
- `spec.imageName` → image (e.g., "ghcr.io/cloudnative-pg/postgresql:16.3")
- `metadata.labels["cnpg.io/cluster"]` → label for pod matching

**Health derivation:**
```
healthy = (readyInstances == desiredInstances) && desiredInstances > 0
```
Shows as `readyInstances/desiredInstances` in a colored badge (green if healthy, red if not).

**Kind:** Always "postgres" (monochrome blue badge "POSTGRES").

**Source badge:** "CNPG" (monochrome, uppercase).

---

### Type 2: Image-detected Databases (source = "deployment" or "statefulset")

**Detection:** Scan all `Deployment` and `StatefulSet` containers for image names matching known database patterns. Skip:
- Images ending in `-operator` or `-exporter`.
- Names like `pgbouncer`, `pgpool`, `tailscale`.

**Matching image patterns (case-insensitive):**
- `postgres` | `postgresql` → "postgres"
- `mysql` → "mysql"
- `mariadb` → "mariadb"
- `mongo` | `mongodb` → "mongo"
- `redis` → "redis"
- `valkey` → "valkey"
- `keydb` → "keydb"
- `clickhouse-server` | `clickhouse` → "clickhouse"
- `elasticsearch` → "elasticsearch"
- `opensearch` → "opensearch"
- `cassandra` → "cassandra"
- `scylla` | `scylladb` → "scylla"
- `dragonfly` | `dragonflydb` → "dragonfly"

**Fields extracted from `Deployment` / `StatefulSet`:**
- `metadata.uid` → id
- `metadata.name` → name
- `metadata.namespace` → namespace
- `metadata.creationTimestamp` → age
- `spec.replicas` or `status.replicas` → desired replicas
- `status.readyReplicas` → ready replicas
- First matched container's `image` → image (full pull URL)
- `spec.selector.matchLabels` → label selector (for pod matching)

**Health derivation:**
```
healthy = (readyReplicas == desiredReplicas) && desiredReplicas > 0
phaseText = healthy ? "Healthy" : "Degraded"
```

**Kind:** Derived from image (e.g., "mysql", "redis").

**Source badge:** "Deploy" (deployment) or "STS" (statefulset).

---

## List layout & columns

Displayed in a card-style list (not a table). Each row is expandable.

### Collapsed row (always shown)

```
[chevron] [KIND-BADGE] [name] [namespace-badge] [SOURCE-BADGE] … [primary*] [nodes*] [ready/desired] 
```

- **[chevron]:** expand/collapse button.
- **[KIND-BADGE]:** monochrome badge with database type name (e.g., "POSTGRES", "MYSQL").
  Color by kind (postgres=blue, mysql=orange, redis=red, etc.; see `DatabaseKind.accent` in Swift).
- **[name]:** instance name (monospace).
- **[namespace-badge]:** namespace in a secondary badge (dark background).
- **[SOURCE-BADGE]:** "CNPG", "DEPLOY", or "STS" (monospace, uppercase, outline style).
- **[primary]** (CNPG only): If `status.currentPrimary` is set, show "primary: [pod-name]" in accent color.
- **[nodes]:** If expanded pods span multiple nodes, show "🖥 node1, node2" (icon + comma-separated).
  For single-node, hide the icon and just show the name.
- **[ready/desired]:** Right-aligned badge showing replica status (green if healthy, red if not).

### Expanded details (when expanded)

Shown in a collapsed section below the row:

#### Actions bar (if available)

Only for CNPG (operations/buttons gated by plugin availability and instance state).
Buttons are disabled with a tooltip if not applicable. **Do NOT implement mutations;
these buttons are deferred.** (Cf. `docs/parity/contracts.md` — action blocks from chat.)

#### IMAGE (if present)

```
IMAGE    [container image URL with tag]
```
Only shown if the image field is populated.

#### STATUS

```
STATUS   [phase text, e.g., "Cluster in healthy state"]
```
Text color: green if healthy (`isHealthy == true`), default text color otherwise.

#### PODS (if expanded and pods match)

```
PODS
  ├─ [pod-name]  [status-dot] [phase]  [primary-badge]  [node-name]
  └─ [pod-name]  [status-dot] [phase]  [node-name]
```

Pods list:
- Sorted by name.
- One per line with vertical connector.
- Status dot (phase-colored circle: green=Running, yellow=Pending, red=Failed, gray=other).
- Phase label (Running, Pending, Failed, Succeeded, Unknown).
- **Primary badge** (only if this pod is the CNPG primary): "primary" in accent color (small badge).
- Node name (right-aligned, monospace).

If no pods match the selector, show "No matching pods" in tertiary text.

#### CONNECT (if capabilities.connection is set)

```
CONNECT  [target-name].[namespace].svc:[port]   (CNPG)
         [pod-name].[namespace]:[port]           (generic)
```

Text is selectable (allow copy).

#### BACKUPS & HEALTH (CNPG only)

```
BACKUPS & HEALTH
  Last backup     [RFC3339 timestamp or "never"]
  Schedule        [cron string or "none configured"]
  WAL archiving   [status-dot] [healthy | failing | unknown]
```

Status dots: green (healthy), red (failing), gray (unknown).

---

## Column/field extraction rules

### From CNPG Cluster

| Field | Swift path | Derived logic |
|-------|------------|---|
| ID | `metadata.uid` | Stable identifier |
| Name | `metadata.name` | Resource name |
| Namespace | `metadata.namespace` | Defaults to "default" |
| Kind | constant | Always "postgres" |
| Source | constant | Always "cnpg" |
| Age | `metadata.creationTimestamp` | Relative duration (e.g., "2d", "5m") |
| Image | `spec.imageName` | Container image, may be nil |
| Desired Instances | `spec.instances ?? status.instances ?? 0` | Fallback to status if spec missing |
| Ready Instances | `status.readyInstances ?? 0` | Defaults to 0 if missing |
| Phase | `status.phase ?? "Unknown"` | Operator-provided phase string |
| Is Healthy | `(readyInstances == desiredInstances) && desiredInstances > 0` | Computed flag |
| Primary Pod | `status.currentPrimary` | Pod name or nil |
| Label Selector | constant | `{"cnpg.io/cluster": [name]}` | Pod matching key |
| Last Successful Backup | `status.lastSuccessfulBackup` | RFC3339 timestamp or nil |
| Scheduled Backup | `scheduledbackups` | GROQ: schedule on matching `spec.cluster.name` |
| WAL Archiving Status | `status.conditions[type=="ContinuousArchiving"].status` | "True" → healthy, "False" → failing, missing → unknown |

### From Deployment/StatefulSet

| Field | Swift path | Derived logic |
|-------|------------|---|
| ID | `metadata.uid` | Stable identifier |
| Name | `metadata.name` | Resource name |
| Namespace | `metadata.namespace` | Defaults to "default" |
| Kind | Detected from image | E.g., "mysql", "redis" |
| Source | constant | "deployment" or "statefulset" |
| Age | `metadata.creationTimestamp` | Relative duration |
| Image | First container's `image` | Full pull URL with tag |
| Desired Instances | `spec.replicas ?? status.replicas ?? 0` | Fallback |
| Ready Instances | `status.readyReplicas ?? 0` | Defaults to 0 |
| Phase | Computed | "Healthy" if ready == desired && desired > 0, else "Degraded" |
| Is Healthy | `(readyReplicas == desiredReplicas) && desiredReplicas > 0` | Computed flag |
| Label Selector | `spec.selector.matchLabels` | Pod matching keys |

### From Pods

Pods are matched by label selector (per-instance). Display:
- `metadata.name` → pod name
- `status.phase` → pod phase (colored dot + text)
- `spec.nodeName` → assigned node
- Is this pod the CNPG primary? (compare `metadata.name` to instance's `status.currentPrimary`)

---

## Search & filtering

**Search targets** (case-insensitive substring match):
- Instance name
- Namespace
- Kind (e.g., "postgres", "mysql")
- Image (if present)
- Label keys/values (if present)

Empty search matches all. Implemented in a display-helper function `matchesDatabase(instance, query)`.

---

## Sorting

Default: stable sort by `namespace`, then by `name` (lexicographic).

---

## Error handling

### Network/watch errors

Show a red/destructive error banner at the top of the panel:
```
[error icon] [error message] [monospace font]
```

Keep the list visible; don't hide instances.

### Missing CRD (CNPG not installed)

- `cnpgAvailable` flag is set to `false` when the first watch fails (no prior successful list).
- If `cnpgAvailable == false` AND no instances exist, show the empty state (not an error).
- If `cnpgAvailable == true` (some list succeeded) but watch drops, keep retrying and show any transient error.

### Pod lookup failure

If a database instance's label selector doesn't match any pods, the PODS section shows "No matching pods" (not an error).

---

## Action block protocol (deferred — no impl in this panel)

When chat emits an action block targeting a database, the app routes it through
a confirm sheet. Relevant kinds (see `docs/parity/contracts.md`):
- `command` with `args: ["cnpg", ...]` — CNPG plugin operations (backup, switchover, hibernate, scale).
- `scale` / `restart` / `deleteWorkload` — standard mutations (reused from Pods/Deployments panels).

This panel does NOT render these buttons itself; they come from chat.

---

## Mock data for testing

For vitest, mock:
- CNPG cluster in "default" namespace with 3 desired, 3 ready, primary = "pg-0".
- Postgres Deployment in "default" with 1 desired, 1 ready.
- Redis StatefulSet in "monitoring" with 2 desired, 1 ready (degraded).
- Empty cluster (no instances).
- CNPG cluster with phase="Unavailable".

Test cases:
- Instances sort by namespace then name.
- Health badge color matches isHealthy flag.
- Search filters by name, namespace, kind.
- Empty state shown when no instances and `cnpgAvailable == false`.
- Error banner does not hide the list.

---

## kubectl commands (reference only — server executes these)

### List CNPG clusters
```bash
kubectl get clusters.postgresql.cnpg.io -A -o json
kubectl get clusters.postgresql.cnpg.io -n <namespace> -o json
```

### List scheduled backups
```bash
kubectl get scheduledbackups.postgresql.cnpg.io -A -o json
```

### List pods matching a label selector
```bash
kubectl get pods -n <namespace> -l <key>=<value> -o json
```

### CNPG plugin operations (from chat action blocks)
```bash
kubectl cnpg backup <cluster> -n <namespace>
kubectl cnpg backup ls <cluster> -n <namespace>
kubectl cnpg maintenance set <cluster> -n <namespace> --reuse-pvc
kubectl cnpg maintenance unset <cluster> -n <namespace>
kubectl cnpg publication ls <cluster> -n <namespace>
kubectl cnpg subscription ls <cluster> -n <namespace>
kubectl cnpg status <cluster> -n <namespace>
kubectl cnpg promote <cluster> <pod> -n <namespace>
kubectl cnpg scale <cluster> <replicas> -n <namespace>
```

None of these are called from the panel; they come from chat action blocks
routed through the server's confirm sheet.

---

## Files to create/modify

### New files
- `apps/web/src/panels/databases/DatabasesPanel.tsx` — main panel UI.
- `apps/web/src/panels/databases/databasesDisplay.ts` — display helpers (sorting, search, health, age, phase).
- `apps/web/src/panels/databases/databasesDisplay.test.ts` — vitest coverage.
- `apps/web/src/panels/databases/types.ts` — TypeScript types (DatabaseInstance, DatabaseKind, DatabaseSource, etc.).

### Modify
- `apps/web/src/App.tsx` — add "databases" to PANELS array and route.
- `packages/k8s/src/index.ts` — export CNPG types if needed (additive only; do not break existing types).

### Documentation
- `docs/parity/databases.md` — this spec.

---

## Verification checklist

1. **WebSocket subscribe/unsubscribe:** CNPG clusters and scheduled backups watched correctly.
2. **Instances list:** All CNPG clusters + image-detected databases appear in order (namespace, name).
3. **Empty state:** Shows friendly message when no instances and CNPG not installed.
4. **Error handling:** Error banner shown on watch failure; list not hidden.
5. **Search:** Filters by name, namespace, kind, image.
6. **Expansion:** Clicking row expands details; pods, connection, backups shown.
7. **Health badge:** Color (green/red) matches `isHealthy` flag.
8. **Pod list:** Displays child pods sorted by name with status dots and node names.
9. **Primary badge:** Only shown for CNPG primary pod.
10. **Type checks:** `pnpm --filter web typecheck` passes.
11. **Tests:** `pnpm --filter web test` covers display helpers (sort, search, health derivation, phase text).
12. **Build:** `pnpm --filter web build` succeeds.
13. **No mutations:** Panel has no action buttons; mutations come from chat only.
