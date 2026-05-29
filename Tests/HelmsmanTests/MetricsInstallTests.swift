import XCTest
@testable import Helmsman

final class MetricsInstallTests: XCTestCase {

    func test_victoriaMetrics_persistent_includesExpectedObjects() {
        let y = MetricsInstallManifests.manifest(backend: .victoriaMetrics, namespace: "helmsman-metrics", persistent: true, sizeGiB: 8)
        XCTAssertTrue(y.contains("kind: Namespace"))
        XCTAssertTrue(y.contains("name: helmsman-metrics"))
        XCTAssertTrue(y.contains("kind: ServiceAccount"))
        XCTAssertTrue(y.contains("kind: ClusterRole"))
        XCTAssertTrue(y.contains("kind: ClusterRoleBinding"))
        XCTAssertTrue(y.contains("kind: ConfigMap"))
        XCTAssertTrue(y.contains("kind: Deployment"))
        XCTAssertTrue(y.contains("kind: Service"))
        XCTAssertTrue(y.contains("victoriametrics/victoria-metrics"))
        XCTAssertTrue(y.contains("port: 8428"))
        XCTAssertTrue(y.contains("/api/v1/nodes/${1}/proxy/metrics/cadvisor"))  // scrape job
        // PVC present + referenced in persistent mode
        XCTAssertTrue(y.contains("kind: PersistentVolumeClaim"))
        XCTAssertTrue(y.contains("storage: 8Gi"))
        XCTAssertTrue(y.contains("persistentVolumeClaim:"))
        XCTAssertFalse(y.contains("emptyDir"))
    }

    func test_ephemeral_usesEmptyDirNoPVC() {
        let y = MetricsInstallManifests.manifest(backend: .victoriaMetrics, namespace: "m", persistent: false, sizeGiB: 5)
        XCTAssertTrue(y.contains("emptyDir: {}"))
        XCTAssertFalse(y.contains("kind: PersistentVolumeClaim"))
    }

    func test_prometheus_objectsAndRetention() {
        let y = MetricsInstallManifests.manifest(backend: .prometheus, namespace: "mon", persistent: true, sizeGiB: 10)
        XCTAssertTrue(y.contains("prom/prometheus"))
        XCTAssertTrue(y.contains("--storage.tsdb.retention.time=30d"))
        XCTAssertTrue(y.contains("port: 9090"))
        XCTAssertTrue(y.contains("namespace: mon"))
    }

    func test_resultingBackend_pointsAtInstalledService() {
        let vm = MetricsInstallManifests.resultingBackend(.victoriaMetrics, namespace: "m")
        XCTAssertEqual(vm.port, 8428)
        XCTAssertEqual(vm.service, "helmsman-metrics")
        XCTAssertEqual(vm.namespace, "m")
        XCTAssertEqual(MetricsInstallManifests.resultingBackend(.prometheus, namespace: "m").port, 9090)
    }
}
