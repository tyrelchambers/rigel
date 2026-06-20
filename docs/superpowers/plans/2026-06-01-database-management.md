# Database Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn Rigel's read-only Databases panel into a management surface — CNPG lifecycle ops (backup, switchover, hibernate, scale), connection helpers (port-forward, reveal credentials, copy DSN), and backup/health observability — behind a multi-operator abstraction.

**Architecture:** A `DatabaseOperator` protocol returns, per `DatabaseInstance`, the available actions + backup/health info + connection info. `CNPGOperator` and `NoOperator` (generic Deployment/StatefulSet) ship in v1; future operators add a conformer. Mutations flow through the existing `WorkloadAction` → `WorkloadConfirmSheet` spine; CNPG ops shell out to the `kubectl cnpg` plugin and degrade gracefully when it is absent. Connection/credentials reuse the existing port-forward and secret-manage sheets.

**Tech Stack:** Swift, SwiftUI, `@Observable`, XCTest. Build: `swift build`. Test: `swift test --filter <ClassName>`.

**Spec:** `docs/superpowers/specs/2026-06-01-database-management-design.md`

---

## File Structure

- **Modify** `Sources/Rigel/Cluster/KubeTypes.swift` — extend `CNPGClusterStatus`; add `CNPGCondition`, `CNPGScheduledBackup`; extend `Container` with `env`/`envFrom`.
- **Modify** `Sources/Rigel/Cluster/ClusterCache.swift` — add `scheduledBackups` watch + `cnpgPluginAvailable`.
- **Create** `Sources/Rigel/Panels/Databases/CNPGPluginProbe.swift` — plugin presence probe.
- **Modify** `Sources/Rigel/Panels/Actions/WorkloadAction.swift` — add CNPG action cases.
- **Create** `Sources/Rigel/Panels/Databases/DatabaseCapabilities.swift` — capability/value types.
- **Create** `Sources/Rigel/Panels/Databases/DatabaseOperator.swift` — protocol, registry, `CNPGOperator`, `NoOperator`.
- **Modify** `Sources/Rigel/Panels/Databases/DatabasesViewModel.swift` — capabilities, context, DSN builder, credential lookup.
- **Modify** `Sources/Rigel/Panels/Databases/DatabasesPanel.swift` — action bar + connection + backups/health subsections.
- **Modify** `Sources/Rigel/Shell/MainWindow.swift` — wire DatabasesPanel callbacks.
- **Create** test files under `Tests/RigelTests/`.

---

## Task 1: CNPG status fields, ScheduledBackup type, and watch

**Files:**
- Modify: `Sources/Rigel/Cluster/KubeTypes.swift:356-367` (CNPG types)
- Modify: `Sources/Rigel/Cluster/ClusterCache.swift` (watch + property + apply helper)
- Test: `Tests/RigelTests/CNPGTypesTests.swift`

- [ ] **Step 1: Write the failing decode test**

Create `Tests/RigelTests/CNPGTypesTests.swift`:

```swift
import XCTest
@testable import Rigel

final class CNPGTypesTests: XCTestCase {
    func test_clusterStatus_decodesBackupAndConditions() throws {
        let json = """
        {"metadata":{"uid":"u1","name":"pg"},
         "status":{"phase":"Cluster in healthy state","instances":3,"readyInstances":3,
           "currentPrimary":"pg-1","lastSuccessfulBackup":"2026-06-01T02:00:00Z",
           "conditions":[{"type":"ContinuousArchiving","status":"True","reason":"ContinuousArchivingSuccess"}]}}
        """.data(using: .utf8)!
        let c = try JSONDecoder().decode(CNPGCluster.self, from: json)
        XCTAssertEqual(c.status?.lastSuccessfulBackup, "2026-06-01T02:00:00Z")
        XCTAssertEqual(c.status?.conditions?.first?.type, "ContinuousArchiving")
        XCTAssertEqual(c.status?.conditions?.first?.status, "True")
    }

    func test_scheduledBackup_decodesScheduleAndCluster() throws {
        let json = """
        {"metadata":{"uid":"s1","name":"pg-daily","namespace":"default"},
         "spec":{"schedule":"0 0 2 * * *","cluster":{"name":"pg"}}}
        """.data(using: .utf8)!
        let s = try JSONDecoder().decode(CNPGScheduledBackup.self, from: json)
        XCTAssertEqual(s.spec?.schedule, "0 0 2 * * *")
        XCTAssertEqual(s.spec?.cluster?.name, "pg")
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `swift test --filter CNPGTypesTests`
Expected: FAIL — `lastSuccessfulBackup`/`conditions` not members of `CNPGClusterStatus`; `CNPGScheduledBackup` undefined.

- [ ] **Step 3: Extend the CNPG types**

In `Sources/Rigel/Cluster/KubeTypes.swift`, replace the `CNPGClusterStatus` struct (currently at ~line 361) with:

```swift
struct CNPGClusterStatus: Codable, Hashable {
    let phase: String?
    let instances: Int?
    let readyInstances: Int?
    let currentPrimary: String?
    let targetPrimary: String?
    let lastSuccessfulBackup: String?
    let conditions: [CNPGCondition]?
}

struct CNPGCondition: Codable, Hashable {
    let type: String
    let status: String
    let reason: String?
    let message: String?
}

/// scheduledbackups.postgresql.cnpg.io — the backup schedule for a CNPG cluster.
struct CNPGScheduledBackup: Codable, Identifiable, Hashable {
    let metadata: ObjectMeta
    let spec: Spec?
    var id: String { metadata.uid }

    struct Spec: Codable, Hashable {
        let schedule: String?     // 6-field cron (CNPG includes seconds)
        let cluster: ClusterRef?
    }
    struct ClusterRef: Codable, Hashable {
        let name: String
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `swift test --filter CNPGTypesTests`
Expected: PASS.

- [ ] **Step 5: Add the scheduledBackups watch to ClusterCache**

In `Sources/Rigel/Cluster/ClusterCache.swift`, near the other `private(set) var` declarations (~line 14):

```swift
    private(set) var scheduledBackups: [CNPGScheduledBackup] = []
```

In the `tasks` array (alongside `cnpgTask(c)`, ~line 110):

```swift
                scheduledBackupTask(c),
```

Add the apply helper next to `applyCNPG` (~line 439):

```swift
    private func applyScheduledBackup(_ event: WatchEvent<CNPGScheduledBackup>) {
        applyGeneric(event, list: \.scheduledBackups)
    }
```

Add the watch task next to `cnpgTask` (~line 233). It mirrors `cnpgTask`'s give-up-if-CRD-absent behavior but does not toggle `cnpgAvailable`:

```swift
    private func scheduledBackupTask(_ c: KubectlClient) -> Task<Void, Never> {
        reconnectingWatch(
            "scheduledbackups.postgresql.cnpg.io", c: c,
            onSync: { [weak self] items in self?.scheduledBackups = items },
            onEvent: { [weak self] event in self?.applyScheduledBackup(event) },
            onError: { _, hasConnected in hasConnected }
        )
    }
```

- [ ] **Step 6: Build to verify**

Run: `swift build`
Expected: builds with no errors.

- [ ] **Step 7: Commit**

```bash
git add Sources/Rigel/Cluster/KubeTypes.swift Sources/Rigel/Cluster/ClusterCache.swift Tests/RigelTests/CNPGTypesTests.swift
git commit -m "feat(databases): CNPG backup status + scheduledbackups watch"
```

---

## Task 2: Container env modeling (for generic credential discovery)

The generic-DB "reveal credentials" path resolves a secret from a pod's `env`/`envFrom`. The `Container` type does not model these yet.

**Files:**
- Modify: `Sources/Rigel/Cluster/KubeTypes.swift:29-34` (Container)
- Test: `Tests/RigelTests/ContainerEnvTests.swift`

- [ ] **Step 1: Write the failing decode test**

Create `Tests/RigelTests/ContainerEnvTests.swift`:

```swift
import XCTest
@testable import Rigel

final class ContainerEnvTests: XCTestCase {
    func test_container_decodesEnvSecretRefs() throws {
        let json = """
        {"name":"db","image":"postgres:16",
         "env":[{"name":"PGPASSWORD","valueFrom":{"secretKeyRef":{"name":"db-creds","key":"password"}}}],
         "envFrom":[{"secretRef":{"name":"db-env"}}]}
        """.data(using: .utf8)!
        let c = try JSONDecoder().decode(Container.self, from: json)
        XCTAssertEqual(c.env?.first?.valueFrom?.secretKeyRef?.name, "db-creds")
        XCTAssertEqual(c.envFrom?.first?.secretRef?.name, "db-env")
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `swift test --filter ContainerEnvTests`
Expected: FAIL — `env`/`envFrom` not members of `Container`.

- [ ] **Step 3: Extend Container**

In `Sources/Rigel/Cluster/KubeTypes.swift`, replace the `Container` struct (lines 29-34) with:

```swift
struct Container: Codable, Hashable {
    let name: String
    let image: String?
    let resources: ResourceRequirements?
    let ports: [ContainerPort]?
    let env: [EnvVar]?
    let envFrom: [EnvFromSource]?
}

struct EnvVar: Codable, Hashable {
    let name: String
    let valueFrom: EnvVarSource?
}

struct EnvVarSource: Codable, Hashable {
    let secretKeyRef: SecretKeySelector?
}

struct SecretKeySelector: Codable, Hashable {
    let name: String?
    let key: String?
}

struct EnvFromSource: Codable, Hashable {
    let secretRef: LocalObjectReference?
}

struct LocalObjectReference: Codable, Hashable {
    let name: String?
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `swift test --filter ContainerEnvTests`
Expected: PASS.

- [ ] **Step 5: Build to verify**

Run: `swift build`
Expected: builds (added fields are optional; existing decode sites unaffected).

- [ ] **Step 6: Commit**

```bash
git add Sources/Rigel/Cluster/KubeTypes.swift Tests/RigelTests/ContainerEnvTests.swift
git commit -m "feat(databases): model container env/envFrom secret refs"
```

---

## Task 3: CNPG plugin probe

**Files:**
- Create: `Sources/Rigel/Panels/Databases/CNPGPluginProbe.swift`
- Modify: `Sources/Rigel/Cluster/ClusterCache.swift` (add `cnpgPluginAvailable` + probe on start)
- Test: `Tests/RigelTests/CNPGPluginProbeTests.swift`

- [ ] **Step 1: Write the failing test**

Create `Tests/RigelTests/CNPGPluginProbeTests.swift`:

```swift
import XCTest
@testable import Rigel

final class CNPGPluginProbeTests: XCTestCase {
    func test_available_whenCommandSucceeds() async {
        let probe = CNPGPluginProbe(
            resolve: { _ in "/usr/local/bin/kubectl" },
            run: { _, _ in Data("cnpg version 1.25".utf8) }
        )
        let ok = await probe.isAvailable()
        XCTAssertTrue(ok)
    }

    func test_unavailable_whenCommandThrows() async {
        let probe = CNPGPluginProbe(
            resolve: { _ in "/usr/local/bin/kubectl" },
            run: { _, _ in throw ProcessError.nonZeroExit(code: 1, stderr: "unknown command \"cnpg\"") }
        )
        let ok = await probe.isAvailable()
        XCTAssertFalse(ok)
    }

    func test_unavailable_whenKubectlMissing() async {
        let probe = CNPGPluginProbe(resolve: { _ in nil }, run: { _, _ in Data() })
        let ok = await probe.isAvailable()
        XCTAssertFalse(ok)
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `swift test --filter CNPGPluginProbeTests`
Expected: FAIL — `CNPGPluginProbe` undefined.

- [ ] **Step 3: Implement the probe**

Create `Sources/Rigel/Panels/Databases/CNPGPluginProbe.swift`:

```swift
import Foundation

/// Detects whether the `kubectl cnpg` plugin is installed by running
/// `kubectl cnpg version`. Closures are injectable for testing; defaults use
/// the shared process helpers.
struct CNPGPluginProbe {
    var resolve: (_ name: String) -> String? = { resolveBinary($0) }
    var run: (_ binary: String, _ args: [String]) async throws -> Data = { bin, args in
        try await runProcess(bin, args: args)
    }

    func isAvailable() async -> Bool {
        guard let kubectl = resolve("kubectl") else { return false }
        do {
            _ = try await run(kubectl, ["cnpg", "version"])
            return true
        } catch {
            return false
        }
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `swift test --filter CNPGPluginProbeTests`
Expected: PASS.

- [ ] **Step 5: Wire the probe into ClusterCache**

In `Sources/Rigel/Cluster/ClusterCache.swift`, add near the other observable vars (~line 38, by `cnpgAvailable`):

```swift
    var cnpgPluginAvailable = false
```

In the `tasks` array (alongside `cnpgTask(c)`), add a one-shot probe task:

```swift
                Task { [weak self] in
                    let available = await CNPGPluginProbe().isAvailable()
                    await MainActor.run { self?.cnpgPluginAvailable = available }
                },
```

- [ ] **Step 6: Build to verify**

Run: `swift build`
Expected: builds.

- [ ] **Step 7: Commit**

```bash
git add Sources/Rigel/Panels/Databases/CNPGPluginProbe.swift Sources/Rigel/Cluster/ClusterCache.swift Tests/RigelTests/CNPGPluginProbeTests.swift
git commit -m "feat(databases): detect kubectl-cnpg plugin availability"
```

---

## Task 4: New WorkloadAction cases for CNPG ops

**Files:**
- Modify: `Sources/Rigel/Panels/Actions/WorkloadAction.swift` (enum + all switch arms)
- Test: `Tests/RigelTests/WorkloadActionCNPGTests.swift`

- [ ] **Step 1: Write the failing tests**

Create `Tests/RigelTests/WorkloadActionCNPGTests.swift`:

```swift
import XCTest
@testable import Rigel

final class WorkloadActionCNPGTests: XCTestCase {
    func test_backupNow_invocationAndRisk() {
        let a = WorkloadAction.cnpgBackupNow(cluster: "pg", namespace: "default")
        XCTAssertEqual(a.kubectlInvocations(), [.args(["cnpg", "backup", "pg", "-n", "default"])])
        XCTAssertFalse(a.isHighRisk)
        XCTAssertFalse(a.needsAcknowledge)
    }

    func test_switchover_promotesInstance_highRisk() {
        let a = WorkloadAction.cnpgSwitchover(cluster: "pg", namespace: "default", to: "pg-2")
        XCTAssertEqual(a.kubectlInvocations(), [.args(["cnpg", "promote", "pg", "pg-2", "-n", "default"])])
        XCTAssertTrue(a.isHighRisk)
        XCTAssertFalse(a.needsAcknowledge)
    }

    func test_hibernateOn_requiresAcknowledge() {
        let a = WorkloadAction.cnpgHibernate(cluster: "pg", namespace: "default", on: true)
        XCTAssertEqual(a.kubectlInvocations(), [.args(["cnpg", "hibernate", "on", "pg", "-n", "default"])])
        XCTAssertTrue(a.isHighRisk)
        XCTAssertTrue(a.needsAcknowledge)
    }

    func test_hibernateOff_isLowRisk() {
        let a = WorkloadAction.cnpgHibernate(cluster: "pg", namespace: "default", on: false)
        XCTAssertEqual(a.kubectlInvocations(), [.args(["cnpg", "hibernate", "off", "pg", "-n", "default"])])
        XCTAssertFalse(a.isHighRisk)
        XCTAssertFalse(a.needsAcknowledge)
    }

    func test_scaleCNPG_patchesInstances() {
        let a = WorkloadAction.scaleCNPG(cluster: "pg", namespace: "default", current: 3, to: 5)
        XCTAssertEqual(a.kubectlInvocations(), [.args(["patch", "cluster", "pg", "-n", "default", "--type=merge", "-p", "{\"spec\":{\"instances\":5}}"])])
        XCTAssertFalse(a.isHighRisk)
        XCTAssertFalse(a.needsAcknowledge)
    }

    func test_scaleCNPG_down_requiresAcknowledge() {
        let a = WorkloadAction.scaleCNPG(cluster: "pg", namespace: "default", current: 3, to: 1)
        XCTAssertTrue(a.isHighRisk)
        XCTAssertTrue(a.needsAcknowledge)
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `swift test --filter WorkloadActionCNPGTests`
Expected: FAIL — the new cases are undefined.

- [ ] **Step 3: Add the enum cases**

In `Sources/Rigel/Panels/Actions/WorkloadAction.swift`, add to the `enum WorkloadAction` case list (e.g. after `case setImage(...)`):

```swift
    /// CNPG: create an on-demand backup via the kubectl-cnpg plugin.
    case cnpgBackupNow(cluster: String, namespace: String)
    /// CNPG: promote a standby to primary (controlled switchover) via the plugin.
    case cnpgSwitchover(cluster: String, namespace: String, to: String)
    /// CNPG: hibernate (`on`) shuts the cluster down; `off` resumes it. Plugin.
    case cnpgHibernate(cluster: String, namespace: String, on: Bool)
    /// CNPG: scale instances by patching `spec.instances` (pure kubectl).
    case scaleCNPG(cluster: String, namespace: String, current: Int, to: Int)
```

- [ ] **Step 4: Add the `id` arms**

In the `var id` switch:

```swift
        case .cnpgBackupNow(let c, let ns): return "cnpg-backup-\(ns)/\(c)"
        case .cnpgSwitchover(let c, let ns, let to): return "cnpg-switchover-\(ns)/\(c)-\(to)"
        case .cnpgHibernate(let c, let ns, let on): return "cnpg-hibernate-\(ns)/\(c)-\(on)"
        case .scaleCNPG(let c, let ns, _, let to): return "scale-cnpg-\(ns)/\(c)-\(to)"
```

- [ ] **Step 5: Add the `title` arms**

In the `var title` switch:

```swift
        case .cnpgBackupNow(let c, _): return "Back up \(c) now"
        case .cnpgSwitchover(let c, _, let to): return "Switch over \(c) → \(to)"
        case .cnpgHibernate(let c, _, let on): return on ? "Hibernate \(c)" : "Resume \(c)"
        case .scaleCNPG(let c, _, _, let to): return "Scale \(c) → \(to)"
```

- [ ] **Step 6: Add the `subtitle` arms**

In the `var subtitle` switch:

```swift
        case .cnpgBackupNow(let c, let ns):
            return "Creates an on-demand backup of CNPG cluster \(ns)/\(c) via the kubectl-cnpg plugin. Non-destructive."
        case .cnpgSwitchover(let c, let ns, let to):
            return "Promotes standby \(to) to primary in CNPG cluster \(ns)/\(c). Causes a brief failover; in-flight connections drop."
        case .cnpgHibernate(let c, let ns, let on):
            return on
                ? "Hibernates CNPG cluster \(ns)/\(c): scales it to zero and shuts Postgres down. The database is OFFLINE until resumed."
                : "Resumes hibernated CNPG cluster \(ns)/\(c). Postgres starts back up."
        case .scaleCNPG(let c, let ns, let current, let to):
            return "Sets spec.instances from \(current) → \(to) on CNPG cluster \(ns)/\(c)."
```

- [ ] **Step 7: Add the `isHighRisk` arms**

The `isHighRisk` getter returns `false` for the listed cases and `true` in the `default`. Add the low-risk CNPG cases to the false list:

```swift
             .cnpgBackupNow,
             .scaleCNPG(_, _, let current, let to) where to >= current,
```

…and add the hibernate split — hibernate `on` and switchover are high-risk, hibernate `off` is low. Since `cnpgHibernate` has a Bool, add a dedicated arm BEFORE `default`:

Replace the `default: return true` tail of `isHighRisk` with:

```swift
        case .cnpgHibernate(_, _, let on):
            return on               // hibernate (offline) is high-risk; resume is not
        default:
            return true
        }
```

(`cnpgSwitchover` and scale-down fall through to `default` → high-risk.)

- [ ] **Step 8: Add the `needsAcknowledge` arms**

In `needsAcknowledge`, add cases that require the "I understand" checkbox. Replace its body's `default: return false` tail with:

```swift
        case .cnpgHibernate(_, _, let on):
            return on               // taking the DB offline needs acknowledgement
        case .scaleCNPG(_, _, let current, let to):
            return to < current     // scaling down drops replicas
        default:
            return false
        }
```

- [ ] **Step 9: Add the `kubectlInvocations()` arms**

In `func kubectlInvocations()`:

```swift
        case .cnpgBackupNow(let c, let ns):
            return [.args(["cnpg", "backup", c, "-n", ns])]
        case .cnpgSwitchover(let c, let ns, let to):
            return [.args(["cnpg", "promote", c, to, "-n", ns])]
        case .cnpgHibernate(let c, let ns, let on):
            return [.args(["cnpg", "hibernate", on ? "on" : "off", c, "-n", ns])]
        case .scaleCNPG(let c, let ns, _, let to):
            return [.args(["patch", "cluster", c, "-n", ns, "--type=merge", "-p", "{\"spec\":{\"instances\":\(to)}}"])]
```

- [ ] **Step 10: Run tests to verify they pass**

Run: `swift test --filter WorkloadActionCNPGTests`
Expected: PASS. Also run `swift build` to confirm all switches are exhaustive.

- [ ] **Step 11: Commit**

```bash
git add Sources/Rigel/Panels/Actions/WorkloadAction.swift Tests/RigelTests/WorkloadActionCNPGTests.swift
git commit -m "feat(databases): CNPG backup/switchover/hibernate/scale actions"
```

---

## Task 5: Capability value types

**Files:**
- Create: `Sources/Rigel/Panels/Databases/DatabaseCapabilities.swift`
- Test: `Tests/RigelTests/DatabaseActionTests.swift`

- [ ] **Step 1: Write the failing test**

Create `Tests/RigelTests/DatabaseActionTests.swift`:

```swift
import XCTest
@testable import Rigel

final class DatabaseActionTests: XCTestCase {
    func test_action_idAndLabel() {
        XCTAssertEqual(DatabaseAction.backupNow.label, "Back up")
        XCTAssertEqual(DatabaseAction.switchover(to: "pg-2").label, "Switch over")
        XCTAssertEqual(DatabaseAction.hibernate.id, "hibernate")
        XCTAssertEqual(DatabaseAction.resume.id, "resume")
        XCTAssertEqual(DatabaseAction.scale(current: 3, to: 5).id, "scale")
        XCTAssertEqual(DatabaseAction.portForward.id, "portForward")
        XCTAssertEqual(DatabaseAction.revealCredentials.id, "revealCredentials")
        XCTAssertEqual(DatabaseAction.copyDSN.id, "copyDSN")
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `swift test --filter DatabaseActionTests`
Expected: FAIL — types undefined.

- [ ] **Step 3: Implement the value types**

Create `Sources/Rigel/Panels/Databases/DatabaseCapabilities.swift`:

```swift
import Foundation

/// A management operation offered for a database instance. UI-facing; the
/// view model maps each to an existing flow (port-forward / secret reveal /
/// clipboard) or to a `WorkloadAction`.
enum DatabaseAction: Hashable, Identifiable {
    case backupNow
    case switchover(to: String)        // target standby instance/pod name
    case hibernate
    case resume
    case scale(current: Int, to: Int)
    case portForward
    case revealCredentials
    case copyDSN

    var id: String {
        switch self {
        case .backupNow:         return "backupNow"
        case .switchover:        return "switchover"
        case .hibernate:         return "hibernate"
        case .resume:            return "resume"
        case .scale:             return "scale"
        case .portForward:       return "portForward"
        case .revealCredentials: return "revealCredentials"
        case .copyDSN:           return "copyDSN"
        }
    }

    var label: String {
        switch self {
        case .backupNow:         return "Back up"
        case .switchover:        return "Switch over"
        case .hibernate:         return "Hibernate"
        case .resume:            return "Resume"
        case .scale:             return "Scale"
        case .portForward:       return "Port-forward"
        case .revealCredentials: return "Credentials"
        case .copyDSN:           return "Copy DSN"
        }
    }

    var systemImage: String {
        switch self {
        case .backupNow:         return "arrow.down.doc"
        case .switchover:        return "arrow.triangle.swap"
        case .hibernate:         return "moon.zzz"
        case .resume:            return "sun.max"
        case .scale:             return "arrow.up.arrow.down"
        case .portForward:       return "arrow.left.arrow.right"
        case .revealCredentials: return "key"
        case .copyDSN:           return "doc.on.doc"
        }
    }
}

/// One action plus whether it is currently usable (e.g. plugin missing, or no
/// standby to switch over to). The action bar renders disabled items with a tooltip.
struct DatabaseActionItem: Identifiable, Hashable {
    let action: DatabaseAction
    let enabled: Bool
    let disabledReason: String?
    var id: String { action.id }
}

/// How to connect to a database. `secretName` is nil when no credential secret
/// is discoverable (the credentials action is then hidden).
struct ConnectionInfo: Hashable {
    let targetKind: String     // "svc" | "pod"
    let targetName: String
    let namespace: String
    let port: Int
    let scheme: String         // "postgresql" | "mysql" | "redis" | ...
    let secretName: String?
    let username: String?      // CNPG: from the -app secret; generic: nil
    let dbName: String?
}

/// Backup/WAL health shown in the panel's "Backups & health" subsection.
struct BackupInfo: Hashable {
    let lastBackup: String?       // RFC3339 timestamp, nil if none yet
    let schedule: String?         // cron string, nil if no ScheduledBackup
    let walArchivingHealthy: Bool?  // nil if no ContinuousArchiving condition
}

/// The full set of management affordances an operator exposes for an instance.
struct DatabaseCapabilities {
    var actions: [DatabaseActionItem]
    var backupInfo: BackupInfo?
    var connection: ConnectionInfo?
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `swift test --filter DatabaseActionTests`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add Sources/Rigel/Panels/Databases/DatabaseCapabilities.swift Tests/RigelTests/DatabaseActionTests.swift
git commit -m "feat(databases): capability value types"
```

---

## Task 6: Operator protocol, registry, and conformers

**Files:**
- Create: `Sources/Rigel/Panels/Databases/DatabaseOperator.swift`
- Test: `Tests/RigelTests/DatabaseOperatorTests.swift`

- [ ] **Step 1: Write the failing tests**

Create `Tests/RigelTests/DatabaseOperatorTests.swift`:

```swift
import XCTest
@testable import Rigel

final class DatabaseOperatorTests: XCTestCase {

    private func instance(source: DatabaseSource, name: String = "pg", ns: String = "default",
                          desired: Int = 3, ready: Int = 3, primary: String? = "pg-1",
                          kind: DatabaseKind = .postgres) -> DatabaseInstance {
        DatabaseInstance(
            id: "u-\(name)", kind: kind, source: source, name: name, namespace: ns,
            image: "postgres:16", desiredReplicas: desired, readyReplicas: ready,
            phaseText: "Healthy", isHealthy: ready == desired, cnpgPrimary: primary,
            labelSelector: source == .cnpg ? ["cnpg.io/cluster": name] : ["app": name]
        )
    }

    private func emptyContext(pluginAvailable: Bool = true) -> DatabaseContext {
        DatabaseContext(cnpgPluginAvailable: pluginAvailable, scheduledBackups: [],
                        cnpgClusters: [], secrets: [], pods: [])
    }

    func test_registry_resolvesCNPGandNoOperator() {
        let reg = DatabaseOperatorRegistry()
        XCTAssertEqual(reg.operator(for: instance(source: .cnpg)).id, "cnpg")
        XCTAssertEqual(reg.operator(for: instance(source: .deployment)).id, "none")
        XCTAssertEqual(reg.operator(for: instance(source: .statefulset)).id, "none")
    }

    func test_cnpg_actions_whenPluginPresent() {
        let caps = CNPGOperator().capabilities(for: instance(source: .cnpg), context: emptyContext())
        let ids = caps.actions.filter { $0.enabled }.map { $0.action.id }
        XCTAssertTrue(ids.contains("backupNow"))
        XCTAssertTrue(ids.contains("hibernate"))
        XCTAssertTrue(ids.contains("scale"))
    }

    func test_cnpg_pluginActionsDisabled_whenPluginMissing() {
        let caps = CNPGOperator().capabilities(for: instance(source: .cnpg),
                                               context: emptyContext(pluginAvailable: false))
        let backup = caps.actions.first { $0.action.id == "backupNow" }!
        XCTAssertFalse(backup.enabled)
        XCTAssertNotNil(backup.disabledReason)
        // Scale is pure kubectl → still enabled.
        let scale = caps.actions.first { $0.action.id == "scale" }!
        XCTAssertTrue(scale.enabled)
    }

    func test_cnpg_switchoverTargetsAReadyStandby() {
        let pods = [
            Pod.testInstance(name: "pg-1", namespace: "default", phase: "Running"),
            Pod.testInstance(name: "pg-2", namespace: "default", phase: "Running"),
        ]
        let ctx = DatabaseContext(cnpgPluginAvailable: true, scheduledBackups: [],
                                  cnpgClusters: [], secrets: [], pods: pods)
        let caps = CNPGOperator().capabilities(for: instance(source: .cnpg), context: ctx)
        let sw = caps.actions.first { $0.action.id == "switchover" }!
        XCTAssertTrue(sw.enabled)
        XCTAssertEqual(sw.action, .switchover(to: "pg-2"))   // not the primary pg-1
    }

    func test_cnpg_switchoverDisabled_withoutStandby() {
        let pods = [Pod.testInstance(name: "pg-1", namespace: "default", phase: "Running")]
        let ctx = DatabaseContext(cnpgPluginAvailable: true, scheduledBackups: [],
                                  cnpgClusters: [], secrets: [], pods: pods)
        let caps = CNPGOperator().capabilities(for: instance(source: .cnpg), context: ctx)
        let sw = caps.actions.first { $0.action.id == "switchover" }!
        XCTAssertFalse(sw.enabled)
    }

    func test_cnpg_backupInfo_fromClusterAndSchedule() {
        let cluster = CNPGCluster(
            metadata: .init(uid: "u-pg", name: "pg", namespace: "default"),
            spec: .init(instances: 3, imageName: "postgres:16"),
            status: .init(phase: "healthy", instances: 3, readyInstances: 3,
                          currentPrimary: "pg-1", targetPrimary: "pg-1",
                          lastSuccessfulBackup: "2026-06-01T02:00:00Z",
                          conditions: [.init(type: "ContinuousArchiving", status: "True",
                                             reason: nil, message: nil)])
        )
        let sb = CNPGScheduledBackup(
            metadata: .init(uid: "s1", name: "pg-daily", namespace: "default"),
            spec: .init(schedule: "0 0 2 * * *", cluster: .init(name: "pg"))
        )
        let ctx = DatabaseContext(cnpgPluginAvailable: true, scheduledBackups: [sb],
                                  cnpgClusters: [cluster], secrets: [], pods: [])
        let caps = CNPGOperator().capabilities(for: instance(source: .cnpg), context: ctx)
        XCTAssertEqual(caps.backupInfo?.lastBackup, "2026-06-01T02:00:00Z")
        XCTAssertEqual(caps.backupInfo?.schedule, "0 0 2 * * *")
        XCTAssertEqual(caps.backupInfo?.walArchivingHealthy, true)
        XCTAssertEqual(caps.connection?.secretName, "pg-app")
    }

    func test_noOperator_hidesCredentials_whenNoSecretRef() {
        let pods = [Pod.testInstance(name: "redis-0", namespace: "default", phase: "Running")]
        let ctx = DatabaseContext(cnpgPluginAvailable: false, scheduledBackups: [],
                                  cnpgClusters: [], secrets: [], pods: pods)
        let caps = NoOperator().capabilities(
            for: instance(source: .statefulset, name: "redis", kind: .redis), context: ctx)
        XCTAssertNil(caps.actions.first { $0.action.id == "revealCredentials" })
        XCTAssertNil(caps.backupInfo)   // generic has no backup concept
    }
}
```

This test references two test helpers that may not exist yet — `Pod.testInstance(...)` and the `ObjectMeta`/`CNPGCluster` memberwise initializers used above. Check whether `Pod.testInstance` exists:

Run: `grep -rn "func testInstance\|static func testInstance" Tests/RigelTests Sources`

- [ ] **Step 2: Add the `Pod.testInstance` helper if missing**

If the grep above returns nothing, create `Tests/RigelTests/Support/PodTestSupport.swift`:

```swift
@testable import Rigel

extension Pod {
    /// Minimal Pod for tests: a name, namespace, and phase. Other fields nil.
    static func testInstance(name: String, namespace: String, phase: String,
                             nodeName: String? = nil) -> Pod {
        Pod(
            metadata: ObjectMeta(uid: "uid-\(name)", name: name, namespace: namespace),
            spec: Pod.Spec(nodeName: nodeName, containers: nil),
            status: PodStatus(phase: phase, podIP: nil, containerStatuses: nil)
        )
    }
}
```

> NOTE TO IMPLEMENTER: open `Sources/Rigel/Cluster/KubeTypes.swift` and match the REAL initializers for `Pod`, `Pod.Spec`, `ObjectMeta`, `CNPGCluster`, `CNPGClusterStatus`, `CNPGScheduledBackup`. Adjust the helper and the `cluster`/`sb` literals in Step 1 to the actual member names/order (e.g. `Pod.Spec` may name the field `containers`/`nodeName` differently). The intent — a Running pod named `pg-2` and a cluster whose status carries the new fields — must hold.

- [ ] **Step 3: Run test to verify it fails**

Run: `swift test --filter DatabaseOperatorTests`
Expected: FAIL — `DatabaseOperator`, `DatabaseOperatorRegistry`, `CNPGOperator`, `NoOperator`, `DatabaseContext` undefined.

- [ ] **Step 4: Implement the operator layer**

Create `Sources/Rigel/Panels/Databases/DatabaseOperator.swift`:

```swift
import Foundation

/// Read-only snapshot the operators consult to compute capabilities. Built by
/// the view model from the live `ClusterCache` each render.
struct DatabaseContext {
    let cnpgPluginAvailable: Bool
    let scheduledBackups: [CNPGScheduledBackup]
    let cnpgClusters: [CNPGCluster]
    let secrets: [Secret]
    let pods: [Pod]
}

/// Maps a detected database instance to the management affordances it supports.
/// Add a conformer + registry entry to support a new operator — no UI changes.
protocol DatabaseOperator {
    var id: String { get }
    func owns(_ instance: DatabaseInstance) -> Bool
    func capabilities(for instance: DatabaseInstance, context: DatabaseContext) -> DatabaseCapabilities
}

struct DatabaseOperatorRegistry {
    let operators: [DatabaseOperator]
    init(operators: [DatabaseOperator] = [CNPGOperator(), NoOperator()]) {
        self.operators = operators
    }
    func `operator`(for instance: DatabaseInstance) -> DatabaseOperator {
        operators.first { $0.owns(instance) } ?? NoOperator()
    }
    func capabilities(for instance: DatabaseInstance, context: DatabaseContext) -> DatabaseCapabilities {
        `operator`(for: instance).capabilities(for: instance, context: context)
    }
}

// MARK: - CNPG

struct CNPGOperator: DatabaseOperator {
    let id = "cnpg"
    func owns(_ instance: DatabaseInstance) -> Bool { instance.source == .cnpg }

    func capabilities(for instance: DatabaseInstance, context: DatabaseContext) -> DatabaseCapabilities {
        let pluginMissing = !context.cnpgPluginAvailable
        let pluginReason = "Requires the kubectl-cnpg plugin"

        // Ready pods for this cluster, primary excluded → switchover targets.
        let pods = context.pods.filter { pod in
            pod.metadata.namespace == instance.namespace &&
            (pod.metadata.labels?["cnpg.io/cluster"] == instance.name) &&
            pod.status?.phase == "Running"
        }
        let standby = pods.map(\.metadata.name).filter { $0 != instance.cnpgPrimary }.sorted().first

        var items: [DatabaseActionItem] = []

        items.append(DatabaseActionItem(action: .backupNow, enabled: !pluginMissing,
                                        disabledReason: pluginMissing ? pluginReason : nil))

        if let standby {
            items.append(DatabaseActionItem(action: .switchover(to: standby),
                                            enabled: !pluginMissing,
                                            disabledReason: pluginMissing ? pluginReason : nil))
        } else {
            items.append(DatabaseActionItem(action: .switchover(to: ""), enabled: false,
                                            disabledReason: "No ready standby to promote"))
        }

        // Resume when scaled to zero ready, else offer hibernate.
        if instance.readyReplicas == 0 {
            items.append(DatabaseActionItem(action: .resume, enabled: !pluginMissing,
                                            disabledReason: pluginMissing ? pluginReason : nil))
        } else {
            items.append(DatabaseActionItem(action: .hibernate, enabled: !pluginMissing,
                                            disabledReason: pluginMissing ? pluginReason : nil))
        }

        // Scale is pure kubectl → always enabled.
        items.append(DatabaseActionItem(action: .scale(current: instance.desiredReplicas,
                                                        to: instance.desiredReplicas),
                                        enabled: true, disabledReason: nil))

        // Connection helpers (pure kubectl / clipboard).
        items.append(DatabaseActionItem(action: .portForward, enabled: true, disabledReason: nil))
        items.append(DatabaseActionItem(action: .revealCredentials, enabled: true, disabledReason: nil))
        items.append(DatabaseActionItem(action: .copyDSN, enabled: true, disabledReason: nil))

        // Backup/health.
        let cluster = context.cnpgClusters.first { $0.metadata.name == instance.name
            && $0.metadata.namespace == instance.namespace }
        let schedule = context.scheduledBackups.first {
            $0.spec?.cluster?.name == instance.name && $0.metadata.namespace == instance.namespace
        }?.spec?.schedule
        let walCond = cluster?.status?.conditions?.first { $0.type == "ContinuousArchiving" }
        let backupInfo = BackupInfo(
            lastBackup: cluster?.status?.lastSuccessfulBackup,
            schedule: schedule,
            walArchivingHealthy: walCond.map { $0.status == "True" }
        )

        let connection = ConnectionInfo(
            targetKind: "svc", targetName: "\(instance.name)-rw", namespace: instance.namespace,
            port: 5432, scheme: "postgresql", secretName: "\(instance.name)-app",
            username: nil, dbName: "app"   // username filled by the view model from the secret
        )

        return DatabaseCapabilities(actions: items, backupInfo: backupInfo, connection: connection)
    }
}

// MARK: - Generic (no operator)

struct NoOperator: DatabaseOperator {
    let id = "none"
    func owns(_ instance: DatabaseInstance) -> Bool {
        instance.source == .deployment || instance.source == .statefulset
    }

    func capabilities(for instance: DatabaseInstance, context: DatabaseContext) -> DatabaseCapabilities {
        let pods = context.pods.filter { pod in
            pod.metadata.namespace == instance.namespace &&
            instance.labelSelector.allSatisfy { (pod.metadata.labels ?? [:])[$0.key] == $0.value }
        }
        let secretName = Self.discoverSecret(in: pods)
        let port = Self.defaultPort(for: instance.kind)
        let target = pods.first(where: { $0.status?.phase == "Running" }) ?? pods.first

        var items: [DatabaseActionItem] = []
        items.append(DatabaseActionItem(action: .scale(current: instance.desiredReplicas,
                                                        to: instance.desiredReplicas),
                                        enabled: true, disabledReason: nil))
        if target != nil {
            items.append(DatabaseActionItem(action: .portForward, enabled: true, disabledReason: nil))
        }
        if secretName != nil {
            items.append(DatabaseActionItem(action: .revealCredentials, enabled: true, disabledReason: nil))
        }
        items.append(DatabaseActionItem(action: .copyDSN, enabled: true, disabledReason: nil))

        let connection = target.map { t in
            ConnectionInfo(targetKind: "pod", targetName: t.metadata.name, namespace: instance.namespace,
                           port: port, scheme: Self.scheme(for: instance.kind),
                           secretName: secretName, username: nil, dbName: nil)
        }

        return DatabaseCapabilities(actions: items, backupInfo: nil, connection: connection)
    }

    /// First secret referenced by any container's env / envFrom. nil if none.
    static func discoverSecret(in pods: [Pod]) -> String? {
        for pod in pods {
            for ct in pod.spec?.containers ?? [] {
                if let n = ct.envFrom?.compactMap({ $0.secretRef?.name }).first { return n }
                if let n = ct.env?.compactMap({ $0.valueFrom?.secretKeyRef?.name }).first { return n }
            }
        }
        return nil
    }

    static func defaultPort(for kind: DatabaseKind) -> Int {
        switch kind {
        case .postgres:                       return 5432
        case .mysql, .mariadb:                return 3306
        case .mongo:                          return 27017
        case .redis, .valkey, .keydb, .dragonfly: return 6379
        case .clickhouse:                     return 9000
        case .elasticsearch, .opensearch:     return 9200
        case .cassandra, .scylla:             return 9042
        }
    }

    static func scheme(for kind: DatabaseKind) -> String {
        switch kind {
        case .postgres:                       return "postgresql"
        case .mysql, .mariadb:                return "mysql"
        case .mongo:                          return "mongodb"
        case .redis, .valkey, .keydb, .dragonfly: return "redis"
        case .clickhouse:                     return "clickhouse"
        case .elasticsearch, .opensearch:     return "http"
        case .cassandra, .scylla:             return "cassandra"
        }
    }
}
```

> NOTE TO IMPLEMENTER: confirm the Pod spec field is `pod.spec?.containers` (it is referenced as `$0.spec?.containers` elsewhere in `DatabasesViewModel`/cache). If `Pod.Spec` names containers differently, adjust `discoverSecret`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `swift test --filter DatabaseOperatorTests`
Expected: PASS. Fix any initializer mismatches flagged in the NOTE blocks until green.

- [ ] **Step 6: Commit**

```bash
git add Sources/Rigel/Panels/Databases/DatabaseOperator.swift Tests/RigelTests/DatabaseOperatorTests.swift Tests/RigelTests/Support/PodTestSupport.swift
git commit -m "feat(databases): operator abstraction + CNPG/generic conformers"
```

---

## Task 7: View model — capabilities, context, DSN, credential lookup

**Files:**
- Modify: `Sources/Rigel/Panels/Databases/DatabasesViewModel.swift`
- Test: `Tests/RigelTests/DatabasesViewModelTests.swift`

- [ ] **Step 1: Write the failing tests**

Create `Tests/RigelTests/DatabasesViewModelTests.swift`:

```swift
import XCTest
@testable import Rigel

final class DatabasesViewModelTests: XCTestCase {
    func test_dsn_cnpgWithUsername() {
        let conn = ConnectionInfo(targetKind: "svc", targetName: "pg-rw", namespace: "default",
                                  port: 5432, scheme: "postgresql", secretName: "pg-app",
                                  username: "app", dbName: "app")
        XCTAssertEqual(DatabasesViewModel.dsn(for: conn),
                       "postgresql://app@pg-rw.default.svc:5432/app")
    }

    func test_dsn_genericNoCredsNoDB() {
        let conn = ConnectionInfo(targetKind: "pod", targetName: "redis-0", namespace: "default",
                                  port: 6379, scheme: "redis", secretName: nil,
                                  username: nil, dbName: nil)
        XCTAssertEqual(DatabasesViewModel.dsn(for: conn), "redis://redis-0.default:6379")
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `swift test --filter DatabasesViewModelTests`
Expected: FAIL — `DatabasesViewModel.dsn(for:)` undefined.

- [ ] **Step 3: Add capabilities, context, and DSN to the view model**

In `Sources/Rigel/Panels/Databases/DatabasesViewModel.swift`, add a registry stored property and these methods (inside the class):

```swift
    private let registry = DatabaseOperatorRegistry()

    /// Live snapshot for operator capability computation.
    private var databaseContext: DatabaseContext {
        DatabaseContext(
            cnpgPluginAvailable: cache.cnpgPluginAvailable,
            scheduledBackups: cache.scheduledBackups,
            cnpgClusters: cache.cnpgClusters,
            secrets: cache.secrets,
            pods: cache.pods
        )
    }

    func capabilities(for instance: DatabaseInstance) -> DatabaseCapabilities {
        var caps = registry.capabilities(for: instance, context: databaseContext)
        // Fill the CNPG username from the -app secret if present.
        if var conn = caps.connection, conn.username == nil, let secretName = conn.secretName,
           let user = username(fromSecret: secretName, namespace: conn.namespace) {
            conn = ConnectionInfo(targetKind: conn.targetKind, targetName: conn.targetName,
                                  namespace: conn.namespace, port: conn.port, scheme: conn.scheme,
                                  secretName: conn.secretName, username: user, dbName: conn.dbName)
            caps.connection = conn
        }
        return caps
    }

    /// Decodes the `username` key from a secret in the cache, if present.
    private func username(fromSecret name: String, namespace: String) -> String? {
        guard let secret = cache.secrets.first(where: {
            $0.metadata.name == name && ($0.metadata.namespace ?? "default") == namespace
        }), let b64 = secret.data?["username"], let data = Data(base64Encoded: b64) else { return nil }
        return String(data: data, encoding: .utf8)
    }

    /// Builds a connection string. `user`/`db` are omitted when nil.
    static func dsn(for c: ConnectionInfo) -> String {
        let hostSuffix = c.targetKind == "svc" ? ".\(c.namespace).svc" : ".\(c.namespace)"
        var s = "\(c.scheme)://"
        if let u = c.username { s += "\(u)@" }
        s += "\(c.targetName)\(hostSuffix):\(c.port)"
        if let db = c.dbName { s += "/\(db)" }
        return s
    }
```

> NOTE TO IMPLEMENTER: confirm `Secret.data` is `[String: String]` of base64 values (matches the `Secret.draft`/`moveSecret` decode in `WorkloadAction.swift`, which does `Data(base64Encoded:)` on `data` values). If the field name differs, adjust `username(fromSecret:)`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `swift test --filter DatabasesViewModelTests`
Expected: PASS.

- [ ] **Step 5: Build to verify**

Run: `swift build`
Expected: builds.

- [ ] **Step 6: Commit**

```bash
git add Sources/Rigel/Panels/Databases/DatabasesViewModel.swift Tests/RigelTests/DatabasesViewModelTests.swift
git commit -m "feat(databases): view model capabilities, DSN, credential lookup"
```

---

## Task 8: Panel UI — action bar, connection, backups/health

This task is SwiftUI; verification is build + manual (no unit test, matching how other panels in this codebase are tested).

**Files:**
- Modify: `Sources/Rigel/Panels/Databases/DatabasesPanel.swift`

- [ ] **Step 1: Add callback closures to DatabasesPanel and DatabaseRow**

At the top of `struct DatabasesPanel`, add (after `@Bindable var viewModel`):

```swift
    let onAction: (WorkloadAction) -> Void
    let onPortForward: (ConnectionInfo) -> Void
    let onRevealCredentials: (_ secretName: String, _ namespace: String) -> Void
    let onCopyDSN: (String) -> Void
```

In the `list` body where `DatabaseRow(...)` is constructed, pass through capabilities + the closures:

```swift
                    DatabaseRow(
                        instance: inst,
                        capabilities: viewModel.capabilities(for: inst),
                        isExpanded: viewModel.isExpanded(inst),
                        nodes: viewModel.nodes(for: inst),
                        childPods: viewModel.isExpanded(inst) ? viewModel.pods(for: inst) : [],
                        onToggle: { viewModel.toggleExpansion(inst) },
                        onAction: onAction,
                        onPortForward: onPortForward,
                        onRevealCredentials: onRevealCredentials,
                        onCopyDSN: onCopyDSN
                    )
```

Add the matching stored properties to `private struct DatabaseRow` (after `let onToggle`):

```swift
    let capabilities: DatabaseCapabilities
    let onAction: (WorkloadAction) -> Void
    let onPortForward: (ConnectionInfo) -> Void
    let onRevealCredentials: (_ secretName: String, _ namespace: String) -> Void
    let onCopyDSN: (String) -> Void
```

> NOTE: `DatabaseRow`'s memberwise init takes parameters in declaration order — keep the call site order in sync with the property order.

- [ ] **Step 2: Add the action bar + connection + backups subsections to `expandedDetails`**

In `DatabaseRow.expandedDetails`, insert an action bar at the top (before the `IMAGE` row) and the two new subsections after the PODS list. Add these computed views to `DatabaseRow`:

```swift
    @ViewBuilder private var actionBar: some View {
        if !capabilities.actions.isEmpty {
            HStack(spacing: 6) {
                ForEach(capabilities.actions) { item in
                    Button { perform(item.action) } label: {
                        Label(item.action.label, systemImage: item.action.systemImage)
                            .font(Theme.Font.body(11, weight: .medium))
                    }
                    .buttonStyle(.plain)
                    .padding(.horizontal, 8).padding(.vertical, 4)
                    .background(Theme.Surface.elevated)
                    .overlay(RoundedRectangle(cornerRadius: Theme.Radius.sm)
                        .strokeBorder(Theme.Border.subtle, lineWidth: 1))
                    .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
                    .foregroundStyle(item.enabled ? Theme.Foreground.primary : Theme.Foreground.tertiary)
                    .disabled(!item.enabled)
                    .help(item.disabledReason ?? item.action.label)
                }
            }
            .padding(.bottom, 4)
        }
    }

    @ViewBuilder private var connectionSection: some View {
        if let conn = capabilities.connection {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text("CONNECT")
                    .font(Theme.Font.body(9, weight: .semibold)).tracking(0.5)
                    .foregroundStyle(Theme.Foreground.tertiary).frame(width: 60, alignment: .leading)
                Text("\(conn.targetName).\(conn.namespace):\(conn.port)")
                    .font(Theme.Font.mono(11)).foregroundStyle(Theme.Foreground.primary)
                    .textSelection(.enabled)
            }
        }
    }

    @ViewBuilder private var backupSection: some View {
        if let b = capabilities.backupInfo {
            VStack(alignment: .leading, spacing: 4) {
                Text("BACKUPS & HEALTH")
                    .font(Theme.Font.body(9, weight: .semibold)).tracking(0.5)
                    .foregroundStyle(Theme.Foreground.tertiary).padding(.top, 4)
                kv("Last backup", b.lastBackup ?? "never")
                kv("Schedule", b.schedule ?? "none configured")
                HStack(spacing: 6) {
                    Text("WAL archiving")
                        .font(Theme.Font.body(11)).foregroundStyle(Theme.Foreground.secondary)
                        .frame(width: 90, alignment: .leading)
                    let healthy = b.walArchivingHealthy
                    Circle().fill(healthy == true ? Theme.Status.running
                                  : healthy == false ? Theme.Status.failed : Theme.Foreground.tertiary)
                        .frame(width: 6, height: 6)
                    Text(healthy == true ? "healthy" : healthy == false ? "failing" : "unknown")
                        .font(Theme.Font.mono(10)).foregroundStyle(Theme.Foreground.secondary)
                }
            }
        }
    }

    private func kv(_ k: String, _ v: String) -> some View {
        HStack(spacing: 6) {
            Text(k).font(Theme.Font.body(11)).foregroundStyle(Theme.Foreground.secondary)
                .frame(width: 90, alignment: .leading)
            Text(v).font(Theme.Font.mono(10)).foregroundStyle(Theme.Foreground.primary)
        }
    }
```

Then place `actionBar` at the very top of the `expandedDetails` `VStack` (before the `IMAGE` block) and add `connectionSection` and `backupSection` after the PODS section. For example, wrap the existing content so the VStack begins with:

```swift
        VStack(alignment: .leading, spacing: 6) {
            actionBar
            // …existing IMAGE / STATUS / PODS content…
            connectionSection
            backupSection
        }
```

- [ ] **Step 3: Implement the `perform` dispatcher on DatabaseRow**

Add to `DatabaseRow`:

```swift
    private func perform(_ action: DatabaseAction) {
        let ns = instance.namespace
        switch action {
        case .backupNow:
            onAction(.cnpgBackupNow(cluster: instance.name, namespace: ns))
        case .switchover(let to):
            onAction(.cnpgSwitchover(cluster: instance.name, namespace: ns, to: to))
        case .hibernate:
            onAction(.cnpgHibernate(cluster: instance.name, namespace: ns, on: true))
        case .resume:
            onAction(.cnpgHibernate(cluster: instance.name, namespace: ns, on: false))
        case .scale(let current, _):
            // CNPG scales via the Cluster CR; generic via its workload kind.
            if instance.source == .cnpg {
                onAction(.scaleCNPG(cluster: instance.name, namespace: ns,
                                    current: current, to: current))
            } else {
                let kind = instance.source == .statefulset ? "statefulset" : "deployment"
                onAction(.scaleWorkload(kind: kind, name: instance.name, namespace: ns,
                                        current: current, to: current))
            }
        case .portForward:
            if let c = capabilities.connection { onPortForward(c) }
        case .revealCredentials:
            if let c = capabilities.connection, let s = c.secretName {
                onRevealCredentials(s, c.namespace)
            }
        case .copyDSN:
            if let c = capabilities.connection { onCopyDSN(DatabasesViewModel.dsn(for: c)) }
        }
    }
```

> NOTE: scale opens the confirm sheet with `to == current`; the user adjusts the target in the sheet. If `WorkloadConfirmSheet` has no replica stepper, a follow-up can add a small scale prompt sheet — out of scope for v1; the confirm sheet's preview still shows the patch/scale command.

- [ ] **Step 4: Build to verify**

Run: `swift build`
Expected: builds. (MainWindow will not compile yet because `DatabasesPanel(...)` now needs the new closures — that is Task 9. If building the whole target fails only on the `DatabasesPanel(viewModel:)` call site, proceed to Task 9 and build them together.)

- [ ] **Step 5: Commit**

```bash
git add Sources/Rigel/Panels/Databases/DatabasesPanel.swift
git commit -m "feat(databases): action bar, connection + backups/health subsections"
```

---

## Task 9: Wire DatabasesPanel into MainWindow

**Files:**
- Modify: `Sources/Rigel/Shell/MainWindow.swift:505` (the `.databases` case)

- [ ] **Step 1: Pass the new closures**

Replace the `.databases` case (line ~505):

```swift
        case .databases:
            DatabasesPanel(viewModel: databasesVM)
```

with:

```swift
        case .databases:
            DatabasesPanel(
                viewModel: databasesVM,
                onAction: { requestWorkload($0) },
                onPortForward: { conn in
                    pendingPortForward = PortForwardTarget(
                        targetKind: conn.targetKind,
                        targetName: conn.targetName,
                        namespace: conn.namespace,
                        remotePort: conn.port
                    )
                },
                onRevealCredentials: { secretName, namespace in
                    if let secret = cache.secrets.first(where: {
                        $0.metadata.name == secretName && ($0.metadata.namespace ?? "default") == namespace
                    }) {
                        manageSecret = secret
                    }
                },
                onCopyDSN: { dsn in
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(dsn, forType: .string)
                }
            )
```

> NOTE TO IMPLEMENTER: confirm `manageSecret` (the secret-manage sheet binding seen at MainWindow:509) and `cache` are in scope here; both are used by the adjacent `.secrets`/`.services` cases. `PortForwardTarget` is defined in `ServicesPanel.swift`.

- [ ] **Step 2: Build the whole target**

Run: `swift build`
Expected: builds with no errors.

- [ ] **Step 3: Run the full test suite**

Run: `swift test`
Expected: all tests pass.

- [ ] **Step 4: Manual smoke test**

Run: `make run`
Verify in the Databases panel: expand a CNPG cluster → action bar shows Back up / Switch over / Hibernate / Scale / Port-forward / Credentials / Copy DSN; Backups & health shows last backup, schedule, WAL status; Copy DSN puts a `postgresql://…` string on the clipboard; Back up opens the confirm sheet previewing `kubectl … cnpg backup …`. With the plugin uninstalled, the three plugin actions are disabled with a tooltip while Scale/Copy DSN/Port-forward still work. Expand a bare Deployment/StatefulSet DB → only Scale / Port-forward / (Credentials if discoverable) / Copy DSN appear, no Backups & health.

- [ ] **Step 5: Commit**

```bash
git add Sources/Rigel/Shell/MainWindow.swift
git commit -m "feat(databases): wire management actions into MainWindow"
```

---

## Self-Review Notes

- **Spec coverage:** Lifecycle ops (Task 4 actions + Task 6 capabilities), connection & credentials (Tasks 5–9: ConnectionInfo, DSN, port-forward, reveal), backups & health (Tasks 1, 6, 8), multi-operator abstraction (Task 6), plugin detection + graceful degradation (Tasks 3, 6, 8). All covered.
- **Generic credential discovery** requires Container env modeling — added in Task 2 so the `NoOperator.discoverSecret` path in Task 6 compiles.
- **Type consistency:** `DatabaseAction`/`DatabaseActionItem`/`ConnectionInfo`/`BackupInfo`/`DatabaseContext` defined in Task 5–6 and consumed unchanged in Tasks 7–9. New `WorkloadAction` cases (`cnpgBackupNow`, `cnpgSwitchover`, `cnpgHibernate`, `scaleCNPG`) defined in Task 4 and dispatched in Task 8.
- **NOTE TO IMPLEMENTER blocks** flag the few places where exact initializer/field names must be confirmed against `KubeTypes.swift`/`Secret.swift` (test fixtures, `Pod.Spec.containers`, `Secret.data`). These are the only intentionally-unverified spots; the build/tests will catch mismatches immediately.
