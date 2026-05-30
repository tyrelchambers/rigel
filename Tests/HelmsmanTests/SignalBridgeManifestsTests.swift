import XCTest
@testable import Helmsman

final class SignalBridgeManifestsTests: XCTestCase {
    func test_manifestContainsCoreObjects() {
        let y = SignalBridgeManifests.manifest(namespace: "default")
        XCTAssertTrue(y.contains("kind: PersistentVolumeClaim"))
        XCTAssertTrue(y.contains("kind: Deployment"))
        XCTAssertTrue(y.contains("kind: Service"))
        XCTAssertTrue(y.contains("name: signal-cli-rest"))
        XCTAssertTrue(y.contains("name: signal-cli-data"))
        XCTAssertTrue(y.contains("bbernhard/signal-cli-rest-api"))
        XCTAssertTrue(y.contains("containerPort: 8080"))
    }

    func test_manifestSubstitutesNamespace() {
        let y = SignalBridgeManifests.manifest(namespace: "ops")
        XCTAssertEqual(y.components(separatedBy: "namespace: ops").count - 1, 3,
                       "PVC, Deployment, and Service should all carry the namespace")
        XCTAssertFalse(y.contains("namespace: default"))
    }

    func test_apiFQDN_isClusterLocal() {
        XCTAssertEqual(SignalBridgeManifests.apiURL(namespace: "ops"),
                       "http://signal-cli-rest.ops.svc.cluster.local:8080")
    }
}
