import XCTest
@testable import Helmsman

final class WarningGroupingTests: XCTestCase {

    func test_groupsByReasonKindNamespace_andSumsCounts() {
        let events =
            (0..<9).map { warning(reason: "Update", kind: "Snapshot", ns: "longhorn-system",
                                   name: "snap-\($0)", message: "snapshot becomes not ready to use") }
            + [warning(reason: "FailedStartingSnapshot", kind: "Engine", ns: "longhorn-system",
                       name: "pvc-953", message: "(combined from similar events): Failed to start snapshot purge for engine pvc-953", count: 4)]

        let groups = SuggestedPromptsBuilder.groupWarnings(events)

        XCTAssertEqual(groups.count, 2)
        // Sorted by total desc: 9 snapshot updates first.
        XCTAssertEqual(groups[0].reason, "Update")
        XCTAssertEqual(groups[0].kind, "Snapshot")
        XCTAssertEqual(groups[0].total, 9)
        XCTAssertEqual(groups[0].sampleMessage, "snapshot becomes not ready to use")
        XCTAssertEqual(groups[0].objectNames.count, 9)
        XCTAssertTrue(groups[0].shortLabel.contains("snapshot becomes not ready"))
    }

    func test_serverSideCountIsSummed() {
        let events = [
            warning(reason: "BackOff", kind: "Pod", ns: "default", name: "a", message: "back-off restarting", count: 5),
            warning(reason: "BackOff", kind: "Pod", ns: "default", name: "b", message: "back-off restarting", count: 3),
        ]
        let groups = SuggestedPromptsBuilder.groupWarnings(events)
        XCTAssertEqual(groups.count, 1)
        XCTAssertEqual(groups[0].total, 8)        // 5 + 3
        XCTAssertEqual(groups[0].objectNames, ["a", "b"])
    }

    func test_compactsCombinedFromSimilarPrefixInLabel() {
        let g = SuggestedPromptsBuilder.groupWarnings([
            warning(reason: "FailedMount", kind: "Pod", ns: "default", name: "p",
                    message: "(combined from similar events): Unable to attach volume")
        ])[0]
        XCTAssertEqual(g.sampleMessage, "Unable to attach volume")
    }

    func test_differentNamespacesStaySeparate() {
        let events = [
            warning(reason: "Update", kind: "Snapshot", ns: "longhorn-system", name: "a", message: "m"),
            warning(reason: "Update", kind: "Snapshot", ns: "other", name: "b", message: "m"),
        ]
        XCTAssertEqual(SuggestedPromptsBuilder.groupWarnings(events).count, 2)
    }

    // MARK: - Fixture

    private func warning(reason: String, kind: String, ns: String, name: String, message: String, count: Int = 1) -> K8sEvent {
        K8sEvent(
            metadata: ObjectMeta(name: "\(name)-evt", namespace: ns, uid: UUID().uuidString,
                                 creationTimestamp: nil, labels: nil, annotations: nil),
            type: "Warning",
            reason: reason,
            message: message,
            count: count,
            firstTimestamp: nil,
            lastTimestamp: nil,
            involvedObject: InvolvedObject(kind: kind, name: name, namespace: ns, uid: nil)
        )
    }
}
