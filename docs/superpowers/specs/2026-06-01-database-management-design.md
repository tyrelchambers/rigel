# Database Management in Helmsman — Design

**Date:** 2026-06-01
**Status:** Approved, ready for planning

## Goal

Turn Helmsman's read-only **Databases** panel into a management surface. Today the
panel detects CNPG clusters and DB-image workloads (Deployment/StatefulSet) and shows
replicas, health, primary, and child pods — but offers no actions. This adds three
capability buckets the user asked for:

1. **Lifecycle / operator ops** — backup, switchover/promote, hibernate/resume, scale.
2. **Connection & credentials** — port-forward, reveal credentials, copy DSN.
3. **Backups & health observability** — last backup, schedule, WAL archiving status.

The design is **multi-operator from the start**: an operator abstraction where CNPG is
the first concrete implementation and future operators (Redis/Valkey, MySQL) plug into
the same UI by adding a conformer — no panel changes.

## Non-goals

- No in-app SQL/query console (explicitly out of scope).
- No restore wizard in v1 (a richer detail sheet can come later; inline action bar now).
- No new local dependency beyond the `kubectl cnpg` plugin the user already uses; plugin
  absence is handled by graceful degradation, not a silent fallback to a different command.

## Architecture — the operator abstraction

Separate **what a database instance is** (already `DatabaseInstance`) from **what you
can do to it** (operator-specific).

```swift
protocol DatabaseOperator {
    var id: String { get }                              // "cnpg", "none", future: "redis-operator"
    func owns(_ instance: DatabaseInstance) -> Bool
    func capabilities(for instance: DatabaseInstance) -> DatabaseCapabilities
}

struct DatabaseCapabilities {
    var actions: [DatabaseAction]      // ordered, drives the inline action bar
    var backupInfo: BackupInfo?        // nil = operator has no backup concept
    var connection: ConnectionInfo?    // secret ref + service:port for DSN/port-forward
}

enum DatabaseAction {
    case backupNow
    case switchover(to: String)        // target instance/pod name
    case hibernate
    case resume
    case scale(current: Int, to: Int)
    case portForward
    case revealCredentials
    case copyDSN
}
```

`DatabaseOperatorRegistry` resolves the right operator per instance
(`first { $0.owns(instance) } ?? NoOperator`). `DatabasesViewModel` asks the registry
for capabilities and never special-cases CNPG vs generic.

### v1 conformers

- **`CNPGOperator`** — `owns` = `source == .cnpg`. Actions: `backupNow`, `switchover`,
  `hibernate`/`resume`, `scale`, plus `backupInfo` (last backup, schedule, WAL archiving)
  and `connection` (the `<cluster>-app` secret + `<cluster>-rw` service:5432). The three
  plugin-backed actions are gated on `cnpgPluginAvailable`.
- **`NoOperator`** — fallback for `.deployment` / `.statefulset`. Actions: `scale`,
  `portForward`, `revealCredentials` (only when a secret is discoverable), `copyDSN`.
  No backup, no switchover.

**Adding a future operator = one new conformer + registry entry; no UI changes.**

## Actions, commands, and risk gating

CNPG plugin ops shell out as `kubectl cnpg …` — a `KubectlInvocation` whose first args
are `cnpg …`, so the existing confirm-sheet preview renders `kubectl --context X cnpg …`
for free. Scaling has no plugin verb, so it is a pure `kubectl patch` regardless.

### New `WorkloadAction` cases

| Action | Invocation | Risk gating |
|---|---|---|
| `cnpgBackupNow(cluster, ns)` | `kubectl cnpg backup <cluster> -n <ns>` | low (neutral) — non-destructive |
| `cnpgSwitchover(cluster, ns, to: instance)` | `kubectl cnpg promote <cluster> <instance> -n <ns>` | high-risk (red) — brief primary failover |
| `cnpgHibernate(cluster, ns, on: true)` | `kubectl cnpg hibernate on <cluster> -n <ns>` | high-risk + acknowledge — takes DB offline |
| `cnpgHibernate(cluster, ns, on: false)` | `kubectl cnpg hibernate off <cluster> -n <ns>` | low (neutral) — brings it back |
| `scaleCNPG(cluster, ns, current, to:)` | `kubectl patch cluster <c> -n <ns> --type=merge -p '{"spec":{"instances":N}}'` | low scaling up; acknowledge when scaling down |

### Reused flows (no new `WorkloadAction` cases)

- Generic scale → existing `scaleDeployment` / `scaleWorkload`.
- Port-forward → existing `PortForwardStartSheet` (CNPG prefills `-rw`:5432; generic
  prefills the detected DB port).
- Reveal credentials → existing secret-reveal flow. CNPG resolves to `<cluster>-app`;
  generic resolves from the pod's `envFrom`/`secretKeyRef`, and the action is **hidden**
  if none is discoverable (no guessing).
- Copy DSN → builds e.g. `postgresql://user@<cluster>-rw.<ns>:5432/app` from connection
  info + resolved secret; pure clipboard, no mutation.

### Plugin detection

One `kubectl cnpg version` probe, cached and re-run on context switch, exposed as
`cnpgPluginAvailable: Bool` on `ClusterCache`. If absent, the three plugin-backed actions
render **disabled with a "Requires kubectl-cnpg" tooltip + install link**; scale (patch)
and all connection actions still work because they are pure kubectl.

## UI layout

**Inline action bar.** The already-existing expanded row gets a compact button row at the
top of `expandedDetails`, built from `capabilities.actions` — the panel renders whatever
the operator offers. Mutations route through the existing `WorkloadConfirmSheet`;
port-forward/credentials open their existing sheets; copy-DSN is inline. Plugin-gated
buttons show disabled + tooltip when the plugin is absent.

**Backups & health subsection (CNPG only),** below the existing PODS list, when
`capabilities.backupInfo != nil`:
- **Last backup** — timestamp + age from cluster status `lastSuccessfulBackup`.
- **Schedule** — from any `ScheduledBackup` CR targeting the cluster ("daily 02:00" /
  "none configured").
- **WAL archiving** — green/red from the cluster's `ContinuousArchiving` status condition.

**Connection subsection** (any DB with `connection != nil`): one line showing
service:port with **Copy DSN**, **Reveal credentials**, and **Port-forward** buttons.

## Cluster-layer data additions

1. Extend `CNPGClusterStatus` with `lastSuccessfulBackup: String?` and
   `conditions: [Condition]?`.
2. New watch for `scheduledbackups.postgresql.cnpg.io` in `ClusterCache` (same pattern as
   the existing `cnpgTask`), exposed as `scheduledBackups`.
3. `cnpgPluginAvailable: Bool` on `ClusterCache` (the version probe).

## Testing

Pure-logic units, matching the existing test style:

- `DatabaseOperatorRegistry` resolution — CNPG → `CNPGOperator`; deployment/statefulset →
  `NoOperator`.
- `CNPGOperator.capabilities` — plugin-present vs absent yields the right action set;
  `backupInfo` populated from status / scheduled-backup fixtures.
- `NoOperator.capabilities` — credentials action hidden when no secret is discoverable;
  present when a `secretKeyRef` exists.
- New `WorkloadAction` cases — `kubectlInvocations()` and `previewCommand` produce the
  exact `kubectl cnpg …` / `patch` strings; correct `isHighRisk` / `needsAcknowledge`.
- Generic scale routes to the existing `scaleWorkload` / `scaleDeployment` action (no
  duplicate scaling path).
