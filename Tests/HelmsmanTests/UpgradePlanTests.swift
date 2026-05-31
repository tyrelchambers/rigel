import XCTest
@testable import Helmsman

final class UpgradePlanTests: XCTestCase {

    func test_make_buildsDeploymentTargetWithSwappedTag() {
        let dep = deployment("plausible", containers: [
            container("app", "ghcr.io/plausible/community-edition:v2.1.4")
        ])
        let plan = UpgradePlan.make(
            appName: "Plausible",
            currentImage: "ghcr.io/plausible/community-edition:v2.1.4",
            targetTag: "v3.2.1",
            deployments: [dep],
            statefulSets: []
        )
        XCTAssertEqual(plan.targets, [
            ImageUpgradeTarget(
                workloadKind: "deployment",
                workloadName: "plausible",
                namespace: "default",
                container: "app",
                currentImage: "ghcr.io/plausible/community-edition:v2.1.4",
                newImage: "ghcr.io/plausible/community-edition:v3.2.1"
            )
        ])
        XCTAssertEqual(plan.currentTag, "v2.1.4")
        XCTAssertEqual(plan.targetTag, "v3.2.1")
    }

    func test_make_findsStatefulSetContainer() {
        let ss = statefulSet("gitea", containers: [container("gitea", "gitea/gitea:1.21")])
        let plan = UpgradePlan.make(
            appName: "Gitea",
            currentImage: "gitea/gitea:1.21",
            targetTag: "1.22",
            deployments: [],
            statefulSets: [ss]
        )
        XCTAssertEqual(plan.targets.map(\.workloadKind), ["statefulset"])
        XCTAssertEqual(plan.targets.first?.newImage, "gitea/gitea:1.22")
    }

    func test_make_ignoresContainersNotRunningTheAppImage() {
        let dep = deployment("plausible", containers: [
            container("app", "ghcr.io/plausible/community-edition:v2.1.4"),
            container("sidecar", "busybox:1.36"),
        ])
        let plan = UpgradePlan.make(
            appName: "Plausible",
            currentImage: "ghcr.io/plausible/community-edition:v2.1.4",
            targetTag: "v3.2.1",
            deployments: [dep],
            statefulSets: []
        )
        XCTAssertEqual(plan.targets.count, 1)
        XCTAssertEqual(plan.targets.first?.container, "app")
    }

    func test_contextBlock_namesWorkloadContainerAndVersions() {
        let dep = deployment("plausible", containers: [
            container("app", "ghcr.io/plausible/community-edition:v2.1.4")
        ])
        let block = UpgradePlan.make(
            appName: "Plausible",
            currentImage: "ghcr.io/plausible/community-edition:v2.1.4",
            targetTag: "v3.2.1",
            deployments: [dep],
            statefulSets: []
        ).contextBlock
        XCTAssertTrue(block.contains("Plausible"), block)
        XCTAssertTrue(block.contains("v2.1.4"), block)
        XCTAssertTrue(block.contains("v3.2.1"), block)
        XCTAssertTrue(block.contains("deployment/plausible"), block)
        XCTAssertTrue(block.contains("app"), block)
    }

    // MARK: - Fixtures

    private func container(_ name: String, _ image: String) -> Container {
        Container(name: name, image: image, resources: nil, ports: nil)
    }

    private func deployment(_ name: String, ns: String = "default", containers: [Container]) -> Deployment {
        Deployment(
            metadata: ObjectMeta(name: name, namespace: ns, uid: "uid-\(name)", creationTimestamp: nil, labels: nil, annotations: nil),
            spec: DeploymentSpec(
                replicas: 1, selector: nil,
                template: PodTemplate(spec: PodSpec(nodeName: nil, containers: containers)),
                strategy: nil, paused: nil
            ),
            status: nil
        )
    }

    private func statefulSet(_ name: String, ns: String = "default", containers: [Container]) -> StatefulSet {
        StatefulSet(
            metadata: ObjectMeta(name: name, namespace: ns, uid: "uid-\(name)", creationTimestamp: nil, labels: nil, annotations: nil),
            spec: StatefulSetSpec(
                replicas: 1, selector: nil,
                template: PodTemplate(spec: PodSpec(nodeName: nil, containers: containers))
            ),
            status: nil
        )
    }
}
