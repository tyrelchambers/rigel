import XCTest
@testable import Helmsman

final class WorkloadActionIngressTests: XCTestCase {
    private func sampleIngress() -> Ingress {
        Ingress.draft(
            name: "web", namespace: "default", className: "nginx",
            rules: [.init(host: "a.com", path: "/", pathType: "Prefix", service: "svc", port: "80")],
            tls: [], annotations: [:]
        )
    }

    func test_applyIngress_isApplyYAML() {
        let action = WorkloadAction.applyIngress(sampleIngress(), isNew: false)
        let invs = action.kubectlInvocations()
        XCTAssertEqual(invs.count, 1)
        XCTAssertEqual(invs[0].args, ["apply", "-f", "-"])
        XCTAssertNotNil(invs[0].stdin)
        XCTAssertFalse(action.isHighRisk)
        XCTAssertFalse(action.needsAcknowledge)
    }

    func test_applyIngress_titleReflectsIsNew() {
        XCTAssertTrue(WorkloadAction.applyIngress(sampleIngress(), isNew: true).title.contains("Create"))
        XCTAssertTrue(WorkloadAction.applyIngress(sampleIngress(), isNew: false).title.contains("Apply"))
    }

    func test_deleteIngress_invocationAndRisk() {
        let action = WorkloadAction.deleteIngress(name: "web", namespace: "default")
        XCTAssertEqual(action.kubectlInvocations(), [.args(["delete", "ingress", "web", "-n", "default"])])
        XCTAssertTrue(action.isHighRisk)
        XCTAssertTrue(action.needsAcknowledge)
    }
}
