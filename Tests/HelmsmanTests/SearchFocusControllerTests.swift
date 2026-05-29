import XCTest
@testable import Helmsman

@MainActor
final class SearchFocusControllerTests: XCTestCase {
    func test_focusActiveSearch_bumpsToken() {
        let c = SearchFocusController.shared
        let before = c.token
        c.focusActiveSearch()
        XCTAssertEqual(c.token, before &+ 1)
        c.focusActiveSearch()
        XCTAssertEqual(c.token, before &+ 2)
    }
}
