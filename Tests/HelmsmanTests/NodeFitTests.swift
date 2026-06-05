import XCTest
@testable import Helmsman

final class NodeFitTests: XCTestCase {

    func test_fit_emptyCluster_returnsNoRecommendation() {
        let result = nodeFit(app: testApp(cpu: "500m", memory: "512Mi"), nodes: [], pods: [])
        XCTAssertNil(result.recommended)
        XCTAssertFalse(result.anyFits)
        XCTAssertEqual(result.dot, .red)
        XCTAssertTrue(result.perNode.isEmpty)
    }

    func test_fit_singleFreeNode_recommendsIt() {
        let nodes = [makeNode(name: "k3s-1", cpu: "4", memory: "8Gi")]
        let result = nodeFit(app: testApp(cpu: "500m", memory: "512Mi"), nodes: nodes, pods: [])
        XCTAssertEqual(result.recommended?.node.metadata.name, "k3s-1")
        XCTAssertEqual(result.dot, .green)
    }

    func test_fit_taintedNode_isExcluded() {
        let nodes = [
            makeNode(name: "tainted", cpu: "8", memory: "16Gi", taints: [NodeTaint(key: "dedicated", value: "ai", effect: "NoSchedule")]),
            makeNode(name: "small", cpu: "200m", memory: "256Mi"),
        ]
        let result = nodeFit(app: testApp(cpu: "500m", memory: "512Mi"), nodes: nodes, pods: [])
        XCTAssertNil(result.recommended, "tainted node should not be recommended even though it has capacity")
        XCTAssertEqual(result.perNode.first(where: { $0.node.metadata.name == "tainted" })?.tainted, true)
    }

    func test_fit_cordonedNode_isExcluded() {
        let nodes = [
            makeNode(name: "cordoned", cpu: "8", memory: "16Gi", unschedulable: true),
        ]
        let result = nodeFit(app: testApp(cpu: "500m", memory: "512Mi"), nodes: nodes, pods: [])
        XCTAssertNil(result.recommended)
    }

    func test_fit_ranking_prefersHighestHeadroom() {
        let nodes = [
            makeNode(name: "busy", cpu: "4", memory: "8Gi"),
            makeNode(name: "idle", cpu: "4", memory: "8Gi"),
        ]
        let pods = [
            makePod(node: "busy", cpu: "3", memory: "6Gi"),
        ]
        let result = nodeFit(app: testApp(cpu: "500m", memory: "512Mi"), nodes: nodes, pods: pods)
        XCTAssertEqual(result.recommended?.node.metadata.name, "idle", "idle node has more headroom and should rank first")
        XCTAssertEqual(result.perNode.first?.node.metadata.name, "idle")
    }

    func test_fit_requirementsExceedAll_returnsNoRecommendation() {
        let nodes = [
            makeNode(name: "tiny-a", cpu: "1", memory: "1Gi"),
            makeNode(name: "tiny-b", cpu: "1", memory: "1Gi"),
        ]
        let result = nodeFit(app: testApp(cpu: "4", memory: "8Gi"), nodes: nodes, pods: [])
        XCTAssertNil(result.recommended)
        XCTAssertEqual(result.dot, .red)
        XCTAssertTrue(result.perNode.allSatisfy { !$0.canHost })
    }

    func test_fit_succeededPodsAreIgnoredInUsage() {
        let nodes = [makeNode(name: "k3s-1", cpu: "2", memory: "2Gi")]
        // A finished Job pod left behind shouldn't reduce headroom.
        let pods = [makePod(node: "k3s-1", cpu: "1500m", memory: "1500Mi", phase: "Succeeded")]
        let result = nodeFit(app: testApp(cpu: "1", memory: "1Gi"), nodes: nodes, pods: pods)
        XCTAssertNotNil(result.recommended)
    }

    func test_fit_notReadyNode_isExcluded() {
        let nodes = [makeNode(name: "k3s-1", cpu: "4", memory: "8Gi", ready: false)]
        let result = nodeFit(app: testApp(cpu: "500m", memory: "512Mi"), nodes: nodes, pods: [])
        XCTAssertNil(result.recommended)
    }

    // MARK: - Fixture builders

    // MARK: - Disk fit

    func test_fit_diskInsufficient_excludesNode() {
        let nodes = [makeNode(name: "k3s-1", cpu: "4", memory: "8Gi")]
        let gib = 1024.0 * 1024 * 1024
        // Node has only 5Gi free disk; the app wants 10Gi.
        let disk = ["k3s-1": NodeDiskUsage(capacityBytes: 100 * gib, usedBytes: 95 * gib, availableBytes: 5 * gib)]
        let result = nodeFit(app: testApp(cpu: "500m", memory: "512Mi", storage: 10),
                             nodes: nodes, pods: [], nodeDisk: disk)
        XCTAssertNil(result.recommended, "node with too little free disk should not host a 10Gi app")
    }

    func test_fit_diskSufficient_fits() {
        let nodes = [makeNode(name: "k3s-1", cpu: "4", memory: "8Gi")]
        let gib = 1024.0 * 1024 * 1024
        let disk = ["k3s-1": NodeDiskUsage(capacityBytes: 100 * gib, usedBytes: 20 * gib, availableBytes: 80 * gib)]
        let result = nodeFit(app: testApp(cpu: "500m", memory: "512Mi", storage: 10),
                             nodes: nodes, pods: [], nodeDisk: disk)
        XCTAssertEqual(result.recommended?.node.metadata.name, "k3s-1")
        XCTAssertNotNil(result.recommended?.usedDiskBytes, "actual disk usage should be carried when known")
    }

    func test_fit_diskUnknown_doesNotGate() {
        // No Summary-API data + an app that wants storage → disk must NOT exclude
        // the node (could be networked PVC storage).
        let nodes = [makeNode(name: "k3s-1", cpu: "4", memory: "8Gi")]
        let result = nodeFit(app: testApp(cpu: "500m", memory: "512Mi", storage: 50),
                             nodes: nodes, pods: [], nodeDisk: [:])
        XCTAssertEqual(result.recommended?.node.metadata.name, "k3s-1")
        XCTAssertNil(result.recommended?.usedDiskBytes)
    }

    private func testApp(cpu: String, memory: String, storage: Int? = nil) -> CatalogApp {
        CatalogApp(
            id: "test",
            name: "Test",
            tagline: "",
            description: "",
            category: .other,
            iconSystemName: "cube",
            docsURL: URL(string: "https://example.com")!,
            repoURL: nil,
            homepageURL: nil,
            tags: [],
            matchImages: [],
            requirements: AppRequirements(
                cpuRequest: cpu,
                cpuLimit: nil,
                memoryRequest: memory,
                memoryLimit: nil,
                storageGiB: storage
            ),
            persistence: false,
            exposesIngress: false,
            notes: nil,
            installPromptTemplate: ""
        )
    }

    private func makeNode(
        name: String,
        cpu: String,
        memory: String,
        ready: Bool = true,
        unschedulable: Bool = false,
        taints: [NodeTaint] = []
    ) -> Node {
        Node(
            metadata: ObjectMeta(
                name: name,
                namespace: nil,
                uid: "uid-\(name)",
                creationTimestamp: nil,
                labels: nil,
                annotations: nil
            ),
            spec: NodeSpec(
                podCIDR: nil,
                providerID: nil,
                unschedulable: unschedulable,
                taints: taints.isEmpty ? nil : taints
            ),
            status: NodeStatus(
                capacity: ["cpu": cpu, "memory": memory],
                allocatable: ["cpu": cpu, "memory": memory],
                conditions: [NodeCondition(type: "Ready", status: ready ? "True" : "False", reason: nil, message: nil)],
                addresses: nil,
                nodeInfo: nil
            )
        )
    }

    private func makePod(node: String, cpu: String, memory: String, phase: String = "Running") -> Pod {
        Pod(
            metadata: ObjectMeta(
                name: "pod-\(node)-\(cpu)-\(memory)",
                namespace: "default",
                uid: UUID().uuidString,
                creationTimestamp: nil,
                labels: nil,
                annotations: nil
            ),
            spec: PodSpec(
                nodeName: node,
                containers: [
                    Container(
                        name: "c0",
                        image: "ubuntu",
                        resources: ResourceRequirements(
                            requests: ["cpu": cpu, "memory": memory],
                            limits: nil
                        ),
                        ports: nil
                    )
                ]
            ),
            status: PodStatus(phase: phase, podIP: nil, containerStatuses: nil)
        )
    }
}
