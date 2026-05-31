import XCTest
@testable import Helmsman

final class PanelKindTests: XCTestCase {
    func test_namespaceScoped_tabs() {
        let scoped: Set<PanelKind> = [
            .deployments, .pods, .workloads, .rightSizing, .ingresses,
            .services, .secrets, .configMaps, .storage, .rbac, .events,
        ]
        for kind in PanelKind.allCases {
            XCTAssertEqual(kind.isNamespaceScoped, scoped.contains(kind),
                           "\(kind) namespace-scoped flag mismatch")
        }
    }
}
