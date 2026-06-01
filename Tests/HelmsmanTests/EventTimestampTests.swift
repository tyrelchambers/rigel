import XCTest
@testable import Helmsman

final class EventTimestampTests: XCTestCase {
    private func event(when: Date?) -> K8sEvent {
        K8sEvent(
            metadata: ObjectMeta(name: "e", namespace: "default", uid: UUID().uuidString,
                                 creationTimestamp: nil, labels: nil, annotations: nil),
            type: "Warning",
            reason: "FailedMount",
            message: "back-off",
            count: 1,
            firstTimestamp: nil,
            lastTimestamp: when,
            involvedObject: InvolvedObject(kind: "Pod", name: "api", namespace: "default", uid: nil)
        )
    }

    func test_relativeAge_secondsMinutesHoursDays() {
        let now = Date(timeIntervalSince1970: 1_000_000)
        XCTAssertEqual(event(when: now.addingTimeInterval(-5)).relativeAge(now: now), "5s")
        XCTAssertEqual(event(when: now.addingTimeInterval(-3 * 60)).relativeAge(now: now), "3m")
        XCTAssertEqual(event(when: now.addingTimeInterval(-2 * 3600)).relativeAge(now: now), "2h")
        XCTAssertEqual(event(when: now.addingTimeInterval(-3 * 86400)).relativeAge(now: now), "3d")
    }

    func test_relativeAge_noTimestamp_isDash() {
        XCTAssertEqual(event(when: nil).relativeAge(), "—")
    }

    func test_relativeAge_futureTimestamp_clampsToZero() {
        let now = Date(timeIntervalSince1970: 1_000_000)
        XCTAssertEqual(event(when: now.addingTimeInterval(30)).relativeAge(now: now), "0s")
    }

    func test_absoluteWhen_presentWhenTimestamped_nilOtherwise() {
        XCTAssertNotNil(event(when: Date()).absoluteWhen)
        XCTAssertNil(event(when: nil).absoluteWhen)
    }
}
