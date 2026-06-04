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
}
