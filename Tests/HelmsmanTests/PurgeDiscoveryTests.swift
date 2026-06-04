import XCTest
@testable import Helmsman

final class PurgeDiscoveryTests: XCTestCase {
    func test_discover_threadsSiblingsAndDependents() {
        let dep = { (n: String) in Deployment(metadata: ObjectMeta(name: n, namespace: "default", uid: "u-\(n)", creationTimestamp: nil, labels: nil, annotations: nil), spec: nil, status: nil) }
        let svc = { (n: String) in Service(metadata: ObjectMeta(name: n, namespace: "default", uid: "s-\(n)", creationTimestamp: nil, labels: nil, annotations: nil), spec: nil, status: nil) }
        let plan = PurgeDiscovery.discover(
            rootName: "canada-hires-web", namespace: "default",
            deployments: [dep("canada-hires-web"), dep("canadahires-api"), dep("big-o")],
            statefulSets: [],
            services: [svc("canada-hires-web"), svc("canadahires-api"), svc("big-o")],
            ingresses: [], secrets: [], configMaps: [], pvcs: []
        )
        let names = Set(plan.resources.map(\.name))
        XCTAssertTrue(names.contains("canada-hires-web"))
        XCTAssertTrue(names.contains("canadahires-api"))
        XCTAssertTrue(plan.resources.contains { $0.kind == .service && $0.name == "canada-hires-web" })
        XCTAssertFalse(names.contains("big-o"), "unrelated app must not be pulled in")
        XCTAssertEqual(plan.namespace, "default")
        XCTAssertEqual(plan.appName, "canada-hires-web")
    }

    func test_discover_doesNotMatchAcrossNamespaces() {
        let dep = { (n: String, ns: String) in Deployment(metadata: ObjectMeta(name: n, namespace: ns, uid: "u-\(n)-\(ns)", creationTimestamp: nil, labels: nil, annotations: nil), spec: nil, status: nil) }
        let plan = PurgeDiscovery.discover(
            rootName: "canada-hires-web", namespace: "default",
            deployments: [dep("canada-hires-web", "default"), dep("canadahires-api", "other")],
            statefulSets: [],
            services: [], ingresses: [], secrets: [], configMaps: [], pvcs: []
        )
        let matched = plan.resources.filter { $0.name == "canadahires-api" }
        XCTAssertTrue(matched.isEmpty, "a same-named resource in a different namespace must not be included")
        XCTAssertTrue(plan.resources.allSatisfy { $0.namespace == "default" })
    }

    func test_discover_detectsHelmRelease() {
        let dep = { (n: String) in Deployment(metadata: ObjectMeta(name: n, namespace: "personal", uid: "u-\(n)", creationTimestamp: nil, labels: nil, annotations: nil), spec: nil, status: nil) }
        let sec = { (n: String) in Secret(metadata: ObjectMeta(name: n, namespace: "personal", uid: "sec-\(n)", creationTimestamp: nil, labels: nil, annotations: nil), type: "helm.sh/release.v1", data: nil) }
        let plan = PurgeDiscovery.discover(
            rootName: "plane", namespace: "personal",
            deployments: [dep("plane")], statefulSets: [], services: [], ingresses: [],
            secrets: [sec("sh.helm.release.v1.plane.v1"), sec("sh.helm.release.v1.plane.v2")],
            configMaps: [], pvcs: [])
        XCTAssertEqual(plan.helmRelease, "plane")
    }

    func test_discover_noHelmReleaseSecret_leavesHelmReleaseNil() {
        let dep = { (n: String) in Deployment(metadata: ObjectMeta(name: n, namespace: "personal", uid: "u-\(n)", creationTimestamp: nil, labels: nil, annotations: nil), spec: nil, status: nil) }
        let plan = PurgeDiscovery.discover(
            rootName: "plane", namespace: "personal",
            deployments: [dep("plane")], statefulSets: [], services: [], ingresses: [],
            secrets: [], configMaps: [], pvcs: [])
        XCTAssertNil(plan.helmRelease)
    }

    func test_discover_inProtectedNamespace_isEmpty() {
        let plan = PurgeDiscovery.discover(
            rootName: "rancher", namespace: "cattle-system",
            deployments: [], statefulSets: [], services: [], ingresses: [],
            secrets: [], configMaps: [], pvcs: [])
        XCTAssertTrue(plan.resources.isEmpty)
        XCTAssertNotNil(plan.blockedReason)
    }
}
