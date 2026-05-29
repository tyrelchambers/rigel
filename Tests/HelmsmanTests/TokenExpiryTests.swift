import XCTest
@testable import Helmsman

final class TokenExpiryTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_800_000_000)
    private func daysAgo(_ d: Int) -> Date { now.addingTimeInterval(-Double(d) * 86_400) }

    func test_freshTokenHasAboutAYearAndIsOK() {
        let s = TokenExpiry.status(issuedAt: now, now: now)
        XCTAssertEqual(s.daysRemaining, 365)
        XCTAssertEqual(s.level, .ok)
    }

    func test_within30DaysIsWarning() {
        let s = TokenExpiry.status(issuedAt: daysAgo(345), now: now)
        XCTAssertEqual(s.daysRemaining, 20)
        XCTAssertEqual(s.level, .warning)
    }

    func test_pastAYearIsExpired() {
        let s = TokenExpiry.status(issuedAt: daysAgo(400), now: now)
        XCTAssertLessThan(s.daysRemaining, 0)
        XCTAssertEqual(s.level, .expired)
    }

    func test_exactlyAtThirtyDaysIsStillWarning() {
        let s = TokenExpiry.status(issuedAt: daysAgo(335), now: now)
        XCTAssertEqual(s.daysRemaining, 30)
        XCTAssertEqual(s.level, .warning)
    }
}
