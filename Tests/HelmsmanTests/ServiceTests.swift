import XCTest
@testable import Helmsman

final class ServiceTests: XCTestCase {
    private func draft(
        type: String = Service.clusterIP,
        selector: [String: String] = ["app": "web"],
        ports: [Service.PortDraft] = [.init(name: "http", port: "80", targetPort: "8080", protocolName: "TCP", nodePort: "")]
    ) -> Service {
        Service.draft(name: "web", namespace: "default", type: type, selector: selector, ports: ports)
    }

    func test_draft_toYAML_basicClusterIP() {
        let yaml = draft().toYAML()
        XCTAssertTrue(yaml.contains("apiVersion: v1"))
        XCTAssertTrue(yaml.contains("kind: Service"))
        XCTAssertTrue(yaml.contains("name: 'web'"))
        XCTAssertTrue(yaml.contains("namespace: 'default'"))
        XCTAssertTrue(yaml.contains("type: 'ClusterIP'"))
        XCTAssertTrue(yaml.contains("'app': 'web'"))   // selector keys are quoted
        XCTAssertTrue(yaml.contains("port: 80"))
        XCTAssertTrue(yaml.contains("targetPort: 8080"))   // numeric → bare, not quoted
        XCTAssertTrue(yaml.contains("protocol: 'TCP'"))
    }

    func test_draft_namedTargetPort_isQuoted() {
        let yaml = draft(ports: [.init(name: "", port: "80", targetPort: "http", protocolName: "TCP", nodePort: "")]).toYAML()
        XCTAssertTrue(yaml.contains("targetPort: 'http'"))
    }

    func test_draft_emptyTargetPort_omitsKey() {
        let yaml = draft(ports: [.init(name: "", port: "80", targetPort: "", protocolName: "TCP", nodePort: "")]).toYAML()
        XCTAssertFalse(yaml.contains("targetPort:"))
    }

    func test_draft_nodePort_emitted() {
        let yaml = draft(type: Service.nodePort,
                         ports: [.init(name: "", port: "80", targetPort: "", protocolName: "TCP", nodePort: "30080")]).toYAML()
        XCTAssertTrue(yaml.contains("nodePort: 30080"))
    }

    func test_draft_skipsNonNumericPort() {
        let svc = draft(ports: [.init(name: "", port: "abc", targetPort: "", protocolName: "TCP", nodePort: "")])
        XCTAssertNil(svc.spec?.ports)
    }

    func test_draft_emptySelector_omitsKey() {
        let svc = draft(selector: [:])
        XCTAssertNil(svc.spec?.selector)
        XCTAssertFalse(svc.toYAML().contains("selector:"))
    }

    func test_portDrafts_roundTripFromSpec() {
        let drafts = draft().portDrafts
        XCTAssertEqual(drafts.count, 1)
        XCTAssertEqual(drafts[0].name, "http")
        XCTAssertEqual(drafts[0].port, "80")
        XCTAssertEqual(drafts[0].targetPort, "8080")
        XCTAssertEqual(drafts[0].protocolName, "TCP")
    }

    func test_portSummaries_arrowOnlyWhenTargetDiffers() {
        XCTAssertEqual(draft().portSummaries, ["80→8080/TCP"])
        let same = draft(ports: [.init(name: "", port: "80", targetPort: "80", protocolName: "TCP", nodePort: "")])
        XCTAssertEqual(same.portSummaries, ["80/TCP"])
    }

    func test_forwardablePorts_emptyForExternalName() {
        XCTAssertTrue(draft(type: Service.externalName).forwardablePorts.isEmpty)
        XCTAssertEqual(draft().forwardablePorts.count, 1)
    }

    // MARK: - WorkloadAction

    func test_applyService_isApplyYAML_andLowRisk() {
        let action = WorkloadAction.applyService(draft(), isNew: false)
        let invs = action.kubectlInvocations()
        XCTAssertEqual(invs.count, 1)
        XCTAssertEqual(invs[0].args, ["apply", "-f", "-"])
        XCTAssertNotNil(invs[0].stdin)
        XCTAssertFalse(action.isHighRisk)
        XCTAssertFalse(action.needsAcknowledge)
    }

    func test_applyService_titleReflectsIsNew() {
        XCTAssertTrue(WorkloadAction.applyService(draft(), isNew: true).title.contains("Create"))
        XCTAssertTrue(WorkloadAction.applyService(draft(), isNew: false).title.contains("Apply"))
    }

    func test_deleteService_invocationAndRisk() {
        let action = WorkloadAction.deleteService(name: "web", namespace: "default")
        XCTAssertEqual(action.kubectlInvocations(), [.args(["delete", "service", "web", "-n", "default"])])
        XCTAssertTrue(action.isHighRisk)
        XCTAssertTrue(action.needsAcknowledge)
    }
}
