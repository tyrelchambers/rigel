import XCTest
@testable import Helmsman

final class NamespaceTests: XCTestCase {

    func test_namespace_phaseDefaultsToActive() throws {
        let active = try JSONDecoder.kube.decode(Namespace.self, from: Data("""
        {"metadata":{"name":"default","uid":"n1"},"status":{"phase":"Active"}}
        """.utf8))
        XCTAssertEqual(active.phase, "Active")

        // Missing status → treated as Active.
        let bare = try JSONDecoder.kube.decode(Namespace.self, from: Data("""
        {"metadata":{"name":"kube-system","uid":"n2"}}
        """.utf8))
        XCTAssertEqual(bare.phase, "Active")

        let terminating = try JSONDecoder.kube.decode(Namespace.self, from: Data("""
        {"metadata":{"name":"old","uid":"n3"},"status":{"phase":"Terminating"}}
        """.utf8))
        XCTAssertEqual(terminating.phase, "Terminating")
    }

    func test_createNamespace_invocationAndRisk() {
        let action = WorkloadAction.createNamespace(name: "staging")
        XCTAssertEqual(action.kubectlInvocations(), [.args(["create", "namespace", "staging"])])
        XCTAssertFalse(action.isHighRisk)
        XCTAssertFalse(action.needsAcknowledge)
        XCTAssertTrue(action.title.contains("staging"))
    }

    func test_deleteNamespace_invocationAndRisk() {
        let action = WorkloadAction.deleteNamespace(name: "staging")
        XCTAssertEqual(action.kubectlInvocations(), [.args(["delete", "namespace", "staging"])])
        XCTAssertTrue(action.isHighRisk)
        XCTAssertTrue(action.needsAcknowledge)
        // The cascade warning is what makes this safe to expose.
        XCTAssertTrue(action.subtitle.contains("irreversible"))
    }
}
