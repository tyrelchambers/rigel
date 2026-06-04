import XCTest
@testable import Helmsman

final class PurgeGuardrailsTests: XCTestCase {
    func test_systemNamespaces_areNotPurgeable() {
        for ns in ["kube-system", "kube-public", "kube-node-lease", "cert-manager",
                   "cnpg-system", "cattle-system", "cattle-fleet-system"] {
            XCTAssertFalse(PurgeGuardrails.isPurgeable(namespace: ns), "\(ns) must be protected")
        }
    }
    func test_userNamespaces_arePurgeable() {
        XCTAssertTrue(PurgeGuardrails.isPurgeable(namespace: "default"))
        XCTAssertTrue(PurgeGuardrails.isPurgeable(namespace: "personal"))
    }
    func test_sharedDBServerWorkloads_areProtected() {
        XCTAssertTrue(PurgeGuardrails.isSharedInfraWorkload(name: "postgres", namespace: "default"))
        XCTAssertTrue(PurgeGuardrails.isSharedInfraWorkload(name: "mysql", namespace: "default"))
        XCTAssertFalse(PurgeGuardrails.isSharedInfraWorkload(name: "canada-hires-web", namespace: "default"))
    }
}
