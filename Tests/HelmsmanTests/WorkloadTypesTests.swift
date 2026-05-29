import XCTest
@testable import Helmsman

final class WorkloadTypesTests: XCTestCase {

    // MARK: - Job decoding + phase

    func test_job_complete() throws {
        let json = """
        {"metadata":{"name":"backup","namespace":"default","uid":"j1"},
         "spec":{"completions":1},
         "status":{"succeeded":1,"startTime":"2026-05-29T10:00:00Z","completionTime":"2026-05-29T10:00:42Z",
                   "conditions":[{"type":"Complete","status":"True"}]}}
        """
        let job = try JSONDecoder.kube.decode(Job.self, from: Data(json.utf8))
        XCTAssertEqual(job.phase, "Complete")
        XCTAssertEqual(job.completionsLabel, "1/1")
        XCTAssertEqual(job.duration, "42s")
    }

    func test_job_failedAndRunningAndSuspended() throws {
        let failed = try JSONDecoder.kube.decode(Job.self, from: Data("""
        {"metadata":{"name":"f","uid":"j2"},"spec":{"completions":1},
         "status":{"failed":1,"conditions":[{"type":"Failed","status":"True"}]}}
        """.utf8))
        XCTAssertEqual(failed.phase, "Failed")

        let running = try JSONDecoder.kube.decode(Job.self, from: Data("""
        {"metadata":{"name":"r","uid":"j3"},"spec":{"completions":3},"status":{"active":2,"succeeded":1}}
        """.utf8))
        XCTAssertEqual(running.phase, "Running")
        XCTAssertEqual(running.completionsLabel, "1/3")

        let suspended = try JSONDecoder.kube.decode(Job.self, from: Data("""
        {"metadata":{"name":"s","uid":"j4"},"spec":{"completions":1,"suspend":true},"status":{}}
        """.utf8))
        XCTAssertEqual(suspended.phase, "Suspended")
    }

    // MARK: - CronJob

    func test_cronJob_scheduleAndSuspend() throws {
        let json = """
        {"metadata":{"name":"nightly","namespace":"default","uid":"c1"},
         "spec":{"schedule":"0 2 * * *","suspend":true},
         "status":{"active":[{"name":"nightly-123"}]}}
        """
        let cj = try JSONDecoder.kube.decode(CronJob.self, from: Data(json.utf8))
        XCTAssertEqual(cj.schedule, "0 2 * * *")
        XCTAssertTrue(cj.isSuspended)
        XCTAssertEqual(cj.activeCount, 1)
    }

    // MARK: - DaemonSet

    func test_daemonSet_readiness() throws {
        let json = """
        {"metadata":{"name":"node-exporter","namespace":"monitoring","uid":"d1"},
         "status":{"desiredNumberScheduled":5,"numberReady":5}}
        """
        let ds = try JSONDecoder.kube.decode(DaemonSet.self, from: Data(json.utf8))
        XCTAssertEqual(ds.readyLabel, "5/5")
        XCTAssertTrue(ds.isHealthy)
    }

    // MARK: - WorkloadActions

    func test_restartWorkload_invocation() {
        let action = WorkloadAction.restartWorkload(kind: "statefulset", name: "db", namespace: "prod")
        XCTAssertEqual(action.kubectlInvocations(), [.args(["rollout", "restart", "statefulset/db", "-n", "prod"])])
        XCTAssertFalse(action.isHighRisk)
    }

    func test_scaleWorkload_usesTargetReplicas() {
        let action = WorkloadAction.scaleWorkload(kind: "statefulset", name: "db", namespace: "prod", current: 1, to: 3)
        XCTAssertEqual(action.kubectlInvocations(), [.args(["scale", "statefulset/db", "--replicas=3", "-n", "prod"])])
        XCTAssertTrue(action.title.contains("→ 3"))
        XCTAssertFalse(action.isHighRisk)
    }

    func test_deleteWorkload_invocationAndRisk() {
        let action = WorkloadAction.deleteWorkload(kind: "daemonset", name: "ne", namespace: "monitoring")
        XCTAssertEqual(action.kubectlInvocations(), [.args(["delete", "daemonset", "ne", "-n", "monitoring"])])
        XCTAssertTrue(action.isHighRisk)
        XCTAssertTrue(action.needsAcknowledge)
    }

    func test_setCronJobSuspend_patch() {
        let suspend = WorkloadAction.setCronJobSuspend(name: "nightly", namespace: "default", suspend: true)
        XCTAssertEqual(suspend.kubectlInvocations(), [.args(["patch", "cronjob", "nightly", "-n", "default", "--type=merge", "-p", "{\"spec\":{\"suspend\":true}}"])])
        XCTAssertFalse(suspend.isHighRisk)
        XCTAssertTrue(WorkloadAction.setCronJobSuspend(name: "x", namespace: "default", suspend: false).title.contains("Resume"))
    }

    func test_triggerCronJob_createsFromCronjob() {
        let action = WorkloadAction.triggerCronJob(name: "nightly", namespace: "default", jobName: "nightly-manual-42")
        XCTAssertEqual(action.kubectlInvocations(), [.args(["create", "job", "nightly-manual-42", "--from=cronjob/nightly", "-n", "default"])])
    }
}
