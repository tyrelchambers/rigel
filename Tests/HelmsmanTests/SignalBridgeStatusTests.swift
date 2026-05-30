import XCTest
@testable import Helmsman

final class SignalBridgeStatusTests: XCTestCase {
    private func deploy(ns: String, ready: Int?) -> Deployment {
        let json = """
        {"metadata":{"name":"signal-cli-rest","namespace":"\(ns)","uid":"u1"},
         "spec":{"replicas":1},
         "status":{"readyReplicas":\(ready.map(String.init) ?? "null")}}
        """
        return try! JSONDecoder().decode(Deployment.self, from: Data(json.utf8))
    }

    func test_notDeployed_whenNoDeployment() {
        let s = SignalBridgeStatus.derive(deployments: [], namespace: "default",
                                          hasSavedNumber: false, applying: false)
        XCTAssertEqual(s, .notDeployed)
    }

    func test_deploying_whenApplyInFlight() {
        let s = SignalBridgeStatus.derive(deployments: [], namespace: "default",
                                          hasSavedNumber: false, applying: true)
        XCTAssertEqual(s, .deploying)
    }

    func test_starting_whenDeploymentNotReady() {
        let s = SignalBridgeStatus.derive(deployments: [deploy(ns: "default", ready: 0)],
                                          namespace: "default", hasSavedNumber: false, applying: false)
        XCTAssertEqual(s, .starting)
    }

    func test_ready_whenReadyAndNoNumber() {
        let s = SignalBridgeStatus.derive(deployments: [deploy(ns: "default", ready: 1)],
                                          namespace: "default", hasSavedNumber: false, applying: false)
        XCTAssertEqual(s, .ready)
    }

    func test_linked_whenReadyAndNumberSaved() {
        let s = SignalBridgeStatus.derive(deployments: [deploy(ns: "default", ready: 1)],
                                          namespace: "default", hasSavedNumber: true, applying: false)
        XCTAssertEqual(s, .linked)
    }

    func test_ignoresDeploymentInOtherNamespace() {
        let s = SignalBridgeStatus.derive(deployments: [deploy(ns: "other", ready: 1)],
                                          namespace: "default", hasSavedNumber: false, applying: false)
        XCTAssertEqual(s, .notDeployed)
    }
}
