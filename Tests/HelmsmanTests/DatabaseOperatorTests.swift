import XCTest
@testable import Helmsman

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
        XCTAssertEqual(sw.action, .switchover(to: "pg-2"))
    }

    func test_cnpg_switchoverDisabled_withoutStandby() {
        let pods = [Pod.testInstance(name: "pg-1", namespace: "default", phase: "Running")]
        let ctx = DatabaseContext(cnpgPluginAvailable: true, scheduledBackups: [],
                                  cnpgClusters: [], secrets: [], pods: pods)
        let caps = CNPGOperator().capabilities(for: instance(source: .cnpg), context: ctx)
        let sw = caps.actions.first { $0.action.id == "switchover" }!
        XCTAssertFalse(sw.enabled)
    }

    func test_cnpg_switchoverDisabled_whenNoPrimaryElected() {
        // Primary not yet elected: even with multiple Running pods, none is a
        // valid promotion target, so switchover must stay disabled.
        let pods = [
            Pod.testInstance(name: "pg-1", namespace: "default", phase: "Running"),
            Pod.testInstance(name: "pg-2", namespace: "default", phase: "Running"),
        ]
        let ctx = DatabaseContext(cnpgPluginAvailable: true, scheduledBackups: [],
                                  cnpgClusters: [], secrets: [], pods: pods)
        let caps = CNPGOperator().capabilities(for: instance(source: .cnpg, primary: nil), context: ctx)
        let sw = caps.actions.first { $0.action.id == "switchover" }!
        XCTAssertFalse(sw.enabled)
        XCTAssertEqual(sw.action, .switchover(to: ""))
    }

    func test_cnpg_backupInfo_fromClusterAndSchedule() {
        let cluster = CNPGCluster(
            metadata: ObjectMeta(name: "pg", namespace: "default", uid: "u-pg",
                                 creationTimestamp: nil, labels: nil, annotations: nil),
            spec: CNPGClusterSpec(instances: 3, imageName: "postgres:16"),
            status: CNPGClusterStatus(
                phase: "healthy", instances: 3, readyInstances: 3,
                currentPrimary: "pg-1", targetPrimary: "pg-1",
                lastSuccessfulBackup: "2026-06-01T02:00:00Z",
                conditions: [CNPGCondition(type: "ContinuousArchiving", status: "True",
                                           reason: nil, message: nil)])
        )
        let sb = CNPGScheduledBackup(
            metadata: ObjectMeta(name: "pg-daily", namespace: "default", uid: "s1",
                                 creationTimestamp: nil, labels: nil, annotations: nil),
            spec: CNPGScheduledBackup.Spec(schedule: "0 0 2 * * *",
                                           cluster: CNPGScheduledBackup.ClusterRef(name: "pg"))
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
        XCTAssertNil(caps.backupInfo)
    }
}
