import XCTest
@testable import Helmsman

final class DatabaseActionTests: XCTestCase {
    func test_action_idAndLabel() {
        XCTAssertEqual(DatabaseAction.backupNow.label, "Back up")
        XCTAssertEqual(DatabaseAction.switchover(to: "pg-2").label, "Switch over")
        XCTAssertEqual(DatabaseAction.hibernate.id, "hibernate")
        XCTAssertEqual(DatabaseAction.resume.id, "resume")
        XCTAssertEqual(DatabaseAction.scale(current: 3, to: 5).id, "scale")
        XCTAssertEqual(DatabaseAction.portForward.id, "portForward")
        XCTAssertEqual(DatabaseAction.revealCredentials.id, "revealCredentials")
        XCTAssertEqual(DatabaseAction.copyDSN.id, "copyDSN")
    }
}
