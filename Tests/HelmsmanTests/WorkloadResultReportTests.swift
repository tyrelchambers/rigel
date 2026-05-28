import XCTest
@testable import Helmsman

final class WorkloadResultReportTests: XCTestCase {
    private func deployment(_ name: String, ns: String = "default") -> Deployment {
        Deployment(
            metadata: ObjectMeta(name: name, namespace: ns, uid: "uid-\(name)",
                                 creationTimestamp: nil, labels: nil, annotations: nil),
            spec: nil, status: nil
        )
    }

    func test_success_includesCommandStatusAndOutput() {
        let action = WorkloadAction.restartDeployment(deployment("memos"))
        let result = WorkloadCommander.Result(stdout: "deployment.apps/memos restarted", stderr: "", exitCode: 0)
        let msg = WorkloadResultReport.chatFeedback(action: action, context: "prod", result: result)

        XCTAssertTrue(msg.contains("Status: success"))
        XCTAssertTrue(msg.contains("rollout restart deployment/memos"))
        XCTAssertTrue(msg.contains("--context prod"))
        XCTAssertTrue(msg.contains("deployment.apps/memos restarted"))
    }

    func test_success_emptyOutput_showsFallback() {
        let action = WorkloadAction.restartDeployment(deployment("api"))
        let result = WorkloadCommander.Result(stdout: "   \n", stderr: "", exitCode: 0)
        let msg = WorkloadResultReport.chatFeedback(action: action, context: nil, result: result)

        XCTAssertTrue(msg.contains("(no output)"))
        XCTAssertFalse(msg.contains("--context"))
    }

    func test_failure_includesExitCodeAndStderr() {
        let action = WorkloadAction.scaleDeployment(deployment("web"), to: 3)
        let result = WorkloadCommander.Result(stdout: "", stderr: "Error from server: deployments.apps \"web\" not found", exitCode: 1)
        let msg = WorkloadResultReport.chatFeedback(action: action, context: nil, result: result)

        XCTAssertTrue(msg.contains("FAILED"))
        XCTAssertTrue(msg.contains("Exit code: 1"))
        XCTAssertTrue(msg.contains("deployments.apps \"web\" not found"))
        XCTAssertTrue(msg.contains("scale deployment/web --replicas=3"))
    }
}
