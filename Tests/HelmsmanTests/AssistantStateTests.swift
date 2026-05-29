import XCTest
@testable import Helmsman

final class AssistantStateTests: XCTestCase {
    private let sample = """
    {
      "updatedAt": "2026-05-29T03:00:00Z",
      "status": {
        "heartbeatAt": "2026-05-29T03:00:00Z",
        "spentUsd": 1.23,
        "spendCapUsd": 50,
        "enabled": true,
        "version": "0.1.0"
      },
      "audit": [
        {
          "at": "2026-05-29T02:14:00Z",
          "fingerprint": "unhealthyPod|default|memos-abc|CrashLoopBackOff",
          "incident": "default/memos-abc: CrashLoopBackOff",
          "proposal": "Rollback memos",
          "command": "kubectl rollout undo deployment/memos -n default",
          "tier": "low",
          "verdict": "auto",
          "outcome": "success",
          "detail": "deployment.apps/memos rolled back",
          "backupRef": "2026-05-29T02:14:00Z_fp"
        }
      ],
      "queue": [
        {
          "at": "2026-05-29T02:40:00Z",
          "incident": "prod/api: Degraded (1/3 ready)",
          "suggestion": "Scale api → 3",
          "reason": "medium-risk — Opus escalated: not confident",
          "action": { "label": "Scale api → 3", "kind": "scale", "deployment": "api", "namespace": "prod", "replicas": 3 }
        }
      ],
      "report": "1 fix applied, 1 awaiting approval"
    }
    """

    func test_decodesFullState() throws {
        let state = try JSONDecoder().decode(AssistantClusterState.self, from: Data(sample.utf8))
        XCTAssertEqual(state.status?.enabled, true)
        XCTAssertEqual(state.status?.spentUsd, 1.23)
        XCTAssertEqual(state.status?.spendCapUsd, 50)
        XCTAssertEqual(state.audit.count, 1)
        XCTAssertEqual(state.audit.first?.outcome, "success")
        XCTAssertEqual(state.audit.first?.backupRef, "2026-05-29T02:14:00Z_fp")
        XCTAssertEqual(state.report, "1 fix applied, 1 awaiting approval")
    }

    func test_decodesQueuedSuggestionWithStructuredAction() throws {
        let state = try JSONDecoder().decode(AssistantClusterState.self, from: Data(sample.utf8))
        let q = try XCTUnwrap(state.queue.first)
        XCTAssertEqual(q.suggestion, "Scale api → 3")
        XCTAssertEqual(q.action?.kind, .scale)
        XCTAssertEqual(q.action?.replicas, 3)
        XCTAssertEqual(q.action?.deployment, "api")
    }

    func test_toleratesMissingArraysAndStatus() throws {
        let minimal = #"{ "report": "" }"#
        let state = try JSONDecoder().decode(AssistantClusterState.self, from: Data(minimal.utf8))
        XCTAssertNil(state.status)
        XCTAssertTrue(state.audit.isEmpty)
        XCTAssertTrue(state.queue.isEmpty)
    }
}
