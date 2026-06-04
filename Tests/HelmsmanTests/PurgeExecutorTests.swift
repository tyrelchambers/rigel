import XCTest
@testable import Helmsman

final class PurgeExecutorTests: XCTestCase {
    func test_mapsSelectedResourcesToActions_skipsDeselectedAndProtected() {
        let plan = PurgePlan(appName: "x", namespace: "default", resources: [
            PurgeResource(kind: .deployment, name: "x-web", namespace: "default", selected: true),
            PurgeResource(kind: .service, name: "x-web", namespace: "default", selected: false),
            PurgeResource(kind: .pvc, name: "x-data", namespace: "default", selected: true),
        ])
        let actions = PurgeExecutor.actions(for: plan)
        XCTAssertEqual(actions.count, 2) // service deselected → excluded
    }

    func test_protectedNamespace_yieldsNoActions() {
        let plan = PurgePlan(appName: "r", namespace: "kube-system", resources: [
            PurgeResource(kind: .deployment, name: "r", namespace: "kube-system", selected: true)
        ])
        XCTAssertTrue(PurgeExecutor.actions(for: plan).isEmpty)
    }

    func test_helmRelease_addsUninstallStep() {
        var plan = PurgePlan(appName: "plane", namespace: "personal", resources: [])
        plan.helmRelease = "plane"
        XCTAssertEqual(PurgeExecutor.helmUninstallArgs(for: plan),
                       ["uninstall", "plane", "-n", "personal"])
    }

    func test_helmRelease_inProtectedNamespace_yieldsNoUninstall() {
        var plan = PurgePlan(appName: "x", namespace: "kube-system", resources: [])
        plan.helmRelease = "x"
        XCTAssertNil(PurgeExecutor.helmUninstallArgs(for: plan))
    }

    func test_noHelmRelease_yieldsNoUninstall() {
        let plan = PurgePlan(appName: "x", namespace: "default", resources: [])
        XCTAssertNil(PurgeExecutor.helmUninstallArgs(for: plan))
    }

    func test_dropDatabase_optInOnly() {
        var plan = PurgePlan(appName: "canadahires", namespace: "default", resources: [])
        plan.databaseHint = "canadahires"
        XCTAssertNil(PurgeExecutor.dbDropPlan(for: plan))          // default off
        plan.dropDatabase = true
        XCTAssertEqual(PurgeExecutor.dbDropPlan(for: plan)?.database, "canadahires")
    }

    func test_dropDatabase_withoutHint_yieldsNil() {
        var plan = PurgePlan(appName: "x", namespace: "default", resources: [])
        plan.dropDatabase = true
        XCTAssertNil(PurgeExecutor.dbDropPlan(for: plan))
    }
}
