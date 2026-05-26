import XCTest
@testable import ClaudeK8s

final class ContextHandoffBuilderTests: XCTestCase {
    func test_podHandoffIncludesNameNamespaceAndDescribe() {
        let pod = Pod(
            metadata: ObjectMeta(
                name: "postiz-844c9f-abcde",
                namespace: "default",
                uid: "abc",
                creationTimestamp: nil,
                labels: ["app": "postiz"]
            ),
            spec: PodSpec(nodeName: "k3s-slave", containers: [Container(name: "postiz", image: "ghcr.io/x/y:latest")]),
            status: PodStatus(phase: "Pending", podIP: nil, containerStatuses: [
                ContainerStatus(name: "postiz", ready: false, restartCount: 3, state: ContainerState(
                    running: nil, waiting: WaitingState(reason: "CrashLoopBackOff", message: nil), terminated: nil
                ))
            ])
        )
        let describe = "Name: postiz-844c9f-abcde\nNamespace: default\nNode: k3s-slave/100.99.155.125\n..."
        let events = "10s    Warning   BackOff    pod/postiz-844c9f-abcde   Back-off restarting failed container"

        let prompt = ContextHandoffBuilder.build(.pod(pod, describe: describe, recentEvents: events))

        XCTAssertTrue(prompt.contains("postiz-844c9f-abcde"))
        XCTAssertTrue(prompt.contains("default"))
        XCTAssertTrue(prompt.contains("CrashLoopBackOff"))
        XCTAssertTrue(prompt.contains("kubectl describe"))
        XCTAssertTrue(prompt.contains("kubectl get events"))
        XCTAssertTrue(prompt.contains("BackOff"))
    }
}
