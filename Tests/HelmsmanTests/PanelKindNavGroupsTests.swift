import XCTest
@testable import Helmsman

final class PanelKindNavGroupsTests: XCTestCase {

    func test_navGroups_coverEveryPanelExactlyOnce() {
        let grouped = PanelKind.navGroups.flatMap { $0.panels }
        XCTAssertEqual(
            Set(grouped), Set(PanelKind.allCases),
            "Every PanelKind must appear in navGroups; otherwise it would vanish from the sidebar."
        )
        XCTAssertEqual(
            grouped.count, PanelKind.allCases.count,
            "A PanelKind is listed more than once in navGroups."
        )
    }

    func test_navGroups_firstGroupIsPinnedAndStartsWithOverview() {
        XCTAssertNil(PanelKind.navGroups.first?.title)
        XCTAssertEqual(PanelKind.navGroups.first?.panels.first, .overview)
    }
}
